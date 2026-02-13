const db = require('better-sqlite3')('data/bot.db');

// Timeout trades are our bread and butter. Let's optimize them.
console.log('=== TIMEOUT TRADE ANALYSIS (Feb 8-9) ===');
const cutoff = new Date('2026-02-08T00:00:00').getTime();

const timeouts = db.prepare(`
  SELECT substr(p.token_mint,1,8) as tok,
    ROUND(p.pnl_sol, 6) as pnl, ROUND(p.pnl_pct, 1) as pct,
    ROUND(p.peak_multiplier, 3) as peak,
    ROUND((p.closed_at - p.opened_at)/1000.0, 0) as hold_sec,
    ROUND(p.liquidity_usd, 0) as liq,
    p.holder_count as holders,
    datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions p
  WHERE p.status IN ('closed','stopped') AND p.exit_reason = 'timeout' AND p.opened_at > ?
  ORDER BY p.peak_multiplier DESC
`).all(cutoff);

console.log(`Total timeout trades: ${timeouts.length}`);
const wins = timeouts.filter(r => r.pnl > 0);
const losses = timeouts.filter(r => r.pnl <= 0);
console.log(`Wins: ${wins.length}, Losses: ${losses.length}`);
console.log(`Total PnL: ${timeouts.reduce((s,r) => s + r.pnl, 0).toFixed(6)} SOL`);

// Peak distribution
console.log('\nPeak distribution (all timeouts):');
const peakBrackets = [
  { min: 0, max: 1.1, label: '<1.1x' },
  { min: 1.1, max: 1.2, label: '1.1-1.2x' },
  { min: 1.2, max: 1.3, label: '1.2-1.3x' },
  { min: 1.3, max: 1.5, label: '1.3-1.5x' },
  { min: 1.5, max: 2.0, label: '1.5-2.0x' },
  { min: 2.0, max: 100, label: '>2.0x' },
];
for (const b of peakBrackets) {
  const inBracket = timeouts.filter(r => r.peak >= b.min && r.peak < b.max);
  if (inBracket.length === 0) continue;
  const pnl = inBracket.reduce((s,r) => s + r.pnl, 0);
  console.log(`  ${b.label.padEnd(10)}: ${inBracket.length} trades, PnL=${pnl.toFixed(6)} SOL, avg PnL=${(pnl/inBracket.length).toFixed(6)}`);
}

// How much profit do we leave on the table?
console.log('\nTimeout exit price vs peak:');
timeouts.forEach(r => {
  const exitMult = 1 + r.pct/100;
  const leftOnTable = r.peak > 0 ? ((r.peak - exitMult) / exitMult * 100).toFixed(1) : '?';
  console.log(`  ${r.opened} | ${r.tok} | peak=${r.peak}x | exit=${exitMult.toFixed(3)}x | left=${leftOnTable}% | ${r.pnl} SOL`);
});

// Trailing stop analysis
console.log('\n=== TRAILING STOP TRADES ===');
const trailing = db.prepare(`
  SELECT substr(token_mint,1,8) as tok,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pct,
    ROUND(peak_multiplier, 3) as peak,
    ROUND((closed_at - opened_at)/1000.0, 0) as hold_sec,
    ROUND(liquidity_usd, 0) as liq,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND exit_reason = 'trailing_stop' AND opened_at > ?
  ORDER BY opened_at DESC
`).all(cutoff);
console.log(`Total trailing stops: ${trailing.length}`);
trailing.forEach(r => {
  console.log(`  ${r.opened} | ${r.tok} | peak=${r.peak}x | exit=${(1+r.pct/100).toFixed(3)}x | ${r.pnl} SOL (${r.pct}%) | hold=${r.hold_sec}s`);
});

// Missed gains (from post_sell data)
console.log('\n=== MISSED GAINS (post-sell max multiplier) ===');
const missedGains = db.prepare(`
  SELECT substr(token_mint,1,8) as tok,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pct,
    ROUND(peak_multiplier, 3) as peak,
    ROUND(post_sell_max_multiplier, 3) as post_max,
    ROUND(post_sell_dex_price_usd, 8) as dex_price,
    ROUND(post_sell_dex_change_24h, 1) as dex_24h,
    ROUND(post_sell_dex_fdv, 0) as dex_fdv,
    exit_reason,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND post_sell_max_multiplier IS NOT NULL AND opened_at > ?
  ORDER BY post_sell_max_multiplier DESC LIMIT 15
`).all(cutoff);
missedGains.forEach(r => {
  const extra = r.post_max > r.peak ? `POST-SELL UP ${r.post_max}x` : `post=${r.post_max}x`;
  console.log(`  ${r.opened} | ${r.tok} | our_peak=${r.peak}x | ${extra} | exit=${r.exit_reason} | ${r.pnl} SOL | dex_24h=${r.dex_24h}%`);
});

db.close();
