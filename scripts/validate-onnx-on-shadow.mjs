/**
 * Validate ONNX GradientBoosting classifier against closed shadow positions.
 * Uses the ACTUAL ONNX model (not DT fallback).
 */
import * as ort from 'onnxruntime-node';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'));

// Load ONNX model
const modelPath = path.join(__dirname, '..', 'data', 'rug-classifier.onnx');
const session = await ort.InferenceSession.create(modelPath);
console.log('ONNX model loaded successfully\n');

// Get positions with features
const positions = db.prepare(`
  SELECT sp.*, dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct,
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

console.log(`=== VALIDACION ONNX GradientBoosting vs ${positions.length} TRADES REALES ===\n`);

let correct = 0, wrong = 0;
let tp = 0, tn = 0, fp = 0, fn = 0;
const results = [];

for (const p of positions) {
  const liq = p.dp_liquidity_usd || 0;
  const holders = Math.max(p.dp_holder_count || 1, 1);
  const liqPerHolder = liq / holders;
  const holderLiqInteraction = holders * liq;
  const reserve = p.entry_sol_reserve || 0;
  const secScore = p.security_score || 0;

  // Build 22-feature array (MUST match training order)
  const features = new Float32Array([
    liq,                                    // 0: dp_liquidity_usd
    p.dp_holder_count || 0,                 // 1: dp_holder_count
    p.dp_top_holder_pct || 0,               // 2: dp_top_holder_pct
    p.dp_rugcheck_score || 0,               // 3: dp_rugcheck_score
    (p.dp_honeypot_verified ? 1 : 0),       // 4: dp_honeypot_verified
    (p.dp_mint_auth_revoked ? 1 : 0),       // 5: dp_mint_auth_revoked
    (p.dp_freeze_auth_revoked ? 1 : 0),     // 6: dp_freeze_auth_revoked
    (p.dp_lp_burned ? 1 : 0),              // 7: dp_lp_burned
    p.dp_graduation_time_s || 0,            // 8: dp_graduation_time_s
    p.dp_bundle_penalty || 0,               // 9: dp_bundle_penalty
    p.dp_insiders_count || 0,               // 10: dp_insiders_count
    p.dp_creator_reputation || 0,           // 11: dp_creator_reputation
    p.dp_early_tx_count || 0,               // 12: dp_early_tx_count
    p.dp_tx_velocity || 0,                  // 13: dp_tx_velocity
    p.dp_unique_slots || 0,                 // 14: dp_unique_slots
    liqPerHolder,                           // 15: liq_per_holder
    (p.pool_source === 'pumpswap' ? 1 : 0), // 16: is_pumpswap
    0,                                       // 17: has_creator_funding (not in detected_pools)
    secScore,                               // 18: security_score
    liqPerHolder,                           // 19: liq_per_holder_v2
    holderLiqInteraction,                   // 20: holder_liq_interaction
    Math.abs(p.dp_creator_reputation || 0), // 21: reputation_abs
  ]);

  const tensor = new ort.Tensor('float32', features, [1, 22]);
  const feeds = { float_input: tensor };
  const res = await session.run(feeds);

  const label = Number(res.label.data[0]);
  const probSafe = Number(res.probabilities.data[0]);
  const probRug = Number(res.probabilities.data[1]);
  const predicted = label === 1 ? 'rug' : 'safe';
  const confidence = label === 1 ? probRug : probSafe;
  const actual = p.rug_detected ? 'rug' : 'safe';
  const isCorrect = predicted === actual;

  if (isCorrect) correct++; else wrong++;
  if (predicted === 'rug' && actual === 'rug') tp++;
  if (predicted === 'safe' && actual === 'safe') tn++;
  if (predicted === 'rug' && actual === 'safe') fp++;
  if (predicted === 'safe' && actual === 'rug') fn++;

  results.push({
    mint: p.token_mint.slice(0, 8),
    score: p.security_score,
    liq: Math.round(liq),
    holders: p.dp_holder_count,
    actual,
    predicted,
    confidence: (confidence * 100).toFixed(0) + '%',
    correct: isCorrect ? 'OK' : 'WRONG',
    tp1: p.tp1_hit ? 'Y' : 'n',
    peak: (p.peak_multiplier || 0).toFixed(2) + 'x',
  });
}

console.log('Token    | Score | Liq     | Hold | Real | ONNX dice | Conf | Acierta | TP1 | Peak');
console.log('---------|-------|---------|------|------|-----------|------|---------|-----|------');
for (const r of results) {
  console.log(
    `${r.mint} | ${String(r.score).padStart(5)} | $${String(r.liq).padStart(5)} | ${String(r.holders).padStart(4)} | ${r.actual.padEnd(4)} | ${r.predicted.padEnd(9)} | ${r.confidence.padStart(4)} | ${r.correct.padEnd(7)} | ${r.tp1}   | ${r.peak}`
  );
}

console.log('\n=== RESUMEN ONNX GradientBoosting ===');
console.log(`Total: ${positions.length}`);
console.log(`Correctos: ${correct} (${(correct/positions.length*100).toFixed(0)}%)`);
console.log(`Incorrectos: ${wrong} (${(wrong/positions.length*100).toFixed(0)}%)`);
console.log();
console.log(`True Positives (dijo rug, ERA rug): ${tp}`);
console.log(`True Negatives (dijo safe, ERA safe): ${tn}`);
console.log(`False Positives (dijo rug, ERA BUENO): ${fp} ← ganancia perdida`);
console.log(`False Negatives (dijo safe, ERA RUG): ${fn} ← peligroso`);

const precision = tp / Math.max(tp + fp, 1);
const recall = tp / Math.max(tp + fn, 1);
console.log(`\nPrecision: ${(precision*100).toFixed(0)}%`);
console.log(`Recall: ${(recall*100).toFixed(0)}%`);

// PnL simulation
console.log('\n=== SIMULACION PnL CON ONNX FILTRANDO ===');
const overhead = 0.0028;
for (const size of [0.03, 0.05]) {
  let pnlAll = 0, pnlOnnx = 0, tradesOnnx = 0, wAll = 0, wOnnx = 0;

  for (let i = 0; i < results.length; i++) {
    const p = positions[i];
    const r = results[i];

    let pnl;
    if (p.rug_detected) {
      pnl = -size * 0.6 - overhead;
    } else if (p.tp1_hit) {
      const tp1g = (size * 0.5) * 0.2 * 0.98;
      const restg = (size * 0.5) * ((p.final_multiplier || 1) - 1) * 0.98;
      pnl = tp1g + restg - overhead;
    } else {
      pnl = size * ((p.final_multiplier || 1) - 1) * 0.98 - overhead;
    }

    pnlAll += pnl;
    if (pnl > 0) wAll++;

    if (r.predicted === 'safe') {
      pnlOnnx += pnl;
      tradesOnnx++;
      if (pnl > 0) wOnnx++;
    }
  }

  console.log(`\n  ${size} SOL por trade:`);
  console.log(`  SIN IA:  N=${results.length} W=${wAll} WR=${(wAll/results.length*100).toFixed(0)}% PnL=${pnlAll.toFixed(4)} SOL`);
  console.log(`  CON IA:  N=${tradesOnnx} W=${wOnnx} WR=${tradesOnnx?(wOnnx/tradesOnnx*100).toFixed(0):0}% PnL=${pnlOnnx.toFixed(4)} SOL`);
  console.log(`  Diferencia: ${(pnlOnnx - pnlAll > 0 ? '+' : '')}${(pnlOnnx - pnlAll).toFixed(4)} SOL`);
}

db.close();
