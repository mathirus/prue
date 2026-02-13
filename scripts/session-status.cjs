const db = require('better-sqlite3')('data/bot.db');
const cutoff = Date.now() - 24 * 60 * 60 * 1000;

console.log('=== SESSION STATUS ===\n');

// Today's closed trades
const today = db.prepare(`
  SELECT COUNT(*) as trades,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
    ROUND(SUM(pnl_sol), 6) as total_pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl
  FROM positions WHERE status IN ('closed', 'stopped')
  AND opened_at > ?
`).get(cutoff);
console.log('Today closed trades:', JSON.stringify(today, null, 2));

// By version
const byVer = db.prepare(`
  SELECT bot_version as ver, COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions WHERE status IN ('closed', 'stopped')
  AND opened_at > ?
  GROUP BY bot_version
`).all(cutoff);
console.log('\nBy version:', JSON.stringify(byVer));

// Active positions
const now = Date.now();
const active = db.prepare(`
  SELECT substr(token_mint, 1, 12) as tok, status,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pnl_pct,
    ROUND(peak_multiplier, 3) as peak,
    ROUND((? - opened_at) / 60000.0, 1) as age_min,
    tp_levels_hit, bot_version, sell_attempts, sell_successes
  FROM positions WHERE status IN ('open', 'partial_close')
  ORDER BY opened_at DESC
`).all(now);
console.log('\nActive positions:');
active.forEach(p => {
  console.log(`  ${p.tok} | ${p.status} | pnl=${p.pnl} SOL (${p.pnl_pct}%) | peak=${p.peak}x | age=${p.age_min}min | TP=${p.tp_levels_hit} | sells=${p.sell_attempts}/${p.sell_successes}`);
});

// Recent closed v8p trades
const recentV8p = db.prepare(`
  SELECT substr(token_mint, 1, 12) as tok, status,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pnl_pct,
    exit_reason, ROUND(peak_multiplier, 3) as peak,
    ROUND((closed_at - opened_at) / 1000.0, 0) as duration_s,
    sell_attempts, sell_successes
  FROM positions WHERE bot_version = 'v8p'
  ORDER BY opened_at DESC
`).all();
console.log('\nAll v8p positions:');
recentV8p.forEach(p => {
  const dur = p.duration_s ? `${p.duration_s}s` : 'active';
  console.log(`  ${p.tok} | ${p.status} | pnl=${p.pnl} SOL (${p.pnl_pct}%) | peak=${p.peak}x | exit=${p.exit_reason || '-'} | dur=${dur}`);
});

// v8p pipeline funnel
const funnel = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN dp_rejection_stage = 'security_check' THEN 1 ELSE 0 END) as rej_security,
    SUM(CASE WHEN dp_rejection_stage = 'observation' THEN 1 ELSE 0 END) as rej_obs,
    SUM(CASE WHEN dp_rejection_stage = 'wash_trading' THEN 1 ELSE 0 END) as rej_wash,
    SUM(CASE WHEN dp_rejection_stage = 'max_concurrent' THEN 1 ELSE 0 END) as rej_concurrent,
    SUM(CASE WHEN dp_rejection_stage = 'creator_history' THEN 1 ELSE 0 END) as rej_creator,
    SUM(CASE WHEN dp_rejection_stage IS NULL THEN 1 ELSE 0 END) as passed
  FROM detected_pools WHERE bot_version = 'v8p'
`).get();
console.log('\nv8p Pipeline Funnel:');
console.log(`  Total pools: ${funnel.total}`);
console.log(`  Rejected at security_check: ${funnel.rej_security} (${(100*funnel.rej_security/funnel.total).toFixed(1)}%)`);
console.log(`  Rejected at observation: ${funnel.rej_obs}`);
console.log(`  Rejected at wash_trading: ${funnel.rej_wash}`);
console.log(`  Rejected at max_concurrent: ${funnel.rej_concurrent}`);
console.log(`  Rejected at creator: ${funnel.rej_creator}`);
console.log(`  PASSED (traded): ${funnel.passed} (${(100*funnel.passed/funnel.total).toFixed(1)}%)`);

// Check v8o+v8p combined (today's strategy)
const combined = db.prepare(`
  SELECT
    SUM(CASE WHEN bot_version IN ('v8o', 'v8p') THEN 1 ELSE 0 END) as new_trades,
    SUM(CASE WHEN bot_version IN ('v8o', 'v8p') AND pnl_sol > 0 THEN 1 ELSE 0 END) as new_wins,
    ROUND(SUM(CASE WHEN bot_version IN ('v8o', 'v8p') THEN pnl_sol ELSE 0 END), 6) as new_pnl,
    SUM(CASE WHEN bot_version NOT IN ('v8o', 'v8p') THEN 1 ELSE 0 END) as old_trades,
    SUM(CASE WHEN bot_version NOT IN ('v8o', 'v8p') AND pnl_sol > 0 THEN 1 ELSE 0 END) as old_wins,
    ROUND(SUM(CASE WHEN bot_version NOT IN ('v8o', 'v8p') THEN pnl_sol ELSE 0 END), 6) as old_pnl
  FROM positions WHERE status IN ('closed', 'stopped') AND opened_at > ?
`).get(cutoff);
console.log('\nToday v8o+v8p vs older:');
console.log(`  v8o+v8p: ${combined.new_trades} trades, ${combined.new_wins} wins, ${combined.new_pnl} SOL`);
console.log(`  Older: ${combined.old_trades} trades, ${combined.old_wins} wins, ${combined.old_pnl} SOL`);

// Rejected tokens summary
const rejReasons = db.prepare(`
  SELECT rejection_reasons, COUNT(*) as n
  FROM detected_pools
  WHERE bot_version = 'v8p' AND dp_rejection_stage = 'security_check'
  GROUP BY rejection_reasons
  ORDER BY n DESC LIMIT 10
`).all();
console.log('\nTop rejection reasons (v8p):');
rejReasons.forEach(r => console.log(`  ${r.n}x: ${r.rejection_reasons}`));

// Missed opportunities (max_concurrent blocks)
const missed = db.prepare(`
  SELECT COUNT(*) as n
  FROM detected_pools
  WHERE bot_version = 'v8p' AND dp_rejection_stage = 'max_concurrent'
`).get();
console.log(`\nMissed due to max_concurrent: ${missed.n}`);

db.close();
