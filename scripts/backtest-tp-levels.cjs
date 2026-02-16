#!/usr/bin/env node
/**
 * Backtest TP Levels (1.20x, 1.30x, 1.50x) across v11o-v11x
 *
 * Calculates "true peak" for each trade by combining:
 * 1. peak_multiplier (max while holding)
 * 2. post_trade_checks multiplier_vs_sell (growth after sell, with liq filter)
 * 3. pool_outcome_checks (additional peak data)
 *
 * Then simulates PnL at each TP level with trailing stop logic.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

// Config
const TP_LEVELS = [1.20, 1.30, 1.50];
const TRAILING_STOP_PCT = 0.20;  // 20% trailing from peak
const STOP_LOSS_MULT = 0.70;     // -30% stop loss
const MIN_LIQ_USD = 5000;        // Minimum liquidity to consider post-sell data valid

// Categories of exit reasons
const RUG_EXITS = ['rug_pull', 'max_retries', 'pool_drained'];
const EARLY_EXITS = ['early_exit', 'sell_burst_detected'];
const WINNER_EXITS = ['tp_complete', 'trailing_stop', 'dust_skip', 'creator_sell_detected', 'moon_bag'];

// ==================== DATA LOADING ====================

function loadTrades() {
  const stmt = db.prepare(`
    SELECT
      p.id,
      p.bot_version,
      p.token_mint,
      p.pool_address,
      p.exit_reason,
      p.pnl_pct,
      p.peak_multiplier,
      p.sol_invested,
      p.entry_price,
      p.opened_at,
      p.closed_at
    FROM positions p
    WHERE p.status IN ('closed','stopped')
    ORDER BY p.opened_at
  `);
  return stmt.all();
}

function loadPostTradeChecks() {
  const stmt = db.prepare(`
    SELECT
      position_id,
      delay_minutes,
      multiplier_vs_sell,
      liquidity_usd
    FROM post_trade_checks
    WHERE multiplier_vs_sell IS NOT NULL
    ORDER BY position_id, delay_minutes
  `);
  const rows = stmt.all();

  // Group by position_id
  const map = {};
  for (const row of rows) {
    if (!map[row.position_id]) map[row.position_id] = [];
    map[row.position_id].push(row);
  }
  return map;
}

function loadPoolOutcomeChecks() {
  // Get max price from pool_outcome_checks, linked via detected_pools.pool_address
  const stmt = db.prepare(`
    SELECT
      dp.pool_address,
      MAX(CASE WHEN poc.liquidity_usd > ? THEN poc.price_native ELSE NULL END) as max_price_liq,
      MAX(poc.price_native) as max_price_any
    FROM pool_outcome_checks poc
    JOIN detected_pools dp ON dp.id = poc.pool_id
    GROUP BY dp.pool_address
  `);
  const rows = stmt.all(MIN_LIQ_USD);

  const map = {};
  for (const row of rows) {
    map[row.pool_address] = row;
  }
  return map;
}

// ==================== TRUE PEAK CALCULATION ====================

function calcTruePeak(trade, postChecks, poolOutcome) {
  const peaks = [];

  // Source 1: peak_multiplier (max price while holding, relative to entry)
  if (trade.peak_multiplier && trade.peak_multiplier > 0) {
    peaks.push({ source: 'peak_multiplier', value: trade.peak_multiplier });
  }

  // Source 2: post_trade_checks
  // multiplier_vs_sell is relative to 2min post-sell price
  // The 2min check is always 1.0 (baseline)
  // So the true peak vs entry = sell_mult * max(multiplier_vs_sell where liq > 5000)
  // sell_mult = 1 + pnl_pct/100
  if (postChecks && postChecks.length > 0) {
    const sellMult = 1 + (trade.pnl_pct || 0) / 100.0;

    // With liquidity filter
    const liqChecks = postChecks.filter(c => c.liquidity_usd > MIN_LIQ_USD);
    if (liqChecks.length > 0) {
      const maxPostSellLiq = Math.max(...liqChecks.map(c => c.multiplier_vs_sell));
      if (maxPostSellLiq > 0 && maxPostSellLiq < 1000) { // Filter extreme outliers (1911x etc)
        const truePostPeak = sellMult * maxPostSellLiq;
        peaks.push({ source: 'post_trade_liq', value: truePostPeak });
      }
    }

    // Without liquidity filter (for informational purposes only)
    const maxPostSellAny = Math.max(...postChecks.map(c => c.multiplier_vs_sell));
    if (maxPostSellAny > 0 && maxPostSellAny < 1000) {
      const truePostPeakAny = sellMult * maxPostSellAny;
      peaks.push({ source: 'post_trade_any', value: truePostPeakAny });
    }
  }

  // Source 3: pool_outcome_checks (price_native needs conversion to multiplier)
  // pool_outcome price_native is absolute SOL price per token
  // entry_price is also SOL price per token
  if (poolOutcome && poolOutcome.max_price_liq && trade.entry_price > 0) {
    const pocMult = poolOutcome.max_price_liq / trade.entry_price;
    if (pocMult > 0 && pocMult < 1000) {
      peaks.push({ source: 'pool_outcome_liq', value: pocMult });
    }
  }

  // True peak = MAX of all sources (conservative: only with liquidity)
  const liqPeaks = peaks.filter(p => p.source !== 'post_trade_any');
  const truePeak = liqPeaks.length > 0 ? Math.max(...liqPeaks.map(p => p.value)) : null;

  // Also track the "any liquidity" peak for reference
  const anyPeak = peaks.length > 0 ? Math.max(...peaks.map(p => p.value)) : null;

  // Best source
  const bestSource = liqPeaks.length > 0
    ? liqPeaks.reduce((a, b) => a.value > b.value ? a : b).source
    : 'none';

  return { truePeak, anyPeak, bestSource, allPeaks: peaks };
}

// ==================== TP SIMULATION ====================

function isRugLike(exitReason) {
  if (!exitReason) return false;
  return RUG_EXITS.includes(exitReason) || exitReason.startsWith('stranded');
}

function isEarlyExit(exitReason) {
  return EARLY_EXITS.includes(exitReason);
}

/**
 * Simulate exit at a given TP level.
 *
 * Logic:
 * - If the trade is a rug/stranded AND the token never reached TP before dying:
 *   → loss = actual pnl_pct (usually -100%)
 * - If the trade is a rug BUT the token DID reach TP before dying:
 *   → we would have sold at TP → gain = TP_level - 1
 * - If the trade hit early_exit/sell_burst:
 *   → same loss as actual (the exit was forced before any TP check)
 * - If the trade is a winner:
 *   → If true_peak >= TP_level: we sell at TP → gain = (TP_level - 1) * 100
 *   → If true_peak < TP_level: trailing stop from peak
 *     simulated_exit = max(true_peak * (1 - TRAILING_STOP_PCT), STOP_LOSS_MULT)
 *     gain = (simulated_exit - 1) * 100
 */
function simulateTP(trade, truePeak, tpLevel) {
  const exitReason = trade.exit_reason || '';

  // Case 1: Rug/stranded — check if token reached TP before dying
  if (isRugLike(exitReason)) {
    // For rugs, peak_multiplier is the max while we held (before rug)
    // If peak_multiplier >= TP level, we would have sold at TP
    const peakBeforeDeath = trade.peak_multiplier || 1.0;
    if (peakBeforeDeath >= tpLevel) {
      // We would have hit TP before the rug!
      return {
        pnl_pct: (tpLevel - 1) * 100,
        outcome: 'tp_before_rug',
        exit_at: tpLevel
      };
    }
    // Token never reached TP → same loss
    return {
      pnl_pct: trade.pnl_pct,
      outcome: 'rug',
      exit_at: peakBeforeDeath
    };
  }

  // Case 2: Early exit (forced before any TP consideration)
  // These exits happen very early (sell_burst, early_exit) regardless of TP setting
  if (isEarlyExit(exitReason)) {
    return {
      pnl_pct: trade.pnl_pct,
      outcome: 'early_exit',
      exit_at: 1 + (trade.pnl_pct || 0) / 100
    };
  }

  // Case 3: Winner trades (tp_complete, trailing_stop, dust_skip, creator_sell)
  if (!truePeak || truePeak <= 0) {
    // No peak data — assume actual PnL is the best we can do
    return {
      pnl_pct: trade.pnl_pct,
      outcome: 'no_peak_data',
      exit_at: 1 + (trade.pnl_pct || 0) / 100
    };
  }

  if (truePeak >= tpLevel) {
    // Token reached TP level → we sell at TP
    return {
      pnl_pct: (tpLevel - 1) * 100,
      outcome: 'tp_hit',
      exit_at: tpLevel
    };
  }

  // Token peaked below TP → trailing stop from true peak
  // trailing stop = peak * (1 - trailing%) but floor at stop_loss
  const trailingExit = Math.max(truePeak * (1 - TRAILING_STOP_PCT), STOP_LOSS_MULT);
  const pnlPct = (trailingExit - 1) * 100;

  return {
    pnl_pct: pnlPct,
    outcome: trailingExit <= STOP_LOSS_MULT ? 'stop_loss' : 'trailing_below_tp',
    exit_at: trailingExit
  };
}

// ==================== REPORTING ====================

function printSep(char = '=', len = 120) {
  console.log(char.repeat(len));
}

function pad(str, len, align = 'left') {
  str = String(str);
  if (align === 'right') return str.padStart(len);
  if (align === 'center') {
    const leftPad = Math.floor((len - str.length) / 2);
    return ' '.repeat(Math.max(0, leftPad)) + str + ' '.repeat(Math.max(0, len - str.length - leftPad));
  }
  return str.padEnd(len);
}

function fmtPct(val, decimals = 1) {
  if (val == null || isNaN(val)) return 'N/A';
  return (val >= 0 ? '+' : '') + val.toFixed(decimals) + '%';
}

function fmtMult(val, decimals = 2) {
  if (val == null || isNaN(val)) return 'N/A';
  return val.toFixed(decimals) + 'x';
}

// ==================== MAIN ====================

function main() {
  console.log('\n' + '='.repeat(120));
  console.log(pad('BACKTEST: TP LEVELS 1.20x / 1.30x / 1.50x across v11o-v11x', 120, 'center'));
  console.log('='.repeat(120));
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Trailing stop: ${TRAILING_STOP_PCT * 100}% from peak`);
  console.log(`Stop loss floor: ${fmtMult(STOP_LOSS_MULT)} (${((STOP_LOSS_MULT - 1) * 100).toFixed(0)}%)`);
  console.log(`Min liquidity for post-sell data: $${MIN_LIQ_USD}`);

  // Load data
  const trades = loadTrades();
  const postChecksMap = loadPostTradeChecks();
  const poolOutcomeMap = loadPoolOutcomeChecks();

  console.log(`\nLoaded: ${trades.length} trades, ${Object.keys(postChecksMap).length} with post-trade checks, ${Object.keys(poolOutcomeMap).length} with pool outcomes\n`);

  // Calculate true peak for each trade
  const enrichedTrades = trades.map(t => {
    const postChecks = postChecksMap[t.id] || null;
    const poolOutcome = poolOutcomeMap[t.pool_address] || null;
    const { truePeak, anyPeak, bestSource, allPeaks } = calcTruePeak(t, postChecks, poolOutcome);
    return { ...t, truePeak, anyPeak, bestSource, allPeaks };
  });

  // Run simulation for each TP level
  const results = {};
  for (const tp of TP_LEVELS) {
    results[tp] = enrichedTrades.map(t => ({
      ...t,
      sim: simulateTP(t, t.truePeak, tp)
    }));
  }

  // ==================== TABLE 0: TRUE PEAK DATA QUALITY ====================
  printSep();
  console.log('\nTABLE 0: TRUE PEAK DATA QUALITY\n');

  const peakSources = {};
  let withPeak = 0, withoutPeak = 0;
  for (const t of enrichedTrades) {
    if (t.truePeak) {
      withPeak++;
      if (!peakSources[t.bestSource]) peakSources[t.bestSource] = 0;
      peakSources[t.bestSource]++;
    } else {
      withoutPeak++;
    }
  }
  console.log(`Trades with true peak data: ${withPeak}/${enrichedTrades.length} (${(withPeak/enrichedTrades.length*100).toFixed(1)}%)`);
  console.log(`Trades WITHOUT peak data:   ${withoutPeak}/${enrichedTrades.length}`);
  console.log('\nPeak source distribution:');
  for (const [src, cnt] of Object.entries(peakSources).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(src, 20)} ${cnt} trades (${(cnt/withPeak*100).toFixed(1)}%)`);
  }

  // Show peak distribution
  const peakBuckets = { '<1.0': 0, '1.0-1.1': 0, '1.1-1.2': 0, '1.2-1.3': 0, '1.3-1.5': 0, '1.5-2.0': 0, '2.0-3.0': 0, '3.0-5.0': 0, '5.0+': 0 };
  for (const t of enrichedTrades) {
    if (!t.truePeak) continue;
    const p = t.truePeak;
    if (p < 1.0) peakBuckets['<1.0']++;
    else if (p < 1.1) peakBuckets['1.0-1.1']++;
    else if (p < 1.2) peakBuckets['1.1-1.2']++;
    else if (p < 1.3) peakBuckets['1.2-1.3']++;
    else if (p < 1.5) peakBuckets['1.3-1.5']++;
    else if (p < 2.0) peakBuckets['1.5-2.0']++;
    else if (p < 3.0) peakBuckets['2.0-3.0']++;
    else if (p < 5.0) peakBuckets['3.0-5.0']++;
    else peakBuckets['5.0+']++;
  }
  console.log('\nTrue peak distribution:');
  for (const [bucket, cnt] of Object.entries(peakBuckets)) {
    const bar = '#'.repeat(Math.round(cnt / 2));
    console.log(`  ${pad(bucket, 10)} ${pad(String(cnt), 4, 'right')} ${bar}`);
  }

  // ==================== TABLE 1: PnL by Version and TP Level ====================
  printSep();
  console.log('\nTABLE 1: SIMULATED PnL BY VERSION AND TP LEVEL\n');

  const versions = [...new Set(enrichedTrades.map(t => t.bot_version))].sort();

  const header = [
    pad('Version', 10),
    pad('N', 5, 'right'),
    pad('Rugs', 5, 'right'),
    pad('Actual PnL%', 13, 'right'),
    pad('TP1.20 PnL%', 13, 'right'),
    pad('TP1.30 PnL%', 13, 'right'),
    pad('TP1.50 PnL%', 13, 'right'),
    pad('Best TP', 10, 'right')
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  const totalsByTp = {};
  for (const tp of TP_LEVELS) totalsByTp[tp] = { pnl: 0, n: 0 };
  let totalActualPnl = 0;
  let totalN = 0;

  for (const ver of versions) {
    const verTrades = enrichedTrades.filter(t => t.bot_version === ver);
    const n = verTrades.length;
    const rugs = verTrades.filter(t => isRugLike(t.exit_reason)).length;
    const actualPnl = verTrades.reduce((s, t) => s + (t.pnl_pct || 0), 0);

    const tpPnls = {};
    let bestTp = null;
    let bestPnl = -Infinity;

    for (const tp of TP_LEVELS) {
      const simTrades = results[tp].filter(t => t.bot_version === ver);
      const simPnl = simTrades.reduce((s, t) => s + (t.sim.pnl_pct || 0), 0);
      tpPnls[tp] = simPnl;
      totalsByTp[tp].pnl += simPnl;
      totalsByTp[tp].n += n;
      if (simPnl > bestPnl) { bestPnl = simPnl; bestTp = tp; }
    }

    totalActualPnl += actualPnl;
    totalN += n;

    const row = [
      pad(ver, 10),
      pad(String(n), 5, 'right'),
      pad(String(rugs), 5, 'right'),
      pad(fmtPct(actualPnl), 13, 'right'),
      pad(fmtPct(tpPnls[1.20]), 13, 'right'),
      pad(fmtPct(tpPnls[1.30]), 13, 'right'),
      pad(fmtPct(tpPnls[1.50]), 13, 'right'),
      pad(fmtMult(bestTp), 10, 'right')
    ].join(' | ');
    console.log(row);
  }

  console.log('-'.repeat(header.length));
  const totalRow = [
    pad('TOTAL', 10),
    pad(String(totalN), 5, 'right'),
    pad(String(enrichedTrades.filter(t => isRugLike(t.exit_reason)).length), 5, 'right'),
    pad(fmtPct(totalActualPnl), 13, 'right'),
    pad(fmtPct(totalsByTp[1.20].pnl), 13, 'right'),
    pad(fmtPct(totalsByTp[1.30].pnl), 13, 'right'),
    pad(fmtPct(totalsByTp[1.50].pnl), 13, 'right'),
    pad('', 10)
  ].join(' | ');
  console.log(totalRow);

  // ==================== TABLE 2: Hit Rate per TP Level ====================
  printSep();
  console.log('\nTABLE 2: HIT RATE PER TP LEVEL (based on true peak)\n');

  // How many trades have true_peak >= each level (excluding rugs that die before)
  const nonRugTrades = enrichedTrades.filter(t => !isRugLike(t.exit_reason) && !isEarlyExit(t.exit_reason));

  const header2 = [
    pad('TP Level', 10),
    pad('Hit N', 8, 'right'),
    pad('Total N', 8, 'right'),
    pad('Hit Rate', 10, 'right'),
    pad('Avg Gain', 12, 'right'),
    pad('Sum Gain%', 12, 'right'),
    pad('Miss Trail%', 12, 'right')
  ].join(' | ');
  console.log(header2);
  console.log('-'.repeat(header2.length));

  for (const tp of TP_LEVELS) {
    const hits = nonRugTrades.filter(t => t.truePeak && t.truePeak >= tp);
    const misses = nonRugTrades.filter(t => t.truePeak && t.truePeak > 1.0 && t.truePeak < tp);
    const hitRate = nonRugTrades.length > 0 ? hits.length / nonRugTrades.length * 100 : 0;
    const avgGain = (tp - 1) * 100;
    const sumGain = hits.length * avgGain;

    // For misses, what's their average trailing stop exit
    const missExits = misses.map(t => {
      const trailExit = Math.max(t.truePeak * (1 - TRAILING_STOP_PCT), STOP_LOSS_MULT);
      return (trailExit - 1) * 100;
    });
    const avgMissTrail = missExits.length > 0 ? missExits.reduce((a, b) => a + b, 0) / missExits.length : 0;

    const row = [
      pad(fmtMult(tp), 10),
      pad(String(hits.length), 8, 'right'),
      pad(String(nonRugTrades.length), 8, 'right'),
      pad(hitRate.toFixed(1) + '%', 10, 'right'),
      pad(fmtPct(avgGain), 12, 'right'),
      pad(fmtPct(sumGain), 12, 'right'),
      pad(fmtPct(avgMissTrail), 12, 'right')
    ].join(' | ');
    console.log(row);
  }

  // Also show: of ALL trades (incl rugs), how many have true_peak >= each level
  console.log('\n  Including rug trades:');
  for (const tp of TP_LEVELS) {
    const allWithPeak = enrichedTrades.filter(t => t.truePeak);
    const hits = allWithPeak.filter(t => t.truePeak >= tp);
    console.log(`    ${fmtMult(tp)}: ${hits.length}/${allWithPeak.length} (${(hits.length/allWithPeak.length*100).toFixed(1)}%) — of which ${hits.filter(t => isRugLike(t.exit_reason)).length} are rugs that peaked above TP before dying`);
  }

  // ==================== TABLE 3: Top 10 Trades with Biggest TP Differential ====================
  printSep();
  console.log('\nTABLE 3: TOP 15 TRADES WHERE TP LEVEL MAKES THE BIGGEST DIFFERENCE\n');

  // For each trade, calculate the difference between best and worst TP result
  const tradeWithDiff = enrichedTrades.map(t => {
    const sims = TP_LEVELS.map(tp => {
      const simResult = simulateTP(t, t.truePeak, tp);
      return { tp, pnl: simResult.pnl_pct, outcome: simResult.outcome };
    });
    const maxPnl = Math.max(...sims.map(s => s.pnl));
    const minPnl = Math.min(...sims.map(s => s.pnl));
    return { ...t, sims, diff: maxPnl - minPnl };
  }).sort((a, b) => b.diff - a.diff);

  const header3 = [
    pad('Token', 10),
    pad('Ver', 6),
    pad('Exit', 16),
    pad('TruePk', 8, 'right'),
    pad('Actual%', 10, 'right'),
    pad('@1.20x', 10, 'right'),
    pad('@1.30x', 10, 'right'),
    pad('@1.50x', 10, 'right'),
    pad('Diff', 8, 'right'),
    pad('PkSrc', 16)
  ].join(' | ');
  console.log(header3);
  console.log('-'.repeat(header3.length));

  for (const t of tradeWithDiff.slice(0, 15)) {
    const row = [
      pad(t.token_mint.substring(0, 10), 10),
      pad(t.bot_version, 6),
      pad(t.exit_reason || 'N/A', 16),
      pad(t.truePeak ? fmtMult(t.truePeak) : 'N/A', 8, 'right'),
      pad(fmtPct(t.pnl_pct), 10, 'right'),
      pad(fmtPct(t.sims[0].pnl), 10, 'right'),
      pad(fmtPct(t.sims[1].pnl), 10, 'right'),
      pad(fmtPct(t.sims[2].pnl), 10, 'right'),
      pad(t.diff.toFixed(1), 8, 'right'),
      pad(t.bestSource, 16)
    ].join(' | ');
    console.log(row);
  }

  // ==================== TABLE 4: Rug Pulls — Would Each TP Have Saved Them? ====================
  printSep();
  console.log('\nTABLE 4: RUG PULLS — WOULD TP HAVE BEEN HIT BEFORE RUG?\n');

  const rugTrades = enrichedTrades.filter(t => isRugLike(t.exit_reason));

  const header4 = [
    pad('Token', 10),
    pad('Ver', 6),
    pad('Exit', 12),
    pad('Peak', 8, 'right'),
    pad('PnL%', 10, 'right'),
    pad('Hit1.20', 8, 'center'),
    pad('Hit1.30', 8, 'center'),
    pad('Hit1.50', 8, 'center'),
    pad('Notes', 30)
  ].join(' | ');
  console.log(header4);
  console.log('-'.repeat(header4.length));

  let savedByTp = { 1.20: 0, 1.30: 0, 1.50: 0 };

  for (const t of rugTrades) {
    const peakBeforeDeath = t.peak_multiplier || 1.0;
    const hit120 = peakBeforeDeath >= 1.20;
    const hit130 = peakBeforeDeath >= 1.30;
    const hit150 = peakBeforeDeath >= 1.50;

    if (hit120) savedByTp[1.20]++;
    if (hit130) savedByTp[1.30]++;
    if (hit150) savedByTp[1.50]++;

    let notes = '';
    if (peakBeforeDeath < 1.05) notes = 'Never pumped (instant rug)';
    else if (peakBeforeDeath < 1.20) notes = `Peaked at ${fmtMult(peakBeforeDeath)} before rug`;
    else notes = `Escaped at ${fmtMult(peakBeforeDeath)}+ then rug`;

    const row = [
      pad(t.token_mint.substring(0, 10), 10),
      pad(t.bot_version, 6),
      pad(t.exit_reason, 12),
      pad(fmtMult(peakBeforeDeath), 8, 'right'),
      pad(fmtPct(t.pnl_pct), 10, 'right'),
      pad(hit120 ? 'YES' : 'no', 8, 'center'),
      pad(hit130 ? 'YES' : 'no', 8, 'center'),
      pad(hit150 ? 'YES' : 'no', 8, 'center'),
      pad(notes, 30)
    ].join(' | ');
    console.log(row);
  }

  console.log('-'.repeat(header4.length));
  console.log(`\nRugs saved by TP (sold at TP before rug):`);
  for (const tp of TP_LEVELS) {
    console.log(`  ${fmtMult(tp)}: ${savedByTp[tp]}/${rugTrades.length} rugs would have been saved (${(savedByTp[tp]/rugTrades.length*100).toFixed(1)}%)`);
  }

  // ==================== TABLE 5: SUMMARY — EV PER TRADE ====================
  printSep();
  console.log('\nTABLE 5: FINAL SUMMARY — EV PER TRADE\n');

  const header5 = [
    pad('TP Level', 10),
    pad('Total PnL%', 13, 'right'),
    pad('Avg/Trade%', 13, 'right'),
    pad('Winners', 10, 'right'),
    pad('Losers', 10, 'right'),
    pad('Win Rate', 10, 'right'),
    pad('Avg Win%', 10, 'right'),
    pad('Avg Loss%', 10, 'right'),
    pad('W:L Ratio', 10, 'right')
  ].join(' | ');
  console.log(header5);
  console.log('-'.repeat(header5.length));

  // Actual results first
  {
    const totalPnl = enrichedTrades.reduce((s, t) => s + (t.pnl_pct || 0), 0);
    const winners = enrichedTrades.filter(t => (t.pnl_pct || 0) > 0);
    const losers = enrichedTrades.filter(t => (t.pnl_pct || 0) <= 0);
    const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnl_pct, 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnl_pct, 0) / losers.length : 0;
    const wlRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;

    const row = [
      pad('ACTUAL', 10),
      pad(fmtPct(totalPnl), 13, 'right'),
      pad(fmtPct(totalPnl / enrichedTrades.length), 13, 'right'),
      pad(String(winners.length), 10, 'right'),
      pad(String(losers.length), 10, 'right'),
      pad((winners.length / enrichedTrades.length * 100).toFixed(1) + '%', 10, 'right'),
      pad(fmtPct(avgWin), 10, 'right'),
      pad(fmtPct(avgLoss), 10, 'right'),
      pad(wlRatio === Infinity ? 'N/A' : wlRatio.toFixed(2), 10, 'right')
    ].join(' | ');
    console.log(row);
  }

  // Each TP level
  for (const tp of TP_LEVELS) {
    const simTrades = results[tp];
    const totalPnl = simTrades.reduce((s, t) => s + (t.sim.pnl_pct || 0), 0);
    const winners = simTrades.filter(t => (t.sim.pnl_pct || 0) > 0);
    const losers = simTrades.filter(t => (t.sim.pnl_pct || 0) <= 0);
    const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.sim.pnl_pct, 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.sim.pnl_pct, 0) / losers.length : 0;
    const wlRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;

    const row = [
      pad(fmtMult(tp), 10),
      pad(fmtPct(totalPnl), 13, 'right'),
      pad(fmtPct(totalPnl / simTrades.length), 13, 'right'),
      pad(String(winners.length), 10, 'right'),
      pad(String(losers.length), 10, 'right'),
      pad((winners.length / simTrades.length * 100).toFixed(1) + '%', 10, 'right'),
      pad(fmtPct(avgWin), 10, 'right'),
      pad(fmtPct(avgLoss), 10, 'right'),
      pad(wlRatio === Infinity ? 'N/A' : wlRatio.toFixed(2), 10, 'right')
    ].join(' | ');
    console.log(row);
  }

  // ==================== TABLE 6: OUTCOME BREAKDOWN PER TP ====================
  printSep();
  console.log('\nTABLE 6: OUTCOME BREAKDOWN PER TP LEVEL\n');

  for (const tp of TP_LEVELS) {
    console.log(`--- TP ${fmtMult(tp)} ---`);
    const simTrades = results[tp];
    const outcomes = {};
    for (const t of simTrades) {
      const o = t.sim.outcome;
      if (!outcomes[o]) outcomes[o] = { count: 0, pnl: 0 };
      outcomes[o].count++;
      outcomes[o].pnl += t.sim.pnl_pct || 0;
    }

    const header6 = [
      pad('Outcome', 22),
      pad('Count', 6, 'right'),
      pad('Pct', 8, 'right'),
      pad('Total PnL%', 12, 'right'),
      pad('Avg PnL%', 12, 'right')
    ].join(' | ');
    console.log(header6);

    for (const [outcome, data] of Object.entries(outcomes).sort((a, b) => b[1].count - a[1].count)) {
      const row = [
        pad(outcome, 22),
        pad(String(data.count), 6, 'right'),
        pad((data.count / simTrades.length * 100).toFixed(1) + '%', 8, 'right'),
        pad(fmtPct(data.pnl), 12, 'right'),
        pad(fmtPct(data.pnl / data.count), 12, 'right')
      ].join(' | ');
      console.log(row);
    }
    console.log('');
  }

  // ==================== TABLE 7: DETAILED TRADE LIST (every trade) ====================
  printSep();
  console.log('\nTABLE 7: DETAILED SIMULATION — ALL TRADES\n');

  const header7 = [
    pad('#', 4, 'right'),
    pad('Token', 10),
    pad('Ver', 6),
    pad('Exit', 16),
    pad('ActPnL%', 10, 'right'),
    pad('TruePk', 8, 'right'),
    pad('@1.20', 10, 'right'),
    pad('Out1.20', 16),
    pad('@1.30', 10, 'right'),
    pad('Out1.30', 16),
    pad('@1.50', 10, 'right'),
    pad('Out1.50', 16)
  ].join(' | ');
  console.log(header7);
  console.log('-'.repeat(header7.length));

  enrichedTrades.forEach((t, idx) => {
    const sim120 = simulateTP(t, t.truePeak, 1.20);
    const sim130 = simulateTP(t, t.truePeak, 1.30);
    const sim150 = simulateTP(t, t.truePeak, 1.50);

    const row = [
      pad(String(idx + 1), 4, 'right'),
      pad(t.token_mint.substring(0, 10), 10),
      pad(t.bot_version, 6),
      pad(t.exit_reason || 'N/A', 16),
      pad(fmtPct(t.pnl_pct), 10, 'right'),
      pad(t.truePeak ? fmtMult(t.truePeak) : 'N/A', 8, 'right'),
      pad(fmtPct(sim120.pnl_pct), 10, 'right'),
      pad(sim120.outcome, 16),
      pad(fmtPct(sim130.pnl_pct), 10, 'right'),
      pad(sim130.outcome, 16),
      pad(fmtPct(sim150.pnl_pct), 10, 'right'),
      pad(sim150.outcome, 16)
    ].join(' | ');
    console.log(row);
  });

  // ==================== SENSITIVITY ANALYSIS ====================
  printSep();
  console.log('\nTABLE 8: SENSITIVITY — TRAILING STOP PERCENTAGE\n');

  const trailingStops = [0.10, 0.15, 0.20, 0.25, 0.30];

  for (const tp of TP_LEVELS) {
    console.log(`--- TP ${fmtMult(tp)} ---`);
    const sens_header = [
      pad('Trail%', 8),
      pad('Total PnL%', 13, 'right'),
      pad('Avg/Trade%', 13, 'right'),
      pad('Winners', 10, 'right'),
      pad('Win Rate', 10, 'right')
    ].join(' | ');
    console.log(sens_header);

    for (const trail of trailingStops) {
      let totalPnl = 0;
      let winners = 0;

      for (const t of enrichedTrades) {
        // Custom simulation with different trailing stop
        const exitReason = t.exit_reason || '';
        let pnl;

        if (isRugLike(exitReason)) {
          const peakBeforeDeath = t.peak_multiplier || 1.0;
          pnl = peakBeforeDeath >= tp ? (tp - 1) * 100 : t.pnl_pct;
        } else if (isEarlyExit(exitReason)) {
          pnl = t.pnl_pct;
        } else if (!t.truePeak || t.truePeak <= 0) {
          pnl = t.pnl_pct;
        } else if (t.truePeak >= tp) {
          pnl = (tp - 1) * 100;
        } else {
          const trailExit = Math.max(t.truePeak * (1 - trail), STOP_LOSS_MULT);
          pnl = (trailExit - 1) * 100;
        }

        totalPnl += pnl || 0;
        if ((pnl || 0) > 0) winners++;
      }

      const row = [
        pad((trail * 100).toFixed(0) + '%', 8),
        pad(fmtPct(totalPnl), 13, 'right'),
        pad(fmtPct(totalPnl / enrichedTrades.length), 13, 'right'),
        pad(String(winners), 10, 'right'),
        pad((winners / enrichedTrades.length * 100).toFixed(1) + '%', 10, 'right')
      ].join(' | ');
      console.log(row);
    }
    console.log('');
  }

  // ==================== FETCH DEXSCREENER FOR RECENT TRADES WITHOUT POST-SELL DATA ====================
  // Skip DexScreener — would require async and these are old tokens anyway

  // ==================== KEY INSIGHTS ====================
  printSep();
  console.log('\nKEY INSIGHTS\n');

  // Find the best strategy
  const strategies = [
    { name: 'Actual', pnl: enrichedTrades.reduce((s, t) => s + (t.pnl_pct || 0), 0) },
  ];
  for (const tp of TP_LEVELS) {
    strategies.push({
      name: `TP ${fmtMult(tp)}`,
      pnl: results[tp].reduce((s, t) => s + (t.sim.pnl_pct || 0), 0)
    });
  }
  strategies.sort((a, b) => b.pnl - a.pnl);

  console.log('Strategy ranking (total PnL%):');
  strategies.forEach((s, i) => {
    const marker = i === 0 ? ' <-- BEST' : '';
    console.log(`  ${i + 1}. ${pad(s.name, 12)} ${fmtPct(s.pnl)}${marker}`);
  });

  // Calculate how many winners get WORSE with higher TP
  const worseWith150 = enrichedTrades.filter(t => {
    if (isRugLike(t.exit_reason) || isEarlyExit(t.exit_reason)) return false;
    const sim120 = simulateTP(t, t.truePeak, 1.20);
    const sim150 = simulateTP(t, t.truePeak, 1.50);
    return sim120.pnl_pct > sim150.pnl_pct;
  });
  const betterWith150 = enrichedTrades.filter(t => {
    if (isRugLike(t.exit_reason) || isEarlyExit(t.exit_reason)) return false;
    const sim120 = simulateTP(t, t.truePeak, 1.20);
    const sim150 = simulateTP(t, t.truePeak, 1.50);
    return sim150.pnl_pct > sim120.pnl_pct;
  });

  console.log(`\nTP 1.50x vs 1.20x trade-by-trade:`);
  console.log(`  Better at 1.50x: ${betterWith150.length} trades`);
  console.log(`  Worse at 1.50x:  ${worseWith150.length} trades`);
  console.log(`  Same:            ${enrichedTrades.length - betterWith150.length - worseWith150.length} trades`);

  if (worseWith150.length > 0) {
    console.log(`\n  Trades that LOSE money moving from 1.20x to 1.50x:`);
    for (const t of worseWith150.slice(0, 10)) {
      const s120 = simulateTP(t, t.truePeak, 1.20);
      const s150 = simulateTP(t, t.truePeak, 1.50);
      console.log(`    ${t.token_mint.substring(0, 10)} (${t.bot_version}): peak=${fmtMult(t.truePeak)}, @1.20=${fmtPct(s120.pnl_pct)}, @1.50=${fmtPct(s150.pnl_pct)} [${s150.outcome}]`);
    }
  }

  // Breakeven analysis
  console.log('\n\nBREAKEVEN ANALYSIS (overhead not included):');
  for (const tp of TP_LEVELS) {
    const simTrades = results[tp];
    const cumPnl = [];
    let running = 0;
    for (const t of simTrades) {
      running += t.sim.pnl_pct || 0;
      cumPnl.push(running);
    }
    const maxDrawdown = Math.min(...cumPnl);
    const finalPnl = cumPnl[cumPnl.length - 1];
    const everPositive = cumPnl.some(p => p > 0);
    const lastPositive = [...cumPnl].reverse().findIndex(p => p > 0);

    console.log(`  TP ${fmtMult(tp)}: final=${fmtPct(finalPnl)}, maxDD=${fmtPct(maxDrawdown)}, ever positive: ${everPositive ? 'YES' : 'NO'}`);
  }

  console.log('\n' + '='.repeat(120));
  console.log('END OF BACKTEST');
  console.log('='.repeat(120) + '\n');

  db.close();
}

main();
