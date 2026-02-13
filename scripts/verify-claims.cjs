#!/usr/bin/env node
/**
 * Verify claims from scoring analysis sessions
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

console.log('='.repeat(70));
console.log('  VERIFICATION: Claims from scoring analysis');
console.log('='.repeat(70));

// 1. observation_stable vs rug
console.log('\n=== 1. observation_stable vs rug (claim: r=+0.27 with rug) ===');
const obsRows = db.prepare(`
  SELECT dp_observation_stable, pool_outcome, COUNT(*) as cnt
  FROM detected_pools
  WHERE dp_observation_stable IS NOT NULL
  AND pool_outcome IN ('rug','survivor')
  GROUP BY dp_observation_stable, pool_outcome
  ORDER BY dp_observation_stable, pool_outcome
`).all();

const obs = {};
obsRows.forEach(r => {
  if (!obs[r.dp_observation_stable]) obs[r.dp_observation_stable] = {};
  obs[r.dp_observation_stable][r.pool_outcome] = r.cnt;
});

for (const [val, data] of Object.entries(obs)) {
  const total = (data.rug || 0) + (data.survivor || 0);
  const rugPct = ((data.rug || 0) / total * 100).toFixed(1);
  console.log(`  obs=${val}: N=${total}, rug=${data.rug || 0} (${rugPct}%), survivor=${data.survivor || 0}`);
}

// How many have NULL observation (rejected before)
const nullObs = db.prepare(`
  SELECT pool_outcome, COUNT(*) as cnt
  FROM detected_pools
  WHERE dp_observation_stable IS NULL
  AND pool_outcome IN ('rug','survivor')
  GROUP BY pool_outcome
`).all();
const nullTotal = nullObs.reduce((s,x) => s + x.cnt, 0);
const nullRug = nullObs.find(x => x.pool_outcome === 'rug')?.cnt || 0;
console.log(`  obs=NULL (pre-observation reject): N=${nullTotal}, rug=${nullRug} (${(nullRug/nullTotal*100).toFixed(1)}%)`);

// 2. freeze_auth_revoked predicts rug?
console.log('\n=== 2. freeze_auth_revoked vs rug (claim: r=+0.07, predicts rug) ===');
const freezeRows = db.prepare(`
  SELECT dp_freeze_auth_revoked, pool_outcome, COUNT(*) as cnt
  FROM detected_pools
  WHERE dp_freeze_auth_revoked IS NOT NULL
  AND pool_outcome IN ('rug','survivor')
  GROUP BY dp_freeze_auth_revoked, pool_outcome
`).all();

const freeze = {};
freezeRows.forEach(r => {
  if (!freeze[r.dp_freeze_auth_revoked]) freeze[r.dp_freeze_auth_revoked] = {};
  freeze[r.dp_freeze_auth_revoked][r.pool_outcome] = r.cnt;
});

for (const [val, data] of Object.entries(freeze)) {
  const total = (data.rug || 0) + (data.survivor || 0);
  const rugPct = ((data.rug || 0) / total * 100).toFixed(1);
  console.log(`  freeze_revoked=${val}: N=${total}, rug=${data.rug || 0} (${rugPct}%)`);
}

// 3. lp_burned predicts rug?
console.log('\n=== 3. lp_burned vs rug (claim: r=+0.09, predicts rug) ===');
const lpRows = db.prepare(`
  SELECT dp_lp_burned, pool_outcome, COUNT(*) as cnt
  FROM detected_pools
  WHERE dp_lp_burned IS NOT NULL
  AND pool_outcome IN ('rug','survivor')
  GROUP BY dp_lp_burned, pool_outcome
`).all();

const lp = {};
lpRows.forEach(r => {
  if (!lp[r.dp_lp_burned]) lp[r.dp_lp_burned] = {};
  lp[r.dp_lp_burned][r.pool_outcome] = r.cnt;
});

for (const [val, data] of Object.entries(lp)) {
  const total = (data.rug || 0) + (data.survivor || 0);
  const rugPct = ((data.rug || 0) / total * 100).toFixed(1);
  console.log(`  lp_burned=${val}: N=${total}, rug=${data.rug || 0} (${rugPct}%)`);
}

// 4. Features "inútiles" — check individually
console.log('\n=== 4. rugcheck_score vs rug (claim: 0.10% importance) ===');
const rcRows = db.prepare(`
  SELECT
    CASE
      WHEN dp_rugcheck_score IS NULL THEN 'null'
      WHEN dp_rugcheck_score < 0 THEN 'negative'
      WHEN dp_rugcheck_score = 0 THEN '0'
      WHEN dp_rugcheck_score <= 50 THEN '1-50'
      WHEN dp_rugcheck_score <= 100 THEN '51-100'
      ELSE '>100'
    END as bucket,
    pool_outcome,
    COUNT(*) as cnt
  FROM detected_pools
  WHERE pool_outcome IN ('rug','survivor')
  GROUP BY bucket, pool_outcome
`).all();

const rc = {};
rcRows.forEach(r => {
  if (!rc[r.bucket]) rc[r.bucket] = {};
  rc[r.bucket][r.pool_outcome] = r.cnt;
});

for (const [val, data] of Object.entries(rc)) {
  const total = (data.rug || 0) + (data.survivor || 0);
  if (total < 10) continue;
  const rugPct = ((data.rug || 0) / total * 100).toFixed(1);
  console.log(`  rugcheck=${val}: N=${total}, rug=${data.rug || 0} (${rugPct}%)`);
}

// 5. bundle_penalty vs rug
console.log('\n=== 5. bundle_penalty vs rug (claim: 0.01% importance) ===');
const bundleRows = db.prepare(`
  SELECT
    CASE
      WHEN dp_bundle_penalty IS NULL THEN 'null'
      WHEN dp_bundle_penalty = 0 THEN '0 (no penalty)'
      WHEN dp_bundle_penalty < 0 THEN 'negative (penalized)'
      ELSE 'positive'
    END as bucket,
    pool_outcome,
    COUNT(*) as cnt
  FROM detected_pools
  WHERE pool_outcome IN ('rug','survivor')
  GROUP BY bucket, pool_outcome
`).all();

const bundle = {};
bundleRows.forEach(r => {
  if (!bundle[r.bucket]) bundle[r.bucket] = {};
  bundle[r.bucket][r.pool_outcome] = r.cnt;
});

for (const [val, data] of Object.entries(bundle)) {
  const total = (data.rug || 0) + (data.survivor || 0);
  if (total < 10) continue;
  const rugPct = ((data.rug || 0) / total * 100).toFixed(1);
  console.log(`  bundle=${val}: N=${total}, rug=${data.rug || 0} (${rugPct}%)`);
}

// 6. Liquidity ranges vs rug (verify their table)
console.log('\n=== 6. Liquidity vs rug (verify their numbers) ===');
const liqRanges = [
  { label: '<$1K', where: 'dp_liquidity_usd < 1000' },
  { label: '$1-5K', where: 'dp_liquidity_usd >= 1000 AND dp_liquidity_usd < 5000' },
  { label: '$5-10K', where: 'dp_liquidity_usd >= 5000 AND dp_liquidity_usd < 10000' },
  { label: '$10-25K', where: 'dp_liquidity_usd >= 10000 AND dp_liquidity_usd < 25000' },
  { label: '$25-50K', where: 'dp_liquidity_usd >= 25000 AND dp_liquidity_usd < 50000' },
  { label: '>$50K', where: 'dp_liquidity_usd >= 50000' },
];

for (const range of liqRanges) {
  const rows = db.prepare(`
    SELECT pool_outcome, COUNT(*) as cnt
    FROM detected_pools
    WHERE ${range.where}
    AND dp_liquidity_usd IS NOT NULL
    AND pool_outcome IN ('rug','survivor')
    GROUP BY pool_outcome
  `).all();
  const rug = rows.find(x => x.pool_outcome === 'rug')?.cnt || 0;
  const total = rows.reduce((s,x) => s + x.cnt, 0);
  if (total === 0) continue;
  console.log(`  ${range.label.padEnd(8)}: N=${String(total).padStart(5)}, rug=${String(rug).padStart(4)} (${(rug/total*100).toFixed(1).padStart(5)}%)`);
}

// 7. Fast graduation penalty — verify my finding
console.log('\n=== 7. Graduation time vs rug (MY finding: fast grad is SAFE) ===');
const gradRanges = [
  { label: 'negative', where: 'dp_graduation_time_s < 0' },
  { label: 'null', where: 'dp_graduation_time_s IS NULL' },
  { label: '0s', where: 'dp_graduation_time_s = 0' },
  { label: '1-59s', where: 'dp_graduation_time_s > 0 AND dp_graduation_time_s < 60' },
  { label: '60-299s', where: 'dp_graduation_time_s >= 60 AND dp_graduation_time_s < 300' },
  { label: '300s+', where: 'dp_graduation_time_s >= 300' },
];

for (const range of gradRanges) {
  const rows = db.prepare(`
    SELECT pool_outcome, COUNT(*) as cnt
    FROM detected_pools
    WHERE ${range.where}
    AND pool_outcome IN ('rug','survivor')
    GROUP BY pool_outcome
  `).all();
  const rug = rows.find(x => x.pool_outcome === 'rug')?.cnt || 0;
  const total = rows.reduce((s,x) => s + x.cnt, 0);
  if (total === 0) continue;
  console.log(`  ${range.label.padEnd(10)}: N=${String(total).padStart(5)}, rug=${String(rug).padStart(4)} (${(rug/total*100).toFixed(1).padStart(5)}%)`);
}

// 8. Leakage check: observation_stable only exists for tokens that REACHED observation
console.log('\n=== 8. DATA LEAKAGE CHECK ===');
const stageCount = db.prepare(`
  SELECT dp_rejection_stage, COUNT(*) as cnt
  FROM detected_pools
  WHERE pool_outcome IN ('rug','survivor')
  GROUP BY dp_rejection_stage
  ORDER BY cnt DESC
`).all();
console.log('Rejection stages:');
stageCount.forEach(r => console.log(`  ${String(r.dp_rejection_stage).padEnd(15)}: ${r.cnt}`));

const obsNotNull = db.prepare(`SELECT COUNT(*) as cnt FROM detected_pools WHERE dp_observation_stable IS NOT NULL AND pool_outcome IN ('rug','survivor')`).get();
const obsTotal = db.prepare(`SELECT COUNT(*) as cnt FROM detected_pools WHERE pool_outcome IN ('rug','survivor')`).get();
console.log(`\nTokens with observation data: ${obsNotNull.cnt} / ${obsTotal.cnt} (${(obsNotNull.cnt/obsTotal.cnt*100).toFixed(1)}%)`);
console.log('If ML used observation_stable for ALL tokens, it filled NULLs somehow — potential leakage.');

db.close();
console.log('\n' + '='.repeat(70));
console.log('  VERIFICATION COMPLETE');
console.log('='.repeat(70));
