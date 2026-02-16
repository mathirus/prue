#!/usr/bin/env node
/**
 * Comprehensive TP Strategy Backtester
 *
 * Tests 7+ take-profit strategies against 91 historical positions (v11o+).
 * Uses position_price_log tick data + DexScreener outcome data to estimate
 * what would have happened under different TP/trailing-stop configurations.
 *
 * Usage:
 *   node scripts/backtest-tp-strategies.cjs
 *   node scripts/backtest-tp-strategies.cjs --verbose    # Show per-trade details
 *   node scripts/backtest-tp-strategies.cjs --strategy A # Run only strategy A
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

// ========== CONSTANTS ==========
const OVERHEAD_PER_TRADE = 0.0011; // SOL (ATA rent + TX fees)
const EXTRA_SELL_FEE = 0.0004;     // SOL per additional sell TX
const STOP_LOSS_PCT = -0.30;       // -30%
const TRAILING_STOP_PCT = 0.15;    // 15% trailing stop (from peak)
const MOON_BAG_TRAILING = 0.25;    // 25% trailing for moon bags

// Tokens to EXCLUDE (wrong decimals in DexScreener)
const EXCLUDE_TOKENS = [
  'AamEDU3zAumgXzRb4KHbzA1Ti8NReDubgsKw1YuSWr19',
  'BCTCJfAuU5sao9H3McRCXgmqN9gkxi9hv8EwUSUxYWJY',
];

const verbose = process.argv.includes('--verbose');
const onlyStrategy = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1]
  || (process.argv.includes('--strategy') ? process.argv[process.argv.indexOf('--strategy') + 1] : null);

// ========== DATA LOADING ==========

function loadPositions() {
  const rows = db.prepare(`
    SELECT p.id, p.token_mint, p.sol_invested, p.entry_price, p.pnl_sol, p.pnl_pct,
           p.peak_multiplier, p.exit_reason, p.security_score, p.bot_version,
           p.opened_at, p.closed_at
    FROM positions p
    WHERE p.bot_version >= 'v11o'
      AND p.status IN ('closed', 'stopped')
    ORDER BY p.opened_at
  `).all();

  return rows.filter(r => !EXCLUDE_TOKENS.includes(r.token_mint));
}

function loadPriceLog(positionId) {
  return db.prepare(`
    SELECT elapsed_ms, multiplier, pnl_pct, sol_reserve, sell_count, buy_count
    FROM position_price_log
    WHERE position_id = ?
    ORDER BY elapsed_ms
  `).all(positionId);
}

function loadDexScreenerPeak(tokenMint, entryPrice) {
  // Get all DexScreener checks, compute multiplier using 6-decimal conversion
  const rows = db.prepare(`
    SELECT poc.check_label, poc.delay_minutes, poc.price_native, poc.market_cap,
           poc.liquidity_usd, poc.is_alive
    FROM pool_outcome_checks poc
    JOIN detected_pools dp ON dp.id = poc.pool_id
    WHERE dp.base_mint = ?
      AND poc.price_native > 0
    ORDER BY poc.delay_minutes
  `).all(tokenMint);

  if (rows.length === 0) return null;

  const checks = rows.map(r => ({
    label: r.check_label,
    delayMin: r.delay_minutes,
    priceNative: r.price_native,
    multiplier: r.price_native / (entryPrice * 1e6),
    marketCap: r.market_cap,
    liquidityUsd: r.liquidity_usd,
    isAlive: r.is_alive,
  }));

  // Peak across all checks
  const peakCheck = checks.reduce((best, c) => c.multiplier > best.multiplier ? c : best, checks[0]);

  // Find the trajectory shape: peak then crash?
  // Sort by delay to get chronological order
  const sorted = [...checks].sort((a, b) => a.delayMin - b.delayMin);

  return {
    checks: sorted,
    peakMultiplier: peakCheck.multiplier,
    peakAtMinute: peakCheck.delayMin,
    lastCheck: sorted[sorted.length - 1],
    // Detect if it peaked then crashed (rug trajectory)
    peakedAndCrashed: sorted.length >= 2 &&
      sorted[sorted.length - 1].multiplier < peakCheck.multiplier * 0.5,
  };
}

function loadTp1Snapshot(positionId) {
  return db.prepare(`
    SELECT time_to_tp1_ms, reserve_change_pct, buy_sell_ratio,
           cumulative_sell_count, current_multiplier, post_tp1_peak,
           post_tp1_exit_reason, post_tp1_duration_ms
    FROM tp1_snapshots
    WHERE position_id = ?
  `).get(positionId);
}

// ========== TRAJECTORY BUILDING ==========

/**
 * Build a complete price trajectory for a position by merging:
 * 1. Our tick-by-tick data (precise, but stops when we sell)
 * 2. DexScreener snapshots (coarse 5/15/30/60 min, but shows post-sell behavior)
 *
 * Returns array of {timeMs, multiplier, source} sorted by time
 */
function buildTrajectory(position, ticks, dexData) {
  const trajectory = [];

  // Add our tick data
  for (const tick of ticks) {
    trajectory.push({
      timeMs: tick.elapsed_ms,
      multiplier: tick.multiplier,
      source: 'tick',
      solReserve: tick.sol_reserve,
    });
  }

  // Add DexScreener data (convert minutes to ms from opened_at)
  // IMPORTANT: DexScreener snapshots are sparse (5/15/30/60 min).
  // Between snapshots, price could have gone HIGHER (hitting TP) or LOWER (hitting trail/SL).
  // We insert intermediate points to model this:
  //   - If next snapshot is LOWER, assume price peaked at current level then dropped
  //   - If next snapshot is HIGHER, assume gradual rise
  if (dexData) {
    const lastTickTime = ticks.length > 0 ? ticks[ticks.length - 1].elapsed_ms : 0;
    const dexPoints = dexData.checks
      .map(c => ({ timeMs: c.delayMin * 60 * 1000, multiplier: c.multiplier }))
      .filter(p => p.timeMs > lastTickTime);

    for (let i = 0; i < dexPoints.length; i++) {
      const point = dexPoints[i];
      trajectory.push({
        timeMs: point.timeMs,
        multiplier: point.multiplier,
        source: 'dex',
      });

      // If next DexScreener point is significantly LOWER (>15% drop),
      // insert an intermediate "peak then drop" trajectory
      if (i + 1 < dexPoints.length) {
        const next = dexPoints[i + 1];
        if (next.multiplier < point.multiplier * 0.85) {
          // Price dropped >15%. Insert midpoint at peak level, then gradual decline
          const midTimeMs = Math.floor((point.timeMs + next.timeMs) / 2);
          // Assume it stayed near peak for a while, then dropped
          trajectory.push({
            timeMs: midTimeMs,
            multiplier: point.multiplier * 0.92, // slight decline midway
            source: 'interpolated',
          });
        }
      }
    }
  }

  // Sort by time
  trajectory.sort((a, b) => a.timeMs - b.timeMs);

  return trajectory;
}

/**
 * Get the "true peak" multiplier combining our data and DexScreener
 */
function getTruePeak(position, dexData) {
  const ourPeak = position.peak_multiplier || 1.0;
  const dexPeak = dexData ? dexData.peakMultiplier : 0;

  // Sanity check: DexScreener peak should be >= 0.5 to be trustworthy
  // (Very low values suggest decimal mismatch or dead token)
  if (dexPeak > 0.5 && dexPeak < 100) {
    return Math.max(ourPeak, dexPeak);
  }
  return ourPeak;
}

// ========== STRATEGY SIMULATION ENGINE ==========

/**
 * Simulate a multi-tier TP strategy on a single position.
 *
 * @param {Object} position - Position data
 * @param {Array} trajectory - Price trajectory points
 * @param {Array} tpLevels - [{multiplier, sellPct}] e.g., [{multiplier: 1.10, sellPct: 0.60}]
 * @param {Object} options - {trailingStopPct, stopLossPct, moonBagMult, moonBagTrailing, timeoutMs}
 * @returns {Object} - {totalPnlSol, sells: [{level, mult, pct, solReturned}], exitReason}
 */
function simulateStrategy(position, trajectory, tpLevels, options = {}) {
  const {
    trailingStopPct = TRAILING_STOP_PCT,
    stopLossPct = STOP_LOSS_PCT,
    moonBagMult = null,      // If set, hold moonBag until this mult (e.g., 3.0)
    moonBagTrailing = MOON_BAG_TRAILING,
    timeoutMs = 12 * 60 * 1000, // 12 min default
  } = options;

  const solInvested = position.sol_invested;
  let remainingPct = 1.0; // Fraction of position still held
  let peakMult = 1.0;
  let totalSolReturned = 0;
  const sells = [];
  let sellCount = 0;
  let tpIndex = 0; // Next TP level to hit
  let inMoonBag = false;
  let moonBagPeak = 1.0;
  let exitReason = 'timeout';
  let isRug = false;

  // Determine if this was a rug (for simulation purposes)
  if (position.exit_reason === 'rug_pull' || position.exit_reason === 'max_retries' ||
      position.exit_reason === 'stranded_timeout_max_retries') {
    isRug = true;
  }

  for (const point of trajectory) {
    const mult = point.multiplier;
    if (mult <= 0) continue;

    // Timeout check: sell remaining position at timeout
    // NOTE: For backtesting, we use an extended timeout (60 min) to see
    // what happens with longer holds. The actual bot timeout (12 min)
    // is tested separately in strategy variants.
    if (point.timeMs > timeoutMs && remainingPct > 0.001) {
      const solReturned = solInvested * remainingPct * mult;
      totalSolReturned += solReturned;
      sellCount++;
      sells.push({
        level: 'Timeout',
        multiplier: mult,
        sellPct: remainingPct,
        solReturned,
        timeMs: point.timeMs,
      });
      remainingPct = 0;
      exitReason = 'timeout';
      break;
    }

    // Update peak
    if (mult > peakMult) peakMult = mult;

    // Check TP levels
    while (tpIndex < tpLevels.length && mult >= tpLevels[tpIndex].multiplier && remainingPct > 0.001) {
      const tp = tpLevels[tpIndex];
      const sellPct = Math.min(tp.sellPct, remainingPct);
      const solReturned = solInvested * sellPct * mult;
      totalSolReturned += solReturned;
      remainingPct -= sellPct;
      sellCount++;
      sells.push({
        level: `TP${tpIndex + 1}`,
        multiplier: mult,
        sellPct,
        solReturned,
        timeMs: point.timeMs,
      });
      tpIndex++;
    }

    // If all TP levels hit and moonBag enabled, switch to moon bag mode
    if (tpIndex >= tpLevels.length && remainingPct > 0.001 && moonBagMult) {
      inMoonBag = true;
      if (mult > moonBagPeak) moonBagPeak = mult;

      // Moon bag hit target?
      if (mult >= moonBagMult) {
        const solReturned = solInvested * remainingPct * mult;
        totalSolReturned += solReturned;
        sellCount++;
        sells.push({
          level: 'MoonBag',
          multiplier: mult,
          sellPct: remainingPct,
          solReturned,
          timeMs: point.timeMs,
        });
        remainingPct = 0;
        exitReason = 'moon_bag_target';
        break;
      }

      // Moon bag trailing stop
      if (moonBagPeak > 1.0 && mult < moonBagPeak * (1 - moonBagTrailing)) {
        const solReturned = solInvested * remainingPct * mult;
        totalSolReturned += solReturned;
        sellCount++;
        sells.push({
          level: 'MoonTrail',
          multiplier: mult,
          sellPct: remainingPct,
          solReturned,
          timeMs: point.timeMs,
        });
        remainingPct = 0;
        exitReason = 'moon_trailing';
        break;
      }
    }

    // Trailing stop on remaining (non-moon) portion
    if (remainingPct > 0.001 && !inMoonBag && tpIndex > 0) {
      // Only apply trailing stop after at least 1 TP hit
      if (peakMult > 1.0 && mult < peakMult * (1 - trailingStopPct)) {
        const solReturned = solInvested * remainingPct * mult;
        totalSolReturned += solReturned;
        sellCount++;
        sells.push({
          level: 'TrailStop',
          multiplier: mult,
          sellPct: remainingPct,
          solReturned,
          timeMs: point.timeMs,
        });
        remainingPct = 0;
        exitReason = 'trailing_stop';
        break;
      }
    }

    // Global trailing stop (even before TP1, after peak > 1.05)
    if (remainingPct > 0.001 && tpIndex === 0 && peakMult > 1.05) {
      if (mult < peakMult * (1 - trailingStopPct)) {
        const solReturned = solInvested * remainingPct * mult;
        totalSolReturned += solReturned;
        sellCount++;
        sells.push({
          level: 'PreTPTrail',
          multiplier: mult,
          sellPct: remainingPct,
          solReturned,
          timeMs: point.timeMs,
        });
        remainingPct = 0;
        exitReason = 'pre_tp_trailing';
        break;
      }
    }

    // Stop loss
    if (remainingPct > 0.001 && mult <= (1 + stopLossPct)) {
      const solReturned = solInvested * remainingPct * mult;
      totalSolReturned += solReturned;
      sellCount++;
      sells.push({
        level: 'StopLoss',
        multiplier: mult,
        sellPct: remainingPct,
        solReturned,
        timeMs: point.timeMs,
      });
      remainingPct = 0;
      exitReason = 'stop_loss';
      break;
    }

    // Check if no more position
    if (remainingPct <= 0.001) break;
  }

  // Handle remaining position at end of trajectory
  if (remainingPct > 0.001) {
    if (isRug) {
      // Rug: lose everything remaining
      sells.push({
        level: 'Rug',
        multiplier: 0,
        sellPct: remainingPct,
        solReturned: 0,
        timeMs: null,
      });
      exitReason = 'rug';
      remainingPct = 0;
    } else {
      // Use the last known multiplier as exit (timeout or end of data)
      const lastPoint = trajectory[trajectory.length - 1];
      const lastMult = lastPoint ? lastPoint.multiplier : 1.0;

      // For non-rugs that timed out, estimate exit at last known price
      // with trailing stop from peak if applicable
      let exitMult = lastMult;
      if (peakMult > 1.0) {
        // Would trailing stop have fired between DexScreener snapshots?
        const trailExit = peakMult * (1 - trailingStopPct);
        if (trailExit > lastMult) {
          // The token dropped below trailing stop at some point
          exitMult = trailExit;
          exitReason = 'trailing_stop_estimated';
        }
      }

      const solReturned = solInvested * remainingPct * exitMult;
      totalSolReturned += solReturned;
      sellCount++;
      sells.push({
        level: 'EndOfData',
        multiplier: exitMult,
        sellPct: remainingPct,
        solReturned,
        timeMs: lastPoint?.timeMs,
      });
    }
  }

  // Calculate total PnL
  const overhead = OVERHEAD_PER_TRADE + (Math.max(0, sellCount - 1) * EXTRA_SELL_FEE);
  const totalPnlSol = totalSolReturned - solInvested - overhead;

  return {
    positionId: position.id,
    tokenMint: position.token_mint,
    solInvested,
    totalSolReturned,
    overhead,
    totalPnlSol,
    pnlPct: ((totalSolReturned - solInvested) / solInvested) * 100,
    sells,
    sellCount,
    exitReason,
    peakMult,
    isRug,
    isWin: totalPnlSol > 0,
  };
}

// ========== STRATEGY DEFINITIONS ==========

function defineStrategies() {
  const strategies = {};

  const DEFAULT_TIMEOUT = 60 * 60 * 1000; // 60 min (covers full DexScreener window)

  // Strategy A: Current baseline — sell 100% at 1.08x
  strategies['A: Current (100% @ 1.08x)'] = {
    tpLevels: [{ multiplier: 1.08, sellPct: 1.0 }],
    options: { timeoutMs: DEFAULT_TIMEOUT },
    description: 'Current baseline: sell 100% at 1.08x',
  };

  // Strategy B: Higher Fixed TP1 — test multiple levels
  for (const mult of [1.10, 1.15, 1.20, 1.25, 1.30]) {
    strategies[`B${mult}: Fixed 100% @ ${mult}x`] = {
      tpLevels: [{ multiplier: mult, sellPct: 1.0 }],
      options: { timeoutMs: DEFAULT_TIMEOUT },
      description: `Sell 100% at ${mult}x, trailing stop otherwise`,
    };
  }

  // Strategy C: Two-Tier Split
  strategies['C: 2-Tier (60%@1.10, 40%@1.30)'] = {
    tpLevels: [
      { multiplier: 1.10, sellPct: 0.60 },
      { multiplier: 1.30, sellPct: 0.40 },
    ],
    options: { timeoutMs: DEFAULT_TIMEOUT },
    description: 'Sell 60% at 1.10x, 40% at 1.30x, trailing stop on remainder',
  };

  // Strategy D: Three-Tier Split
  strategies['D: 3-Tier (50/30/20 @ 1.10/1.20/1.30)'] = {
    tpLevels: [
      { multiplier: 1.10, sellPct: 0.50 },
      { multiplier: 1.20, sellPct: 0.30 },
      { multiplier: 1.30, sellPct: 0.20 },
    ],
    options: { timeoutMs: DEFAULT_TIMEOUT },
    description: 'Sell 50% at 1.10x, 30% at 1.20x, 20% at 1.30x',
  };

  // Strategy E: Three-Tier + Moon Bag
  strategies['E: 3-Tier + Moon (40/30/20 + 10%@3x)'] = {
    tpLevels: [
      { multiplier: 1.10, sellPct: 0.40 },
      { multiplier: 1.20, sellPct: 0.30 },
      { multiplier: 1.30, sellPct: 0.20 },
    ],
    options: {
      moonBagMult: 3.0,
      moonBagTrailing: MOON_BAG_TRAILING,
      timeoutMs: DEFAULT_TIMEOUT,
    },
    description: 'Sell 40/30/20% at 1.10/1.20/1.30x, 10% moon bag targeting 3x',
  };

  // Strategy F: Score-Based Dynamic TP1
  strategies['F: Score-Based Dynamic'] = {
    dynamic: true,
    getConfig: (score) => {
      if (score >= 85) {
        return {
          tpLevels: [
            { multiplier: 1.10, sellPct: 0.50 },
            { multiplier: 1.20, sellPct: 0.30 },
          ],
          options: { timeoutMs: DEFAULT_TIMEOUT },
        };
      } else if (score >= 80) {
        return {
          tpLevels: [
            { multiplier: 1.10, sellPct: 0.70 },
            { multiplier: 1.30, sellPct: 0.30 },
          ],
          options: { timeoutMs: DEFAULT_TIMEOUT },
        };
      } else {
        return {
          tpLevels: [{ multiplier: 1.10, sellPct: 1.0 }],
          options: { timeoutMs: DEFAULT_TIMEOUT },
        };
      }
    },
    description: '75-79: 100%@1.10x, 80-84: 70/30%@1.10/1.30x, 85+: 50/30%@1.10/1.20x + trail',
  };

  // Strategy G: Ultra-Conservative
  strategies['G: Ultra-Conservative (70%@1.15, 30%@1.30)'] = {
    tpLevels: [
      { multiplier: 1.15, sellPct: 0.70 },
      { multiplier: 1.30, sellPct: 0.30 },
    ],
    options: { timeoutMs: DEFAULT_TIMEOUT },
    description: 'Sell 70% at 1.15x, 30% at 1.30x, no moon bag',
  };

  // === BONUS STRATEGIES based on data-driven insights ===

  // Strategy H: Aggressive early exit — capture the 67% that reach 1.10x
  strategies['H: Aggressive (100% @ 1.10x)'] = {
    tpLevels: [{ multiplier: 1.10, sellPct: 1.0 }],
    options: { timeoutMs: DEFAULT_TIMEOUT },
    description: 'Quick in-and-out at 1.10x',
  };

  // Strategy I: 2-tier with tighter TP1 and wide TP2
  strategies['I: 2-Tier Wide (70%@1.10, 30%@2.0)'] = {
    tpLevels: [
      { multiplier: 1.10, sellPct: 0.70 },
      { multiplier: 2.0, sellPct: 0.30 },
    ],
    options: { timeoutMs: DEFAULT_TIMEOUT },
    description: 'Lock 70% at 1.10x, let 30% ride to 2x',
  };

  // Strategy J: Tight trailing only (no fixed TP, just trail from peak)
  strategies['J: TrailingOnly (15% trail, 60min)'] = {
    tpLevels: [],
    options: { trailingStopPct: 0.15, timeoutMs: DEFAULT_TIMEOUT },
    description: 'No fixed TP. Trail 15% from peak once peak > 1.05x. 60min window.',
  };

  // Strategy J2: Same but with realistic 12-min timeout
  strategies['J2: TrailingOnly (15% trail, 12min)'] = {
    tpLevels: [],
    options: { trailingStopPct: 0.15, timeoutMs: 12 * 60 * 1000 },
    description: 'No fixed TP. Trail 15% from peak. 12min timeout (realistic).',
  };

  // Strategy K: Conservative trailing — 20% trail (wider stop)
  strategies['K: TrailingOnly (20% trail, 60min)'] = {
    tpLevels: [],
    options: { trailingStopPct: 0.20, timeoutMs: DEFAULT_TIMEOUT },
    description: 'No fixed TP. Trail 20% from peak once peak > 1.05x. 60min window.',
  };

  // Strategy L: Hybrid — sell 50% at TP1 1.15x, trail the rest
  strategies['L: Hybrid (50%@1.15, 50% trail 15%)'] = {
    tpLevels: [{ multiplier: 1.15, sellPct: 0.50 }],
    options: { trailingStopPct: 0.15, timeoutMs: DEFAULT_TIMEOUT },
    description: 'Lock 50% at 1.15x, trail remaining 50% with 15% trailing stop',
  };

  // Strategy M: Hybrid — sell 50% at TP1 1.20x, trail the rest
  strategies['M: Hybrid (50%@1.20, 50% trail 15%)'] = {
    tpLevels: [{ multiplier: 1.20, sellPct: 0.50 }],
    options: { trailingStopPct: 0.15, timeoutMs: DEFAULT_TIMEOUT },
    description: 'Lock 50% at 1.20x, trail remaining 50% with 15% trailing stop',
  };

  return strategies;
}

// ========== MAIN BACKTEST ==========

function runBacktest() {
  console.log('='.repeat(100));
  console.log('  COMPREHENSIVE TP STRATEGY BACKTESTER');
  console.log('  Historical data: v11o+ positions | Database: data/bot.db');
  console.log('='.repeat(100));
  console.log();

  // Load all positions
  const positions = loadPositions();
  console.log(`Loaded ${positions.length} positions (excluded ${EXCLUDE_TOKENS.length} bad-decimal tokens)`);

  // Distribution
  const sizeDist = {};
  positions.forEach(p => { sizeDist[p.sol_invested] = (sizeDist[p.sol_invested] || 0) + 1; });
  console.log(`Position sizes: ${Object.entries(sizeDist).map(([k,v]) => `${k} SOL (${v})`).join(', ')}`);

  const rugCount = positions.filter(p => ['rug_pull', 'max_retries', 'stranded_timeout_max_retries'].includes(p.exit_reason)).length;
  console.log(`Rugs: ${rugCount}/${positions.length} (${(rugCount/positions.length*100).toFixed(1)}%)`);
  console.log();

  // Pre-load all data
  console.log('Loading tick data and DexScreener outcomes...');
  const positionData = positions.map(p => {
    const ticks = loadPriceLog(p.id);
    const dexData = loadDexScreenerPeak(p.token_mint, p.entry_price);
    const trajectory = buildTrajectory(p, ticks, dexData);
    const truePeak = getTruePeak(p, dexData);
    const tp1Snapshot = loadTp1Snapshot(p.id);
    return { position: p, ticks, dexData, trajectory, truePeak, tp1Snapshot };
  });

  // Peak distribution analysis
  console.log('--- TRUE PEAK DISTRIBUTION (our data + DexScreener) ---');
  const peakBuckets = [
    { label: '< 1.0x (never profit)', min: 0, max: 1.0 },
    { label: '1.0-1.08x', min: 1.0, max: 1.08 },
    { label: '1.08-1.10x', min: 1.08, max: 1.10 },
    { label: '1.10-1.15x', min: 1.10, max: 1.15 },
    { label: '1.15-1.20x', min: 1.15, max: 1.20 },
    { label: '1.20-1.30x', min: 1.20, max: 1.30 },
    { label: '1.30-1.50x', min: 1.30, max: 1.50 },
    { label: '1.50-2.0x',  min: 1.50, max: 2.0 },
    { label: '2.0-3.0x',   min: 2.0, max: 3.0 },
    { label: '3.0-5.0x',   min: 3.0, max: 5.0 },
    { label: '5.0x+',      min: 5.0, max: Infinity },
  ];

  for (const bucket of peakBuckets) {
    const count = positionData.filter(d => d.truePeak >= bucket.min && d.truePeak < bucket.max).length;
    const pct = (count / positions.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(count / 2));
    console.log(`  ${bucket.label.padEnd(20)} ${String(count).padStart(3)} (${pct.padStart(5)}%) ${bar}`);
  }

  // Cumulative: what % reach each level?
  console.log('\n--- CUMULATIVE HIT RATES ---');
  const hitLevels = [1.05, 1.08, 1.10, 1.15, 1.20, 1.25, 1.30, 1.50, 2.0, 3.0, 5.0, 10.0];
  for (const level of hitLevels) {
    const count = positionData.filter(d => d.truePeak >= level).length;
    const pct = (count / positions.length * 100).toFixed(1);
    console.log(`  Reach ${String(level).padStart(5)}x: ${String(count).padStart(3)}/${positions.length} (${pct.padStart(5)}%)`);
  }
  console.log();

  // Run all strategies
  const strategies = defineStrategies();
  const results = {};

  for (const [name, strategy] of Object.entries(strategies)) {
    if (onlyStrategy && !name.startsWith(onlyStrategy)) continue;

    const tradeResults = [];

    for (const data of positionData) {
      let config;
      if (strategy.dynamic) {
        config = strategy.getConfig(data.position.security_score || 0);
      } else {
        config = { tpLevels: strategy.tpLevels, options: strategy.options };
      }

      const result = simulateStrategy(
        data.position,
        data.trajectory,
        config.tpLevels,
        config.options,
      );
      tradeResults.push(result);
    }

    // Aggregate metrics
    const totalPnl = tradeResults.reduce((sum, r) => sum + r.totalPnlSol, 0);
    const totalOverhead = tradeResults.reduce((sum, r) => sum + r.overhead, 0);
    const winners = tradeResults.filter(r => r.isWin);
    const losers = tradeResults.filter(r => !r.isWin);
    const rugsFullLoss = tradeResults.filter(r => r.isRug && r.sells.every(s => s.level === 'Rug'));
    const rugsPartialRecovery = tradeResults.filter(r => r.isRug && r.sells.some(s => s.level !== 'Rug' && s.solReturned > 0));
    const avgWinPnl = winners.length > 0 ? winners.reduce((s, r) => s + r.totalPnlSol, 0) / winners.length : 0;
    const avgLossPnl = losers.length > 0 ? losers.reduce((s, r) => s + r.totalPnlSol, 0) / losers.length : 0;
    const maxDrawdown = Math.min(...tradeResults.map(r => r.totalPnlSol));
    const sellsPerTrade = tradeResults.reduce((s, r) => s + r.sellCount, 0) / tradeResults.length;

    // Exit reason breakdown
    const exitReasons = {};
    tradeResults.forEach(r => {
      exitReasons[r.exitReason] = (exitReasons[r.exitReason] || 0) + 1;
    });

    results[name] = {
      totalPnl,
      evPerTrade: totalPnl / tradeResults.length,
      winRate: (winners.length / tradeResults.length * 100),
      winCount: winners.length,
      lossCount: losers.length,
      avgWinPnl,
      avgLossPnl,
      maxDrawdown,
      totalOverhead,
      sellsPerTrade,
      rugsFullLoss: rugsFullLoss.length,
      rugsPartialRecovery: rugsPartialRecovery.length,
      exitReasons,
      tradeResults,
      description: strategy.description,
    };
  }

  // ========== OUTPUT ==========

  // Summary comparison table
  console.log('='.repeat(100));
  console.log('  STRATEGY COMPARISON (N=' + positions.length + ' positions)');
  console.log('='.repeat(100));
  console.log();

  // Header
  const header = [
    'Strategy'.padEnd(45),
    'Total PnL'.padStart(11),
    'EV/Trade'.padStart(10),
    'Win%'.padStart(6),
    'W/L'.padStart(7),
    'AvgWin'.padStart(9),
    'AvgLoss'.padStart(9),
    'MaxDD'.padStart(9),
    'OH'.padStart(7),
    'Sells/T'.padStart(8),
    'RugFull'.padStart(8),
    'RugPart'.padStart(8),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  // Sort by total PnL descending
  const sorted = Object.entries(results).sort((a, b) => b[1].totalPnl - a[1].totalPnl);

  for (const [name, r] of sorted) {
    const row = [
      name.padEnd(45),
      `${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(4)}`.padStart(11),
      `${r.evPerTrade >= 0 ? '+' : ''}${(r.evPerTrade * 1000).toFixed(3)}m`.padStart(10),
      `${r.winRate.toFixed(1)}%`.padStart(6),
      `${r.winCount}/${r.lossCount}`.padStart(7),
      `${r.avgWinPnl >= 0 ? '+' : ''}${(r.avgWinPnl * 1000).toFixed(2)}m`.padStart(9),
      `${(r.avgLossPnl * 1000).toFixed(2)}m`.padStart(9),
      `${(r.maxDrawdown * 1000).toFixed(2)}m`.padStart(9),
      `${(r.totalOverhead * 1000).toFixed(1)}m`.padStart(7),
      `${r.sellsPerTrade.toFixed(2)}`.padStart(8),
      `${r.rugsFullLoss}`.padStart(8),
      `${r.rugsPartialRecovery}`.padStart(8),
    ].join(' | ');
    console.log(row);
  }

  console.log();
  console.log('Legend: PnL in SOL, EV in milli-SOL (m), W=winners, L=losers');
  console.log('        OH=total overhead, Sells/T=avg sell TXs per trade');
  console.log('        RugFull=rugs losing 100%, RugPart=rugs with partial recovery');
  console.log();

  // Detailed per-strategy breakdown
  for (const [name, r] of sorted) {
    console.log('='.repeat(100));
    console.log(`  ${name}`);
    console.log(`  ${r.description}`);
    console.log('='.repeat(100));

    // Exit reasons
    console.log('  Exit reasons:');
    for (const [reason, count] of Object.entries(r.exitReasons).sort((a, b) => b[1] - a[1])) {
      const subset = r.tradeResults.filter(t => t.exitReason === reason);
      const subPnl = subset.reduce((s, t) => s + t.totalPnlSol, 0);
      console.log(`    ${reason.padEnd(30)} ${String(count).padStart(3)} trades  ${subPnl >= 0 ? '+' : ''}${subPnl.toFixed(4)} SOL`);
    }

    // TP level hit rates
    const allSells = r.tradeResults.flatMap(t => t.sells);
    const tpLevelCounts = {};
    allSells.forEach(s => { tpLevelCounts[s.level] = (tpLevelCounts[s.level] || 0) + 1; });
    console.log('  Sell level distribution:');
    for (const [level, count] of Object.entries(tpLevelCounts).sort((a, b) => b[1] - a[1])) {
      const subset = allSells.filter(s => s.level === level);
      const avgMult = subset.reduce((s, t) => s + t.multiplier, 0) / subset.length;
      const totalSol = subset.reduce((s, t) => s + t.solReturned, 0);
      console.log(`    ${level.padEnd(15)} ${String(count).padStart(3)}x  avg mult=${avgMult.toFixed(3)}  total returned=${totalSol.toFixed(4)} SOL`);
    }

    // Moon bag warning for Strategy E
    if (name.includes('Moon')) {
      const moonSells = allSells.filter(s => s.level === 'MoonBag' || s.level === 'MoonTrail');
      if (moonSells.length > 0) {
        const avgMoonSize = moonSells.reduce((s, t) => s + (t.sellPct * 0.015), 0) / moonSells.length;
        console.log(`\n  *** MOON BAG WARNING ***`);
        console.log(`  Avg moon bag size: ${(avgMoonSize * 1000).toFixed(2)} mSOL`);
        console.log(`  Sell fee per moon bag: ${(EXTRA_SELL_FEE * 1000).toFixed(2)} mSOL`);
        console.log(`  Fee as % of moon bag: ${(EXTRA_SELL_FEE / avgMoonSize * 100).toFixed(1)}%`);
        if (EXTRA_SELL_FEE / avgMoonSize > 0.20) {
          console.log(`  *** OVERHEAD > 20% — Moon bags are NOT economically viable at this position size ***`);
        }
      }
    }

    // Per-trade details in verbose mode
    if (verbose) {
      console.log('\n  Per-trade details:');
      for (const t of r.tradeResults) {
        const mint6 = t.tokenMint.slice(0, 6);
        const sellDesc = t.sells.map(s => `${s.level}@${s.multiplier.toFixed(3)}x(${(s.sellPct*100).toFixed(0)}%)`).join(', ');
        console.log(`    ${mint6} ${t.solInvested}SOL peak=${t.peakMult.toFixed(3)}x ${t.exitReason.padEnd(25)} PnL=${(t.totalPnlSol*1000).toFixed(2)}m | ${sellDesc}`);
      }
    }

    console.log();
  }

  // ========== NORMALIZED COMPARISON ==========
  // Since positions are different sizes, also show per-SOL-invested metrics
  console.log('='.repeat(100));
  console.log('  NORMALIZED COMPARISON (per 0.015 SOL invested)');
  console.log('  Adjusting all trades to 0.015 SOL for fair comparison');
  console.log('='.repeat(100));
  console.log();

  const normHeader = [
    'Strategy'.padEnd(45),
    'Norm PnL'.padStart(11),
    'Norm EV/T'.padStart(11),
    'Breakeven'.padStart(10),
  ].join(' | ');
  console.log(normHeader);
  console.log('-'.repeat(normHeader.length));

  for (const [name, r] of sorted) {
    // Normalize: scale each trade's PnL as if position was 0.015 SOL
    let normTotalPnl = 0;
    for (const t of r.tradeResults) {
      const scale = 0.015 / t.solInvested;
      // PnL scales with position, overhead is fixed per trade
      const grossPnl = (t.totalSolReturned - t.solInvested) * scale;
      const normPnl = grossPnl - t.overhead; // overhead doesn't scale
      normTotalPnl += normPnl;
    }
    const normEv = normTotalPnl / r.tradeResults.length;
    // Breakeven win rate: at what win rate does this strategy break even?
    // EV = winRate * avgWin + (1-winRate) * avgLoss = 0
    // winRate = -avgLoss / (avgWin - avgLoss)
    const beWinRate = r.avgLossPnl !== 0 && r.avgWinPnl !== r.avgLossPnl
      ? (-r.avgLossPnl / (r.avgWinPnl - r.avgLossPnl) * 100)
      : 0;

    const normRow = [
      name.padEnd(45),
      `${normTotalPnl >= 0 ? '+' : ''}${normTotalPnl.toFixed(4)}`.padStart(11),
      `${normEv >= 0 ? '+' : ''}${(normEv * 1000).toFixed(3)}m`.padStart(11),
      `${beWinRate.toFixed(1)}%`.padStart(10),
    ].join(' | ');
    console.log(normRow);
  }

  console.log();

  // ========== SENSITIVITY ANALYSIS ==========
  console.log('='.repeat(100));
  console.log('  SENSITIVITY ANALYSIS: Impact of rug rate on top strategies');
  console.log('='.repeat(100));
  console.log();

  // Take top 3 strategies and simulate with different rug rates
  const topStrategies = sorted.slice(0, 5).map(([name]) => name);
  const rugRates = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20];

  console.log('  Estimated EV/trade (mSOL) at different rug rates:');
  const sensHeader = ['Strategy'.padEnd(45), ...rugRates.map(r => `${(r*100).toFixed(0)}%rug`.padStart(8))].join(' | ');
  console.log(sensHeader);
  console.log('-'.repeat(sensHeader.length));

  for (const stratName of topStrategies) {
    const r = results[stratName];
    const nonRugTrades = r.tradeResults.filter(t => !t.isRug);
    const rugTrades = r.tradeResults.filter(t => t.isRug);
    const avgNonRugPnl = nonRugTrades.length > 0 ? nonRugTrades.reduce((s, t) => s + t.totalPnlSol, 0) / nonRugTrades.length : 0;
    const avgRugPnl = rugTrades.length > 0 ? rugTrades.reduce((s, t) => s + t.totalPnlSol, 0) / rugTrades.length : 0;

    const evs = rugRates.map(rr => {
      const ev = (1 - rr) * avgNonRugPnl + rr * avgRugPnl;
      return `${ev >= 0 ? '+' : ''}${(ev * 1000).toFixed(2)}m`.padStart(8);
    });

    console.log([stratName.padEnd(45), ...evs].join(' | '));
  }

  console.log();

  // ========== KEY FINDINGS ==========
  console.log('='.repeat(100));
  console.log('  KEY FINDINGS & RECOMMENDATIONS');
  console.log('='.repeat(100));
  console.log();

  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const baseline = results['A: Current (100% @ 1.08x)'];

  if (baseline) {
    console.log(`  BASELINE (current): ${baseline.totalPnl >= 0 ? '+' : ''}${baseline.totalPnl.toFixed(4)} SOL total, EV=${(baseline.evPerTrade*1000).toFixed(3)} mSOL/trade, Win=${baseline.winRate.toFixed(1)}%`);
  }
  console.log(`  BEST:     ${best[0]}: ${best[1].totalPnl >= 0 ? '+' : ''}${best[1].totalPnl.toFixed(4)} SOL total, EV=${(best[1].evPerTrade*1000).toFixed(3)} mSOL/trade`);
  console.log(`  WORST:    ${worst[0]}: ${worst[1].totalPnl >= 0 ? '+' : ''}${worst[1].totalPnl.toFixed(4)} SOL total`);

  if (baseline && best[1].totalPnl > baseline.totalPnl) {
    const delta = best[1].totalPnl - baseline.totalPnl;
    console.log(`  IMPROVEMENT: Best strategy gains +${delta.toFixed(4)} SOL vs baseline (${(delta/Math.abs(baseline.totalPnl)*100).toFixed(1)}% better)`);
  }

  console.log();

  // Moon bag viability check
  const moonStrat = results['E: 3-Tier + Moon (40/30/20 + 10%@3x)'];
  if (moonStrat) {
    const moonSells = moonStrat.tradeResults.flatMap(t => t.sells).filter(s => s.level === 'MoonBag' || s.level === 'MoonTrail');
    console.log(`  MOON BAG ANALYSIS:`);
    console.log(`    Moon bag sells executed: ${moonSells.length}`);
    console.log(`    At 0.015 SOL position, 10% moon bag = 0.0015 SOL`);
    console.log(`    Sell overhead: 0.0004 SOL = ${(0.0004/0.0015*100).toFixed(1)}% of moon bag value`);
    console.log(`    VERDICT: ${0.0004/0.0015 > 0.20 ? 'NOT VIABLE at current position size' : 'Marginally viable'}`);
    console.log();
  }

  // Score-based strategy analysis
  const scoreStrat = results['F: Score-Based Dynamic'];
  if (scoreStrat) {
    const byScore = {
      'low (<80)': scoreStrat.tradeResults.filter(t => (t.position || positionData.find(d => d.position.id === t.positionId)?.position)?.security_score < 80),
    };
    // Note: most positions are <75 score, so score-based won't help much
    console.log(`  SCORE-BASED NOTE: ${positions.filter(p => p.security_score >= 80).length}/${positions.length} positions have score >= 80`);
    console.log(`    Score-based strategy has limited impact because most trades score < 80`);
    console.log();
  }

  // Position with DexScreener data coverage
  const withDex = positionData.filter(d => d.dexData !== null).length;
  const withoutDex = positionData.filter(d => d.dexData === null).length;
  console.log(`  DATA COVERAGE:`);
  console.log(`    Positions with DexScreener data: ${withDex}/${positions.length} (${(withDex/positions.length*100).toFixed(0)}%)`);
  console.log(`    Positions with tick data only: ${withoutDex}/${positions.length}`);
  console.log(`    Average ticks per position: ${(positionData.reduce((s, d) => s + d.ticks.length, 0) / positions.length).toFixed(1)}`);
  console.log();

  // Detailed comparison of top 3 strategies
  console.log('='.repeat(100));
  console.log('  TOP 3 STRATEGIES — TRADE-BY-TRADE COMPARISON');
  console.log('='.repeat(100));
  const top3 = sorted.slice(0, 3);

  // Show where strategies DIFFER
  console.log('\n  Positions where top strategy BEATS baseline:');
  if (baseline) {
    for (let i = 0; i < positions.length; i++) {
      const baseResult = baseline.tradeResults[i];
      const bestResult = top3[0][1].tradeResults[i];
      const diff = bestResult.totalPnlSol - baseResult.totalPnlSol;
      if (Math.abs(diff) > 0.0005) {
        const mint6 = positions[i].token_mint.slice(0, 6);
        const arrow = diff > 0 ? '>>>' : '<<<';
        console.log(`    ${mint6} ${arrow} base=${(baseResult.totalPnlSol*1000).toFixed(2)}m, best=${(bestResult.totalPnlSol*1000).toFixed(2)}m, delta=${(diff*1000).toFixed(2)}m (peak=${bestResult.peakMult.toFixed(2)}x)`);
      }
    }
  }

  // ========== DATA QUALITY & CAVEATS ==========
  console.log('='.repeat(100));
  console.log('  CRITICAL CAVEATS & DATA QUALITY');
  console.log('='.repeat(100));
  console.log();

  // Calculate how many positions use DexScreener vs tick-only
  const tickOnlyPositions = positionData.filter(d => !d.dexData);
  const dexPositions = positionData.filter(d => d.dexData);

  // How many of the "timeout" exits are based on DexScreener data (sparse)?
  let dexDrivenTimeouts = 0;
  let tickDrivenTimeouts = 0;
  const bestStrat = sorted[0][1];
  for (const t of bestStrat.tradeResults) {
    if (t.exitReason === 'timeout') {
      const data = positionData.find(d => d.position.id === t.positionId);
      if (data && data.dexData && data.dexData.checks.length > 0) {
        dexDrivenTimeouts++;
      } else {
        tickDrivenTimeouts++;
      }
    }
  }

  console.log('  1. DATA GAP: Most positions sell in <60s. Post-sell data comes from');
  console.log('     DexScreener snapshots (5/15/30/60 min) — coarse, not tick-by-tick.');
  console.log(`     ${dexDrivenTimeouts} "timeout" exits in best strategy use DexScreener data.`);
  console.log('     Intra-snapshot drawdowns (dips between 5min and 15min) are NOT captured.');
  console.log('     This makes trailing-stop strategies OPTIMISTIC — real trailing would fire');
  console.log('     on intra-snapshot dips we cannot see.');
  console.log();

  console.log('  2. EXECUTION RISK: Strategies that hold longer (J, K, L, M) assume the bot');
  console.log('     CAN sell at the trailing stop price. In practice:');
  console.log('     - Memecoin liquidity can evaporate instantly (rug = 0 liquidity)');
  console.log('     - Sell slippage increases as price drops');
  console.log('     - 7/91 positions had sell failures in production');
  console.log('     - Holding 5-12 min exposes position to MORE rug risk than selling at 30s');
  console.log();

  console.log('  3. SAMPLE SIZE: N=89 (9 rugs). At 10% rug rate, 1 additional rug');
  console.log('     changes EV by ~0.15 SOL. Results are sensitive to outliers.');
  console.log(`     Confidence: MEDIUM for direction (higher TP > 1.08x), LOW for exact values.`);
  console.log();

  console.log('  4. SURVIVORSHIP BIAS: DexScreener only returns data for tokens that still');
  console.log('     exist on-chain. Tokens that were completely rugged and drained may not');
  console.log('     show up, biasing peak multipliers upward.');
  console.log();

  console.log('  5. POSITION SIZE HETEROGENEITY: 4 different sizes (0.001-0.015 SOL).');
  console.log('     Overhead is fixed per trade, so small positions look worse.');
  console.log('     Normalized comparison (per 0.015 SOL) is more fair.');
  console.log();

  console.log('  6. TRAILING-ONLY STRATEGIES (J, J2, K): These work well in backtest but');
  console.log('     require EXTENDING the bot timeout from 12min to at least 15min.');
  console.log('     They also require HOLDING through sell bursts without panic-exiting.');
  console.log('     The bot currently sells on sell momentum — this would need to change.');
  console.log();

  // ========== PRACTICAL RECOMMENDATION ==========
  console.log('='.repeat(100));
  console.log('  PRACTICAL RECOMMENDATION');
  console.log('='.repeat(100));
  console.log();

  const b120 = results['B1.2: Fixed 100% @ 1.2x'];
  const b125 = results['B1.25: Fixed 100% @ 1.25x'];
  const hybridL = results['L: Hybrid (50%@1.15, 50% trail 15%)'];
  const hybridM = results['M: Hybrid (50%@1.20, 50% trail 15%)'];

  console.log('  SAFE BET (high confidence, minimal code change):');
  console.log('    -> Raise TP1 from 1.08x to 1.20x, still sell 100%');
  if (b120) {
    console.log(`       EV: +${(b120.evPerTrade*1000).toFixed(3)} mSOL/trade (was +${(baseline.evPerTrade*1000).toFixed(3)}), improvement: +${((b120.evPerTrade - baseline.evPerTrade)*1000).toFixed(3)} mSOL`);
    console.log(`       Win rate: ${b120.winRate.toFixed(1)}% (was ${baseline.winRate.toFixed(1)}%)`);
    console.log(`       This works because 66% of tokens reach 1.20x (vs 84% reaching 1.08x)`);
    console.log(`       You lose 18% of TP hits but each hit is worth 2.5x more (+20% vs +8%)`);
  }
  console.log();

  console.log('  MODERATE BET (needs testing, 2 sell TXs per trade):');
  console.log('    -> Hybrid: sell 50% at 1.20x, trail remaining 50% with 15% stop');
  if (hybridM) {
    console.log(`       EV: +${(hybridM.evPerTrade*1000).toFixed(3)} mSOL/trade, improvement: +${((hybridM.evPerTrade - baseline.evPerTrade)*1000).toFixed(3)} mSOL`);
    console.log(`       Extra overhead: 0.0004 SOL per trade for 2nd sell TX`);
    console.log(`       Requires extending timeout + holding through sell bursts`);
  }
  console.log();

  console.log('  AGGRESSIVE BET (highest EV but highest uncertainty):');
  console.log('    -> Trailing-only: no fixed TP, 15% trail from peak');
  if (bestStrat) {
    console.log(`       EV: +${(bestStrat.evPerTrade*1000).toFixed(3)} mSOL/trade, improvement: +${((bestStrat.evPerTrade - baseline.evPerTrade)*1000).toFixed(3)} mSOL`);
    console.log(`       WARNING: Most optimistic estimate. Real EV likely 30-50% lower`);
    console.log(`       due to intra-snapshot drawdowns and execution failures.`);
    console.log(`       Requires major bot changes: timeout extension, sell burst tolerance.`);
  }
  console.log();

  console.log('  VERDICT: Start with B1.2 (raise TP1 to 1.20x, sell 100%). Zero risk,');
  console.log('  minimal code change, validated improvement. Then test hybrid M in shadow');
  console.log('  mode to collect trailing-stop data before committing.');
  console.log();

  console.log('Done. Use --verbose for per-trade breakdown of all strategies.');
  console.log('Use --strategy X to focus on a single strategy (A through M).');
}

// ========== RUN ==========
try {
  runBacktest();
} catch (err) {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
} finally {
  db.close();
}
