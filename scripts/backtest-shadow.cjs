#!/usr/bin/env node
/**
 * Shadow Backtest: Simula qué hubiese pasado si ejecutábamos trades reales
 * con distintas estrategias, usando datos shadow reales.
 *
 * IMPORTANT: Shadow data es OPTIMISTA vs realidad. Adjustments:
 * - Slippage on buy: -2% (real slippage estimado)
 * - Slippage on sell: -2% (real slippage estimado)
 * - ATA overhead: 0.0024 SOL por trade (irrecoverable)
 * - TX fees: 0.0004 SOL por trade (buy + sell)
 * - Shadow entry prices can be slightly better than real execution
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// ============ CONFIG ============
const OVERHEAD_SOL = 0.0024 + 0.0004; // ATA rent + TX fees
const BUY_SLIPPAGE = 0.02;  // 2% worse entry
const SELL_SLIPPAGE = 0.02;  // 2% worse exit
const MAX_CONCURRENT = 1;    // Only 1 trade at a time (real constraint)

// ============ LOAD DATA ============
// Get all closed shadow positions with price logs
const positions = db.prepare(`
  SELECT sp.*, dp.dp_liquidity_usd, dp.source,
         dp.dp_holder_count, dp.dp_top_holder_pct, dp.dp_graduation_time_s,
         dp.dp_creator_reputation, dp.security_score as dp_score
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON (sp.token_mint = dp.base_mint OR sp.token_mint = dp.quote_mint)
    AND dp.base_mint != 'So11111111111111111111111111111111111111112'
    AND dp.quote_mint != dp.base_mint
  WHERE sp.status = 'closed'
    AND sp.peak_multiplier > 0
    AND sp.entry_price > 0
  ORDER BY sp.opened_at ASC
`).all();

console.log(`\n${'='.repeat(80)}`);
console.log('SHADOW BACKTEST — Simulación de Estrategias con Data Real');
console.log(`${'='.repeat(80)}`);
console.log(`\nData: ${positions.length} shadow positions cerradas`);
console.log(`Período: ${new Date(positions[0]?.opened_at).toLocaleString()} — ${new Date(positions[positions.length-1]?.opened_at).toLocaleString()}`);

// Load price logs for each position
const priceLogStmt = db.prepare(`
  SELECT spl.multiplier, spl.sol_reserve, spl.created_at as timestamp, spl.elapsed_ms
  FROM shadow_price_log spl
  JOIN shadow_positions sp ON sp.id = spl.shadow_id
  WHERE sp.token_mint = ?
  ORDER BY spl.created_at ASC
`);

const positionLogs = {};
for (const p of positions) {
  positionLogs[p.token_mint] = priceLogStmt.all(p.token_mint);
}

// ============ OVERVIEW ============
console.log('\n--- DATA OVERVIEW ---');
const rugs = positions.filter(p => p.exit_reason === 'rug_pull_detected');
const timeouts = positions.filter(p => p.exit_reason === 'timeout');
console.log(`Rugs detectados: ${rugs.length} (${(rugs.length/positions.length*100).toFixed(0)}%)`);
console.log(`Timeouts: ${timeouts.length}`);
console.log(`TP1 hit: ${positions.filter(p=>p.tp1_hit).length} (${(positions.filter(p=>p.tp1_hit).length/positions.length*100).toFixed(0)}%)`);
console.log(`TP2 hit: ${positions.filter(p=>p.tp2_hit).length}`);
console.log(`TP3 hit: ${positions.filter(p=>p.tp3_hit).length}`);

// Score distribution
const scoreRanges = {};
positions.forEach(p => {
  const s = p.security_score || 0;
  const range = s < 50 ? '<50' : s < 60 ? '50-59' : s < 65 ? '60-64' : s < 70 ? '65-69' : s < 75 ? '70-74' : s < 80 ? '75-79' : '80+';
  if (!scoreRanges[range]) scoreRanges[range] = { total: 0, rugs: 0, tp1: 0, peaks: [] };
  scoreRanges[range].total++;
  if (p.exit_reason === 'rug_pull_detected') scoreRanges[range].rugs++;
  if (p.tp1_hit) scoreRanges[range].tp1++;
  scoreRanges[range].peaks.push(p.peak_multiplier);
});

console.log('\n--- SCORE DISTRIBUTION ---');
console.log('Range    | Total | Rugs  | Rug%  | TP1%  | Avg Peak');
console.log('-'.repeat(60));
for (const [range, data] of Object.entries(scoreRanges).sort((a,b) => a[0].localeCompare(b[0]))) {
  const avgPeak = data.peaks.reduce((a,b)=>a+b,0) / data.peaks.length;
  console.log(
    `${range.padEnd(8)} | ${String(data.total).padStart(5)} | ${String(data.rugs).padStart(5)} | ${(data.rugs/data.total*100).toFixed(1).padStart(5)}% | ${(data.tp1/data.total*100).toFixed(1).padStart(5)}% | ${avgPeak.toFixed(2)}x`
  );
}

// Liquidity distribution
const liqRanges = {};
positions.forEach(p => {
  const liq = p.dp_liquidity_usd || 0;
  const range = liq < 5000 ? '<5K' : liq < 8000 ? '5-8K' : liq < 10000 ? '8-10K' : liq < 15000 ? '10-15K' : liq < 20000 ? '15-20K' : '20K+';
  if (!liqRanges[range]) liqRanges[range] = { total: 0, rugs: 0, tp1: 0, peaks: [] };
  liqRanges[range].total++;
  if (p.exit_reason === 'rug_pull_detected') liqRanges[range].rugs++;
  if (p.tp1_hit) liqRanges[range].tp1++;
  liqRanges[range].peaks.push(p.peak_multiplier);
});

console.log('\n--- LIQUIDITY DISTRIBUTION ---');
console.log('Range    | Total | Rugs  | Rug%  | TP1%  | Avg Peak');
console.log('-'.repeat(60));
for (const [range, data] of Object.entries(liqRanges).sort()) {
  const avgPeak = data.peaks.reduce((a,b)=>a+b,0) / data.peaks.length;
  console.log(
    `${range.padEnd(8)} | ${String(data.total).padStart(5)} | ${String(data.rugs).padStart(5)} | ${(data.rugs/data.total*100).toFixed(1).padStart(5)}% | ${(data.tp1/data.total*100).toFixed(1).padStart(5)}% | ${avgPeak.toFixed(2)}x`
  );
}

// ============ STRATEGY SIMULATION ============

/**
 * Simulate a strategy on shadow data.
 * Returns PnL assuming position_size SOL per trade.
 */
function simulateStrategy(config) {
  const {
    name,
    positionSize,   // SOL per trade
    minScore,       // Minimum security score to buy
    minLiqUsd,      // Minimum liquidity USD
    tp1Mult, tp1Pct,   // Take profit level 1
    tp2Mult, tp2Pct,   // Take profit level 2
    tp3Mult, tp3Pct,   // Take profit level 3
    trailingPct,        // Trailing stop %
    trailingPostTp1,    // Trailing after TP1
    trailingPostTp2,    // Trailing after TP2 (moon bag)
    stopLossPct,        // Hard stop loss %
    timeoutMin,         // Timeout minutes
    moonBagPct,         // Moon bag retention %
    minTrailingActivation, // Min multiplier before trailing activates
    earlyExitMin,       // Early exit if below entry after N min
    slowGrindMin,       // Slow grind exit if below 1.1x after N min
    postTpFloor,        // Post-TP floor multiplier
    maxConcurrent,      // Max concurrent positions
  } = config;

  let totalPnl = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let rugsTaken = 0;
  let rugsAvoided = 0;
  let winnersSkipped = 0;
  let totalGain = 0;
  let totalLoss = 0;
  let activePositions = 0;
  let openTimes = []; // [opened_at, closed_at]
  const tradeDetails = [];

  for (const pos of positions) {
    const score = pos.security_score || 0;
    const liq = pos.dp_liquidity_usd || 0;
    const isRug = pos.exit_reason === 'rug_pull_detected';

    // Filter: would we buy this?
    if (score < minScore || liq < minLiqUsd) {
      if (pos.tp1_hit && pos.peak_multiplier > 1.3) winnersSkipped++;
      if (isRug) rugsAvoided++;
      continue;
    }

    // Concurrency check: count active positions at this time
    openTimes = openTimes.filter(t => t[1] > pos.opened_at);
    if (openTimes.length >= maxConcurrent) {
      if (pos.tp1_hit && pos.peak_multiplier > 1.3) winnersSkipped++;
      if (isRug) rugsAvoided++;
      continue;
    }

    // We would buy this token
    const logs = positionLogs[pos.token_mint] || [];
    if (logs.length < 3) continue; // Not enough data to simulate

    trades++;

    // Simulate the trade using price logs
    let remainingPct = 100; // % of position remaining
    let tpHits = 0;
    let peakMult = 1.0;
    let pnlSol = 0;
    let soldAtTimeout = false;
    let exitMult = 0;
    const entryTime = logs[0]?.timestamp || pos.opened_at;

    // Adjust entry for slippage (we'd buy slightly worse)
    const slippageAdj = 1 + BUY_SLIPPAGE; // multipliers are relative, so our entry is worse

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      const mult = log.multiplier / slippageAdj; // Adjusted for buy slippage
      const elapsed = (log.timestamp - entryTime) / 60000; // minutes

      if (mult > peakMult) peakMult = mult;

      // TP1
      if (tpHits === 0 && mult >= tp1Mult && remainingPct > 0) {
        const sellPct = Math.min(tp1Pct, remainingPct);
        const sellMult = mult * (1 - SELL_SLIPPAGE); // sell slippage
        pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
        remainingPct -= sellPct;
        tpHits = 1;
      }

      // TP2
      if (tpHits === 1 && mult >= tp2Mult && remainingPct > 0) {
        const sellPct = Math.min(tp2Pct, remainingPct);
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
        remainingPct -= sellPct;
        tpHits = 2;
      }

      // TP3
      if (tpHits === 2 && mult >= tp3Mult && remainingPct > 0) {
        const sellPct = Math.min(tp3Pct, remainingPct);
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
        remainingPct -= sellPct;
        tpHits = 3;
      }

      // Hard stop loss
      if (mult <= (1 + stopLossPct / 100) && tpHits === 0 && remainingPct > 0) {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        exitMult = mult;
        remainingPct = 0;
        break;
      }

      // Trailing stop
      const effectiveTrailing = tpHits >= 2 ? trailingPostTp2 : tpHits >= 1 ? trailingPostTp1 : trailingPct;
      if (peakMult >= (minTrailingActivation || 1.12) && remainingPct > 0) {
        const dropFromPeak = (peakMult - mult) / peakMult * 100;
        if (dropFromPeak >= effectiveTrailing) {
          // Moon bag logic
          const moonBag = tpHits >= 1 ? moonBagPct : 0;
          const sellPct = Math.min(remainingPct - (moonBag > 0 ? Math.min(moonBag, remainingPct) : 0), remainingPct);
          if (sellPct > 0) {
            const sellMult = mult * (1 - SELL_SLIPPAGE);
            pnlSol += (sellMult - 1) * (positionSize * sellPct / 100);
            remainingPct -= sellPct;
            exitMult = mult;
          }
          if (remainingPct <= moonBagPct + 1) {
            // Moon bag continues...
          }
        }
      }

      // Post-TP floor
      if (tpHits >= 1 && mult < postTpFloor && remainingPct > 0) {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        exitMult = mult;
        remainingPct = 0;
        break;
      }

      // Early exit (3min+ no TP + below entry)
      if (earlyExitMin > 0 && elapsed >= earlyExitMin && tpHits === 0 && mult < 1.0 && remainingPct > 0) {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        exitMult = mult;
        remainingPct = 0;
        break;
      }

      // Slow grind exit (5min+ no TP + below 1.1x)
      if (slowGrindMin > 0 && elapsed >= slowGrindMin && tpHits === 0 && mult < 1.1 && remainingPct > 0) {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        exitMult = mult;
        remainingPct = 0;
        break;
      }

      // Rug detection (reserve-based)
      if (isRug && i >= logs.length - 3 && remainingPct > 0) {
        // Simulate rug: lose remaining position (sell at ~0)
        // In reality, rug = pool drained, sell gets nothing or almost nothing
        pnlSol += (0 - 1) * (positionSize * remainingPct / 100); // Total loss of remaining
        exitMult = 0;
        remainingPct = 0;
        rugsTaken++;
        break;
      }

      // Timeout
      if (elapsed >= timeoutMin && remainingPct > 0) {
        const sellMult = mult * (1 - SELL_SLIPPAGE);
        pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        exitMult = mult;
        remainingPct = 0;
        soldAtTimeout = true;
        break;
      }
    }

    // If still holding at end of data, sell at final price
    if (remainingPct > 0) {
      const lastLog = logs[logs.length - 1];
      if (lastLog) {
        const mult = lastLog.multiplier / slippageAdj;
        if (isRug) {
          // Rug: lose everything remaining
          pnlSol += (0 - 1) * (positionSize * remainingPct / 100);
          rugsTaken++;
        } else {
          const sellMult = mult * (1 - SELL_SLIPPAGE);
          pnlSol += (sellMult - 1) * (positionSize * remainingPct / 100);
        }
      }
    }

    // Subtract overhead
    pnlSol -= OVERHEAD_SOL;

    totalPnl += pnlSol;
    if (pnlSol > 0) { wins++; totalGain += pnlSol; }
    else { losses++; totalLoss += pnlSol; }

    openTimes.push([pos.opened_at, pos.closed_at || pos.opened_at + timeoutMin * 60000]);

    tradeDetails.push({
      token: pos.token_mint.substring(0, 8),
      score: score,
      liq: Math.round(liq),
      peak: peakMult,
      pnl: pnlSol,
      isRug: isRug,
      tpHits: tpHits,
    });
  }

  const winRate = trades > 0 ? (wins / trades * 100) : 0;
  const avgWin = wins > 0 ? totalGain / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;
  const rr = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const ev = trades > 0 ? totalPnl / trades : 0;

  return {
    name,
    trades,
    wins,
    losses,
    winRate,
    totalPnl,
    avgWin,
    avgLoss,
    rr,
    ev,
    rugsTaken,
    rugsAvoided,
    winnersSkipped,
    tradeDetails,
  };
}

// ============ DEFINE STRATEGIES ============

const strategies = [
  // Current v9d strategy
  {
    name: 'v9d ACTUAL (score>=75, liq>=10K)',
    positionSize: 0.02,
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // v8t strategy (old)
  {
    name: 'v8t OLD (score>=75, liq>=10K, trail 25%)',
    positionSize: 0.02,
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 2.0, tp2Pct: 25,
    tp3Mult: 4.0, tp3Pct: 25,
    trailingPct: 25, trailingPostTp1: 20, trailingPostTp2: 15,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // Aggressive: lower score, lower liq
  {
    name: 'AGGRESSIVE (score>=50, liq>=5K)',
    positionSize: 0.02,
    minScore: 50, minLiqUsd: 5000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // Conservative: higher score
  {
    name: 'CONSERVATIVE (score>=80, liq>=10K)',
    positionSize: 0.02,
    minScore: 80, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // No filter at all (buy everything)
  {
    name: 'NO FILTER (score>=0, liq>=0)',
    positionSize: 0.02,
    minScore: 0, minLiqUsd: 0,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // Liq only filter
  {
    name: 'LIQ ONLY (score>=0, liq>=10K)',
    positionSize: 0.02,
    minScore: 0, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // Score only, no liq filter
  {
    name: 'SCORE ONLY (score>=60, no liq filter)',
    positionSize: 0.02,
    minScore: 60, minLiqUsd: 0,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  // Score>=65 + liq>=7K (middle ground)
  {
    name: 'MEDIUM (score>=65, liq>=7K)',
    positionSize: 0.02,
    minScore: 65, minLiqUsd: 7000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  // Score>=60 + liq>=10K (more trades)
  {
    name: 'RELAXED SCORE (score>=60, liq>=10K)',
    positionSize: 0.02,
    minScore: 60, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  // v9d with concurrent=3
  {
    name: 'v9d + liq>=8K (match PumpSwap block)',
    positionSize: 0.02,
    minScore: 75, minLiqUsd: 8000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 3,
  },
  // Quick scalp: faster exit
  {
    name: 'QUICK SCALP (TP1 only @1.15x, sell 100%)',
    positionSize: 0.02,
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.15, tp1Pct: 100,
    tp2Mult: 99, tp2Pct: 0,
    tp3Mult: 99, tp3Pct: 0,
    trailingPct: 8, trailingPostTp1: 5, trailingPostTp2: 5,
    stopLossPct: -15,
    timeoutMin: 5,
    moonBagPct: 0,
    minTrailingActivation: 1.08,
    earlyExitMin: 2,
    slowGrindMin: 3,
    postTpFloor: 1.05,
    maxConcurrent: 1,
  },
  // Higher position size
  {
    name: 'v9d + 0.05 SOL (lower overhead %)',
    positionSize: 0.05,
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 1,
  },
  // Sell all at TP1 (no trailing)
  {
    name: 'ALL-IN TP1 (sell 100% @1.2x)',
    positionSize: 0.02,
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 100,
    tp2Mult: 99, tp2Pct: 0,
    tp3Mult: 99, tp3Pct: 0,
    trailingPct: 10, trailingPostTp1: 5, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 0,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.0,
    maxConcurrent: 1,
  },
  // v9d with concurrent=3
  {
    name: 'v9d + 3 CONCURRENT',
    positionSize: 0.02,
    minScore: 75, minLiqUsd: 10000,
    tp1Mult: 1.2, tp1Pct: 50,
    tp2Mult: 1.5, tp2Pct: 30,
    tp3Mult: 3.0, tp3Pct: 20,
    trailingPct: 10, trailingPostTp1: 8, trailingPostTp2: 5,
    stopLossPct: -30,
    timeoutMin: 12,
    moonBagPct: 25,
    minTrailingActivation: 1.12,
    earlyExitMin: 3,
    slowGrindMin: 5,
    postTpFloor: 1.15,
    maxConcurrent: 3,
  },
];

// ============ RUN ALL STRATEGIES ============
console.log('\n' + '='.repeat(110));
console.log('RESULTADOS DE ESTRATEGIAS (con slippage 2%, overhead 0.0028 SOL/trade)');
console.log('='.repeat(110));
console.log(
  'Estrategia'.padEnd(42) + '|' +
  ' Trades'.padStart(7) + ' |' +
  ' WinR%'.padStart(7) + ' |' +
  '  PnL SOL'.padStart(10) + ' |' +
  ' EV/trade'.padStart(10) + ' |' +
  ' R:R'.padStart(5) + ' |' +
  ' Rugs'.padStart(5) + ' |' +
  ' Avoid'.padStart(6) + ' |' +
  ' Skip$'.padStart(6) + ' |'
);
console.log('-'.repeat(110));

const results = [];
for (const strategy of strategies) {
  const result = simulateStrategy(strategy);
  results.push(result);
  console.log(
    result.name.padEnd(42) + '|' +
    String(result.trades).padStart(7) + ' |' +
    result.winRate.toFixed(1).padStart(6) + '% |' +
    (result.totalPnl >= 0 ? '+' : '') + result.totalPnl.toFixed(4).padStart(9) + ' |' +
    (result.ev >= 0 ? '+' : '') + result.ev.toFixed(5).padStart(9) + ' |' +
    result.rr.toFixed(2).padStart(5) + ' |' +
    String(result.rugsTaken).padStart(5) + ' |' +
    String(result.rugsAvoided).padStart(6) + ' |' +
    String(result.winnersSkipped).padStart(6) + ' |'
  );
}

// ============ BEST STRATEGY ============
const sorted = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
console.log('\n--- RANKING POR PnL ---');
sorted.forEach((r, i) => {
  console.log(`${i+1}. ${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(4)} SOL | ${r.name}`);
});

// ============ INDIVIDUAL TRADE DETAILS FOR BEST ============
const best = sorted[0];
if (best.tradeDetails.length > 0 && best.tradeDetails.length <= 30) {
  console.log(`\n--- TRADES DETALLADOS: ${best.name} ---`);
  console.log('Token    | Score | Liq$   | Peak  | PnL SOL   | Rug? | TPs');
  console.log('-'.repeat(70));
  for (const t of best.tradeDetails) {
    console.log(
      t.token.padEnd(8) + ' | ' +
      String(t.score).padStart(5) + ' | ' +
      ('$' + t.liq).padStart(6) + ' | ' +
      t.peak.toFixed(2).padStart(5) + 'x | ' +
      (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(5).padStart(9) + ' | ' +
      (t.isRug ? 'YES ' : ' no ') + ' | ' +
      t.tpHits
    );
  }
}

// ============ CRITICAL CAVEATS ============
console.log('\n' + '='.repeat(80));
console.log('CAVEATS CRÍTICOS — LEER ANTES DE DECIDIR');
console.log('='.repeat(80));
console.log(`
1. SHADOW ≠ REAL: Shadow asume entry instantáneo al precio spot.
   En realidad: TX demora 0.5-2s, slippage real puede ser 5-10%, no 2%.

2. N=${positions.length} es PEQUEÑO: Cualquier resultado con <20 trades es ANECDÓTICO.
   Un solo trade extremo (70x peak) distorsiona promedios.

3. CONCURRENCY SIMULADA: El modelo de concurrencia es simplificado.
   En realidad hay cooldowns, circuit breakers, y latencia variable.

4. OVERHEAD es FIJO: En realidad varía (CU optimization, ATA reuse).

5. RUG TIMING: Shadow detecta rugs con precio exacto de caída.
   En realidad: detección demora 1-5s, sell TX demora 1-3s,
   para cuando vendés el precio ya bajó más.

6. SESGO DE SUPERVIVENCIA: Solo tenemos ${positions.length} shadow positions.
   Pools que nunca obtuvieron precio (error RPC) no están incluidos.

7. PERÍODO CORTO: ~${((positions[positions.length-1]?.opened_at - positions[0]?.opened_at) / 3600000).toFixed(1)}h de datos.
   Condiciones de mercado cambian hora a hora.

CONCLUSIÓN: Los números son INDICATIVOS, no predictivos.
Si shadow dice +0.01 SOL, real probablemente sea entre -0.01 y +0.005 SOL.
`);

db.close();
