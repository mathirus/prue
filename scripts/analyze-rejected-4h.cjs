const Database = require('better-sqlite3');
const db = new Database('data/bot.db');
const since = Date.now() - 4 * 3600 * 1000; // last 4h

// Rejected tokens that survived (missed opportunities)
console.log('=== REJECTED SURVIVORS (last 4h) ===');
const survivors = db.prepare(`
  SELECT base_mint, security_score, rejection_reasons,
    dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
    dp_honeypot_verified, dp_mint_auth_revoked, dp_freeze_auth_revoked,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as detected
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0 AND pool_outcome = 'survivor'
  ORDER BY security_score DESC LIMIT 20
`).all(since);
console.log('Total:', survivors.length);
survivors.forEach(s => console.log(
  s.base_mint?.slice(0, 8), 'score:', s.security_score,
  'liq:', Math.round(s.dp_liquidity_usd || 0),
  'holders:', s.dp_holder_count, 'top:', s.dp_top_holder_pct,
  'freeze:', s.dp_freeze_auth_revoked, 'mint:', s.dp_mint_auth_revoked,
  'reasons:', s.rejection_reasons?.slice(0, 120),
  s.detected
));

// What outcome did rejected tokens get?
console.log('\n=== REJECTED OUTCOME DISTRIBUTION (last 4h) ===');
const rejected = db.prepare(`
  SELECT pool_outcome, COUNT(*) as n,
    ROUND(AVG(security_score),1) as avg_score
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0
    AND pool_outcome IS NOT NULL AND pool_outcome != 'unknown'
  GROUP BY pool_outcome
`).all(since);
rejected.forEach(r => console.log(r));

// What about passed tokens?
console.log('\n=== PASSED OUTCOME DISTRIBUTION (last 4h) ===');
const passed = db.prepare(`
  SELECT pool_outcome, COUNT(*) as n,
    ROUND(AVG(security_score),1) as avg_score
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 1
    AND pool_outcome IS NOT NULL AND pool_outcome != 'unknown'
  GROUP BY pool_outcome
`).all(since);
passed.forEach(p => console.log(p));

// Passed tokens we bought
console.log('\n=== PASSED TOKENS (last 4h) ===');
const passedAll = db.prepare(`
  SELECT base_mint, security_score, pool_outcome,
    dp_liquidity_usd, dp_holder_count,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as detected
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 1
  ORDER BY detected_at DESC LIMIT 15
`).all(since);
passedAll.forEach(p => console.log(
  p.base_mint?.slice(0,8), 'score:', p.security_score,
  'outcome:', p.pool_outcome || 'pending',
  'liq:', Math.round(p.dp_liquidity_usd || 0), 'holders:', p.dp_holder_count,
  p.detected
));

// Score distribution of rejected survivors
console.log('\n=== REJECTED SURVIVOR SCORE BRACKETS ===');
const brackets = db.prepare(`
  SELECT
    CASE WHEN security_score >= 75 THEN '75+'
         WHEN security_score >= 70 THEN '70-74'
         WHEN security_score >= 60 THEN '60-69'
         WHEN security_score >= 50 THEN '50-59'
         ELSE '<50' END as bracket,
    COUNT(*) as survivors,
    GROUP_CONCAT(SUBSTR(base_mint,1,8)) as tokens
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0 AND pool_outcome = 'survivor'
  GROUP BY bracket ORDER BY bracket DESC
`).all(since);
brackets.forEach(b => console.log(b.bracket, ':', b.survivors, 'survivors'));

// Top rejection reasons
console.log('\n=== TOP REJECTION REASONS (last 4h) ===');
const reasons = db.prepare(`
  SELECT rejection_reasons, COUNT(*) as n,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survs
  FROM detected_pools
  WHERE detected_at > ? AND security_passed = 0
    AND rejection_reasons IS NOT NULL
  GROUP BY rejection_reasons ORDER BY n DESC LIMIT 10
`).all(since);
reasons.forEach(r => console.log('N:', r.n, 'rugs:', r.rugs, 'survs:', r.survs, '|', r.rejection_reasons?.slice(0, 100)));

db.close();
