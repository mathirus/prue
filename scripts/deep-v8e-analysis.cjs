const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// QUESTION 1: Are there actually profitable tokens we're missing?
// Check if rejected survivors with score 70-79 would have been profitable
console.log('=== Q1: REJECTED SURVIVORS WITH SCORE 70-79 ===');
console.log('These are the "closest misses" - tokens near our threshold\n');

const since = Date.now() - 6 * 3600 * 1000;
const closeMisses = db.prepare(`
  SELECT base_mint, security_score, rejection_reasons,
    ROUND(dp_liquidity_usd) as liq, dp_holder_count as holders,
    ROUND(dp_top_holder_pct,1) as top_pct,
    dp_freeze_auth_revoked as freeze, dp_mint_auth_revoked as mint
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0 AND pool_outcome = 'survivor'
    AND security_score BETWEEN 70 AND 79
  ORDER BY security_score DESC
`).all(since);
console.log('Close misses (70-79):', closeMisses.length);
closeMisses.forEach(s => console.log(
  s.base_mint?.slice(0, 8), 'score:', s.security_score,
  'liq:$' + s.liq, 'holders:', s.holders, 'top:', s.top_pct + '%',
  'freeze:', s.freeze ? 'OK' : 'BAD', 'mint:', s.mint ? 'OK' : 'BAD',
  '| reasons:', s.rejection_reasons
));

// QUESTION 2: What's the biggest PnL driver? TP levels analysis
console.log('\n=== Q2: V8E PNL BY TP OUTCOME ===');
const v8eSince = new Date('2026-02-08T16:07:00').getTime();
const byTP = db.prepare(`
  SELECT tp_levels_hit,
    COUNT(*) as n,
    ROUND(AVG(pnl_pct),1) as avg_pnl,
    ROUND(SUM(pnl_sol),6) as total_sol
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
  GROUP BY tp_levels_hit
`).all(v8eSince);
byTP.forEach(t => console.log('TP:', t.tp_levels_hit, 'N:', t.n, 'avg:', t.avg_pnl + '%', 'total:', t.total_sol + ' SOL'));

// QUESTION 3: Post-TP breakeven floor - did it fire?
console.log('\n=== Q3: POST-TP BREAKEVEN FLOOR EFFECTIVENESS ===');
const postTPdrops = db.prepare(`
  SELECT token_mint, ROUND(pnl_pct,1) as pnl, ROUND(pnl_sol,6) as sol,
    tp_levels_hit, ROUND(peak_price/NULLIF(entry_price,0),2) as peak_x,
    ROUND((closed_at - opened_at)/60000.0,1) as dur_min
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
    AND tp_levels_hit LIKE '%0%' AND pnl_pct < 5
  ORDER BY pnl_pct
`).all(v8eSince);
console.log('TP1+ trades that ended below +5%:', postTPdrops.length);
postTPdrops.forEach(d => console.log(
  d.token_mint?.slice(0,8), 'pnl:', d.pnl + '%', d.sol + ' SOL',
  'peak:', d.peak_x + 'x', 'dur:', d.dur_min + 'min', 'tp:', d.tp_levels_hit
));

// QUESTION 4: Early exit trades - did they save us?
console.log('\n=== Q4: EARLY EXITS (NO TP, <4min) ===');
const earlyExits = db.prepare(`
  SELECT token_mint, ROUND(pnl_pct,1) as pnl, ROUND(pnl_sol,6) as sol,
    tp_levels_hit, ROUND(peak_price/NULLIF(entry_price,0),2) as peak_x,
    ROUND((closed_at - opened_at)/60000.0,1) as dur_min
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
    AND tp_levels_hit = '[]' AND (closed_at - opened_at) < 240000
  ORDER BY opened_at
`).all(v8eSince);
console.log('Early exits:', earlyExits.length);
earlyExits.forEach(d => console.log(
  d.token_mint?.slice(0,8), 'pnl:', d.pnl + '%', d.sol + ' SOL',
  'peak:', d.peak_x + 'x', 'dur:', d.dur_min + 'min'
));

// QUESTION 5: Score 80 vs 85+ performance in v8e
console.log('\n=== Q5: SCORE 80 vs 85+ IN V8E ===');
const by80 = db.prepare(`
  SELECT
    CASE WHEN security_score >= 85 THEN '85+' ELSE '80-84' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol),6) as total_sol,
    ROUND(AVG(pnl_pct),1) as avg_pnl
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
  GROUP BY bracket
`).all(v8eSince);
by80.forEach(b => console.log(b));

// QUESTION 6: TP2@1.5x effect - how many trades benefited?
console.log('\n=== Q6: TP2 TRIGGERS (trades that hit TP2@1.5x) ===');
const tp2hits = db.prepare(`
  SELECT token_mint, ROUND(pnl_pct,1) as pnl, ROUND(pnl_sol,6) as sol,
    tp_levels_hit, ROUND(peak_price/NULLIF(entry_price,0),2) as peak_x
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
    AND tp_levels_hit LIKE '%1%'
  ORDER BY pnl_pct DESC
`).all(v8eSince);
console.log('TP2 hits:', tp2hits.length);
tp2hits.forEach(d => console.log(
  d.token_mint?.slice(0,8), 'pnl:', d.pnl + '%', d.sol + ' SOL',
  'peak:', d.peak_x + 'x', 'tp:', d.tp_levels_hit
));

db.close();
