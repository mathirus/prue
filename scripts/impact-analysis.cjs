const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// 1. Performance by version
console.log('=== PERFORMANCE BY VERSION ===');
const versions = db.prepare(`
  SELECT bot_version,
    COUNT(*) as trades,
    SUM(CASE WHEN exit_reason LIKE '%rug%' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as honeypots,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_sol), 6) as net_pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(AVG(security_score), 1) as avg_score,
    ROUND(AVG(peak_multiplier), 3) as avg_peak
  FROM positions
  WHERE status = 'closed'
  GROUP BY bot_version
  ORDER BY MIN(opened_at) DESC
`).all();
for (const v of versions) {
  const wr = v.trades > 0 ? (v.wins/v.trades*100).toFixed(0) : 0;
  const rr = v.trades > 0 ? (v.rugs/v.trades*100).toFixed(0) : 0;
  console.log(`  ${(v.bot_version||'null').padEnd(8)} N=${String(v.trades).padEnd(4)} WR=${wr}% RUG=${rr}% HP=${v.honeypots} PnL=${v.net_pnl} avg=${v.avg_pnl} score=${v.avg_score} peak=${v.avg_peak}`);
}

// 2. Score distribution post changes
console.log('\n=== SCORE DISTRIBUTION: v10d+ (post scoring changes) ===');
const scores = db.prepare(`
  SELECT security_score as score, COUNT(*) as n
  FROM detected_pools WHERE bot_version IN ('v10d','v10e','v10f') AND security_score > 0
  GROUP BY security_score ORDER BY security_score
`).all();
for (const p of scores) console.log(`  score=${p.score}: N=${p.n}`);

// 3. Shadow rug rate pre vs post
console.log('\n=== SHADOW: RUG RATE PRE vs POST ===');
const shadowPre = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN rug_detected=1 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN peak_multiplier >= 1.2 THEN 1 ELSE 0 END) as tp1
  FROM shadow_positions sp
  JOIN detected_pools dp ON sp.pool_id = dp.id
  WHERE sp.status='closed' AND dp.bot_version IN ('v10c','v10b','v10a')
    AND dp.security_score >= 60
`).get();
const shadowPost = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN rug_detected=1 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN peak_multiplier >= 1.2 THEN 1 ELSE 0 END) as tp1
  FROM shadow_positions sp
  JOIN detected_pools dp ON sp.pool_id = dp.id
  WHERE sp.status='closed' AND dp.bot_version IN ('v10d','v10e','v10f')
    AND dp.security_score >= 60
`).get();
const preRR = shadowPre.n > 0 ? (shadowPre.rugs/shadowPre.n*100).toFixed(1) : 'N/A';
const postRR = shadowPost.n > 0 ? (shadowPost.rugs/shadowPost.n*100).toFixed(1) : 'N/A';
const preTp = shadowPre.n > 0 ? (shadowPre.tp1/shadowPre.n*100).toFixed(1) : 'N/A';
const postTp = shadowPost.n > 0 ? (shadowPost.tp1/shadowPost.n*100).toFixed(1) : 'N/A';
console.log(`  PRE  (v10a-c): N=${shadowPre.n}, rugs=${shadowPre.rugs} (${preRR}%), TP1=${shadowPre.tp1} (${preTp}%)`);
console.log(`  POST (v10d-f): N=${shadowPost.n}, rugs=${shadowPost.rugs} (${postRR}%), TP1=${shadowPost.tp1} (${postTp}%)`);

// 4. Rejection columns
const cols = db.prepare('PRAGMA table_info(detected_pools)').all().map(c => c.name);
const rejCol = cols.find(c => c.includes('rejection_r'));
if (rejCol) {
  console.log(`\n=== REJECTIONS BY NEW FEATURES (column: ${rejCol}) ===`);
  const rej = db.prepare(`SELECT ${rejCol} as reason, COUNT(*) as cnt FROM detected_pools WHERE ${rejCol} LIKE '%allenhark%' OR ${rejCol} LIKE '%whale%' OR ${rejCol} LIKE '%velocity%' GROUP BY ${rejCol} ORDER BY cnt DESC`).all();
  if (rej.length === 0) console.log('  (no rejections from new features)');
  for (const r of rej) console.log(`  ${r.reason}: ${r.cnt}`);

  // How many allenhark blocks total?
  const ah = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE ${rejCol} LIKE '%allenhark%'`).get();
  console.log(`  AllenHark total blocks: ${ah.n}`);
}

// 5. Observation bonus impact
console.log('\n=== OBS DROP vs OUTCOME (v10d+) ===');
const obs = db.prepare(`
  SELECT
    CASE WHEN dp.dp_observation_drop_pct IS NULL THEN 'no_obs'
         WHEN dp.dp_observation_drop_pct < 1 THEN 'stable(<1%)'
         WHEN dp.dp_observation_drop_pct BETWEEN 1 AND 3 THEN 'neutral(1-3%)'
         WHEN dp.dp_observation_drop_pct BETWEEN 3 AND 5 THEN 'borderline(3-5%)'
         ELSE 'unstable(>5%)' END as bucket,
    COUNT(*) as n,
    SUM(CASE WHEN sp.rug_detected=1 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN sp.peak_multiplier >= 1.2 THEN 1 ELSE 0 END) as tp1
  FROM shadow_positions sp
  JOIN detected_pools dp ON sp.pool_id = dp.id
  WHERE sp.status='closed' AND dp.bot_version IN ('v10d','v10e','v10f')
    AND dp.security_score >= 60
  GROUP BY bucket
  ORDER BY bucket
`).all();
for (const o of obs) {
  const rr = o.n > 0 ? (o.rugs/o.n*100).toFixed(0) : '?';
  const tp = o.n > 0 ? (o.tp1/o.n*100).toFixed(0) : '?';
  console.log(`  ${o.bucket.padEnd(20)} N=${String(o.n).padEnd(4)} RUG=${rr}% TP1=${tp}%`);
}

// 6. Today's trades
console.log('\n=== TODAY REAL TRADES ===');
const today = db.prepare(`
  SELECT bot_version, token_mint, exit_reason,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pnl_pct,
    security_score, ROUND(peak_multiplier, 3) as peak
  FROM positions
  WHERE status = 'closed' AND opened_at > 1739404800000
  ORDER BY opened_at DESC
`).all();
for (const t of today) {
  const emoji = t.pnl > 0 ? 'W' : (t.exit_reason||'').includes('rug') ? 'R' : 'L';
  console.log(`  ${emoji} ${(t.token_mint||'').slice(0,8)} s=${t.security_score} peak=${t.peak} pnl=${t.pnl_pct}% exit=${t.exit_reason} [${t.bot_version}]`);
}

db.close();
