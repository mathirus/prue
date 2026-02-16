#!/usr/bin/env node
/**
 * Comprehensive Exit Strategy Backtester
 * Uses tick-by-tick data from position_price_log to simulate different TP/trailing/time exit combinations
 *
 * Key insight: We reconstruct the price PATH for each position, then simulate
 * what would have happened under different exit rules.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

// Constants
const OVERHEAD_SOL = 0.0024; // ATA rent + TX fees per trade

// ============================================================
// DATA LOADING
// ============================================================

function loadPositionsWithTicks() {
  // Load all closed positions
  const positions = db.prepare(`
    SELECT id, token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct,
           exit_reason, peak_multiplier, entry_price, opened_at, closed_at,
           bot_version, security_score, status
    FROM positions
    WHERE status IN ('closed', 'stopped')
    ORDER BY opened_at
  `).all();

  // Load all ticks for each position
  const tickStmt = db.prepare(`
    SELECT multiplier, sol_reserve, elapsed_ms, sell_count, buy_count, cumulative_sell_count
    FROM position_price_log
    WHERE position_id = ?
    ORDER BY elapsed_ms ASC
  `);

  const result = [];
  for (const pos of positions) {
    const ticks = tickStmt.all(pos.id);
    // Classify the position
    let outcome;
    if (['rug_pull', 'max_retries', 'stranded_timeout_max_retries'].includes(pos.exit_reason)) {
      outcome = 'rug'; // sell failed = total loss
    } else if (pos.exit_reason === 'dust_skip') {
      // dust_skip means sell returned dust - could be honeypot, late rug, or just worthless
      // For backtest: we assume if we sold EARLIER we could have gotten real value
      // The tick data shows the actual price path before the dust exit
      outcome = 'dust_exit';
    } else if (pos.exit_reason === 'early_exit') {
      outcome = 'early_exit';
    } else {
      outcome = 'normal'; // tp_complete, trailing_stop, sell_burst, creator_sell
    }

    result.push({
      ...pos,
      ticks,
      outcome,
      hasTicks: ticks.length > 0
    });
  }
  return result;
}

// ============================================================
// SIMULATION ENGINE
// ============================================================

/**
 * Simulate a position under given exit rules.
 * Returns the simulated PnL in SOL.
 *
 * Rules:
 * - tp1_level: multiplier at which to take TP1
 * - tp1_pct: fraction of position to sell at TP1 (0.5 = 50%)
 * - tp2_level: multiplier for TP2 (if applicable)
 * - tp2_pct: fraction of ORIGINAL position to sell at TP2
 * - trailing_pct: trailing stop percentage for remaining portion (0.15 = 15%)
 * - time_exit_s: if position hasn't hit TP1 after this many seconds AND is below time_exit_floor, sell
 * - time_exit_floor: multiplier floor for time-based exit
 * - rug_total_loss: if true, rug positions lose 100% regardless (can't sell if honeypot)
 */
function simulatePosition(pos, rules) {
  const { tp1_level, tp1_pct, tp2_level, tp2_pct, trailing_pct,
          time_exit_s, time_exit_floor, rug_total_loss } = rules;

  const solInvested = pos.sol_invested;

  // For rug positions (sell completely failed): we can only save money if we exit BEFORE the rug
  // Using tick data to see if any exit rule triggers before the token dies
  const isRug = pos.outcome === 'rug';
  const isDustExit = pos.outcome === 'dust_exit';

  // If no tick data, use actual outcome as-is (can't simulate)
  if (!pos.hasTicks || pos.ticks.length === 0) {
    return {
      pnl_sol: pos.pnl_sol || (isRug ? -solInvested : 0),
      exit_at: null,
      exit_reason_sim: 'no_tick_data',
      sold_portions: []
    };
  }

  let remainingPct = 1.0; // fraction of position still held
  let totalReturned = 0; // SOL returned from sells
  let peakMultAfterTp1 = 0;
  let tp1Hit = false;
  let tp2Hit = false;
  let exitComplete = false;
  let exitReasonSim = '';
  const soldPortions = [];

  // For trailing stop tracking
  let trailingActive = false;
  let postTp1Peak = 0;

  for (let i = 0; i < pos.ticks.length; i++) {
    const tick = pos.ticks[i];
    const mult = tick.multiplier;
    const elapsedS = tick.elapsed_ms / 1000;

    if (exitComplete) break;

    // --- TP1 Check ---
    if (!tp1Hit && mult >= tp1_level) {
      tp1Hit = true;
      const sellPct = Math.min(tp1_pct, remainingPct);
      const solFromSell = solInvested * sellPct * mult;
      totalReturned += solFromSell;
      remainingPct -= sellPct;
      soldPortions.push({ level: tp1_level, pct: sellPct, mult, elapsed_s: elapsedS, sol: solFromSell });

      if (remainingPct <= 0.001) {
        exitComplete = true;
        exitReasonSim = 'tp1_full';
        break;
      }
      trailingActive = true;
      postTp1Peak = mult;
    }

    // --- TP2 Check ---
    if (tp1Hit && !tp2Hit && tp2_level && tp2_pct && mult >= tp2_level) {
      tp2Hit = true;
      const sellPct = Math.min(tp2_pct, remainingPct);
      const solFromSell = solInvested * sellPct * mult;
      totalReturned += solFromSell;
      remainingPct -= sellPct;
      soldPortions.push({ level: tp2_level, pct: sellPct, mult, elapsed_s: elapsedS, sol: solFromSell });

      if (remainingPct <= 0.001) {
        exitComplete = true;
        exitReasonSim = 'tp2_full';
        break;
      }
    }

    // --- Trailing Stop (only after TP1) ---
    if (trailingActive && mult > postTp1Peak) {
      postTp1Peak = mult;
    }
    if (trailingActive && postTp1Peak > 0 && trailing_pct > 0) {
      const dropFromPeak = (postTp1Peak - mult) / postTp1Peak;
      if (dropFromPeak >= trailing_pct) {
        const solFromSell = solInvested * remainingPct * mult;
        totalReturned += solFromSell;
        soldPortions.push({ level: 'trailing', pct: remainingPct, mult, elapsed_s: elapsedS, sol: solFromSell });
        remainingPct = 0;
        exitComplete = true;
        exitReasonSim = 'trailing_stop';
        break;
      }
    }

    // --- Time-based exit (only if TP1 NOT hit) ---
    if (!tp1Hit && time_exit_s && elapsedS >= time_exit_s && mult < time_exit_floor) {
      const solFromSell = solInvested * remainingPct * mult;
      totalReturned += solFromSell;
      soldPortions.push({ level: 'time_exit', pct: remainingPct, mult, elapsed_s: elapsedS, sol: solFromSell });
      remainingPct = 0;
      exitComplete = true;
      exitReasonSim = 'time_exit';
      break;
    }
  }

  // --- Position still open at end of tick data ---
  if (!exitComplete && remainingPct > 0.001) {
    // What happened in reality?
    if (isRug) {
      // Rug: remaining portion lost entirely
      // But if we already sold some at TP1, that's saved
      exitReasonSim = tp1Hit ? 'rug_after_tp1' : 'rug_total';
      // remaining portion = 0 (lost)
    } else if (isDustExit) {
      // Dust exit: token became worthless after ticks ended
      // If we had tick data showing high prices, we could have sold there
      // remaining portion = use last known tick price
      const lastTick = pos.ticks[pos.ticks.length - 1];
      if (lastTick && lastTick.multiplier > 0.5) {
        // Assume we could sell at last tick price (optimistic for dust)
        // In reality: dust means sell failed/returned nothing
        // For conservative backtest: remaining = 0
      }
      exitReasonSim = tp1Hit ? 'dust_after_tp1' : 'dust_total';
      // Conservative: remaining portion = 0 for dust exits too
    } else {
      // Normal exit: use actual outcome for remaining portion
      // Scale the actual PnL by remaining fraction
      const actualReturnPerUnit = pos.sol_returned / pos.sol_invested;
      const solFromRemaining = solInvested * remainingPct * actualReturnPerUnit;
      totalReturned += solFromRemaining;
      exitReasonSim = tp1Hit ? 'actual_after_tp1' : 'actual_no_tp';
    }
  }

  const pnl_sol = totalReturned - solInvested;

  return {
    pnl_sol,
    totalReturned,
    exit_reason_sim: exitReasonSim || 'end_of_ticks',
    sold_portions: soldPortions,
    tp1Hit,
    tp2Hit,
    remainingPct
  };
}

/**
 * For positions WITHOUT tick data, use actual outcome
 * but adjust for TP1 level (if peak_multiplier >= level, assume TP hit)
 */
function simulateNoTickPosition(pos, rules) {
  const { tp1_level, tp1_pct } = rules;
  const solInvested = pos.sol_invested;
  const isRug = pos.outcome === 'rug';

  // If peak_multiplier reached TP1 level
  if (pos.peak_multiplier && pos.peak_multiplier >= tp1_level) {
    if (tp1_pct >= 0.99) {
      // 100% sell at TP1 = guaranteed profit
      const pnl = solInvested * (tp1_level - 1);
      return { pnl_sol: pnl, exit_reason_sim: 'tp1_no_ticks' };
    } else {
      // Partial: TP1 portion saved, rest depends on actual outcome
      const tp1Return = solInvested * tp1_pct * tp1_level;
      const restPct = 1 - tp1_pct;
      let restReturn;
      if (isRug) {
        restReturn = 0; // rug = rest lost
      } else {
        restReturn = solInvested * restPct * (1 + (pos.pnl_pct || 0) / 100);
      }
      const pnl = tp1Return + restReturn - solInvested;
      return { pnl_sol: pnl, exit_reason_sim: 'partial_no_ticks' };
    }
  } else {
    // Didn't reach TP1 - actual outcome applies
    return { pnl_sol: pos.pnl_sol || (isRug ? -solInvested : 0), exit_reason_sim: 'no_tp_no_ticks' };
  }
}

// ============================================================
// STRATEGY DEFINITIONS
// ============================================================

function getStrategies() {
  const strategies = [];

  // === SECTION 1: TP1 Level sweep (100% sell) ===
  const tp1Levels = [1.03, 1.05, 1.08, 1.10, 1.12, 1.15, 1.20, 1.25, 1.30, 1.40, 1.50];
  for (const level of tp1Levels) {
    strategies.push({
      name: `TP1 ${level}x / 100%`,
      group: 'tp1_level',
      rules: {
        tp1_level: level,
        tp1_pct: 1.0,
        tp2_level: null,
        tp2_pct: null,
        trailing_pct: 0,
        time_exit_s: null,
        time_exit_floor: null,
        rug_total_loss: true
      }
    });
  }

  // === SECTION 2: Partial sell combos (TP1 at various levels) ===
  const partialTp1s = [1.08, 1.10, 1.15, 1.20];
  const partialPcts = [0.5, 0.6, 0.7, 0.8];
  const trailingPcts = [0.05, 0.08, 0.10, 0.15, 0.20];

  for (const tp1 of partialTp1s) {
    for (const pct of partialPcts) {
      for (const trail of trailingPcts) {
        strategies.push({
          name: `TP1 ${tp1}x/${Math.round(pct*100)}% + trail ${Math.round(trail*100)}%`,
          group: 'partial',
          rules: {
            tp1_level: tp1,
            tp1_pct: pct,
            tp2_level: null,
            tp2_pct: null,
            trailing_pct: trail,
            time_exit_s: null,
            time_exit_floor: null,
            rug_total_loss: true
          }
        });
      }
    }
  }

  // === SECTION 3: Two-stage TP ===
  const twoStageConfigs = [
    { tp1: 1.10, tp1p: 0.50, tp2: 1.50, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.10, tp1p: 0.50, tp2: 2.00, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.15, tp1p: 0.50, tp2: 1.50, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.15, tp1p: 0.50, tp2: 2.00, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.20, tp1p: 0.50, tp2: 1.50, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.20, tp1p: 0.50, tp2: 2.00, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.20, tp1p: 0.50, tp2: 2.00, tp2p: 0.25, trail: 0.15 },
    { tp1: 1.20, tp1p: 0.60, tp2: 2.00, tp2p: 0.20, trail: 0.10 },
    { tp1: 1.10, tp1p: 0.60, tp2: 1.30, tp2p: 0.20, trail: 0.08 },
    { tp1: 1.10, tp1p: 0.70, tp2: 1.50, tp2p: 0.15, trail: 0.10 },
    { tp1: 1.08, tp1p: 0.50, tp2: 1.20, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.08, tp1p: 0.50, tp2: 1.50, tp2p: 0.25, trail: 0.10 },
    { tp1: 1.15, tp1p: 0.60, tp2: 1.50, tp2p: 0.20, trail: 0.08 },
  ];
  for (const c of twoStageConfigs) {
    strategies.push({
      name: `TP1 ${c.tp1}x/${Math.round(c.tp1p*100)}% + TP2 ${c.tp2}x/${Math.round(c.tp2p*100)}% + trail ${Math.round(c.trail*100)}%`,
      group: 'two_stage',
      rules: {
        tp1_level: c.tp1,
        tp1_pct: c.tp1p,
        tp2_level: c.tp2,
        tp2_pct: c.tp2p,
        trailing_pct: c.trail,
        time_exit_s: null,
        time_exit_floor: null,
        rug_total_loss: true
      }
    });
  }

  // === SECTION 4: Time-based exits (for non-TP positions) ===
  // These combine with the best TP strategies
  const timeExits = [
    { s: 30, floor: 1.0, label: '30s below entry' },
    { s: 60, floor: 1.0, label: '60s below entry' },
    { s: 60, floor: 1.02, label: '60s below 1.02x' },
    { s: 120, floor: 1.0, label: '120s below entry' },
    { s: 120, floor: 1.03, label: '120s below 1.03x' },
    { s: 180, floor: 1.0, label: '180s below entry' },
    { s: 180, floor: 1.05, label: '180s below 1.05x' },
  ];

  for (const te of timeExits) {
    strategies.push({
      name: `TP1 1.08x/100% + TimeExit ${te.label}`,
      group: 'time_exit',
      rules: {
        tp1_level: 1.08,
        tp1_pct: 1.0,
        trailing_pct: 0,
        time_exit_s: te.s,
        time_exit_floor: te.floor,
        rug_total_loss: true
      }
    });
    // Also test with 1.15x TP
    strategies.push({
      name: `TP1 1.15x/100% + TimeExit ${te.label}`,
      group: 'time_exit',
      rules: {
        tp1_level: 1.15,
        tp1_pct: 1.0,
        trailing_pct: 0,
        time_exit_s: te.s,
        time_exit_floor: te.floor,
        rug_total_loss: true
      }
    });
  }

  return strategies;
}

// ============================================================
// BACKTEST RUNNER
// ============================================================

function runBacktest(positions, strategy) {
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let tp1Hits = 0;
  let tp2Hits = 0;
  let rugsSaved = 0; // rugs where we got some money back
  let totalInvested = 0;
  const details = [];

  for (const pos of positions) {
    let result;
    if (pos.hasTicks && pos.ticks.length > 0) {
      result = simulatePosition(pos, strategy.rules);
    } else {
      result = simulateNoTickPosition(pos, strategy.rules);
    }

    totalPnl += result.pnl_sol;
    totalInvested += pos.sol_invested;

    if (result.pnl_sol > 0) wins++;
    else losses++;

    if (result.tp1Hit) tp1Hits++;
    if (result.tp2Hit) tp2Hits++;

    if (pos.outcome === 'rug' && result.pnl_sol > -pos.sol_invested * 0.9) {
      rugsSaved++;
    }

    details.push({
      id: pos.id,
      actual_pnl: pos.pnl_sol,
      sim_pnl: result.pnl_sol,
      delta: result.pnl_sol - (pos.pnl_sol || 0),
      exit_sim: result.exit_reason_sim,
      outcome: pos.outcome
    });
  }

  // Overhead cost: 0.0024 SOL per trade
  const overheadTotal = positions.length * OVERHEAD_SOL;
  const pnlAfterOverhead = totalPnl - overheadTotal;

  return {
    name: strategy.name,
    group: strategy.group,
    totalPnl_mSOL: +(totalPnl * 1000).toFixed(3),
    pnlAfterOverhead_mSOL: +(pnlAfterOverhead * 1000).toFixed(3),
    winRate: +((wins / (wins + losses)) * 100).toFixed(1),
    wins,
    losses,
    tp1Hits,
    tp2Hits,
    rugsSaved,
    n: positions.length,
    avgPnl_mSOL: +((totalPnl / positions.length) * 1000).toFixed(3),
    details
  };
}

// ============================================================
// ANALYSIS HELPERS
// ============================================================

function printSectionHeader(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function printTable(headers, rows, widths) {
  const divider = widths.map(w => '-'.repeat(w)).join('+');
  console.log(divider);
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join('|'));
  console.log(divider);
  for (const row of rows) {
    console.log(row.map((c, i) => String(c).padEnd(widths[i])).join('|'));
  }
  console.log(divider);
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log('COMPREHENSIVE EXIT STRATEGY BACKTEST');
  console.log('====================================');
  console.log(`Database: ${DB_PATH}`);
  console.log(`Date: ${new Date().toISOString()}`);

  // Load data
  const positions = loadPositionsWithTicks();
  const withTicks = positions.filter(p => p.hasTicks && p.ticks.length > 0);
  const withoutTicks = positions.filter(p => !p.hasTicks || p.ticks.length === 0);

  console.log(`\nData Summary:`);
  console.log(`  Total positions: ${positions.length}`);
  console.log(`  With tick data: ${withTicks.length} (${(withTicks.length/positions.length*100).toFixed(0)}%)`);
  console.log(`  Without tick data: ${withoutTicks.length}`);
  console.log(`  Outcomes: rug=${positions.filter(p=>p.outcome==='rug').length}, dust=${positions.filter(p=>p.outcome==='dust_exit').length}, normal=${positions.filter(p=>p.outcome==='normal').length}, early=${positions.filter(p=>p.outcome==='early_exit').length}`);

  // Tick coverage stats
  const tickCounts = withTicks.map(p => p.ticks.length);
  console.log(`  Tick counts: min=${Math.min(...tickCounts)}, median=${tickCounts.sort((a,b)=>a-b)[Math.floor(tickCounts.length/2)]}, max=${Math.max(...tickCounts)}`);
  console.log(`  Avg ticks per position: ${(tickCounts.reduce((a,b)=>a+b,0)/tickCounts.length).toFixed(1)}`);

  // Current strategy baseline
  const actualPnl = positions.reduce((s, p) => s + (p.pnl_sol || 0), 0);
  console.log(`\n  ACTUAL PnL (current strategy): ${(actualPnl * 1000).toFixed(2)} mSOL`);
  console.log(`  Overhead (${positions.length} trades x 2.4 mSOL): ${(positions.length * OVERHEAD_SOL * 1000).toFixed(1)} mSOL`);
  console.log(`  Actual after overhead: ${((actualPnl - positions.length * OVERHEAD_SOL) * 1000).toFixed(2)} mSOL`);

  // Run all strategies
  const strategies = getStrategies();
  console.log(`\nRunning ${strategies.length} strategy combinations...`);

  const results = [];
  for (const strat of strategies) {
    const result = runBacktest(positions, strat);
    results.push(result);
  }

  // Sort by PnL
  results.sort((a, b) => b.totalPnl_mSOL - a.totalPnl_mSOL);

  // ============================================================
  // SECTION 1: TP1 Level Sweep (100% sell)
  // ============================================================
  printSectionHeader('1. TP1 LEVEL SWEEP (sell 100% at TP1)');

  const tp1Results = results.filter(r => r.group === 'tp1_level');
  tp1Results.sort((a, b) => {
    const aLevel = parseFloat(a.name.match(/[\d.]+/)[0]);
    const bLevel = parseFloat(b.name.match(/[\d.]+/)[0]);
    return aLevel - bLevel;
  });

  const tp1Headers = ['Strategy', 'PnL(mSOL)', 'After OH', 'WinRate', 'TP1 Hits', 'AvgPnL', 'Delta'];
  const tp1Widths = [22, 12, 12, 10, 10, 12, 12];
  const tp1Rows = tp1Results.map(r => [
    r.name,
    r.totalPnl_mSOL.toFixed(1),
    r.pnlAfterOverhead_mSOL.toFixed(1),
    r.winRate + '%',
    `${r.tp1Hits}/${r.n}`,
    r.avgPnl_mSOL.toFixed(3),
    (r.totalPnl_mSOL - actualPnl * 1000).toFixed(1)
  ]);
  printTable(tp1Headers, tp1Rows, tp1Widths);

  // ============================================================
  // SECTION 2: Best Partial Sell Combos
  // ============================================================
  printSectionHeader('2. PARTIAL SELL COMBOS (top 30 by PnL)');

  const partialResults = results.filter(r => r.group === 'partial');
  partialResults.sort((a, b) => b.totalPnl_mSOL - a.totalPnl_mSOL);

  const partHeaders = ['Strategy', 'PnL(mSOL)', 'After OH', 'WinRate', 'TP1', 'Rugs$', 'Delta'];
  const partWidths = [40, 12, 12, 10, 6, 8, 12];
  const partRows = partialResults.slice(0, 30).map(r => [
    r.name,
    r.totalPnl_mSOL.toFixed(1),
    r.pnlAfterOverhead_mSOL.toFixed(1),
    r.winRate + '%',
    r.tp1Hits,
    r.rugsSaved,
    (r.totalPnl_mSOL - actualPnl * 1000).toFixed(1)
  ]);
  printTable(partHeaders, partRows, partWidths);

  // ============================================================
  // SECTION 3: Two-Stage TP
  // ============================================================
  printSectionHeader('3. TWO-STAGE TP STRATEGIES');

  const twoStageResults = results.filter(r => r.group === 'two_stage');
  twoStageResults.sort((a, b) => b.totalPnl_mSOL - a.totalPnl_mSOL);

  const tsHeaders = ['Strategy', 'PnL(mSOL)', 'After OH', 'WR', 'TP1', 'TP2', 'Delta'];
  const tsWidths = [55, 12, 12, 8, 6, 6, 12];
  const tsRows = twoStageResults.map(r => [
    r.name,
    r.totalPnl_mSOL.toFixed(1),
    r.pnlAfterOverhead_mSOL.toFixed(1),
    r.winRate + '%',
    r.tp1Hits,
    r.tp2Hits,
    (r.totalPnl_mSOL - actualPnl * 1000).toFixed(1)
  ]);
  printTable(tsHeaders, tsRows, tsWidths);

  // ============================================================
  // SECTION 4: Time-based Exits
  // ============================================================
  printSectionHeader('4. TIME-BASED EXIT COMBOS');

  const timeResults = results.filter(r => r.group === 'time_exit');
  timeResults.sort((a, b) => b.totalPnl_mSOL - a.totalPnl_mSOL);

  const teHeaders = ['Strategy', 'PnL(mSOL)', 'After OH', 'WinRate', 'TP1', 'Delta'];
  const teWidths = [48, 12, 12, 10, 6, 12];
  const teRows = timeResults.map(r => [
    r.name,
    r.totalPnl_mSOL.toFixed(1),
    r.pnlAfterOverhead_mSOL.toFixed(1),
    r.winRate + '%',
    r.tp1Hits,
    (r.totalPnl_mSOL - actualPnl * 1000).toFixed(1)
  ]);
  printTable(teHeaders, teRows, teWidths);

  // ============================================================
  // SECTION 5: GLOBAL TOP 20
  // ============================================================
  printSectionHeader('5. GLOBAL TOP 20 STRATEGIES (all categories)');

  const topHeaders = ['#', 'Strategy', 'PnL(mSOL)', 'After OH', 'WR', 'TP1', 'Delta'];
  const topWidths = [4, 52, 12, 12, 8, 6, 12];
  const topRows = results.slice(0, 20).map((r, i) => [
    `${i+1}`,
    r.name,
    r.totalPnl_mSOL.toFixed(1),
    r.pnlAfterOverhead_mSOL.toFixed(1),
    r.winRate + '%',
    r.tp1Hits,
    (r.totalPnl_mSOL - actualPnl * 1000).toFixed(1)
  ]);
  printTable(topHeaders, topRows, topWidths);

  // ============================================================
  // SECTION 6: Per-Position Deep Dive (best strategy)
  // ============================================================
  if (results.length > 0) {
    const best = results[0];
    printSectionHeader(`6. DEEP DIVE: Best Strategy "${best.name}"`);

    // Show each position's actual vs simulated
    console.log('\nPer-position comparison (sim vs actual):');
    console.log('Outcome|Actual(mSOL)|Sim(mSOL)|Delta(mSOL)|ExitSim');
    console.log('-'.repeat(70));

    const sorted = [...best.details].sort((a, b) => b.delta - a.delta);
    for (const d of sorted.slice(0, 30)) {
      const actual = ((d.actual_pnl || 0) * 1000).toFixed(2);
      const sim = (d.sim_pnl * 1000).toFixed(2);
      const delta = (d.delta * 1000).toFixed(2);
      console.log(`${d.outcome.padEnd(12)} ${actual.padStart(10)} ${sim.padStart(10)} ${delta.padStart(10)}  ${d.exit_sim}`);
    }

    // Summary of where gains come from
    const rugPositions = best.details.filter(d => d.outcome === 'rug');
    const dustPositions = best.details.filter(d => d.outcome === 'dust_exit');
    const normalPositions = best.details.filter(d => d.outcome === 'normal');

    console.log('\nGains breakdown by outcome type:');
    console.log(`  Rug positions (N=${rugPositions.length}): actual ${(rugPositions.reduce((s,d) => s + (d.actual_pnl||0), 0)*1000).toFixed(1)} mSOL -> sim ${(rugPositions.reduce((s,d) => s + d.sim_pnl, 0)*1000).toFixed(1)} mSOL`);
    console.log(`  Dust positions (N=${dustPositions.length}): actual ${(dustPositions.reduce((s,d) => s + (d.actual_pnl||0), 0)*1000).toFixed(1)} mSOL -> sim ${(dustPositions.reduce((s,d) => s + d.sim_pnl, 0)*1000).toFixed(1)} mSOL`);
    console.log(`  Normal positions (N=${normalPositions.length}): actual ${(normalPositions.reduce((s,d) => s + (d.actual_pnl||0), 0)*1000).toFixed(1)} mSOL -> sim ${(normalPositions.reduce((s,d) => s + d.sim_pnl, 0)*1000).toFixed(1)} mSOL`);
  }

  // ============================================================
  // SECTION 7: Trailing Stop Isolation Test
  // ============================================================
  printSectionHeader('7. TRAILING STOP ISOLATION (TP1 at 1.08x, vary trailing)');

  // Get results for TP1=1.08x with different trailing stops
  const trailIso = partialResults.filter(r => r.name.startsWith('TP1 1.08x/50%'));
  trailIso.sort((a, b) => {
    const aTrail = parseInt(a.name.match(/trail (\d+)/)[1]);
    const bTrail = parseInt(b.name.match(/trail (\d+)/)[1]);
    return aTrail - bTrail;
  });

  if (trailIso.length > 0) {
    console.log('\nTP1 1.08x/50% + varying trailing stop:');
    for (const r of trailIso) {
      console.log(`  ${r.name}: PnL ${r.totalPnl_mSOL.toFixed(1)} mSOL, WR ${r.winRate}%, delta ${(r.totalPnl_mSOL - actualPnl * 1000).toFixed(1)}`);
    }
  }

  // ============================================================
  // SECTION 8: Smart TP Analysis (tp1_snapshots)
  // ============================================================
  printSectionHeader('8. SMART TP ANALYSIS (tp1_snapshots)');

  const snapshots = db.prepare(`
    SELECT ts.*, p.pnl_sol, p.exit_reason, p.peak_multiplier, p.sol_invested
    FROM tp1_snapshots ts
    JOIN positions p ON ts.position_id = p.id
    WHERE p.status IN ('closed', 'stopped')
    ORDER BY ts.created_at
  `).all();

  console.log(`\nTP1 Snapshots: N=${snapshots.length}`);

  if (snapshots.length > 0) {
    // Group by reserve change direction
    const growing = snapshots.filter(s => s.reserve_change_pct > 5);
    const stable = snapshots.filter(s => Math.abs(s.reserve_change_pct) <= 5);
    const declining = snapshots.filter(s => s.reserve_change_pct < -5);

    console.log(`\n  Reserve at TP1 hit:`);
    console.log(`  Growing (>5%): N=${growing.length}, avg post_peak=${growing.length > 0 ? (growing.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/growing.length).toFixed(3) : 'N/A'}, avg PnL=${growing.length > 0 ? (growing.reduce((s,x)=>s+x.pnl_sol,0)*1000/growing.length).toFixed(2) : 'N/A'} mSOL`);
    console.log(`  Stable (+-5%): N=${stable.length}, avg post_peak=${stable.length > 0 ? (stable.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/stable.length).toFixed(3) : 'N/A'}, avg PnL=${stable.length > 0 ? (stable.reduce((s,x)=>s+x.pnl_sol,0)*1000/stable.length).toFixed(2) : 'N/A'} mSOL`);
    console.log(`  Declining (<-5%): N=${declining.length}, avg post_peak=${declining.length > 0 ? (declining.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/declining.length).toFixed(3) : 'N/A'}, avg PnL=${declining.length > 0 ? (declining.reduce((s,x)=>s+x.pnl_sol,0)*1000/declining.length).toFixed(2) : 'N/A'} mSOL`);

    // Buy/sell ratio signal
    const highBuys = snapshots.filter(s => s.buy_count_30s > 0 && s.buy_sell_ratio > 1);
    const lowBuys = snapshots.filter(s => s.buy_sell_ratio <= 1 || s.buy_count_30s === 0);

    console.log(`\n  Buy/Sell Ratio at TP1:`);
    console.log(`  High (ratio>1): N=${highBuys.length}, avg post_peak=${highBuys.length > 0 ? (highBuys.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/highBuys.length).toFixed(3) : 'N/A'}`);
    console.log(`  Low (ratio<=1): N=${lowBuys.length}, avg post_peak=${lowBuys.length > 0 ? (lowBuys.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/lowBuys.length).toFixed(3) : 'N/A'}`);

    // Speed to TP1 signal
    const fastTp = snapshots.filter(s => s.time_to_tp1_ms < 15000);
    const slowTp = snapshots.filter(s => s.time_to_tp1_ms >= 15000);

    console.log(`\n  Speed to TP1:`);
    console.log(`  Fast (<15s): N=${fastTp.length}, avg post_peak=${fastTp.length > 0 ? (fastTp.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/fastTp.length).toFixed(3) : 'N/A'}, rugs=${fastTp.filter(s=>['rug_pull','max_retries'].includes(s.exit_reason)).length}`);
    console.log(`  Slow (>=15s): N=${slowTp.length}, avg post_peak=${slowTp.length > 0 ? (slowTp.reduce((s,x)=>s+(x.post_tp1_peak||0),0)/slowTp.length).toFixed(3) : 'N/A'}, rugs=${slowTp.filter(s=>['rug_pull','max_retries'].includes(s.exit_reason)).length}`);

    // Per-snapshot detail
    console.log('\n  Individual snapshots:');
    console.log('  TimeToTP1 | ReserveChg | B/S Ratio | PostPeak | ExitReason     | PnL(mSOL)');
    console.log('  ' + '-'.repeat(80));
    for (const s of snapshots) {
      const ttTp1 = s.time_to_tp1_ms ? `${(s.time_to_tp1_ms/1000).toFixed(1)}s` : 'N/A';
      const resChg = s.reserve_change_pct ? `${s.reserve_change_pct > 0 ? '+' : ''}${s.reserve_change_pct.toFixed(1)}%` : 'N/A';
      const bsr = s.buy_sell_ratio ? s.buy_sell_ratio.toFixed(2) : '0';
      const ppeak = s.post_tp1_peak ? s.post_tp1_peak.toFixed(3) : 'N/A';
      const pnl = (s.pnl_sol * 1000).toFixed(2);
      console.log(`  ${ttTp1.padEnd(10)} ${resChg.padEnd(12)} ${bsr.padEnd(11)} ${ppeak.padEnd(10)} ${(s.exit_reason||'').padEnd(16)} ${pnl}`);
    }
  }

  // ============================================================
  // SECTION 9: Position Size Impact
  // ============================================================
  printSectionHeader('9. POSITION SIZE IMPACT ON PROFITABILITY');

  const sizeGroups = {
    '1 mSOL': positions.filter(p => p.sol_invested <= 0.002),
    '5 mSOL': positions.filter(p => p.sol_invested > 0.002 && p.sol_invested <= 0.007),
    '10 mSOL': positions.filter(p => p.sol_invested > 0.007 && p.sol_invested <= 0.012),
    '15 mSOL': positions.filter(p => p.sol_invested > 0.012)
  };

  for (const [label, group] of Object.entries(sizeGroups)) {
    if (group.length === 0) continue;
    const pnl = group.reduce((s, p) => s + (p.pnl_sol || 0), 0);
    const overhead = group.length * OVERHEAD_SOL;
    const overheadPct = group.length > 0 ? (OVERHEAD_SOL / group[0].sol_invested * 100) : 0;
    console.log(`  ${label} (N=${group.length}): PnL ${(pnl*1000).toFixed(1)} mSOL, overhead ${(overhead*1000).toFixed(1)} mSOL (${overheadPct.toFixed(0)}% per trade), net ${((pnl-overhead)*1000).toFixed(1)} mSOL`);
  }

  // ============================================================
  // SECTION 10: What if we could sell rugs?
  // ============================================================
  printSectionHeader('10. RUG IMPACT ANALYSIS');

  const rugs = positions.filter(p => p.outcome === 'rug');
  const rugLoss = rugs.reduce((s, p) => s + (p.pnl_sol || 0), 0);
  const nonRugPnl = actualPnl - rugLoss;

  console.log(`  Rug positions: N=${rugs.length}`);
  console.log(`  Total rug loss: ${(rugLoss*1000).toFixed(1)} mSOL`);
  console.log(`  Non-rug PnL: ${(nonRugPnl*1000).toFixed(1)} mSOL`);
  console.log(`  If we could avoid ALL rugs: PnL would be ${(nonRugPnl*1000).toFixed(1)} mSOL`);
  console.log(`  Avg rug loss: ${(rugLoss*1000/rugs.length).toFixed(1)} mSOL per rug`);

  // What % of rug positions had tick data showing price above entry?
  const rugsWithTicks = rugs.filter(p => p.hasTicks && p.ticks.length > 0);
  const rugsAboveEntry = rugsWithTicks.filter(p => p.ticks.some(t => t.multiplier > 1.02));
  console.log(`\n  Rugs with tick data: ${rugsWithTicks.length}/${rugs.length}`);
  console.log(`  Rugs that went above 1.02x: ${rugsAboveEntry.length}/${rugsWithTicks.length}`);

  for (const rug of rugsWithTicks) {
    const maxMult = Math.max(...rug.ticks.map(t => t.multiplier));
    const maxTick = rug.ticks.find(t => t.multiplier === maxMult);
    console.log(`    ${rug.id.substring(0,12)}: peak ${maxMult.toFixed(3)}x at ${(maxTick.elapsed_ms/1000).toFixed(0)}s, ${rug.ticks.length} ticks, invested ${(rug.sol_invested*1000).toFixed(0)} mSOL`);
  }

  // ============================================================
  // FINAL RECOMMENDATION
  // ============================================================
  printSectionHeader('FINAL RECOMMENDATION');

  const currentPnl = actualPnl * 1000;
  const best = results[0];
  const bestSimple = tp1Results.sort((a,b) => b.totalPnl_mSOL - a.totalPnl_mSOL)[0];

  console.log(`\n  Current strategy PnL: ${currentPnl.toFixed(1)} mSOL`);
  console.log(`  Best overall: "${best.name}" = ${best.totalPnl_mSOL.toFixed(1)} mSOL (delta: +${(best.totalPnl_mSOL - currentPnl).toFixed(1)} mSOL)`);
  console.log(`  Best simple (100% sell): "${bestSimple.name}" = ${bestSimple.totalPnl_mSOL.toFixed(1)} mSOL (delta: +${(bestSimple.totalPnl_mSOL - currentPnl).toFixed(1)} mSOL)`);

  // Top 5 overall
  console.log('\n  Top 5 strategies:');
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    console.log(`    ${i+1}. ${r.name}: ${r.totalPnl_mSOL.toFixed(1)} mSOL (WR ${r.winRate}%, delta +${(r.totalPnl_mSOL - currentPnl).toFixed(1)})`);
  }

  // Worst 5 (to avoid)
  console.log('\n  Bottom 5 strategies (avoid):');
  for (let i = results.length - 1; i >= Math.max(0, results.length - 5); i--) {
    const r = results[i];
    console.log(`    ${results.length - i}. ${r.name}: ${r.totalPnl_mSOL.toFixed(1)} mSOL (WR ${r.winRate}%, delta ${(r.totalPnl_mSOL - currentPnl).toFixed(1)})`);
  }

  db.close();
}

main();
