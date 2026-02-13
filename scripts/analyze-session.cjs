const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// V8e session analysis - trades since 16:00 Feb 8
const since = Date.now() - 3 * 3600 * 1000; // 3 hours ago

console.log('=== REJECTED TOKENS WITH KNOWN OUTCOMES (last 3h) ===');
const rejected = db.prepare(`
  SELECT pool_outcome, COUNT(*) as n
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0
    AND pool_outcome IS NOT NULL AND pool_outcome != 'unknown'
  GROUP BY pool_outcome
`).all(since);
console.log(rejected);

// Top rejected that survived (potential missed opportunities)
console.log('\n=== REJECTED SURVIVORS (missed opportunities?) ===');
const survivors = db.prepare(`
  SELECT base_mint, security_score, rejection_reasons,
    dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
    dp_honeypot_verified, dp_mint_auth_revoked, dp_freeze_auth_revoked,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as detected
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0 AND pool_outcome = 'survivor'
  ORDER BY security_score DESC
  LIMIT 20
`).all(since);
console.log('Survived but rejected:', survivors.length);
survivors.forEach(s => console.log(
  s.base_mint?.slice(0, 8), 'score:', s.security_score,
  'liq:', Math.round(s.dp_liquidity_usd || 0),
  'holders:', s.dp_holder_count, 'top:', s.dp_top_holder_pct,
  'reasons:', s.rejection_reasons?.slice(0, 80),
  s.detected
));

// Passed tokens with outcome
console.log('\n=== PASSED TOKENS WITH OUTCOMES (last 3h) ===');
const passed = db.prepare(`
  SELECT base_mint, security_score, pool_outcome,
    dp_liquidity_usd, dp_holder_count,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as detected
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 1
  ORDER BY detected_at DESC
  LIMIT 20
`).all(since);
console.log('Passed:', passed.length);
passed.forEach(p => console.log(
  p.base_mint?.slice(0, 8), 'score:', p.security_score,
  'outcome:', p.pool_outcome || 'unknown',
  'liq:', Math.round(p.dp_liquidity_usd || 0), 'holders:', p.dp_holder_count,
  p.detected
));

// Score distribution of all detected in last 3h
console.log('\n=== SCORE DISTRIBUTION (last 3h) ===');
const scores = db.prepare(`
  SELECT
    CASE WHEN security_score >= 85 THEN '85+'
         WHEN security_score >= 80 THEN '80-84'
         WHEN security_score >= 70 THEN '70-79'
         WHEN security_score >= 50 THEN '50-69'
         ELSE '<50' END as bracket,
    COUNT(*) as total,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors
  FROM detected_pools
  WHERE detected_at > ?
  GROUP BY bracket ORDER BY bracket DESC
`).all(since);
scores.forEach(s => console.log(s));

// V8e trade summary
console.log('\n=== V8E TRADE SUMMARY (since 16:07) ===');
const v8eSince = new Date('2026-02-08T16:07:00').getTime();
const v8eTrades = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN pnl_pct BETWEEN -80 AND 0 THEN 1 ELSE 0 END) as losses,
    SUM(CASE WHEN status IN ('open','partial_close') THEN 1 ELSE 0 END) as active,
    ROUND(SUM(pnl_sol), 6) as total_pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(100.0 * SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
    ROUND(100.0 * SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) / COUNT(*), 1) as rug_rate
  FROM positions
  WHERE opened_at > ?
`).get(v8eSince);
console.log(v8eTrades);

// Detailed v8e trades
console.log('\n=== V8E DETAILED TRADES ===');
const details = db.prepare(`
  SELECT token_mint, security_score, ROUND(pnl_pct,1) as pnl, ROUND(pnl_sol,6) as sol,
    status, tp_levels_hit, ROUND(peak_price/NULLIF(entry_price,0),2) as peak,
    ROUND((COALESCE(closed_at, strftime('%s','now')*1000) - opened_at)/60000.0, 1) as dur,
    datetime(opened_at/1000,'unixepoch','localtime') as opened
  FROM positions WHERE opened_at > ?
  ORDER BY opened_at
`).all(v8eSince);
details.forEach(d => console.log(
  d.token_mint?.slice(0,8), 's:'+d.security_score, d.pnl+'%', d.sol+'SOL',
  d.status, 'tp:'+d.tp_levels_hit, 'peak:'+d.peak+'x', d.dur+'min', d.opened
));

// Early exit and breakeven analysis
console.log('\n=== NEW EXIT STRATEGY ANALYSIS ===');
const earlyExits = details.filter(d => d.tp_levels_hit === '[]' && d.dur <= 4 && d.pnl < 0);
console.log('Early exits (no TP, <4min, negative):', earlyExits.length);
earlyExits.forEach(d => console.log('  EARLY EXIT:', d.token_mint?.slice(0,8), d.pnl+'%', d.dur+'min'));

const breakevens = details.filter(d => d.tp_levels_hit.includes('0') && !d.tp_levels_hit.includes('1') && d.pnl < 0 && d.dur <= 5);
console.log('Post-TP breakeven exits:', breakevens.length);
breakevens.forEach(d => console.log('  BREAKEVEN:', d.token_mint?.slice(0,8), d.pnl+'%', d.dur+'min', 'peak:', d.peak+'x'));
