const db = require('better-sqlite3')('data/bot.db');

// v8o pools
const pools = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, security_score as score, security_passed as p,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as h, dp_graduation_time_s as grad,
    rejection_reasons as rej, datetime(detected_at/1000, 'unixepoch', 'localtime') as dt
  FROM detected_pools WHERE bot_version = 'v8o' ORDER BY detected_at DESC LIMIT 20
`).all();

const total = db.prepare("SELECT COUNT(*) as n FROM detected_pools WHERE bot_version='v8o'").get();
const passed = db.prepare("SELECT COUNT(*) as n FROM detected_pools WHERE bot_version='v8o' AND security_passed=1").get();

console.log('=== v8o POOLS (' + total.n + ' total, ' + passed.n + ' passed) ===');
pools.forEach(r => {
  const g = r.grad != null && r.grad >= 0 ? Math.round(r.grad / 60) + 'min' : '?';
  console.log(r.dt + ' | ' + r.tok + ' | score=' + r.score + (r.p ? ' PASS' : ' REJ') +
    ' | $' + r.liq + ' | h=' + r.h + ' | grad=' + g + ' | ' + (r.rej || ''));
});

// v8o positions
console.log('\n=== v8o POSITIONS ===');
const positions = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, status, ROUND(pnl_sol,6) as pnl,
    ROUND(pnl_pct,1) as pct, security_score as score,
    ROUND(liquidity_usd,0) as liq, holder_count as h, exit_reason,
    ROUND(peak_multiplier,3) as peak, sell_attempts, sell_successes,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened,
    datetime(closed_at/1000, 'unixepoch', 'localtime') as closed
  FROM positions WHERE bot_version = 'v8o' ORDER BY opened_at DESC
`).all();

if (positions.length === 0) {
  console.log('  (no positions yet)');
} else {
  positions.forEach(r => {
    const dur = r.closed ? '' : ' (ACTIVE)';
    console.log(r.opened + ' | ' + r.tok + ' | ' + r.status + dur + ' | score=' + r.score +
      ' | $' + r.liq + ' | h=' + r.h + ' | peak=' + r.peak + 'x | ' +
      (r.exit_reason || 'active') + ' | ' + r.pnl + ' SOL (' + r.pct + '%)' +
      (r.sell_attempts ? ' | sells=' + r.sell_successes + '/' + r.sell_attempts : ''));
  });
}

// Summary
const pnl = positions.reduce((s, r) => s + (r.pnl || 0), 0);
const wins = positions.filter(r => r.pnl > 0).length;
const closed = positions.filter(r => r.status !== 'open').length;
console.log('\nv8o summary: ' + positions.length + ' trades, ' + wins + ' wins, ' + closed + ' closed, PnL=' + pnl.toFixed(6) + ' SOL');

// Balance
try {
  const bal = db.prepare("SELECT ROUND(balance_sol,6) as b FROM session_stats ORDER BY updated_at DESC LIMIT 1").get();
  if (bal) console.log('Balance: ' + bal.b + ' SOL');
} catch {}

db.close();
