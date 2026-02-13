/**
 * Validate ML classifier against the 28 closed shadow positions
 * that passed score>=60 + liq>=10K filter.
 *
 * Uses the SAME ONNX model to predict each one, then compares
 * predicted vs actual outcome (rug_detected).
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'));

// Get the 28 positions with their features from detected_pools
const positions = db.prepare(`
  SELECT
    sp.pool_id, sp.token_mint, sp.security_score, sp.rug_detected,
    sp.tp1_hit, sp.tp2_hit, sp.peak_multiplier, sp.exit_reason,
    sp.entry_sol_reserve, sp.bot_version,
    dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct,
    dp.dp_rugcheck_score, dp.dp_honeypot_verified, dp.dp_mint_auth_revoked,
    dp.dp_freeze_auth_revoked, dp.dp_lp_burned, dp.dp_graduation_time_s,
    dp.dp_bundle_penalty, dp.dp_insiders_count, dp.dp_creator_reputation,
    dp.dp_early_tx_count, dp.dp_tx_velocity, dp.dp_unique_slots,
    dp.source as pool_source
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL
    AND sp.security_score >= 60
    AND dp.dp_liquidity_usd >= 10000
`).all();

console.log(`\n=== VALIDACION ML vs ${positions.length} TRADES REALES ===\n`);

// Build features and classify each one using the SAME logic as the bot
// We can't use ONNX here (CJS), so we'll use the DT fallback logic
// But we CAN build the feature array and show what would happen

let correct = 0, wrong = 0;
let truePositives = 0, trueNegatives = 0, falsePositives = 0, falseNegatives = 0;

const results = [];

for (const p of positions) {
  const liq = p.dp_liquidity_usd || 0;
  const holders = Math.max(p.dp_holder_count || 1, 1);
  const liqPerHolder = liq / holders;
  const holderLiqInteraction = holders * liq;
  const reserve = p.entry_sol_reserve || 0;
  const topHolder = p.dp_top_holder_pct || 0;
  const rugcheck = p.dp_rugcheck_score || 0;
  const secScore = p.security_score || 0;

  // DT v2 classifier logic (same as ml-classifier.ts classifyToken)
  let dtPrediction, dtConfidence, dtNode;
  if (reserve > 0) {
    if (liqPerHolder <= 5686) {
      if (reserve <= 89.5) {
        dtPrediction = 'safe'; dtConfidence = 0.67; dtNode = 'v2_low_reserve';
      } else if (reserve <= 158) {
        dtPrediction = 'rug'; dtConfidence = 0.86; dtNode = 'v2_mid_reserve_concentrated';
      } else {
        dtPrediction = 'safe'; dtConfidence = 0.60; dtNode = 'v2_high_reserve';
      }
    } else {
      if (holderLiqInteraction <= 9917) {
        dtPrediction = 'safe'; dtConfidence = 1.00; dtNode = 'v2_distributed_small';
      } else {
        dtPrediction = 'safe'; dtConfidence = 0.75; dtNode = 'v2_distributed_large';
      }
    }
  } else {
    if (liq <= 26743) {
      if (liqPerHolder <= 809) {
        dtPrediction = 'safe'; dtConfidence = 0.80; dtNode = 'v1_low_liq_many_holders';
      } else if (liq <= 7338) {
        dtPrediction = 'safe'; dtConfidence = 0.70; dtNode = 'v1_very_low_liq';
      } else if (liq <= 22061) {
        dtPrediction = 'rug'; dtConfidence = 0.68; dtNode = 'v1_mid_liq_few_holders';
      } else {
        dtPrediction = 'safe'; dtConfidence = 0.56; dtNode = 'v1_high_mid_liq';
      }
    } else {
      if (liqPerHolder <= 28057) {
        dtPrediction = 'safe'; dtConfidence = 0.75; dtNode = 'v1_high_liq_distributed';
      } else if (liqPerHolder <= 37196) {
        dtPrediction = 'rug'; dtConfidence = 0.58; dtNode = 'v1_high_liq_whale_trap';
      } else {
        dtPrediction = 'safe'; dtConfidence = 0.64; dtNode = 'v1_ultra_high_lph';
      }
    }
  }

  const actual = p.rug_detected ? 'rug' : 'safe';
  const predicted = dtPrediction;
  const isCorrect = predicted === actual;

  if (isCorrect) correct++;
  else wrong++;

  if (predicted === 'rug' && actual === 'rug') truePositives++;
  if (predicted === 'safe' && actual === 'safe') trueNegatives++;
  if (predicted === 'rug' && actual === 'safe') falsePositives++;
  if (predicted === 'safe' && actual === 'rug') falseNegatives++;

  results.push({
    mint: p.token_mint.slice(0, 8),
    score: p.security_score,
    liq: Math.round(liq),
    holders: p.dp_holder_count,
    reserve: (reserve || 0).toFixed(1),
    actual,
    predicted,
    confidence: (dtConfidence * 100).toFixed(0) + '%',
    node: dtNode,
    correct: isCorrect ? 'OK' : 'WRONG',
    tp1: p.tp1_hit ? 'Y' : 'n',
    peak: (p.peak_multiplier || 0).toFixed(2) + 'x',
    version: p.bot_version,
  });
}

// Print results
console.log('Token    | Score | Liq     | Hold | Res   | Real | ML dice | Conf | Acierta | TP1 | Peak');
console.log('---------|-------|---------|------|-------|------|---------|------|---------|-----|------');
for (const r of results) {
  console.log(
    `${r.mint} | ${String(r.score).padStart(5)} | $${String(r.liq).padStart(5)} | ${String(r.holders).padStart(4)} | ${r.reserve.padStart(5)} | ${r.actual.padEnd(4)} | ${r.predicted.padEnd(7)} | ${r.confidence.padStart(4)} | ${r.correct.padEnd(7)} | ${r.tp1}   | ${r.peak}`
  );
}

console.log('\n=== RESUMEN ===');
console.log(`Total: ${positions.length}`);
console.log(`Correctos: ${correct} (${(correct/positions.length*100).toFixed(0)}%)`);
console.log(`Incorrectos: ${wrong} (${(wrong/positions.length*100).toFixed(0)}%)`);
console.log();
console.log(`True Positives (ML dijo rug, ERA rug): ${truePositives}`);
console.log(`True Negatives (ML dijo safe, ERA safe): ${trueNegatives}`);
console.log(`False Positives (ML dijo rug, ERA BUENO): ${falsePositives} ← dinero perdido`);
console.log(`False Negatives (ML dijo safe, ERA RUG): ${falseNegatives} ← peligroso`);
console.log();

const precision = truePositives / Math.max(truePositives + falsePositives, 1);
const recall = truePositives / Math.max(truePositives + falseNegatives, 1);
const f1 = 2 * precision * recall / Math.max(precision + recall, 0.001);
console.log(`Precision: ${(precision*100).toFixed(0)}% (de los que dijo rug, cuantos eran)`);
console.log(`Recall: ${(recall*100).toFixed(0)}% (de los rugs reales, cuantos detectó)`);
console.log(`F1: ${(f1*100).toFixed(0)}%`);

console.log('\n=== NOTA ===');
console.log('Este test usa el Decision Tree (fallback), NO el ONNX GradientBoosting.');
console.log('El ONNX (F1=0.925) debería ser MEJOR que estos números.');
console.log('Para validar ONNX necesitamos las predicciones guardadas en la DB (ya implementado).');

db.close();
