#!/usr/bin/env node
/**
 * BACKTEST MULTI-ESTRATEGIA v2 (Escéptico)
 *
 * Simula 8 estrategias × 3 tamaños de posición usando price logs reales de shadow positions.
 * Aplica ajustes conservadores para ser MENOS optimista que la realidad shadow.
 *
 * Diferencias clave vs backtest-shadow.cjs:
 * - Buy slippage: 3% (no 2%)
 * - Sell slippage: 2% por venta
 * - Rug loss: 60% de posición remaining (no 100%)
 * - Entry delay: skip first 2 data points (~10s)
 * - Trailing stop delay: 1 poll de delay (no instantáneo)
 * - Overhead: 0.0028 SOL fijo
 * - Bootstrap CI (1000x) para cada estrategia con N>=10
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// ============ SKEPTICAL CONFIG ============
const OVERHEAD_SOL = 0.0028;      // ATA rent (0.0024) + TX fees (0.0004)
const BUY_SLIPPAGE = 0.03;        // 3% worse entry (conservative)
const SELL_SLIPPAGE = 0.02;       // 2% worse exit per sell
const RUG_LOSS_PCT = 0.60;        // Lose 60% of remaining on rug (not 100%)
const ENTRY_DELAY_POLLS = 2;      // Skip first 2 data points (~10s real delay)
const TRAILING_DELAY_POLLS = 1;   // 1 poll delay before trailing triggers
const BOOTSTRAP_ITERATIONS = 1000;
const POSITION_SIZES = [0.02, 0.05, 0.10];

// ============ LOAD DATA ============
const positions = db.prepare(`
  SELECT sp.*, dp.dp_liquidity_usd, dp.source as dp_source,
         dp.dp_holder_count, dp.dp_top_holder_pct,
         dp.security_score as dp_score, dp.pool_outcome
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_id = dp.id
  WHERE sp.status = 'closed'
    AND sp.peak_multiplier > 0
    AND sp.entry_price > 0
    AND sp.total_polls >= 3
  ORDER BY sp.opened_at ASC
`).all();

console.log(`\n${'='.repeat(100)}`);
console.log('BACKTEST MULTI-ESTRATEGIA v2 (ESCÉPTICO)');
console.log(`${'='.repeat(100)}`);
console.log(`\nData: ${positions.length} shadow positions cerradas`);
if (positions.length === 0) { console.log('ERROR: No hay datos shadow. Correr bot en shadow mode primero.'); process.exit(1); }
console.log(`Período: ${new Date(positions[0].opened_at).toLocaleString()} — ${new Date(positions[positions.length-1].opened_at).toLocaleString()}`);
console.log(`\nAjustes escépticos:`);
console.log(`  Buy slippage:  ${(BUY_SLIPPAGE*100).toFixed(0)}%`);
console.log(`  Sell slippage: ${(SELL_SLIPPAGE*100).toFixed(0)}%`);
console.log(`  Rug loss:      ${(RUG_LOSS_PCT*100).toFixed(0)}% de posición restante`);
console.log(`  Entry delay:   ${ENTRY_DELAY_POLLS} polls (~${ENTRY_DELAY_POLLS*5}s)`);
console.log(`  Trailing delay:${TRAILING_DELAY_POLLS} poll`);
console.log(`  Overhead:      ${OVERHEAD_SOL} SOL/trade`);

// Load price logs for each position by shadow_id
const priceLogStmt = db.prepare(`
  SELECT multiplier, sol_reserve, elapsed_ms, created_at as timestamp
  FROM shadow_price_log
  WHERE shadow_id = ?
  ORDER BY elapsed_ms ASC
`);

const positionLogs = new Map();
for (const p of positions) {
  const logs = priceLogStmt.all(p.id);
  if (logs.length >= 3) {
    positionLogs.set(p.id, logs);
  }
}

// ============ DATA OVERVIEW ============
console.log('\n--- DATA OVERVIEW ---');
const rugs = positions.filter(p => p.rug_detected === 1 || p.exit_reason === 'rug_pull_detected');
const withLogs = positions.filter(p => positionLogs.has(p.id));
console.log(`Positions con price logs: ${withLogs.length}/${positions.length}`);
console.log(`Rugs: ${rugs.length} (${(rugs.length/positions.length*100).toFixed(1)}%)`);
console.log(`TP1 hit: ${positions.filter(p=>p.tp1_hit).length} (${(positions.filter(p=>p.tp1_hit).length/positions.length*100).toFixed(0)}%)`);
console.log(`TP2 hit: ${positions.filter(p=>p.tp2_hit).length}`);

// Score distribution
const scoreRanges = {};
positions.forEach(p => {
  const s = p.security_score || 0;
  const range = s < 50 ? '<50' : s < 60 ? '50-59' : s < 70 ? '60-69' : s < 75 ? '70-74' : '75+';
  if (!scoreRanges[range]) scoreRanges[range] = { total: 0, rugs: 0, tp1: 0, hasLogs: 0 };
  scoreRanges[range].total++;
  if (p.rug_detected === 1 || p.exit_reason === 'rug_pull_detected') scoreRanges[range].rugs++;
  if (p.tp1_hit) scoreRanges[range].tp1++;
  if (positionLogs.has(p.id)) scoreRanges[range].hasLogs++;
});

console.log('\nRange    | Total | w/Logs | Rugs  | Rug%  | TP1%');
console.log('-'.repeat(56));
for (const [range, data] of Object.entries(scoreRanges).sort()) {
  console.log(
    `${range.padEnd(8)} | ${String(data.total).padStart(5)} | ${String(data.hasLogs).padStart(6)} | ${String(data.rugs).padStart(5)} | ${(data.rugs/data.total*100).toFixed(1).padStart(5)}% | ${(data.tp1/data.total*100).toFixed(1).padStart(5)}%`
  );
}

// Liquidity distribution
const liqRanges = {};
withLogs.forEach(p => {
  const liq = p.dp_liquidity_usd || 0;
  const range = liq < 5000 ? '<5K' : liq < 7000 ? '5-7K' : liq < 10000 ? '7-10K' : liq < 15000 ? '10-15K' : '15K+';
  if (!liqRanges[range]) liqRanges[range] = { total: 0, rugs: 0, tp1: 0 };
  liqRanges[range].total++;
  if (p.rug_detected === 1 || p.exit_reason === 'rug_pull_detected') liqRanges[range].rugs++;
  if (p.tp1_hit) liqRanges[range].tp1++;
});

console.log('\nLiq Range | Total | Rugs  | Rug%  | TP1%');
console.log('-'.repeat(50));
for (const [range, data] of Object.entries(liqRanges).sort()) {
  console.log(
    `${range.padEnd(9)} | ${String(data.total).padStart(5)} | ${String(data.rugs).padStart(5)} | ${(data.rugs/data.total*100).toFixed(1).padStart(5)}% | ${(data.tp1/data.total*100).toFixed(1).padStart(5)}%`
  );
}

// ============ STRATEGY SIMULATION ENGINE ============

/**
 * Simulate a single trade using price logs.
 * Returns PnL in SOL for the given position size.
 */
function simulateTrade(pos, logs, config, positionSize) {
  const {
    tp1Mult, tp1Pct, tp2Mult, tp2Pct, tp3Mult, tp3Pct,
    trailingPct, trailingPostTp1, trailingPostTp2,
    stopLossPct, timeoutMin, moonBagPct,
    earlyExitMin, slowGrindMin, postTpFloor,
  } = config;

  const isRug = pos.rug_detected === 1 || pos.exit_reason === 'rug_pull_detected';

  // Skip entry delay polls (simulate real entry delay)
  const startIdx = Math.min(ENTRY_DELAY_POLLS, logs.length - 1);

  let remainingPct = 100;
  let tpHits = 0;
  let peakMult = 1.0;
  let pnlSol = 0;
  let exitReason = 'end_of_data';
  let trailingTriggerCountdown = 0; // delay counter

  for (let i = startIdx; i < logs.length; i++) {
    const log = logs[i];
    // Adjust multiplier for buy slippage (our effective entry is worse)
    const mult = log.multiplier / (1 + BUY_SLIPPAGE);
    const elapsedMin = log.elapsed_ms / 60000;

    if (mult > peakMult) {
      peakMult = mult;
      trailingTriggerCountdown = TRAILING_DELAY_POLLS; // reset trailing delay on new peak
    }

    // --- EXIT CHECKS (priority order) ---

    // 1. Rug detection (in last 3 polls or reserve-based)
    if (isRug && remainingPct > 0) {
      // Check if we're near the end of the position data (rug happened)
      const reserveDrop = log.sol_reserve && logs[startIdx].sol_reserve
        ? (logs[startIdx].sol_reserve - log.sol_reserve) / logs[startIdx].sol_reserve
        : 0;

      if (i >= logs.length - 3 || reserveDrop > 0.20) {
        // Emergency sell: lose RUG_LOSS_PCT of remaining position
        pnlSol += (-RUG_LOSS_PCT) * (positionSize * remainingPct / 100);
        remainingPct = 0;
        exitReason = 'rug';
        break;
      }
    }

    // 2. Hard stop loss
    if (mult <= (1 + stopLossPct / 100) && tpHits === 0 && remainingPct > 0) {
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
      remainingPct = 0;
      exitReason = 'stop_loss';
      break;
    }

    // 3. TP1
    if (tpHits === 0 && mult >= tp1Mult && remainingPct > 0 && tp1Pct > 0) {
      const sellPct = Math.min(tp1Pct, remainingPct);
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
      remainingPct -= sellPct;
      tpHits = 1;
      if (remainingPct <= 0) { exitReason = 'tp1_full'; break; }
    }

    // 4. TP2
    if (tpHits === 1 && mult >= tp2Mult && remainingPct > 0 && tp2Pct > 0) {
      const sellPct = Math.min(tp2Pct, remainingPct);
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
      remainingPct -= sellPct;
      tpHits = 2;
      if (remainingPct <= 0) { exitReason = 'tp2_full'; break; }
    }

    // 5. TP3
    if (tpHits === 2 && mult >= tp3Mult && remainingPct > 0 && tp3Pct > 0) {
      const sellPct = Math.min(tp3Pct, remainingPct);
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
      remainingPct -= sellPct;
      tpHits = 3;
      if (remainingPct <= 0) { exitReason = 'tp3_full'; break; }
    }

    // 6. Post-TP floor (if TP1+ hit and price drops below floor)
    if (tpHits >= 1 && mult < postTpFloor && remainingPct > 0) {
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
      remainingPct = 0;
      exitReason = 'post_tp_floor';
      break;
    }

    // 7. Trailing stop (with delay)
    const effectiveTrailing = tpHits >= 2 ? trailingPostTp2 : tpHits >= 1 ? trailingPostTp1 : trailingPct;
    if (peakMult >= 1.12 && remainingPct > 0 && trailingTriggerCountdown <= 0) {
      const dropFromPeak = (peakMult - mult) / peakMult * 100;
      if (dropFromPeak >= effectiveTrailing) {
        const moonBag = tpHits >= 1 ? moonBagPct : 0;
        const sellPct = Math.max(0, remainingPct - moonBag);
        if (sellPct > 0) {
          const sellMult = mult * (1 - SELL_SLIPPAGE);
          pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
          remainingPct -= sellPct;
          exitReason = 'trailing_stop';
        }
        if (remainingPct <= moonBagPct + 1) {
          // Moon bag: sell at end of data or on rug
          // Continue tracking but don't exit yet
        }
      }
    }
    if (trailingTriggerCountdown > 0) trailingTriggerCountdown--;

    // 8. Early exit (3min+ no TP + below entry)
    if (earlyExitMin > 0 && elapsedMin >= earlyExitMin && tpHits === 0 && mult < 1.0 && remainingPct > 0) {
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
      remainingPct = 0;
      exitReason = 'early_exit';
      break;
    }

    // 9. Slow grind exit (5min+ no TP + below 1.1x)
    if (slowGrindMin > 0 && elapsedMin >= slowGrindMin && tpHits === 0 && mult < 1.1 && remainingPct > 0) {
      const sellMult = mult * (1 - SELL_SLIPPAGE);
      pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
      remainingPct = 0;
      exitReason = 'slow_grind';
      break;
    }

    // 10. Timeout
    if (elapsedMin >= timeoutMin && remainingPct > 0) {
      // Extended timeout if TP2+
      const effectiveTimeout = tpHits >= 2 ? timeoutMin + 5 : timeoutMin;
      if (elapsedMin >= effectiveTimeout) {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        remainingPct = 0;
        exitReason = 'timeout';
        break;
      }
    }
  }

  // If still holding at end of data, sell at last price
  if (remainingPct > 0) {
    const lastLog = logs[logs.length - 1];
    if (lastLog) {
      const mult = lastLog.multiplier / (1 + BUY_SLIPPAGE);
      if (isRug) {
        pnlSol += (-RUG_LOSS_PCT) * (positionSize * remainingPct / 100);
        exitReason = 'rug_end';
      } else {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        exitReason = 'end_of_data';
      }
      remainingPct = 0;
    }
  }

  // Subtract overhead
  pnlSol -= OVERHEAD_SOL;

  return {
    pnl: pnlSol,
    isWin: pnlSol > 0,
    isRug: isRug && (exitReason === 'rug' || exitReason === 'rug_end'),
    tpHits,
    peakMult,
    exitReason,
    token: pos.token_mint?.substring(0, 8) || '?',
    score: pos.security_score || 0,
    liq: Math.round(pos.dp_liquidity_usd || 0),
  };
}

/**
 * Run a strategy across all positions for a given position size.
 */
function runStrategy(config, positionSize) {
  const { name, minScore, minLiqUsd, maxConcurrent } = config;

  const eligible = [];
  let rugsAvoided = 0;
  let winnersSkipped = 0;

  for (const pos of positions) {
    const score = pos.security_score || 0;
    const liq = pos.dp_liquidity_usd || 0;
    const logs = positionLogs.get(pos.id);
    const isRug = pos.rug_detected === 1 || pos.exit_reason === 'rug_pull_detected';

    if (score < minScore || liq < minLiqUsd) {
      if (pos.tp1_hit && pos.peak_multiplier > 1.3) winnersSkipped++;
      if (isRug) rugsAvoided++;
      continue;
    }

    if (!logs || logs.length < 3) continue;

    eligible.push(pos);
  }

  // Simulate with concurrency limits
  const trades = [];
  const openPositions = []; // [{opened, closed}]

  for (const pos of eligible) {
    // Concurrency check
    const now = pos.opened_at;
    // Remove closed positions
    while (openPositions.length > 0 && openPositions[0].closed <= now) {
      openPositions.shift();
    }
    if (openPositions.length >= maxConcurrent) {
      continue;
    }

    const logs = positionLogs.get(pos.id);
    const result = simulateTrade(pos, logs, config, positionSize);
    trades.push(result);

    const duration = (config.timeoutMin || 12) * 60000;
    openPositions.push({ opened: pos.opened_at, closed: pos.closed_at || pos.opened_at + duration });
    // Keep sorted
    openPositions.sort((a, b) => a.closed - b.closed);
  }

  const wins = trades.filter(t => t.isWin).length;
  const losses = trades.length - wins;
  const rugs = trades.filter(t => t.isRug).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pnls = trades.map(t => t.pnl);
  const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
  const winRate = trades.length > 0 ? (wins / trades.length * 100) : 0;

  // Std dev
  const variance = trades.length > 1
    ? pnls.reduce((s, p) => s + (p - avgPnl) ** 2, 0) / (trades.length - 1)
    : 0;
  const stdPnl = Math.sqrt(variance);
  const sharpe = stdPnl > 0 ? avgPnl / stdPnl : 0;

  // Max drawdown (cumulative)
  let peak = 0;
  let maxDD = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    name,
    positionSize,
    n: trades.length,
    wins,
    losses,
    winRate,
    totalPnl,
    avgPnl,
    stdPnl,
    sharpe,
    maxDD,
    rugs,
    rugsAvoided,
    winnersSkipped,
    trades,
    pnls,
  };
}

/**
 * Bootstrap confidence interval (1000x resampling)
 */
function bootstrapCI(pnls, iterations = BOOTSTRAP_ITERATIONS) {
  if (pnls.length < 5) return { median: 0, p5: 0, p95: 0, pctNegative: 100 };

  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < pnls.length; j++) {
      sum += pnls[Math.floor(Math.random() * pnls.length)];
    }
    means.push(sum / pnls.length);
  }

  means.sort((a, b) => a - b);
  const p5 = means[Math.floor(iterations * 0.05)];
  const median = means[Math.floor(iterations * 0.50)];
  const p95 = means[Math.floor(iterations * 0.95)];
  const pctNegative = (means.filter(m => m < 0).length / iterations * 100);

  return { median, p5, p95, pctNegative };
}

// ============ DEFINE 8 STRATEGIES ============

const STRATEGIES = [
  {
    name: '1. v9d ACTUAL',
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50, tp2Mult: 1.5, tp2Pct: 30, tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30, timeoutMin: 12, moonBagPct: 25,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  {
    name: '2. RELAXED v9e',
    minScore: 60, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50, tp2Mult: 1.5, tp2Pct: 30, tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30, timeoutMin: 12, moonBagPct: 25,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  {
    name: '3. AGGRESSIVE',
    minScore: 50, minLiqUsd: 7000,
    tp1Mult: 1.2, tp1Pct: 50, tp2Mult: 1.5, tp2Pct: 30, tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30, timeoutMin: 12, moonBagPct: 25,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  {
    name: '4. SCALPER',
    minScore: 60, minLiqUsd: 10000,
    tp1Mult: 1.15, tp1Pct: 100, tp2Mult: 99, tp2Pct: 0, tp3Mult: 99, tp3Pct: 0,
    trailingPct: 8, trailingPostTp1: 5, trailingPostTp2: 5,
    stopLossPct: -20, timeoutMin: 8, moonBagPct: 0,
    earlyExitMin: 2, slowGrindMin: 3, postTpFloor: 1.05,
    maxConcurrent: 3,
  },
  {
    name: '5. CONSERVATIVE',
    minScore: 70, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50, tp2Mult: 1.5, tp2Pct: 30, tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30, timeoutMin: 12, moonBagPct: 25,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  {
    name: '6. WIDE TRAIL',
    minScore: 60, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50, tp2Mult: 1.5, tp2Pct: 30, tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 15, trailingPostTp1: 12, trailingPostTp2: 8,
    stopLossPct: -30, timeoutMin: 15, moonBagPct: 25,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  {
    name: '7. HIGH LIQ',
    minScore: 60, minLiqUsd: 15000,
    tp1Mult: 1.2, tp1Pct: 50, tp2Mult: 1.5, tp2Pct: 30, tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30, timeoutMin: 12, moonBagPct: 25,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  {
    name: '8. ALL-IN TP1',
    minScore: 60, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 100, tp2Mult: 99, tp2Pct: 0, tp3Mult: 99, tp3Pct: 0,
    trailingPct: 10, trailingPostTp1: 5, trailingPostTp2: 5,
    stopLossPct: -30, timeoutMin: 12, moonBagPct: 0,
    earlyExitMin: 3, slowGrindMin: 5, postTpFloor: 1.15,
    maxConcurrent: 3,
  },
];

// ============ RUN ALL STRATEGIES × ALL SIZES ============

console.log(`\n${'='.repeat(130)}`);
console.log('RESULTADOS (slippage buy 3%, sell 2%, overhead 0.0028 SOL, rug loss 60%, entry delay 10s)');
console.log('='.repeat(130));

const header =
  'Estrategia'.padEnd(22) + '|' +
  ' Size'.padStart(6) + ' |' +
  '  N'.padStart(4) + ' |' +
  '  W'.padStart(4) + ' |' +
  '  L'.padStart(4) + ' |' +
  '  WR%'.padStart(6) + ' |' +
  ' Total PnL'.padStart(11) + ' |' +
  ' Avg/trade'.padStart(10) + ' |' +
  ' MaxDD'.padStart(7) + ' |' +
  ' Sharpe'.padStart(7) + ' |' +
  ' Rugs'.padStart(5) + ' |' +
  '  P5%'.padStart(8) + ' |' +
  ' P50%'.padStart(8) + ' |' +
  '  P95%'.padStart(8) + ' |' +
  ' %Neg'.padStart(5) + ' |';

console.log(header);
console.log('-'.repeat(130));

const allResults = [];

for (const strategy of STRATEGIES) {
  for (const size of POSITION_SIZES) {
    const result = runStrategy(strategy, size);

    // Bootstrap CI
    const ci = bootstrapCI(result.pnls);

    allResults.push({ ...result, ci });

    const sizeStr = size.toFixed(2);
    const pnlStr = (result.totalPnl >= 0 ? '+' : '') + result.totalPnl.toFixed(4);
    const avgStr = (result.avgPnl >= 0 ? '+' : '') + result.avgPnl.toFixed(5);
    const ddStr = '-' + result.maxDD.toFixed(4);
    const sharpeStr = result.sharpe.toFixed(2);
    const p5Str = (ci.p5 >= 0 ? '+' : '') + ci.p5.toFixed(5);
    const p50Str = (ci.median >= 0 ? '+' : '') + ci.median.toFixed(5);
    const p95Str = (ci.p95 >= 0 ? '+' : '') + ci.p95.toFixed(5);
    const negStr = ci.pctNegative.toFixed(0) + '%';

    console.log(
      result.name.padEnd(22) + '|' +
      sizeStr.padStart(6) + ' |' +
      String(result.n).padStart(4) + ' |' +
      String(result.wins).padStart(4) + ' |' +
      String(result.losses).padStart(4) + ' |' +
      (result.winRate.toFixed(1) + '%').padStart(6) + ' |' +
      pnlStr.padStart(11) + ' |' +
      avgStr.padStart(10) + ' |' +
      ddStr.padStart(7) + ' |' +
      sharpeStr.padStart(7) + ' |' +
      String(result.rugs).padStart(5) + ' |' +
      p5Str.padStart(8) + ' |' +
      p50Str.padStart(8) + ' |' +
      p95Str.padStart(8) + ' |' +
      negStr.padStart(5) + ' |'
    );
  }
  // Separator between strategies
  console.log('-'.repeat(130));
}

// ============ RANKING ============

console.log(`\n${'='.repeat(100)}`);
console.log('RANKING POR EV/TRADE (esperanza por operación)');
console.log('='.repeat(100));

const ranked = [...allResults]
  .filter(r => r.n >= 5)
  .sort((a, b) => b.avgPnl - a.avgPnl);

ranked.slice(0, 15).forEach((r, i) => {
  const confident = r.ci.p5 > 0 ? ' *** CONFIABLE (P5>0)' : r.ci.pctNegative < 30 ? ' ** PROMETEDORA' : '';
  console.log(
    `${String(i+1).padStart(2)}. ${(r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(5)} SOL/trade | ` +
    `${r.name} @ ${r.positionSize} SOL | ` +
    `N=${r.n}, WR=${r.winRate.toFixed(0)}%, Rugs=${r.rugs}, P5=${(r.ci.p5 >= 0 ? '+' : '') + r.ci.p5.toFixed(5)}` +
    confident
  );
});

// ============ BEST STRATEGIES AT EACH SIZE ============

console.log(`\n${'='.repeat(100)}`);
console.log('MEJOR ESTRATEGIA POR TAMAÑO DE POSICIÓN');
console.log('='.repeat(100));

for (const size of POSITION_SIZES) {
  const sizeResults = allResults
    .filter(r => r.positionSize === size && r.n >= 5)
    .sort((a, b) => b.avgPnl - a.avgPnl);

  const best = sizeResults[0];
  if (!best) { console.log(`\n${size} SOL: No hay estrategias con N>=5`); continue; }

  console.log(`\n--- ${size} SOL (overhead = ${(OVERHEAD_SOL/size*100).toFixed(1)}% de posición) ---`);
  console.log(`  Mejor: ${best.name}`);
  console.log(`  N=${best.n}, W=${best.wins}, L=${best.losses}, WR=${best.winRate.toFixed(1)}%`);
  console.log(`  Total PnL: ${(best.totalPnl >= 0 ? '+' : '') + best.totalPnl.toFixed(4)} SOL`);
  console.log(`  EV/trade: ${(best.avgPnl >= 0 ? '+' : '') + best.avgPnl.toFixed(5)} SOL`);
  console.log(`  Max Drawdown: -${best.maxDD.toFixed(4)} SOL`);
  console.log(`  Sharpe: ${best.sharpe.toFixed(2)}`);
  console.log(`  Bootstrap: P5=${(best.ci.p5 >= 0 ? '+' : '') + best.ci.p5.toFixed(5)}, Median=${(best.ci.median >= 0 ? '+' : '') + best.ci.median.toFixed(5)}, P95=${(best.ci.p95 >= 0 ? '+' : '') + best.ci.p95.toFixed(5)}`);
  console.log(`  % Bootstrap negativo: ${best.ci.pctNegative.toFixed(1)}%`);

  if (best.ci.p5 > 0) {
    console.log(`  >>> CONFIABLE: P5 > 0 (con 95% de confianza, la estrategia es positiva)`);
  } else if (best.ci.pctNegative < 30) {
    console.log(`  >>> PROMETEDORA: Solo ${best.ci.pctNegative.toFixed(0)}% de probabilidad de ser negativa`);
  } else {
    console.log(`  >>> RIESGOSA: ${best.ci.pctNegative.toFixed(0)}% de probabilidad de ser negativa`);
  }
}

// ============ RISK ASSESSMENT ============

console.log(`\n${'='.repeat(100)}`);
console.log('EVALUACIÓN DE RIESGO (Balance actual: ~0.162 SOL)');
console.log('='.repeat(100));

const CURRENT_BALANCE = 0.162;
const HARD_FLOOR = 0.003;

for (const size of POSITION_SIZES) {
  const maxLossPerTrade = size * 0.60 + OVERHEAD_SOL; // Worst case: 60% rug + overhead
  const tradesToFloor = Math.floor((CURRENT_BALANCE - HARD_FLOOR) / maxLossPerTrade);
  const viable = tradesToFloor >= 3;

  console.log(`\n${size} SOL:`);
  console.log(`  Max loss/trade: ${maxLossPerTrade.toFixed(4)} SOL`);
  console.log(`  Trades antes de hard floor: ${tradesToFloor}`);
  console.log(`  Overhead %: ${(OVERHEAD_SOL/size*100).toFixed(1)}%`);
  console.log(`  ${viable ? 'VIABLE (>=3 trades de margen)' : 'NO VIABLE (<3 trades de margen)'}`);
}

// ============ TRADE DETAILS FOR TOP STRATEGIES ============

console.log(`\n${'='.repeat(100)}`);
console.log('DETALLE DE TRADES — TOP 3 ESTRATEGIAS (0.05 SOL)');
console.log('='.repeat(100));

const top3 = allResults
  .filter(r => r.positionSize === 0.05 && r.n >= 5)
  .sort((a, b) => b.avgPnl - a.avgPnl)
  .slice(0, 3);

for (const strat of top3) {
  console.log(`\n--- ${strat.name} @ ${strat.positionSize} SOL ---`);
  console.log('Token    | Score | Liq$   | Peak  | PnL SOL   | Rug? | TPs | Exit');
  console.log('-'.repeat(80));
  for (const t of strat.trades.slice(0, 30)) {
    console.log(
      t.token.padEnd(8) + ' | ' +
      String(t.score).padStart(5) + ' | ' +
      ('$' + t.liq).padStart(6) + ' | ' +
      t.peakMult.toFixed(2).padStart(5) + 'x | ' +
      (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(5).padStart(9) + ' | ' +
      (t.isRug ? ' RUG' : '  no') + ' | ' +
      ('TP' + t.tpHits).padStart(3) + ' | ' +
      t.exitReason
    );
  }
  if (strat.trades.length > 30) {
    console.log(`... y ${strat.trades.length - 30} trades más`);
  }
}

// ============ RECOMMENDATION ============

console.log(`\n${'='.repeat(100)}`);
console.log('RECOMENDACIÓN FINAL');
console.log('='.repeat(100));

// Find best strategy that's viable with current balance
const viableStrategies = allResults
  .filter(r => {
    const maxLoss = r.positionSize * 0.60 + OVERHEAD_SOL;
    const tradesToFloor = Math.floor((CURRENT_BALANCE - HARD_FLOOR) / maxLoss);
    return tradesToFloor >= 3 && r.n >= 5;
  })
  .sort((a, b) => b.avgPnl - a.avgPnl);

if (viableStrategies.length === 0) {
  console.log('\nNinguna estrategia es viable con el balance actual. Seguir en shadow mode.');
} else {
  const rec = viableStrategies[0];
  const maxLoss = rec.positionSize * 0.60 + OVERHEAD_SOL;
  const tradesToFloor = Math.floor((CURRENT_BALANCE - HARD_FLOOR) / maxLoss);

  console.log(`\nMejor estrategia viable: ${rec.name} @ ${rec.positionSize} SOL`);
  console.log(`  N=${rec.n}, WR=${rec.winRate.toFixed(1)}%, EV=${(rec.avgPnl >= 0 ? '+' : '') + rec.avgPnl.toFixed(5)} SOL/trade`);
  console.log(`  Total PnL backtest: ${(rec.totalPnl >= 0 ? '+' : '') + rec.totalPnl.toFixed(4)} SOL`);
  console.log(`  Bootstrap P5: ${(rec.ci.p5 >= 0 ? '+' : '') + rec.ci.p5.toFixed(5)}`);
  console.log(`  Trades antes de floor: ${tradesToFloor}`);

  if (rec.ci.p5 > 0) {
    console.log(`\n  >>> ACTIVAR: P5 > 0 indica rentabilidad con 95% confianza`);
    console.log(`  >>> Config: shadow_mode=false, max_position_sol=${rec.positionSize}, min_score=${STRATEGIES.find(s => s.name === rec.name)?.minScore || '?'}`);
  } else if (rec.ci.pctNegative < 40) {
    console.log(`\n  >>> CONSIDERAR: ${rec.ci.pctNegative.toFixed(0)}% prob negativa. Podría activarse con cuidado.`);
    console.log(`  >>> Alternativa: Seguir en shadow 24h más, recolectar N>=50`);
  } else {
    console.log(`\n  >>> NO ACTIVAR: ${rec.ci.pctNegative.toFixed(0)}% prob negativa. Seguir en shadow.`);
  }
}

// ============ CAVEATS ============

console.log(`\n${'='.repeat(100)}`);
console.log('CAVEATS CRÍTICOS — LEER ANTES DE DECIDIR');
console.log('='.repeat(100));
console.log(`
1. N=${positions.length} TOTAL, muchas estrategias filtran a N<20 = ANECDÓTICO
2. Shadow ≠ Real: entry instantáneo, sin competencia, sin RPC errors
3. 3% buy slippage es CONSERVADOR pero puede ser 5-10% en tokens ilíquidos
4. Bootstrap CI con N<20 tiene intervalos MUY amplios
5. Data de ~${Math.round((positions[positions.length-1].opened_at - positions[0].opened_at) / 3600000)}h = condiciones de mercado no representativas
6. Con 0.162 SOL balance, 0.05 SOL/trade = 3 trades antes de floor
7. NUNCA decir "el bot es rentable" hasta 50+ trades reales con PnL positivo
8. Los resultados de este backtest son TENTATIVOS, no definitivos
`);

db.close();
console.log('Done.\n');
