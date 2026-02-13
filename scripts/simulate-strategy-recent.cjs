#!/usr/bin/env node
/**
 * Same simulation but ONLY last 4-5 days of trades (more representative of current bot)
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const TRADE_SIZE = 0.1;
const FEE = 0.0024;

const DAYS_BACK = 5;
const cutoff = Date.now() - DAYS_BACK * 24 * 3600 * 1000;

const trades = db.prepare(`
  SELECT p.token_mint, p.security_score, p.pnl_pct, p.pnl_sol,
    p.exit_reason, p.peak_multiplier, p.sol_invested, p.opened_at,
    p.bot_version, p.sell_attempts, p.sell_successes,
    d.dp_liquidity_usd, d.dp_top_holder_pct, d.dp_holder_count,
    d.dp_graduation_time_s, tc.wallet_age_seconds
  FROM positions p
  LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
  LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
  WHERE p.closed_at IS NOT NULL AND p.opened_at > ?
  ORDER BY p.opened_at ASC
`).all(cutoff);

console.log(`SIMULACION ULTIMOS ${DAYS_BACK} DIAS (desde ${new Date(cutoff).toISOString().substring(0,10)})`);
console.log(`Trades: ${trades.length}\n`);

// Show all trades first
console.log('='.repeat(140));
console.log('  TODOS LOS TRADES RECIENTES');
console.log('='.repeat(140));
console.log(
  'Token'.padEnd(12) + '| ' +
  'Ver'.padEnd(6) + '| ' +
  'Score'.padStart(5) + ' | ' +
  'Liq$'.padStart(7) + ' | ' +
  'TopH%'.padStart(6) + ' | ' +
  'Peak'.padStart(6) + ' | ' +
  'Exit'.padEnd(22) + '| ' +
  'PnL%'.padStart(7) + ' | ' +
  'Sells'.padStart(5) + ' | ' +
  'Fecha'
);
console.log('-'.repeat(140));

for (const t of trades) {
  const peak = t.peak_multiplier || 0;
  const pnl = t.pnl_pct || 0;
  const isRug = (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot');
  const date = new Date(t.opened_at).toISOString().substring(5, 16).replace('T', ' ');
  console.log(
    t.token_mint.substring(0, 10).padEnd(12) + '| ' +
    (t.bot_version || '?').padEnd(6) + '| ' +
    String(t.security_score || '?').padStart(5) + ' | ' +
    ('$' + (t.dp_liquidity_usd || 0).toFixed(0)).padStart(7) + ' | ' +
    ((t.dp_top_holder_pct || 0).toFixed(0) + '%').padStart(6) + ' | ' +
    (peak.toFixed(2) + 'x').padStart(6) + ' | ' +
    (t.exit_reason || '?').substring(0, 20).padEnd(22) + '| ' +
    ((pnl > 0 ? '+' : '') + pnl.toFixed(0) + '%').padStart(7) + ' | ' +
    ((t.sell_attempts || 0) + '/' + (t.sell_successes || 0)).padStart(5) + ' | ' +
    date +
    (isRug ? ' *** RUG' : '')
  );
}

// Data quality
const withPeak = trades.filter(t => (t.peak_multiplier || 0) > 0);
console.log(`\nCon peak_multiplier real: ${withPeak.length}/${trades.length} (${(withPeak.length/trades.length*100).toFixed(0)}%)`);

function wouldHitTP(t, tpPct) {
  const tpTarget = 1 + tpPct / 100;
  const peak = t.peak_multiplier || 0;
  const pnl = t.pnl_pct || 0;
  if (peak >= tpTarget) return true;
  if (peak === 0 && pnl >= tpPct) return true;
  return false;
}

function simulate(label, filterFn, tpPct) {
  const tpGain = TRADE_SIZE * (tpPct / 100) - FEE;
  const passed = trades.filter(filterFn);
  let totalPnl = 0, wins = 0, losses = 0, rugs = 0, tp1Hits = 0;
  let rugLoss = 0, normalLoss = 0, tpWin = 0;

  for (const t of passed) {
    const isRug = (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot');
    let tradePnl;

    if (wouldHitTP(t, tpPct)) {
      tradePnl = tpGain;
      tp1Hits++;
      wins++;
      tpWin += tradePnl;
    } else if (isRug) {
      const lossPct = Math.abs(t.pnl_pct || 100) / 100;
      tradePnl = -TRADE_SIZE * Math.min(1, lossPct) - FEE;
      rugs++;
      losses++;
      rugLoss += tradePnl;
    } else {
      const pnlRatio = (t.pnl_pct || 0) / 100;
      tradePnl = TRADE_SIZE * pnlRatio - FEE;
      if (tradePnl > 0) { wins++; tpWin += tradePnl; }
      else { losses++; normalLoss += tradePnl; }
    }
    totalPnl += tradePnl;
  }

  return { label, total: passed.length, tp1Hits, rugs, wins, losses, totalPnl, rugLoss, normalLoss, tpWin };
}

// Main simulation table
console.log('\n' + '='.repeat(120));
console.log('  SIMULACION: 0.1 SOL/trade, distintos filtros y TPs');
console.log('='.repeat(120));

const filters = [
  ['Sin filtro extra (actual)', t => true],
  ['Liq >= $10K', t => (t.dp_liquidity_usd || 0) >= 10000],
  ['Liq >= $15K', t => (t.dp_liquidity_usd || 0) >= 15000],
  ['Liq >= $20K', t => (t.dp_liquidity_usd || 0) >= 20000],
  ['Score>=75 Liq>=$15K', t => (t.security_score||0) >= 75 && (t.dp_liquidity_usd||0) >= 15000],
  ['Score>=80 Liq>=$20K', t => (t.security_score||0) >= 80 && (t.dp_liquidity_usd||0) >= 20000],
];

for (const tpPct of [10, 15, 20, 25, 30]) {
  const tpGain = TRADE_SIZE * (tpPct / 100) - FEE;
  console.log(`\n--- TP = ${tpPct}% (gain/hit = +${tpGain.toFixed(4)} SOL, 1 rug = ${Math.ceil((TRADE_SIZE+FEE)/tpGain)} wins) ---`);
  console.log(
    'Config'.padEnd(30) + '| ' +
    'N'.padStart(4) + ' | ' +
    'TP hits'.padStart(7) + ' | ' +
    'Rugs'.padStart(4) + ' | ' +
    'Losses'.padStart(6) + ' | ' +
    'Win%'.padStart(5) + ' | ' +
    'PnL SOL'.padStart(10) + ' | ' +
    'Breakdown'
  );
  console.log('-'.repeat(120));

  for (const [label, fn] of filters) {
    const r = simulate(label, fn, tpPct);
    const winPct = (r.wins / Math.max(r.total, 1) * 100).toFixed(0);
    console.log(
      label.padEnd(30) + '| ' +
      String(r.total).padStart(4) + ' | ' +
      (String(r.tp1Hits) + '(' + (r.tp1Hits/Math.max(r.total,1)*100).toFixed(0) + '%)').padStart(7) + ' | ' +
      String(r.rugs).padStart(4) + ' | ' +
      String(r.losses - r.rugs).padStart(6) + ' | ' +
      (winPct + '%').padStart(5) + ' | ' +
      ((r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(4)).padStart(10) + ' | ' +
      `wins=${r.tpWin.toFixed(3)} rugs=${r.rugLoss.toFixed(3)} norm=${r.normalLoss.toFixed(3)}`
    );
  }
}

// What SL would make it work?
console.log('\n' + '='.repeat(120));
console.log('  ¿QUE STOP LOSS NECESITAS? (TP=20%, Score>=80 Liq>=$20K, datos recientes)');
console.log('='.repeat(120));

const bestFilter = t => (t.security_score||0) >= 80 && (t.dp_liquidity_usd||0) >= 20000;
const bestTrades = trades.filter(bestFilter);

for (const slPct of [5, 10, 15, 20, 25, 30]) {
  const tpPct = 20;
  const tpGain = TRADE_SIZE * (tpPct / 100) - FEE;
  let pnl = 0, wins = 0, losses = 0;

  for (const t of bestTrades) {
    const isRug = (t.exit_reason||'').includes('rug') || (t.exit_reason||'').includes('honeypot');

    if (wouldHitTP(t, tpPct)) {
      pnl += tpGain;
      wins++;
    } else if (isRug) {
      // Rug: lose everything regardless of SL
      pnl += -TRADE_SIZE - FEE;
      losses++;
    } else {
      // Normal loss: cap at SL
      const actualLoss = Math.abs(t.pnl_pct || 0);
      const cappedLoss = Math.min(actualLoss, slPct) / 100;
      pnl += -TRADE_SIZE * cappedLoss - FEE;
      losses++;
    }
  }

  console.log(
    `  SL=${(slPct+'%').padStart(4)}: ` +
    `PnL=${(pnl>=0?'+':'') + pnl.toFixed(4)} SOL | ` +
    `${wins}W/${losses}L` +
    (pnl >= 0 ? ' ← PROFITABLE' : '')
  );
}

db.close();
console.log('\nDone.');
