const db = require('better-sqlite3')('data/bot.db');

// All closed trades with exit data (v8g+ has exit_reason, peak data)
console.log('=== EXIT QUALITY ANALYSIS ===\n');

// 1. v8o trades - detailed exit analysis
console.log('--- v8o TRADES (current version) ---');
const v8o = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, token_mint, pool_address,
    ROUND(pnl_sol,6) as pnl, ROUND(pnl_pct,1) as pct,
    ROUND(peak_multiplier,4) as peak, ROUND(entry_price,12) as entry,
    ROUND((closed_at - opened_at)/1000.0,0) as hold_sec,
    ROUND(time_to_peak_ms/1000.0,0) as peak_sec,
    exit_reason, ROUND(liquidity_usd,0) as liq,
    sell_attempts, sell_successes,
    post_sell_max_multiplier as post_max,
    post_sell_dex_price_usd as dex_price,
    post_sell_dex_change_24h as dex_24h,
    post_sell_dex_fdv as dex_fdv,
    post_sell_check_count as checks,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions WHERE bot_version = 'v8o' AND status IN ('closed','stopped')
  ORDER BY opened_at ASC
`).all();

v8o.forEach(r => {
  const exitMult = 1 + r.pct / 100;
  const capturedPct = r.peak > 1 ? ((exitMult - 1) / (r.peak - 1) * 100) : 0;
  const peakToExit = r.peak > 0 ? ((r.peak - exitMult) / exitMult * 100) : 0;

  console.log(`  ${r.opened} | ${r.tok} | $${r.liq}`);
  console.log(`    Entry→Peak: ${r.peak}x in ${r.peak_sec}s | Hold: ${r.hold_sec}s`);
  console.log(`    Exit: ${exitMult.toFixed(4)}x (${r.pct}%) | ${r.exit_reason}`);
  console.log(`    Peak captured: ${capturedPct.toFixed(0)}% of max move | Left on table: ${peakToExit.toFixed(1)}%`);
  if (r.post_max) {
    console.log(`    POST-SELL: max=${r.post_max.toFixed(2)}x | dex_price=$${r.dex_price} | dex_24h=${r.dex_24h}% | fdv=$${Math.round(r.dex_fdv||0)}`);
  } else {
    console.log(`    POST-SELL: not checked yet (scheduled at 1h/4h/24h)`);
  }
  console.log('');
});

// 2. Compare with older trades (same exit_reason=timeout)
console.log('--- TIMEOUT TRADES COMPARISON (all versions, Feb 8-9) ---');
const cutoff = new Date('2026-02-08T00:00:00').getTime();
const timeouts = db.prepare(`
  SELECT COALESCE(bot_version,'old') as ver,
    substr(token_mint,1,8) as tok,
    ROUND(pnl_pct,1) as pct,
    ROUND(peak_multiplier,4) as peak,
    ROUND((closed_at - opened_at)/1000.0,0) as hold_sec,
    ROUND(time_to_peak_ms/1000.0,0) as peak_sec,
    ROUND(liquidity_usd,0) as liq,
    post_sell_max_multiplier as post_max,
    post_sell_dex_change_24h as dex_24h,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND exit_reason = 'timeout' AND opened_at > ?
  ORDER BY opened_at ASC
`).all(cutoff);

timeouts.forEach(r => {
  const exitMult = 1 + r.pct / 100;
  const capturedPct = r.peak > 1 ? ((exitMult - 1) / (r.peak - 1) * 100) : 0;
  const postStr = r.post_max ? `post=${r.post_max.toFixed(1)}x` : 'post=?';
  const dexStr = r.dex_24h !== null ? `dex24h=${r.dex_24h > 0 ? '+' : ''}${r.dex_24h.toFixed(0)}%` : '';
  console.log(`  ${r.ver.padEnd(4)} | ${r.opened} | ${r.tok} | peak=${r.peak}x | exit=${exitMult.toFixed(3)}x (${r.pct}%) | captured=${capturedPct.toFixed(0)}% | hold=${r.hold_sec}s | $${r.liq} | ${postStr} ${dexStr}`);
});

// 3. Aggregate stats
console.log('\n--- AGGREGATE: Exit quality by version ---');
const versions = ['old', 'v8o'];
for (const ver of versions) {
  const condition = ver === 'old' ? "bot_version IS NULL" : `bot_version = '${ver}'`;
  const stats = db.prepare(`
    SELECT COUNT(*) as n,
      ROUND(AVG(pnl_pct),1) as avg_pct,
      ROUND(AVG(peak_multiplier),4) as avg_peak,
      ROUND(AVG((closed_at - opened_at)/1000.0),0) as avg_hold,
      ROUND(AVG(time_to_peak_ms/1000.0),0) as avg_peak_sec,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
      ROUND(SUM(pnl_sol),6) as total_pnl,
      ROUND(AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END),6) as avg_win,
      ROUND(AVG(CASE WHEN pnl_sol <= 0 THEN pnl_sol END),6) as avg_loss
    FROM positions
    WHERE ${condition} AND status IN ('closed','stopped') AND exit_reason IS NOT NULL AND opened_at > ?
  `).get(cutoff);

  if (stats.n === 0) continue;
  const winRate = Math.round(100 * stats.wins / stats.n);
  const rugRate = Math.round(100 * stats.rugs / stats.n);
  const avgExitMult = 1 + stats.avg_pct / 100;

  console.log(`  ${ver}:`);
  console.log(`    N=${stats.n} | wins=${stats.wins}(${winRate}%) | rugs=${stats.rugs}(${rugRate}%) | PnL=${stats.total_pnl} SOL`);
  console.log(`    Avg peak=${stats.avg_peak}x | Avg exit=${avgExitMult.toFixed(3)}x (${stats.avg_pct}%)`);
  console.log(`    Avg hold=${stats.avg_hold}s | Avg peak_time=${stats.avg_peak_sec}s`);
  console.log(`    Avg win=${stats.avg_win} SOL | Avg loss=${stats.avg_loss} SOL`);
  if (stats.avg_win && stats.avg_loss) {
    const rr = Math.abs(stats.avg_win / stats.avg_loss);
    console.log(`    R:R ratio=${rr.toFixed(2)} (need >1.0 for edge)`);
  }
}

// 4. Missed gains analysis - did tokens moon after we sold?
console.log('\n--- MISSED GAINS: Tokens that went UP after we sold ---');
const missed = db.prepare(`
  SELECT COALESCE(bot_version,'old') as ver,
    substr(token_mint,1,8) as tok,
    ROUND(pnl_pct,1) as pct, exit_reason,
    ROUND(peak_multiplier,3) as our_peak,
    ROUND(post_sell_max_multiplier,2) as post_max,
    ROUND(post_sell_dex_change_24h,0) as dex_24h,
    ROUND(post_sell_dex_fdv,0) as fdv,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND post_sell_max_multiplier IS NOT NULL
    AND opened_at > ?
  ORDER BY post_sell_max_multiplier DESC LIMIT 20
`).all(cutoff);

missed.forEach(r => {
  const mooned = r.post_max > 2 ? ' MOONED' : r.post_max > 1.5 ? ' UP' : '';
  console.log(`  ${r.ver.padEnd(4)} | ${r.opened} | ${r.tok} | exit=${r.exit_reason} | our_peak=${r.our_peak}x | post_sell=${r.post_max}x${mooned} | dex_24h=${r.dex_24h}% | fdv=$${r.fdv}`);
});

db.close();
