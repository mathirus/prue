#!/usr/bin/env node
/**
 * Analyze hypothetical 20s delay strategy vs current strategy
 *
 * Current: buy at detection (~0s), TP at 1.08x from entry
 * Delayed: buy 20s after detection IF pool alive and mul > 1.0, TP at 1.08x from delayed entry
 *
 * Key: if we buy at t20 price, our TP1 needs peak >= t20_mul * 1.08
 * The "upside from delayed entry" = peak_multiplier / t20_mul
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// === 1. Get all v11o+ closed positions ===
const positions = db.prepare(`
  SELECT p.id, p.token_mint, p.exit_reason, p.pnl_pct, p.peak_multiplier,
         p.sol_invested, p.bot_version, p.pnl_sol,
         p.opened_at, p.closed_at
  FROM positions p
  WHERE p.bot_version >= 'v11o' AND p.status IN ('closed','stopped')
  ORDER BY p.opened_at
`).all();

// === 2. Get tick near 20s for each position ===
const tickQuery = db.prepare(`
  SELECT multiplier, elapsed_ms, sol_reserve
  FROM position_price_log
  WHERE position_id = ?
  ORDER BY ABS(elapsed_ms - 20000)
  LIMIT 1
`);

const tickNear10s = db.prepare(`
  SELECT multiplier, elapsed_ms, sol_reserve
  FROM position_price_log
  WHERE position_id = ? AND elapsed_ms BETWEEN 8000 AND 15000
  ORDER BY ABS(elapsed_ms - 10000)
  LIMIT 1
`);

const allTicks = db.prepare(`
  SELECT multiplier, elapsed_ms, sol_reserve
  FROM position_price_log
  WHERE position_id = ?
  ORDER BY elapsed_ms
`);

// === 3. Categorize each position ===
const TP_MULTIPLIER = 1.08; // Current TP1
const OVERHEAD_SOL = 0.0024; // ATA rent + TX fees per trade

console.log('='.repeat(100));
console.log('ANALISIS: ESTRATEGIA DE DELAY 20s vs ENTRADA INMEDIATA');
console.log('='.repeat(100));
console.log('');
console.log('Hipotesis: esperar 20s post-deteccion filtra rugs rapidos pero reduce upside en winners');
console.log('Current: comprar al detectar (~0s), TP1 a 1.08x del entry price');
console.log('Delayed: comprar a los 20s SI pool vivo Y mul > 1.0, TP1 a 1.08x del delayed entry');
console.log('');

// Classify
function classify(p) {
  if (p.pnl_pct <= -90) return 'RUG';
  if (p.exit_reason === 'tp_complete') return 'WIN';
  return 'OTHER'; // trailing_stop, dust_skip, sell_burst, etc.
}

let results = [];

for (const p of positions) {
  const cat = classify(p);
  const ticks = allTicks.all(p.id);
  const t20raw = tickQuery.get(p.id);

  // Only use tick if it's between 8s and 30s (reasonable proxy for 20s)
  let t20 = null;
  if (t20raw && t20raw.elapsed_ms >= 8000 && t20raw.elapsed_ms <= 30000) {
    t20 = t20raw;
  }

  const t10raw = tickNear10s.get(p.id);

  // Check if we'd even enter at 20s
  let delayed_would_enter = false;
  let delayed_entry_mul = null;
  let delayed_remaining_upside = null;
  let delayed_would_hit_tp = false;
  let delayed_pnl_pct = null;

  if (t20 && t20.multiplier > 0.98) { // Would enter if pool alive (mul > 0.98 to account for noise)
    delayed_would_enter = true;
    delayed_entry_mul = t20.multiplier;

    // Remaining upside from delayed entry to peak
    if (p.peak_multiplier) {
      delayed_remaining_upside = p.peak_multiplier / delayed_entry_mul;
      delayed_would_hit_tp = delayed_remaining_upside >= TP_MULTIPLIER;
    }

    // For rugs: they'd still enter and lose (entry at t20 price, then rug to 0)
    if (cat === 'RUG') {
      delayed_pnl_pct = -100; // Rug is still -100%
    } else if (delayed_would_hit_tp) {
      // Would still hit TP, but at a higher price, so absolute PnL scaled by entry price
      // TP sell price = entry * TP_MULTIPLIER
      // If entry is at t20_mul (relative to original), then
      // actual gain % from delayed entry = TP_MULTIPLIER - 1 = 8%
      delayed_pnl_pct = (TP_MULTIPLIER - 1) * 100;
    } else {
      // Wouldn't hit TP from delayed entry. What happens?
      // We'd get trailing_stop at some lower value
      // Best proxy: the PnL would be scaled by (peak_mul/t20_mul - 1) but with trailing stop
      if (p.peak_multiplier) {
        // Rough approximation: if original PnL was X% with entry at 1.0,
        // delayed PnL = (peak_from_t20 * original_exit_fraction) - 1
        // This is complex. Use simpler model:
        // delayed_exit_mul ~= original pnl_pct adjusted by entry price shift
        // pnl_delayed = (1 + pnl_original/100) / t20.multiplier - 1
        const original_exit_mul = 1 + p.pnl_pct / 100;
        delayed_pnl_pct = (original_exit_mul / delayed_entry_mul - 1) * 100;
      } else {
        delayed_pnl_pct = p.pnl_pct; // fallback
      }
    }
  }

  results.push({
    id: p.id,
    mint: p.token_mint.substring(0, 10),
    cat,
    exit_reason: p.exit_reason,
    pnl_pct: p.pnl_pct,
    pnl_sol: p.pnl_sol,
    peak_mul: p.peak_multiplier,
    sol_invested: p.sol_invested,
    version: p.bot_version,
    t20_mul: t20 ? t20.multiplier : null,
    t20_sec: t20 ? (t20.elapsed_ms / 1000).toFixed(1) : null,
    t20_reserve: t20 ? t20.sol_reserve : null,
    has_t20: !!t20,
    delayed_would_enter,
    delayed_entry_mul,
    delayed_remaining_upside,
    delayed_would_hit_tp,
    delayed_pnl_pct,
    tick_count: ticks.length,
    last_tick_ms: ticks.length > 0 ? ticks[ticks.length - 1].elapsed_ms : 0,
  });
}

// === 4. Summary Statistics ===

const rugs = results.filter(r => r.cat === 'RUG');
const wins = results.filter(r => r.cat === 'WIN');
const others = results.filter(r => r.cat === 'OTHER');

console.log('--- DATASET OVERVIEW ---');
console.log(`Total positions: N=${results.length}`);
console.log(`  WINS (tp_complete):  N=${wins.length}`);
console.log(`  RUGS (pnl <= -90%):  N=${rugs.length}`);
console.log(`  OTHER (trail/dust):  N=${others.length}`);
console.log('');

// === 5. RUGS at 20s ===
console.log('='.repeat(100));
console.log('RUGS A LOS 20s: Estan muertos o vivos?');
console.log('='.repeat(100));
console.log('');

for (const r of rugs) {
  const status = !r.has_t20
    ? 'NO DATA at 20s (died <10s?)'
    : r.t20_mul >= 1.02
      ? `ALIVE (${r.t20_mul.toFixed(4)}x, reserva ${r.t20_reserve?.toFixed(1) || '?'})`
      : r.t20_mul >= 0.98
        ? `FLAT  (${r.t20_mul.toFixed(4)}x, reserva ${r.t20_reserve?.toFixed(1) || '?'})`
        : `DYING (${r.t20_mul.toFixed(4)}x, reserva ${r.t20_reserve?.toFixed(1) || '?'})`;

  console.log(`  ${r.mint} | peak ${(r.peak_mul || 0).toFixed(3)}x | t20=${r.t20_mul?.toFixed(4) || 'N/A'} | ${status} | ${r.version}`);
}

const rugsWithT20 = rugs.filter(r => r.has_t20);
const rugsAliveAt20 = rugsWithT20.filter(r => r.t20_mul >= 1.0);
const rugsAbove102 = rugsWithT20.filter(r => r.t20_mul >= 1.02);
const rugsNoT20 = rugs.filter(r => !r.has_t20);

console.log('');
console.log(`Rugs con tick a ~20s: ${rugsWithT20.length}/${rugs.length}`);
console.log(`  Vivos (mul >= 1.0):  ${rugsAliveAt20.length}/${rugsWithT20.length} (${(rugsAliveAt20.length/rugsWithT20.length*100).toFixed(0)}%)`);
console.log(`  Arriba 1.02x:       ${rugsAbove102.length}/${rugsWithT20.length} (${(rugsAbove102.length/rugsWithT20.length*100).toFixed(0)}%)`);
console.log(`  Sin data a 20s:     ${rugsNoT20.length} (murieron rapido)`);
console.log('');
console.log('CONCLUSION RUGS: La mayoria de rugs estan VIVOS a los 20s.');
console.log('Un delay de 20s NO evitaria la mayoria de los rugs.');
console.log('');

// === 6. WINNERS at 20s ===
console.log('='.repeat(100));
console.log('WINNERS A LOS 20s: Cuanto upside queda?');
console.log('='.repeat(100));
console.log('');

// Group winners by t20 availability
const winsWithT20 = wins.filter(r => r.has_t20);
const winsNoT20 = wins.filter(r => !r.has_t20);

console.log(`Winners con tick a ~20s: ${winsWithT20.length}/${wins.length}`);
console.log(`Winners SIN tick a 20s (cerraron rapido): ${winsNoT20.length}/${wins.length}`);
console.log('');

console.log('--- Winners con data a 20s ---');
console.log(String('Mint').padEnd(12) + String('Peak').padStart(7) + String('t20_mul').padStart(9) +
            String('Upside').padStart(9) + String('HitTP?').padStart(8) + String('Size').padStart(7) +
            String('Ver').padStart(6));

for (const r of winsWithT20) {
  const upside = r.delayed_remaining_upside;
  console.log(
    r.mint.padEnd(12) +
    (r.peak_mul || 0).toFixed(3).padStart(7) +
    r.t20_mul.toFixed(4).padStart(9) +
    (upside ? upside.toFixed(3) : 'N/A').padStart(9) +
    (r.delayed_would_hit_tp ? 'YES' : 'NO').padStart(8) +
    r.sol_invested.toFixed(3).padStart(7) +
    r.version.padStart(6)
  );
}

const wouldHitTP = winsWithT20.filter(r => r.delayed_would_hit_tp);
const wouldNotHitTP = winsWithT20.filter(r => !r.delayed_would_hit_tp);

console.log('');
console.log(`Winners que TODAVIA alcanzan TP1 a 20s:     ${wouldHitTP.length}/${winsWithT20.length} (${(wouldHitTP.length/winsWithT20.length*100).toFixed(0)}%)`);
console.log(`Winners que ya NO alcanzan TP1 a 20s:       ${wouldNotHitTP.length}/${winsWithT20.length} (${(wouldNotHitTP.length/winsWithT20.length*100).toFixed(0)}%)`);
console.log(`Winners sin data a 20s (cerraron <10s):     ${winsNoT20.length}/${wins.length} — probablemente PERDIDOS con delay`);
console.log('');

console.log('--- Winners SIN data a 20s (cerrados antes de 10s) ---');
for (const r of winsNoT20) {
  console.log(`  ${r.mint} | peak ${(r.peak_mul||0).toFixed(3)}x | pnl ${r.pnl_pct.toFixed(1)}% | ${r.tick_count} ticks, last ${r.last_tick_ms}ms | ${r.version}`);
}

// === 7. OTHERS at 20s (trailing_stop, dust_skip, etc) ===
console.log('');
console.log('='.repeat(100));
console.log('OTHERS (trailing_stop, dust_skip, sell_burst) A LOS 20s');
console.log('='.repeat(100));
console.log('');

const othersWithT20 = others.filter(r => r.has_t20);
const othersWouldEnter = othersWithT20.filter(r => r.delayed_would_enter);
const othersProfit = othersWithT20.filter(r => r.pnl_pct > 0);
const othersLoss = othersWithT20.filter(r => r.pnl_pct <= 0);

console.log(`Others con data a 20s: ${othersWithT20.length}/${others.length}`);
console.log(`  Con ganancia (pnl > 0): ${othersProfit.length}`);
console.log(`  Con perdida (pnl <= 0): ${othersLoss.length}`);
console.log(`  Avg t20_mul: ${(othersWithT20.reduce((s,r) => s + r.t20_mul, 0) / othersWithT20.length).toFixed(4)}`);
console.log('');

// === 8. HYPOTHETICAL PnL COMPARISON ===
console.log('='.repeat(100));
console.log('PnL HIPOTETICO: ACTUAL vs DELAY 20s');
console.log('='.repeat(100));
console.log('');

// Current PnL
let currentPnL = 0;
let currentTrades = 0;
for (const r of results) {
  currentPnL += r.pnl_sol || 0;
  currentTrades++;
}

// Delayed PnL simulation
let delayedPnL = 0;
let delayedTrades = 0;
let delayedWins = 0;
let delayedRugs = 0;
let delayedOthers = 0;
let skippedFastWins = 0;
let skippedNoData = 0;
let skippedDeadPool = 0;
let rugsAvoided = 0;
let rugsCaught = 0;

for (const r of results) {
  // Would we enter at 20s?
  if (!r.has_t20) {
    // No data at 20s — position closed too fast OR no price data
    if (r.cat === 'WIN') skippedFastWins++;
    else if (r.cat === 'RUG') rugsAvoided++; // lucky miss
    else skippedNoData++;
    continue; // Skip this trade entirely
  }

  if (r.t20_mul < 0.98) {
    // Pool is dying at 20s — don't enter
    if (r.cat === 'RUG') rugsAvoided++;
    else skippedDeadPool++;
    continue;
  }

  // We'd enter at t20 price
  delayedTrades++;

  if (r.cat === 'RUG') {
    // Still get rugged — we entered but rug came later
    rugsCaught++;
    delayedRugs++;
    delayedPnL += -(r.sol_invested); // lose full position
    continue;
  }

  if (r.cat === 'WIN') {
    // Would we still hit TP?
    if (r.delayed_would_hit_tp) {
      // Yes! TP at 1.08x from delayed entry
      // PnL = sol_invested * (TP_MUL - 1) - overhead
      const gain = r.sol_invested * (TP_MULTIPLIER - 1) - OVERHEAD_SOL;
      delayedPnL += gain;
      delayedWins++;
    } else {
      // No — peak not high enough from delayed entry
      // We'd get trailing_stop exit. Approximate PnL:
      const approxPnL = r.sol_invested * (r.delayed_pnl_pct / 100) - OVERHEAD_SOL;
      delayedPnL += approxPnL;
      if (r.delayed_pnl_pct > 0) delayedWins++;
      else delayedOthers++;
    }
    continue;
  }

  // OTHER: trailing_stop, dust_skip, etc
  if (r.delayed_pnl_pct !== null) {
    const approxPnL = r.sol_invested * (r.delayed_pnl_pct / 100) - OVERHEAD_SOL;
    delayedPnL += approxPnL;
    delayedOthers++;
  }
}

console.log('ESTRATEGIA ACTUAL:');
console.log(`  Trades: ${currentTrades}`);
console.log(`  PnL total: ${(currentPnL * 1000).toFixed(1)} mSOL (${currentPnL.toFixed(4)} SOL)`);
console.log(`  PnL/trade: ${(currentPnL / currentTrades * 1000).toFixed(2)} mSOL`);
console.log(`  Wins: ${wins.length}, Rugs: ${rugs.length}, Others: ${others.length}`);
console.log(`  Win rate: ${(wins.length / currentTrades * 100).toFixed(1)}%`);
console.log(`  Rug rate: ${(rugs.length / currentTrades * 100).toFixed(1)}%`);
console.log('');

console.log('ESTRATEGIA DELAY 20s:');
console.log(`  Trades: ${delayedTrades} (${currentTrades - delayedTrades} filtrados)`);
console.log(`  PnL total: ${(delayedPnL * 1000).toFixed(1)} mSOL (${delayedPnL.toFixed(4)} SOL)`);
console.log(`  PnL/trade: ${delayedTrades > 0 ? (delayedPnL / delayedTrades * 1000).toFixed(2) : 'N/A'} mSOL`);
console.log(`  Wins delayed: ${delayedWins}, Rugs delayed: ${delayedRugs}, Others: ${delayedOthers}`);
console.log(`  Win rate: ${delayedTrades > 0 ? (delayedWins / delayedTrades * 100).toFixed(1) : 'N/A'}%`);
console.log(`  Rug rate: ${delayedTrades > 0 ? (delayedRugs / delayedTrades * 100).toFixed(1) : 'N/A'}%`);
console.log('');

console.log('FILTRADO POR DELAY:');
console.log(`  Rugs evitados (sin data a 20s / pool muerto): ${rugsAvoided}/${rugs.length}`);
console.log(`  Rugs que IGUAL nos agarran:                    ${rugsCaught}/${rugs.length}`);
console.log(`  Winners rapidos PERDIDOS (cerraron <10s):      ${skippedFastWins}/${wins.length}`);
console.log(`  Otros perdidos (sin data/pool muerto):         ${skippedNoData + skippedDeadPool}`);
console.log('');

console.log('DIFERENCIA NETA:');
const delta = delayedPnL - currentPnL;
console.log(`  Delta PnL: ${delta > 0 ? '+' : ''}${(delta * 1000).toFixed(1)} mSOL (${delta > 0 ? '+' : ''}${delta.toFixed(4)} SOL)`);
console.log(`  ${delta > 0 ? 'DELAY ES MEJOR' : 'ENTRADA INMEDIATA ES MEJOR'}`);
console.log('');

// === 9. DETAILED ANALYSIS: What happens to each winner ===
console.log('='.repeat(100));
console.log('DETALLE: IMPACTO EN CADA WINNER');
console.log('='.repeat(100));
console.log('');

console.log('Winners que cerraron antes de 20s (PERDIDOS con delay):');
for (const r of winsNoT20) {
  const pnlMsol = (r.pnl_sol || r.sol_invested * r.pnl_pct / 100) * 1000;
  console.log(`  ${r.mint} | peak ${(r.peak_mul||0).toFixed(3)}x | PnL actual: +${pnlMsol.toFixed(2)} mSOL | ${r.version}`);
}
const lostWinPnL = winsNoT20.reduce((s, r) => s + (r.pnl_sol || r.sol_invested * r.pnl_pct / 100), 0);
console.log(`  TOTAL PnL perdido: ${(lostWinPnL * 1000).toFixed(1)} mSOL`);
console.log('');

console.log('Winners con data a 20s (que TODAVIA alcanzan TP):');
for (const r of wouldHitTP) {
  const origPnL = (r.pnl_sol || r.sol_invested * r.pnl_pct / 100) * 1000;
  const delayPnL = (r.sol_invested * (TP_MULTIPLIER - 1) - OVERHEAD_SOL) * 1000;
  console.log(`  ${r.mint} | t20=${r.t20_mul.toFixed(4)} | upside=${r.delayed_remaining_upside.toFixed(3)}x | orig +${origPnL.toFixed(2)} mSOL → delay +${delayPnL.toFixed(2)} mSOL`);
}
console.log('');

console.log('Winners con data a 20s (que YA NO alcanzan TP):');
for (const r of wouldNotHitTP) {
  const origPnL = (r.pnl_sol || r.sol_invested * r.pnl_pct / 100) * 1000;
  const delayPnL = r.delayed_pnl_pct !== null ? (r.sol_invested * r.delayed_pnl_pct / 100 - OVERHEAD_SOL) * 1000 : 0;
  console.log(`  ${r.mint} | t20=${r.t20_mul.toFixed(4)} | upside=${r.delayed_remaining_upside?.toFixed(3) || 'N/A'}x | orig +${origPnL.toFixed(2)} mSOL → delay ${delayPnL.toFixed(2)} mSOL`);
}
console.log('');

// === 10. WHAT ABOUT OBSERVATION WINDOW? ===
console.log('='.repeat(100));
console.log('CONTEXTO: OBSERVATION WINDOW');
console.log('='.repeat(100));
console.log('');
console.log('El bot YA tiene un observation window de ~10s antes de comprar.');
console.log('Es decir, la "entrada" real ocurre ~12s despues de la deteccion del pool.');
console.log('"20s delay" significaria comprar ~32s despues de pool creation.');
console.log('');
console.log('Los ticks del price_log empiezan DESPUES de la compra:');
console.log('  tick 1 (~0-1s post-compra = ~12s post-deteccion)');
console.log('  tick 2 (~10s post-compra = ~22s post-deteccion)');
console.log('  tick 3 (~20s post-compra = ~32s post-deteccion)');
console.log('');
console.log('Entonces "20s delay" realmente mide "12s de observacion + 20s extra = 32s total"');
console.log('Pero en terminos del price log, tick 2 (~10s post-entry) es el mas relevante');
console.log('porque ya incluye los ~12s de observacion pre-compra.');
console.log('');

// === 11. Alternative: Check t10 (tick 2, ~10s post-entry = ~22s from pool creation) ===
console.log('='.repeat(100));
console.log('ALTERNATIVA: DELAY 10s POST-ENTRY (tick 2, ~22s desde pool creation)');
console.log('='.repeat(100));
console.log('');

// Count rugs still alive at tick 2
const rugsAtT10 = rugs.map(r => {
  const t10 = tickNear10s.get(r.id);
  return { ...r, t10_mul: t10?.multiplier, t10_sec: t10?.elapsed_ms / 1000 };
});

const rugsAliveAtT10 = rugsAtT10.filter(r => r.t10_mul && r.t10_mul >= 1.0);
const rugsDeadAtT10 = rugsAtT10.filter(r => !r.t10_mul || r.t10_mul < 1.0);

console.log('Rugs a tick 2 (~10s post-compra, ~22s post-pool):');
for (const r of rugsAtT10) {
  console.log(`  ${r.mint} | t10=${r.t10_mul?.toFixed(4) || 'N/A'} | peak=${(r.peak_mul||0).toFixed(3)} | ${r.version}`);
}
console.log(`  Vivos (mul >= 1.0): ${rugsAliveAtT10.length}/${rugs.length}`);
console.log(`  Muertos/sin data:   ${rugsDeadAtT10.length}/${rugs.length}`);
console.log('');

// === 12. RUG TIMELINE ANALYSIS ===
console.log('='.repeat(100));
console.log('TIMELINE DE RUGS: Cuando mueren exactamente?');
console.log('='.repeat(100));
console.log('');

for (const r of rugs) {
  const ticks = allTicks.all(r.id);
  console.log(`  ${r.mint} (${r.version}) | peak ${(r.peak_mul||0).toFixed(3)}x | ${ticks.length} ticks`);
  for (const t of ticks) {
    const alive = t.multiplier >= 0.98 ? 'ALIVE' : t.multiplier >= 0.50 ? 'DYING' : 'DEAD';
    console.log(`    ${(t.elapsed_ms/1000).toFixed(1)}s: mul=${t.multiplier.toFixed(4)} res=${t.sol_reserve?.toFixed(1) || 'N/A'} [${alive}]`);
  }
  console.log('');
}

// === 13. KEY INSIGHT: How many rugs are detectable by 20s delay? ===
console.log('='.repeat(100));
console.log('RESUMEN FINAL: RUGS DETECTABLES vs NO-DETECTABLES A 20s');
console.log('='.repeat(100));
console.log('');

const rugsStillTrading20s = rugsWithT20.filter(r => r.t20_mul >= 1.0);
const rugsShowingWeakness20s = rugsWithT20.filter(r => r.t20_mul >= 0.98 && r.t20_mul < 1.0);
const rugsDead20s = rugsWithT20.filter(r => r.t20_mul < 0.98);

console.log(`Total rugs: ${rugs.length}`);
console.log(`  Sin data a 20s (murieron <10s):  ${rugsNoT20.length} -> EVITADOS por delay`);
console.log(`  Pool muerto a 20s (mul < 0.98):  ${rugsDead20s.length} -> EVITADOS por delay`);
console.log(`  Pool debil a 20s (0.98-1.0):     ${rugsShowingWeakness20s.length} -> EVITADOS con threshold 1.0`);
console.log(`  Pool SANO a 20s (mul >= 1.0):    ${rugsStillTrading20s.length} -> INEVITABLE, nos agarran igual`);
console.log('');
console.log(`Rugs evitables: ${rugsNoT20.length + rugsDead20s.length + rugsShowingWeakness20s.length}/${rugs.length} (${((rugsNoT20.length + rugsDead20s.length + rugsShowingWeakness20s.length) / rugs.length * 100).toFixed(0)}%)`);
console.log(`Rugs inevitables: ${rugsStillTrading20s.length}/${rugs.length} (${(rugsStillTrading20s.length / rugs.length * 100).toFixed(0)}%)`);
console.log('');

// SOL impact of avoided vs caught rugs
const avoidedRugSOL = rugs.filter(r => !r.has_t20 || r.t20_mul < 1.0).reduce((s,r) => s + r.sol_invested, 0);
const caughtRugSOL = rugsStillTrading20s.reduce((s,r) => s + r.sol_invested, 0);
console.log(`SOL salvado por rugs evitados: ${(avoidedRugSOL * 1000).toFixed(1)} mSOL`);
console.log(`SOL perdido por rugs inevitables: ${(caughtRugSOL * 1000).toFixed(1)} mSOL`);
console.log('');

// Final comparison
console.log('='.repeat(100));
console.log('VEREDICTO FINAL');
console.log('='.repeat(100));
console.log('');
console.log(`Actual:  ${currentTrades} trades, PnL = ${(currentPnL * 1000).toFixed(1)} mSOL`);
console.log(`Delay:   ${delayedTrades} trades, PnL = ${(delayedPnL * 1000).toFixed(1)} mSOL`);
console.log(`Delta:   ${(delta * 1000).toFixed(1)} mSOL (${delta > 0 ? 'delay gana' : 'delay pierde'})`);
console.log('');

// Per-trade efficiency
if (delayedTrades > 0) {
  console.log(`EV/trade actual:  ${(currentPnL / currentTrades * 1000).toFixed(2)} mSOL`);
  console.log(`EV/trade delay:   ${(delayedPnL / delayedTrades * 1000).toFixed(2)} mSOL`);
  console.log('');
}

console.log('TRADE-OFFS:');
console.log(`  + Rugs evitados: ${rugsAvoided} (ahorra ${(avoidedRugSOL * 1000).toFixed(1)} mSOL)`);
console.log(`  - Winners rapidos perdidos: ${skippedFastWins} (pierde ${(lostWinPnL * 1000).toFixed(1)} mSOL)`);
console.log(`  - Upside reducido en winners restantes por entrar mas alto`);
console.log(`  ~ Rugs que igual nos agarran: ${rugsCaught} (${(caughtRugSOL * 1000).toFixed(1)} mSOL perdido)`);

db.close();
