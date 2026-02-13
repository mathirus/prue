/**
 * bot-status.cjs — One-call bot status for Claude Code monitoring
 * Usage: node scripts/bot-status.cjs [--logs N]
 *
 * Shows: balance, open positions, recent trades, log health, RPC errors
 * Designed to replace multiple tail/grep calls with a single invocation.
 */
const Database = require('better-sqlite3');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
require('dotenv').config();

const decode = bs58.decode || bs58.default?.decode;
const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const LOCK_FILE = path.join(__dirname, '..', '.bot.lock');
const WATCHDOG_LOG = path.join(__dirname, '..', 'watchdog.log');
const DATA_DIR = path.join(__dirname, '..', 'data');

// How many log lines to scan for health check (default 300)
const LOG_SCAN_LINES = parseInt(process.argv.find(a => a.startsWith('--logs='))?.split('=')[1] || '300');

function shortenMint(mint) { return mint ? mint.slice(0, 8) + '...' : '?'; }
function formatSol(n) { return n != null ? n.toFixed(6) : '?'; }
function formatPct(n) { return n != null ? (n >= 0 ? '+' : '') + n.toFixed(1) + '%' : '?'; }
function timeSince(ts) {
  if (!ts) return '?';
  const sec = (Date.now() - ts) / 1000;
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return (sec / 60).toFixed(1) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // ═══════ BOT STATUS ═══════
  let botRunning = false;
  let botPid = null;
  let watchdogPid = null;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      botPid = lock.pid;
      // Check if process exists
      try { process.kill(lock.pid, 0); botRunning = true; } catch { botRunning = false; }
    }
  } catch {}

  // ═══════ BALANCE ═══════
  let balance = null;
  try {
    const conn = new Connection(process.env.RPC_URL);
    const wallet = Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));
    balance = (await conn.getBalance(wallet.publicKey)) / 1e9;
  } catch (e) {
    balance = null;
  }

  // ═══════ OPEN POSITIONS ═══════
  const openPositions = db.prepare(`
    SELECT token_mint, pool_address, entry_price, current_price, peak_price,
           token_amount, sol_invested, sol_returned, pnl_pct, pnl_sol,
           security_score, opened_at, peak_multiplier, tp_levels_hit,
           sell_attempts, sell_successes, entry_latency_ms
    FROM positions WHERE status IN ('open', 'partial_close')
    ORDER BY opened_at DESC
  `).all();

  // ═══════ RECENT TRADES (last 8) ═══════
  const recentTrades = db.prepare(`
    SELECT token_mint, status, pnl_pct, pnl_sol, security_score,
           exit_reason, peak_multiplier, sell_attempts, sell_successes,
           entry_latency_ms, bot_version, opened_at, closed_at,
           holder_count, liquidity_usd
    FROM positions WHERE status IN ('closed', 'stopped')
    ORDER BY opened_at DESC LIMIT 8
  `).all();

  // ═══════ SESSION STATS (today) ═══════
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const sessionStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
      SUM(CASE WHEN pnl_pct BETWEEN -80 AND 5 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(COALESCE(pnl_sol, 0)), 6) as net_pnl,
      ROUND(AVG(entry_latency_ms), 0) as avg_latency_ms,
      SUM(sell_attempts) as total_sell_attempts,
      SUM(sell_successes) as total_sell_successes
    FROM positions
    WHERE opened_at >= ? AND status IN ('closed', 'stopped')
  `).get(todayStart.getTime());

  // ═══════ LOG HEALTH ═══════
  let logHealth = { errors: 0, warns429: 0, sellFails: 0, buySuccess: 0, poolsDetected: 0, lastLogAge: null, sellBursts: 0, sellBurstIgnored: 0, logFile: null };
  try {
    // v9z: Find most recent session log in data/ (bot-YYYY-MM-DD_HHmmss.log)
    let logFile = null;
    try {
      const botLogs = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
        .sort()
        .reverse();
      if (botLogs.length > 0) logFile = path.join(DATA_DIR, botLogs[0]);
    } catch {}
    // Fallback to watchdog.log
    if (!logFile && fs.existsSync(WATCHDOG_LOG)) logFile = WATCHDOG_LOG;
    logHealth.logFile = logFile ? path.basename(logFile) : null;
    if (logFile) {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n');
      const recent = lines.slice(-LOG_SCAN_LINES);

      // Extract timestamp from last line
      const lastLine = lines.filter(l => l.trim()).pop();
      if (lastLine) {
        const timeMatch = lastLine.match(/(\d{2}:\d{2}:\d{2}\.\d{3})/);
        if (timeMatch) {
          const [h, m, s] = timeMatch[1].split(':');
          const now = new Date();
          const logTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +h, +m, parseFloat(s));
          logHealth.lastLogAge = Math.round((now - logTime) / 1000);
        }
      }

      for (const line of recent) {
        if (/\berror\b/i.test(line) && !/error.*String\(err\)/i.test(line)) logHealth.errors++;
        if (/429|rate.limit/i.test(line)) logHealth.warns429++;
        if (/sell.*FAIL|SELL.*FAIL|All sell strategies failed/i.test(line)) logHealth.sellFails++;
        if (/BUY SUCCESS/i.test(line)) logHealth.buySuccess++;
        if (/POOL NUEVO/i.test(line)) logHealth.poolsDetected++;
        if (/SELL BURST.*emergency/i.test(line)) logHealth.sellBursts++;
        if (/SELL BURST but reserve OK|SELL BURST but NO RESERVE/i.test(line)) logHealth.sellBurstIgnored++;
      }
    }
  } catch {}

  db.close();

  // ═══════ OUTPUT ═══════
  console.log('╔══════════════════════════════════════════╗');
  console.log('║          BOT STATUS REPORT               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // Bot & Balance
  console.log(`Bot:     ${botRunning ? '🟢 RUNNING (PID ' + botPid + ')' : '🔴 STOPPED'}`);
  console.log(`Balance: ${balance != null ? formatSol(balance) + ' SOL' : '⚠️ Could not read'}`);
  console.log(`Log:     ${logHealth.logFile || 'N/A'} (age: ${logHealth.lastLogAge != null ? logHealth.lastLogAge + 's' : '?'})`);
  console.log();

  // Open Positions
  console.log(`═══ OPEN POSITIONS (${openPositions.length}) ═══`);
  if (openPositions.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of openPositions) {
      const age = timeSince(p.opened_at);
      const mult = p.peak_multiplier ? p.peak_multiplier.toFixed(3) + 'x' : '?';
      const tpHit = p.tp_levels_hit ? JSON.parse(p.tp_levels_hit).length : 0;
      console.log(`  ${shortenMint(p.token_mint)} | ${formatPct(p.pnl_pct)} | peak=${mult} | TP=${tpHit} | score=${p.security_score} | ${age} | sells=${p.sell_successes}/${p.sell_attempts} | lat=${p.entry_latency_ms ? Math.round(p.entry_latency_ms / 1000) + 's' : '?'}`);
    }
  }
  console.log();

  // Recent Trades
  console.log('═══ RECENT TRADES ═══');
  for (const t of recentTrades) {
    const result = (t.pnl_pct || -100) <= -80 ? '❌RUG ' : (t.pnl_pct || 0) > 5 ? '✅WIN ' : '➖LOSS';
    const dur = t.closed_at && t.opened_at ? timeSince(t.opened_at).replace(/[a-z]/g, '') + '->' + timeSince(t.closed_at) : '?';
    const peak = t.peak_multiplier ? t.peak_multiplier.toFixed(2) + 'x' : '-';
    const lat = t.entry_latency_ms ? Math.round(t.entry_latency_ms / 1000) + 's' : '?';
    console.log(`  ${shortenMint(t.token_mint)} ${result} ${formatPct(t.pnl_pct)} | peak=${peak} | s=${t.security_score} | sells=${t.sell_successes}/${t.sell_attempts} | ${t.exit_reason || '?'} | lat=${lat} | ${t.bot_version}`);
  }
  console.log();

  // Session Stats
  if (sessionStats && sessionStats.total > 0) {
    const wr = sessionStats.total > 0 ? ((sessionStats.wins / sessionStats.total) * 100).toFixed(0) : '0';
    const sellRate = sessionStats.total_sell_attempts > 0 ? ((sessionStats.total_sell_successes / sessionStats.total_sell_attempts) * 100).toFixed(0) : '-';
    console.log('═══ TODAY ═══');
    console.log(`  Trades: ${sessionStats.total} | Wins: ${sessionStats.wins} (${wr}%) | Rugs: ${sessionStats.rugs} | Losses: ${sessionStats.losses}`);
    console.log(`  Net PnL: ${formatSol(sessionStats.net_pnl)} SOL | Avg latency: ${sessionStats.avg_latency_ms ? Math.round(sessionStats.avg_latency_ms / 1000) + 's' : '?'}`);
    console.log(`  Sell rate: ${sellRate}% (${sessionStats.total_sell_successes}/${sessionStats.total_sell_attempts})`);
    console.log();
  }

  // Log Health
  console.log(`═══ LOG HEALTH (last ${LOG_SCAN_LINES} lines) ═══`);
  console.log(`  Pools detected: ${logHealth.poolsDetected} | Buys: ${logHealth.buySuccess}`);
  console.log(`  Errors: ${logHealth.errors} | 429s: ${logHealth.warns429} | Sell fails: ${logHealth.sellFails}`);
  console.log(`  Sell bursts: ${logHealth.sellBursts} triggered, ${logHealth.sellBurstIgnored} correctly ignored`);

  // Alerts
  const alerts = [];
  if (!botRunning) alerts.push('🔴 Bot is NOT running');
  if (balance != null && balance < 0.005) alerts.push('⚠️ LOW BALANCE: ' + formatSol(balance) + ' SOL');
  if (logHealth.sellFails > 2) alerts.push('🚨 Multiple sell failures (' + logHealth.sellFails + ')');
  if (logHealth.warns429 > 5) alerts.push('⚠️ Heavy 429 rate limiting (' + logHealth.warns429 + ')');
  if (logHealth.lastLogAge != null && logHealth.lastLogAge > 120 && botRunning) alerts.push('⚠️ Log stale (' + logHealth.lastLogAge + 's old) in ' + (logHealth.logFile || '?') + ' — bot may be hung');
  if (openPositions.some(p => (p.pnl_pct || 0) < -25)) alerts.push('🚨 Position with >25% loss');
  if (openPositions.some(p => p.sell_attempts > 0 && p.sell_successes === 0)) alerts.push('🚨 Failed sell attempt on open position');

  if (alerts.length > 0) {
    console.log();
    console.log('═══ ⚡ ALERTS ═══');
    for (const a of alerts) console.log('  ' + a);
  }
}

main().catch(e => {
  console.error('Status script error:', e.message);
  process.exit(1);
});
