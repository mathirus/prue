/**
 * analyze-rejected.cjs
 * Análisis profundo de tokens rechazados vs aceptados
 * Busca oportunidades perdidas y patrones de mejora
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

const NOW = Date.now();
const H24 = 24 * 60 * 60 * 1000;
const H48 = 48 * 60 * 60 * 1000;

// Use 48h window for more data if 24h is too sparse
const WINDOW = H24;
const WINDOW_LABEL = '24h';
const CUTOFF = NOW - WINDOW;

function pct(n, total) {
  if (!total) return '0.0%';
  return (n / total * 100).toFixed(1) + '%';
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  ANÁLISIS DE TOKENS RECHAZADOS - OPORTUNIDADES PERDIDAS');
console.log('  Período:', WINDOW_LABEL, '| Fecha:', new Date().toISOString().slice(0, 19));
console.log('═══════════════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════════
// 1. RESUMEN GENERAL: Rechazados vs Pasados
// ═══════════════════════════════════════════════════════════════
console.log('┌─────────────────────────────────────────────────────────────┐');
console.log('│  1. RESUMEN GENERAL: Rechazados vs Pasados (últimas ' + WINDOW_LABEL + ')    │');
console.log('└─────────────────────────────────────────────────────────────┘');

const allPools24h = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN security_passed = 0 THEN 1 ELSE 0 END) as rejected,
    SUM(CASE WHEN security_passed IS NULL THEN 1 ELSE 0 END) as no_analysis
  FROM detected_pools WHERE detected_at > ?
`).get(CUTOFF);

const passedOutcomes24h = db.prepare(`
  SELECT pool_outcome, COUNT(*) as c
  FROM detected_pools WHERE detected_at > ? AND security_passed = 1
  GROUP BY pool_outcome
`).all(CUTOFF);

const rejectedOutcomes24h = db.prepare(`
  SELECT pool_outcome, COUNT(*) as c
  FROM detected_pools WHERE detected_at > ? AND security_passed = 0
  GROUP BY pool_outcome
`).all(CUTOFF);

console.log(`  Total pools detectados: ${allPools24h.total}`);
console.log(`  ├── Pasaron análisis:   ${allPools24h.passed} (${pct(allPools24h.passed, allPools24h.total)})`);
console.log(`  ├── Rechazados:         ${allPools24h.rejected} (${pct(allPools24h.rejected, allPools24h.total)})`);
console.log(`  └── Sin análisis:       ${allPools24h.no_analysis}`);

console.log('\n  Outcomes de PASADOS:');
for (const o of passedOutcomes24h) {
  console.log(`    ${o.pool_outcome || 'NULL'}: ${o.c}`);
}
console.log('  Outcomes de RECHAZADOS:');
for (const o of rejectedOutcomes24h) {
  console.log(`    ${o.pool_outcome || 'NULL'}: ${o.c}`);
}

// Also check ALL TIME for more robust stats
const allPoolsTotal = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN security_passed = 0 THEN 1 ELSE 0 END) as rejected
  FROM detected_pools
`).get();

console.log(`\n  ALL TIME: ${allPoolsTotal.total} pools (${allPoolsTotal.passed} passed, ${allPoolsTotal.rejected} rejected)`);

// ═══════════════════════════════════════════════════════════════
// 2. ZONA GRIS: Score 65-79 (cerca del umbral)
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  2. ZONA GRIS: Score 65-79 (cerca del umbral)              │');
console.log('└─────────────────────────────────────────────────────────────┘');

// Check what the effective threshold is
const minPassedScore = db.prepare(`
  SELECT MIN(security_score) as min_s FROM positions
`).get();
console.log(`  Umbral efectivo (min score en positions): ${minPassedScore.min_s}`);

// Score 70-79 breakdown (the interesting zone)
const grayZone = db.prepare(`
  SELECT security_score as score,
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN pool_outcome IS NULL OR pool_outcome = 'unknown' THEN 1 ELSE 0 END) as unknown
  FROM detected_pools
  WHERE security_score BETWEEN 65 AND 79
  GROUP BY security_score
  ORDER BY security_score DESC
`).all();

console.log('\n  Score | Total | Survivors | Rugs | Unknown | Rug Rate');
console.log('  ------+-------+-----------+------+---------+---------');
for (const r of grayZone) {
  const known = r.survivors + r.rugs;
  const rugRate = known > 0 ? pct(r.rugs, known) : 'N/A';
  console.log(`    ${r.score}  |  ${String(r.total).padStart(4)} |    ${String(r.survivors).padStart(5)} |  ${String(r.rugs).padStart(3)} |    ${String(r.unknown).padStart(4)} | ${rugRate}`);
}

const totalGray = grayZone.reduce((a, b) => a + b.total, 0);
const survivorsGray = grayZone.reduce((a, b) => a + b.survivors, 0);
const rugsGray = grayZone.reduce((a, b) => a + b.rugs, 0);
const knownGray = survivorsGray + rugsGray;
console.log(`  ------+-------+-----------+------+---------+---------`);
console.log(`  TOTAL | ${String(totalGray).padStart(5)} |    ${String(survivorsGray).padStart(5)} |  ${String(rugsGray).padStart(3)} |         | ${pct(rugsGray, knownGray)}`);
console.log(`\n  >>> ${survivorsGray} tokens sobrevivientes RECHAZADOS en zona gris 65-79`);

// Compare with score 75-79 specifically (just under old threshold)
const near75 = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN security_passed = 0 THEN 1 ELSE 0 END) as rejected
  FROM detected_pools
  WHERE security_score BETWEEN 75 AND 79
`).get();
const knownNear = near75.survivors + near75.rugs;
console.log(`\n  Score 75-79: ${near75.total} pools, ${near75.rejected} rechazados`);
console.log(`    Rug rate: ${pct(near75.rugs, knownNear)} (${near75.rugs}/${knownNear})`);
console.log(`    Survivors rechazados: ~${near75.rejected} oportunidades potencialmente perdidas`);

// ═══════════════════════════════════════════════════════════════
// 3. RAZONES DE RECHAZO MÁS COMUNES
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  3. RAZONES DE RECHAZO MÁS COMUNES                         │');
console.log('└─────────────────────────────────────────────────────────────┘');

// Parse comma-separated rejection_reasons
const allRejected = db.prepare(`
  SELECT rejection_reasons, pool_outcome, security_score
  FROM detected_pools
  WHERE security_passed = 0 AND rejection_reasons IS NOT NULL AND rejection_reasons != ''
`).all();

const reasonCounts = {};
const reasonSurvivors = {};
const reasonRugs = {};

for (const row of allRejected) {
  const reasons = row.rejection_reasons.split(',');
  for (const r of reasons) {
    const reason = r.trim();
    if (!reason) continue;
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (row.pool_outcome === 'survivor') {
      reasonSurvivors[reason] = (reasonSurvivors[reason] || 0) + 1;
    } else if (row.pool_outcome === 'rug') {
      reasonRugs[reason] = (reasonRugs[reason] || 0) + 1;
    }
  }
}

const sortedReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);

console.log('\n  Razón           | Count | Survivors | Rugs  | False Reject Rate');
console.log('  ----------------+-------+-----------+-------+------------------');
for (const [reason, count] of sortedReasons) {
  const surv = reasonSurvivors[reason] || 0;
  const rug = reasonRugs[reason] || 0;
  const known = surv + rug;
  const falseRejectRate = known > 0 ? pct(surv, known) : 'N/A';
  console.log(`  ${reason.padEnd(16)}| ${String(count).padStart(5)} | ${String(surv).padStart(9)} | ${String(rug).padStart(5)} | ${falseRejectRate}`);
}

console.log('\n  "False Reject Rate" = % de tokens rechazados por esta razón que eran survivors');
console.log('  (Alto = la razón es demasiado agresiva, rechaza tokens buenos)');

// Check rejection reasons that ONLY appear for non-rug tokens
console.log('\n  >> Razones más agresivas (alto false reject rate):');
for (const [reason, count] of sortedReasons) {
  const surv = reasonSurvivors[reason] || 0;
  const rug = reasonRugs[reason] || 0;
  const known = surv + rug;
  if (known >= 5 && surv / known > 0.7) {
    console.log(`     ${reason}: ${pct(surv, known)} false reject (${surv}/${known}) - ¡MUY AGRESIVA!`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. FEATURES: Survivors vs Rugs en zona gris (65-79)
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  4. FEATURES: Survivors vs Rugs en zona 65-79              │');
console.log('└─────────────────────────────────────────────────────────────┘');

const grayFeatures = db.prepare(`
  SELECT pool_outcome,
    dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
    dp_honeypot_verified, dp_mint_auth_revoked, dp_freeze_auth_revoked,
    dp_rugcheck_score, dp_lp_burned, security_score
  FROM detected_pools
  WHERE security_score BETWEEN 65 AND 79
    AND pool_outcome IN ('survivor', 'rug')
    AND dp_liquidity_usd IS NOT NULL
`).all();

const survivors = grayFeatures.filter(r => r.pool_outcome === 'survivor');
const rugs = grayFeatures.filter(r => r.pool_outcome === 'rug');

console.log(`\n  Datos con dp_* features: ${grayFeatures.length} (${survivors.length} survivors, ${rugs.length} rugs)`);

if (survivors.length > 0 && rugs.length > 0) {
  const features = ['dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct', 'dp_rugcheck_score', 'security_score'];
  const boolFeatures = ['dp_honeypot_verified', 'dp_mint_auth_revoked', 'dp_freeze_auth_revoked', 'dp_lp_burned'];

  console.log('\n  Feature              | Survivor (avg/med) | Rug (avg/med)    | Diferencia');
  console.log('  ---------------------+--------------------+------------------+-----------');

  for (const f of features) {
    const sVals = survivors.map(r => r[f]).filter(v => v !== null);
    const rVals = rugs.map(r => r[f]).filter(v => v !== null);
    if (sVals.length && rVals.length) {
      const sAvg = avg(sVals).toFixed(1);
      const sM = median(sVals).toFixed(1);
      const rAvg = avg(rVals).toFixed(1);
      const rM = median(rVals).toFixed(1);
      const diff = ((avg(sVals) - avg(rVals)) / (avg(rVals) || 1) * 100).toFixed(0);
      const label = f.replace('dp_', '').padEnd(21);
      console.log(`  ${label}| ${sAvg.padStart(7)}/${sM.padStart(7)}   | ${rAvg.padStart(7)}/${rM.padStart(7)} | ${diff}%`);
    }
  }

  console.log('\n  Bool Feature         | Survivor (% true)  | Rug (% true)');
  console.log('  ---------------------+--------------------+-------------');
  for (const f of boolFeatures) {
    const sVals = survivors.map(r => r[f]).filter(v => v !== null);
    const rVals = rugs.map(r => r[f]).filter(v => v !== null);
    if (sVals.length && rVals.length) {
      const sPct = pct(sVals.filter(v => v === 1).length, sVals.length);
      const rPct = pct(rVals.filter(v => v === 1).length, rVals.length);
      const label = f.replace('dp_', '').padEnd(21);
      console.log(`  ${label}| ${sPct.padStart(18)} | ${rPct.padStart(11)}`);
    }
  }
} else {
  console.log('  NOTA: Datos insuficientes en zona gris con dp_* features');
}

// Also check from token_analysis for more data
const grayTA = db.prepare(`
  SELECT ta.*, dp.pool_outcome, dp.security_score as dp_score
  FROM token_analysis ta
  JOIN detected_pools dp ON ta.token_mint = dp.base_mint
  WHERE dp.security_score BETWEEN 65 AND 79
    AND dp.pool_outcome IN ('survivor', 'rug')
`).all();

const taSurvivors = grayTA.filter(r => r.pool_outcome === 'survivor');
const taRugs = grayTA.filter(r => r.pool_outcome === 'rug');

if (taSurvivors.length > 0 || taRugs.length > 0) {
  console.log(`\n  Datos token_analysis: ${grayTA.length} (${taSurvivors.length} survivors, ${taRugs.length} rugs)`);

  const taFeatures = ['liquidity_usd', 'top_holder_pct', 'holder_count', 'rugcheck_score', 'detection_latency_ms'];
  const taBoolFeatures = ['mint_authority_revoked', 'freeze_authority_revoked', 'honeypot_safe', 'lp_burned'];

  console.log('\n  Feature (t_analysis)  | Survivor (avg/med) | Rug (avg/med)');
  console.log('  ---------------------+--------------------+------------------');
  for (const f of taFeatures) {
    const sVals = taSurvivors.map(r => r[f]).filter(v => v !== null && v !== undefined);
    const rVals = taRugs.map(r => r[f]).filter(v => v !== null && v !== undefined);
    if (sVals.length || rVals.length) {
      const sAvg = sVals.length ? avg(sVals).toFixed(1) : 'N/A';
      const sM = sVals.length ? median(sVals).toFixed(1) : 'N/A';
      const rAvg = rVals.length ? avg(rVals).toFixed(1) : 'N/A';
      const rM = rVals.length ? median(rVals).toFixed(1) : 'N/A';
      console.log(`  ${f.padEnd(22)}| ${String(sAvg).padStart(7)}/${String(sM).padStart(7)}   | ${String(rAvg).padStart(7)}/${String(rM).padStart(7)}`);
    }
  }

  console.log('\n  Bool Feature (t_a)   | Survivor (% true)  | Rug (% true)');
  console.log('  ---------------------+--------------------+-------------');
  for (const f of taBoolFeatures) {
    const sVals = taSurvivors.map(r => r[f]).filter(v => v !== null && v !== undefined);
    const rVals = taRugs.map(r => r[f]).filter(v => v !== null && v !== undefined);
    if (sVals.length || rVals.length) {
      const sPct = sVals.length ? pct(sVals.filter(v => v === 1).length, sVals.length) : 'N/A';
      const rPct = rVals.length ? pct(rVals.filter(v => v === 1).length, rVals.length) : 'N/A';
      console.log(`  ${f.padEnd(22)}| ${sPct.padStart(18)} | ${rPct.padStart(11)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. FILTRO EFFECTIVENESS: Rug rate de trades vs rechazados
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  5. EFECTIVIDAD DEL FILTRO: Rug rate actual vs rechazados  │');
console.log('└─────────────────────────────────────────────────────────────┘');

// Our actual trades
const trades = db.prepare(`
  SELECT pnl_pct, pnl_sol, security_score, status, sol_invested
  FROM positions
`).all();

const tradeRugs = trades.filter(t => t.pnl_pct <= -80);
const tradeWins = trades.filter(t => t.pnl_pct > 0);
const tradeLosses = trades.filter(t => t.pnl_pct <= 0);

console.log(`\n  TRADES REALES (positions): ${trades.length}`);
console.log(`    Wins (PnL > 0): ${tradeWins.length} (${pct(tradeWins.length, trades.length)})`);
console.log(`    Losses (PnL ≤ 0): ${tradeLosses.length} (${pct(tradeLosses.length, trades.length)})`);
console.log(`    Rugs (PnL ≤ -80%): ${tradeRugs.length} (${pct(tradeRugs.length, trades.length)})`);
console.log(`    Avg PnL: ${avg(trades.map(t => t.pnl_pct)).toFixed(2)}%`);
console.log(`    Median PnL: ${median(trades.map(t => t.pnl_pct)).toFixed(2)}%`);
console.log(`    Total SOL P&L: ${trades.reduce((a, t) => a + (t.pnl_sol || 0), 0).toFixed(6)} SOL`);

// Pool-level rug rates by pass/reject
const allPoolOutcomes = db.prepare(`
  SELECT
    security_passed,
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs
  FROM detected_pools
  WHERE pool_outcome IN ('survivor', 'rug')
  GROUP BY security_passed
`).all();

console.log('\n  RUG RATE por grupo (ALL TIME):');
for (const g of allPoolOutcomes) {
  const label = g.security_passed === 1 ? 'PASADOS' : 'RECHAZADOS';
  const total = g.survivors + g.rugs;
  console.log(`    ${label}: ${pct(g.rugs, total)} rug rate (${g.rugs}/${total}) | ${g.survivors} survivors`);
}

// Rug rate by score bands (all time)
const scoreBands = db.prepare(`
  SELECT
    CASE
      WHEN security_score >= 90 THEN '90+'
      WHEN security_score >= 85 THEN '85-89'
      WHEN security_score >= 80 THEN '80-84'
      WHEN security_score >= 75 THEN '75-79'
      WHEN security_score >= 70 THEN '70-74'
      WHEN security_score >= 65 THEN '65-69'
      WHEN security_score >= 50 THEN '50-64'
      ELSE '<50'
    END as band,
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs
  FROM detected_pools
  WHERE pool_outcome IN ('survivor', 'rug')
  GROUP BY band
  ORDER BY band DESC
`).all();

console.log('\n  Score Band | Total | Survivors | Rugs | Rug Rate');
console.log('  ----------+-------+-----------+------+---------');
for (const b of scoreBands) {
  const known = b.survivors + b.rugs;
  console.log(`  ${b.band.padEnd(10)}| ${String(b.total).padStart(5)} | ${String(b.survivors).padStart(9)} | ${String(b.rugs).padStart(4)} | ${pct(b.rugs, known)}`);
}

// ═══════════════════════════════════════════════════════════════
// 6. PASADOS QUE HICIERON RUG: ¿Qué features tenían?
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  6. TOKENS COMPRADOS QUE HICIERON RUG (PnL ≤ -80%)        │');
console.log('└─────────────────────────────────────────────────────────────┘');

const rugTrades = db.prepare(`
  SELECT p.*, dp.rejection_reasons, dp.pool_outcome,
    dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct,
    dp.dp_honeypot_verified, dp.dp_mint_auth_revoked, dp.dp_freeze_auth_revoked,
    dp.dp_rugcheck_score, dp.dp_lp_burned
  FROM positions p
  LEFT JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.pnl_pct <= -80
`).all();

console.log(`\n  Trades con PnL ≤ -80%: ${rugTrades.length}`);

if (rugTrades.length > 0) {
  console.log('\n  Token Mint (first 8) | Score | PnL%     | Liq USD   | Holders | TopH%  | Features');
  console.log('  --------------------+-------+----------+-----------+---------+--------+---------');
  for (const t of rugTrades.slice(0, 20)) {
    const mint = (t.token_mint || '').slice(0, 8);
    const features = [];
    if (t.dp_mint_auth_revoked === 0) features.push('mint!');
    if (t.dp_freeze_auth_revoked === 0) features.push('freeze!');
    if (t.dp_lp_burned === 0) features.push('lpUnlock');
    if (t.dp_honeypot_verified === 0) features.push('noHpVer');
    console.log(`  ${mint.padEnd(20)}| ${String(t.security_score || '?').padStart(5)} | ${String((t.pnl_pct || 0).toFixed(1)).padStart(8)}% | ${String((t.dp_liquidity_usd || 0).toFixed(0)).padStart(9)} | ${String(t.dp_holder_count || '?').padStart(7)} | ${String((t.dp_top_holder_pct || 0).toFixed(1)).padStart(5)}% | ${features.join(',')}`);
  }

  // Aggregate features of rug trades
  const rugFeatureAgg = {
    liq: rugTrades.map(t => t.dp_liquidity_usd).filter(v => v != null),
    holders: rugTrades.map(t => t.dp_holder_count).filter(v => v != null),
    topH: rugTrades.map(t => t.dp_top_holder_pct).filter(v => v != null),
    scores: rugTrades.map(t => t.security_score).filter(v => v != null),
  };

  console.log(`\n  Aggregate de rug trades:`);
  if (rugFeatureAgg.liq.length) console.log(`    Liquidity USD: avg=${avg(rugFeatureAgg.liq).toFixed(0)}, median=${median(rugFeatureAgg.liq).toFixed(0)}`);
  if (rugFeatureAgg.holders.length) console.log(`    Holders: avg=${avg(rugFeatureAgg.holders).toFixed(0)}, median=${median(rugFeatureAgg.holders).toFixed(0)}`);
  if (rugFeatureAgg.topH.length) console.log(`    Top Holder %: avg=${avg(rugFeatureAgg.topH).toFixed(1)}%, median=${median(rugFeatureAgg.topH).toFixed(1)}%`);
  if (rugFeatureAgg.scores.length) console.log(`    Security Score: avg=${avg(rugFeatureAgg.scores).toFixed(0)}, median=${median(rugFeatureAgg.scores).toFixed(0)}`);
}

// Also look at passed pools that rugged (not just our trades)
const passedRugs = db.prepare(`
  SELECT dp.*, ta.liquidity_usd as ta_liq, ta.top_holder_pct as ta_topH, ta.holder_count as ta_holders,
    ta.honeypot_safe, ta.lp_burned as ta_lp_burned, ta.rugcheck_score as ta_rugcheck
  FROM detected_pools dp
  LEFT JOIN token_analysis ta ON dp.base_mint = ta.token_mint
  WHERE dp.security_passed = 1 AND dp.pool_outcome = 'rug'
`).all();

console.log(`\n  Pools PASADOS con outcome='rug': ${passedRugs.length}`);
if (passedRugs.length > 0) {
  console.log('  Score distribution:');
  const rugScoreDist = {};
  for (const r of passedRugs) {
    const band = Math.floor(r.security_score / 5) * 5;
    rugScoreDist[band] = (rugScoreDist[band] || 0) + 1;
  }
  for (const [band, count] of Object.entries(rugScoreDist).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    console.log(`    Score ${band}-${Number(band) + 4}: ${count}`);
  }

  // Feature comparison: passed rugs vs passed survivors
  const passedSurvivors = db.prepare(`
    SELECT dp.*, ta.liquidity_usd as ta_liq, ta.top_holder_pct as ta_topH, ta.holder_count as ta_holders
    FROM detected_pools dp
    LEFT JOIN token_analysis ta ON dp.base_mint = ta.token_mint
    WHERE dp.security_passed = 1 AND dp.pool_outcome = 'survivor'
    AND dp.dp_liquidity_usd IS NOT NULL
  `).all();

  const passedRugsWithDP = passedRugs.filter(r => r.dp_liquidity_usd != null);

  if (passedRugsWithDP.length > 0 && passedSurvivors.length > 0) {
    console.log(`\n  Pasados Rugs (con features): ${passedRugsWithDP.length} vs Pasados Survivors: ${passedSurvivors.length}`);
    console.log('\n  Feature            | Passed Rug (avg)  | Passed Survivor (avg) | Signal?');
    console.log('  -------------------+-------------------+-----------------------+--------');

    const compareFeatures = [
      ['dp_liquidity_usd', 'Liquidity USD'],
      ['dp_holder_count', 'Holders'],
      ['dp_top_holder_pct', 'Top Holder %'],
      ['dp_rugcheck_score', 'RugCheck Score'],
    ];

    for (const [field, label] of compareFeatures) {
      const rVals = passedRugsWithDP.map(r => r[field]).filter(v => v != null);
      const sVals = passedSurvivors.map(r => r[field]).filter(v => v != null);
      if (rVals.length && sVals.length) {
        const rAvg = avg(rVals);
        const sAvg = avg(sVals);
        const diff = ((sAvg - rAvg) / (rAvg || 1) * 100).toFixed(0);
        const signal = Math.abs(Number(diff)) > 20 ? '*** YES ***' : 'weak';
        console.log(`  ${label.padEnd(19)}| ${rAvg.toFixed(1).padStart(17)} | ${sAvg.toFixed(1).padStart(21)} | ${signal} (${diff}%)`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. SCORE 85+ vs 80-84: Win rates y PnL
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  7. SCORE 85+ vs 80-84: Win rates y PnL de trades reales  │');
console.log('└─────────────────────────────────────────────────────────────┘');

const tradesByBand = db.prepare(`
  SELECT
    CASE
      WHEN security_score >= 90 THEN '90+'
      WHEN security_score >= 85 THEN '85-89'
      WHEN security_score >= 80 THEN '80-84'
      WHEN security_score >= 75 THEN '75-79'
      ELSE '<75'
    END as band,
    COUNT(*) as total,
    SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) as losses,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    AVG(pnl_pct) as avg_pnl,
    SUM(pnl_sol) as total_pnl_sol,
    AVG(pnl_sol) as avg_pnl_sol
  FROM positions
  GROUP BY band
  ORDER BY band DESC
`).all();

console.log('\n  Band   | Trades | Wins | Losses | Rugs | Win% | Avg PnL% | Total PnL SOL');
console.log('  -------+--------+------+--------+------+------+----------+--------------');
for (const b of tradesByBand) {
  console.log(`  ${b.band.padEnd(7)}| ${String(b.total).padStart(6)} | ${String(b.wins).padStart(4)} | ${String(b.losses).padStart(6)} | ${String(b.rugs).padStart(4)} | ${pct(b.wins, b.total).padStart(4)} | ${(b.avg_pnl || 0).toFixed(2).padStart(8)}% | ${(b.total_pnl_sol || 0).toFixed(6)}`);
}

// ═══════════════════════════════════════════════════════════════
// 8. OPORTUNIDADES PERDIDAS CONCRETAS
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  8. OPORTUNIDADES PERDIDAS: Rechazados que sobrevivieron   │');
console.log('└─────────────────────────────────────────────────────────────┘');

// High-score rejected survivors
const missedOpportunities = db.prepare(`
  SELECT base_mint, security_score, rejection_reasons, pool_outcome, source,
    dp_liquidity_usd, dp_holder_count, dp_top_holder_pct, detected_at
  FROM detected_pools
  WHERE security_passed = 0 AND pool_outcome = 'survivor' AND security_score >= 70
  ORDER BY security_score DESC
  LIMIT 20
`).all();

console.log(`\n  Top 20 tokens rechazados con mayor score que sobrevivieron:\n`);
console.log('  Mint (8)  | Score | Liq USD   | Holders | TopH%  | Reasons');
console.log('  ----------+-------+-----------+---------+--------+--------');
for (const m of missedOpportunities) {
  const mint = (m.base_mint || '').slice(0, 8);
  console.log(`  ${mint.padEnd(10)}| ${String(m.security_score).padStart(5)} | ${String((m.dp_liquidity_usd || 0).toFixed(0)).padStart(9)} | ${String(m.dp_holder_count || '?').padStart(7)} | ${String((m.dp_top_holder_pct || 0).toFixed(1)).padStart(5)}% | ${m.rejection_reasons || 'score<threshold'}`);
}

// Count missed by score
const missedByScore = db.prepare(`
  SELECT security_score, COUNT(*) as c
  FROM detected_pools
  WHERE security_passed = 0 AND pool_outcome = 'survivor' AND security_score >= 65
  GROUP BY security_score
  ORDER BY security_score DESC
`).all();

console.log('\n  Survivors rechazados por score:');
let totalMissed = 0;
for (const m of missedByScore) {
  console.log(`    Score ${m.security_score}: ${m.c} tokens sobrevivientes rechazados`);
  totalMissed += m.c;
}
console.log(`    TOTAL: ${totalMissed} oportunidades potencialmente perdidas (score >= 65)`);

// ═══════════════════════════════════════════════════════════════
// 9. RESUMEN Y RECOMENDACIONES
// ═══════════════════════════════════════════════════════════════
console.log('\n┌─────────────────────────────────────────────────────────────┐');
console.log('│  9. RESUMEN Y RECOMENDACIONES                              │');
console.log('└─────────────────────────────────────────────────────────────┘');

// Calculate key metrics
const passedTotal = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_passed = 1 AND pool_outcome IN ('survivor','rug')
`).get();
const passedRugCount = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_passed = 1 AND pool_outcome = 'rug'
`).get();
const rejectedSurvCount = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_passed = 0 AND pool_outcome = 'survivor'
`).get();
const rejectedTotal = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_passed = 0 AND pool_outcome IN ('survivor','rug')
`).get();

const passedRugRate = passedTotal.c > 0 ? (passedRugCount.c / passedTotal.c * 100).toFixed(1) : 'N/A';
const rejectedSurvRate = rejectedTotal.c > 0 ? (rejectedSurvCount.c / rejectedTotal.c * 100).toFixed(1) : 'N/A';

console.log(`
  MÉTRICAS CLAVE:
  ├── Rug rate de tokens PASADOS: ${passedRugRate}% (${passedRugCount.c}/${passedTotal.c})
  ├── Survivor rate de tokens RECHAZADOS: ${rejectedSurvRate}% (${rejectedSurvCount.c}/${rejectedTotal.c})
  ├── Trades totales: ${trades.length}
  ├── Win rate: ${pct(tradeWins.length, trades.length)}
  ├── Rug rate en trades: ${pct(tradeRugs.length, trades.length)}
  └── P&L total: ${trades.reduce((a, t) => a + (t.pnl_sol || 0), 0).toFixed(6)} SOL
`);

// Specific recommendations based on data
const score75Survivors = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_passed = 0 AND pool_outcome = 'survivor' AND security_score = 75
`).get();
const score75Total = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_score = 75 AND pool_outcome IN ('survivor','rug')
`).get();
const score75Rugs = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_score = 75 AND pool_outcome = 'rug'
`).get();

const score80Survivors = db.prepare(`
  SELECT COUNT(*) as c FROM detected_pools WHERE security_passed = 0 AND pool_outcome = 'survivor' AND security_score = 80
`).get();

console.log(`  ANÁLISIS DE UMBRAL:`);
console.log(`    Score 75: ${score75Total.c} pools con outcome, ${score75Rugs.c} rugs (${pct(score75Rugs.c, score75Total.c)} rug rate)`);
console.log(`    Score 75 survivors rechazados: ${score75Survivors.c}`);
console.log(`    Score 80 survivors rechazados: ${score80Survivors.c}`);

// What if we lowered threshold to 75?
const hypothetical75 = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs
  FROM detected_pools
  WHERE security_score >= 75 AND pool_outcome IN ('survivor', 'rug')
`).get();

const hypothetical70 = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs
  FROM detected_pools
  WHERE security_score >= 70 AND pool_outcome IN ('survivor', 'rug')
`).get();

const currentThreshold = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs
  FROM detected_pools
  WHERE security_passed = 1 AND pool_outcome IN ('survivor', 'rug')
`).get();

console.log(`\n  SIMULACIÓN DE UMBRALES:`);
console.log(`    Actual (passed): ${currentThreshold.total} pools, rug rate ${pct(currentThreshold.rugs, currentThreshold.total)}, ${currentThreshold.survivors} survivors`);
console.log(`    Si score >= 75:  ${hypothetical75.total} pools, rug rate ${pct(hypothetical75.rugs, hypothetical75.total)}, ${hypothetical75.survivors} survivors (+${hypothetical75.survivors - currentThreshold.survivors})`);
console.log(`    Si score >= 70:  ${hypothetical70.total} pools, rug rate ${pct(hypothetical70.rugs, hypothetical70.total)}, ${hypothetical70.survivors} survivors (+${hypothetical70.survivors - currentThreshold.survivors})`);

// Estimate value of missed opportunities
const avgWinPnl = trades.filter(t => t.pnl_pct > 0).length > 0
  ? avg(trades.filter(t => t.pnl_pct > 0).map(t => t.pnl_sol))
  : 0;
const tradeWinRate = tradeWins.length / trades.length;
const additionalTrades75 = hypothetical75.survivors - currentThreshold.survivors;
const estimatedExtraProfit = additionalTrades75 * tradeWinRate * avgWinPnl - additionalTrades75 * (1 - tradeWinRate) * 0.003 * 0.3;

console.log(`\n  ESTIMACIÓN DE VALOR:`);
console.log(`    Avg win en SOL: ${avgWinPnl.toFixed(6)}`);
console.log(`    Win rate actual: ${pct(tradeWins.length, trades.length)}`);
console.log(`    Trades adicionales si umbral=75: ~${additionalTrades75}`);
console.log(`    Profit estimado extra: ~${estimatedExtraProfit.toFixed(6)} SOL (MUY aproximado)`);

// Top rejection reasons that reject survivors
console.log('\n  RAZONES QUE MÁS SURVIVORS RECHAZAN:');
const sortedByFalse = Object.entries(reasonSurvivors).sort((a, b) => b[1] - a[1]);
for (const [reason, count] of sortedByFalse.slice(0, 5)) {
  const total = reasonCounts[reason];
  const rugsR = reasonRugs[reason] || 0;
  console.log(`    ${reason}: ${count} survivors rechazados (de ${total} total, ${rugsR} rugs)`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  FIN DEL ANÁLISIS');
console.log('═══════════════════════════════════════════════════════════════');

db.close();
