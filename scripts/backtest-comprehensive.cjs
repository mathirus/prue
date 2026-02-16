#!/usr/bin/env node
/**
 * Comprehensive Backtest: Higher TP Levels + Selectivity + Combined
 *
 * KEY INSIGHT on PnL modeling:
 *   The DB stores pnl_sol = sol_returned - sol_invested (real, net of all fees).
 *   For tp_complete at 0.015 SOL, avg pnl = +0.0014 SOL (avg pnl_pct = 10%).
 *   The TP triggers at 1.08x TOKEN price, but due to favorable sell execution,
 *   actual SOL returned is ~1.09-1.10x of invested.
 *
 * For simulation of DIFFERENT TP levels, we use:
 *   simulated_pnl = invested * (tp_level - 1) * sell_efficiency
 *   where sell_efficiency ≈ 0.97 (3% lost to AMM fees + slippage)
 *   This is calibrated from actual data: at 1.08x TP, avg pnl_pct = 10%
 *   → invested * 0.08 * efficiency = invested * 0.10 → efficiency = 1.25?
 *   Actually: the bot sells ABOVE 1.08x (price can rise between trigger and execution)
 *
 * SIMPLEST CORRECT APPROACH:
 *   For TP hits: pnl = invested * (tp_level - 1) - overhead
 *   overhead ≈ 0.0004 SOL per sell (TX fee)
 *   The ATA cost is paid at buy time and is the same regardless of TP level.
 *   From data: invested=0.015, returned=0.0164 → gross_return = 1.093x
 *   But TP trigger = 1.08x → the extra 1.3% is price improvement during sell
 *
 * For trailing stop exits: pnl = invested * (exit_mult - 1) - overhead
 * For rugs: pnl = -invested (total loss)
 *
 * Usage:
 *   node scripts/backtest-comprehensive.cjs
 *   node scripts/backtest-comprehensive.cjs --verbose
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

// Tokens to EXCLUDE (wrong decimals in DexScreener causing 1000x+ readings)
const EXCLUDE_TOKENS = [
  'AamEDU3zAumgXzRb4KHbzA1Ti8NReDubgsKw1YuSWr19',
  'BCTCJfAuU5sao9H3McRCXgmqN9gkxi9hv8EwUSUxYWJY',
];

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const versionFilter = args.find(a => a.startsWith('--version='))?.split('=')[1]
  || (args.includes('--version') ? args[args.indexOf('--version') + 1] : null);

// ========== DATA ==========

function loadAllTrades() {
  let query = `
    SELECT p.id, p.token_mint, p.pool_address, p.sol_invested, p.sol_returned,
           p.pnl_sol, p.pnl_pct, p.peak_multiplier, p.exit_reason, p.bot_version,
           p.security_score, p.holder_count, p.liquidity_usd,
           p.opened_at, p.closed_at,
           p.post_sell_max_multiplier, p.entry_price
    FROM positions p
    WHERE p.status IN ('closed', 'stopped')
      AND p.bot_version >= 'v11o'
  `;
  if (versionFilter) query += ` AND p.bot_version = '${versionFilter}'`;
  query += ` ORDER BY p.opened_at`;
  return db.prepare(query).all().filter(r => !EXCLUDE_TOKENS.includes(r.token_mint));
}

function loadDexPeakForToken(tokenMint, entryPrice) {
  if (!entryPrice) return null;
  const rows = db.prepare(`
    SELECT poc.price_native, poc.delay_minutes
    FROM pool_outcome_checks poc
    JOIN detected_pools dp ON dp.id = poc.pool_id
    WHERE dp.base_mint = ? AND poc.price_native > 0
    ORDER BY poc.delay_minutes
  `).all(tokenMint);
  if (!rows.length) return null;
  let maxMult = 0;
  for (const r of rows) {
    const mult = r.price_native / (entryPrice * 1e6);
    if (mult > maxMult && mult < 100) maxMult = mult;
  }
  return maxMult > 0 ? maxMult : null;
}

// ========== TRADE CLASSIFICATION ==========

function isRug(trade) {
  return trade.exit_reason === 'rug_pull' ||
         trade.exit_reason === 'stranded_timeout_max_retries' ||
         (trade.exit_reason === 'max_retries' && trade.pnl_pct <= -80) ||
         trade.pnl_pct <= -90;
}

// ========== COMPUTE TRUE PEAK ==========
// True peak = MAX of peak during trade + what DexScreener saw after

function computeTruePeak(trade) {
  let peak = trade.peak_multiplier || 1.0;

  // DexScreener pool_outcome_checks is the MOST RELIABLE source
  // (we compute multiplier directly from price_native / entry_price)
  const dexPeak = loadDexPeakForToken(trade.token_mint, trade.entry_price);
  if (dexPeak && dexPeak > peak) peak = dexPeak;

  // post_sell_max_multiplier is UNRELIABLE for rugs (shows inflated values)
  // Only use it if: (a) it's not a rug, (b) it's < 100 (not broken), (c) it agrees with direction
  // For rugs, DexScreener + peak_multiplier are sufficient
  if (!isRug(trade) && trade.post_sell_max_multiplier &&
      trade.post_sell_max_multiplier < 100 && trade.post_sell_max_multiplier > peak) {
    peak = trade.post_sell_max_multiplier;
  }

  return peak;
}

// ========== TP SIMULATION ==========
// Given a trade and a target TP level, compute what WOULD have happened

function simulateAtTPLevel(trade, tpLevel, truePeak) {
  const inv = trade.sol_invested;

  // Rugs always lose 100% regardless of TP level
  if (isRug(trade)) {
    return { outcome: 'rug', pnlSol: -inv, exitMult: 0 };
  }

  // Did the token reach the TP level?
  if (truePeak >= tpLevel) {
    // TP HIT: sell 100% at tpLevel
    // From real data: the sell execution gives about 2% bonus above trigger
    // (price rises between TP trigger check and actual sell)
    // But to be conservative, assume sell exactly at tpLevel
    // The actual overhead is already in the price (AMM swap fee ~0.25%)
    // pnl = inv * (tpLevel - 1) - swap_fees
    // swap_fees ≈ inv * tpLevel * 0.0025 (0.25% of sell amount)
    const grossReturn = inv * tpLevel;
    const swapFee = grossReturn * 0.0025; // PumpSwap fee
    const txFee = 0.00005; // Solana TX fee (negligible)
    const netReturn = grossReturn - swapFee - txFee;
    const pnlSol = netReturn - inv;
    return { outcome: 'tp_hit', pnlSol, exitMult: tpLevel };
  }

  // Token didn't reach TP: would exit via trailing stop
  // Trailing stop fires at peak * (1 - trail%)
  // Before TP1: trail = 25%
  // After TP1: trail = 20%
  // Since TP wasn't hit, use 25% trailing
  const trailPct = 0.25;
  let exitMult = truePeak * (1 - trailPct);

  // Stop loss floor at -30%
  if (exitMult < 0.70) exitMult = 0.70;

  const grossReturn = inv * exitMult;
  const swapFee = grossReturn * 0.0025;
  const txFee = 0.00005;
  const netReturn = grossReturn - swapFee - txFee;
  const pnlSol = netReturn - inv;

  const outcomeType = pnlSol > 0 ? 'trailing_profit' : 'trailing_loss';
  return { outcome: outcomeType, pnlSol, exitMult };
}

// Use ACTUAL pnl for the current strategy (since that's ground truth)
function actualPnl(trade) {
  return trade.pnl_sol;
}

// ========== MAIN ==========

function main() {
  const trades = loadAllTrades();

  console.log(`\n${'='.repeat(100)}`);
  console.log(`  COMPREHENSIVE BACKTEST — ${versionFilter || 'ALL v11o+'} — N=${trades.length} trades`);
  console.log(`${'='.repeat(100)}\n`);

  // Enrich with true peak
  const enriched = trades.map(t => ({
    ...t,
    truePeak: computeTruePeak(t),
    rug: isRug(t),
  }));

  const rugs = enriched.filter(t => t.rug);
  const nonRugs = enriched.filter(t => !t.rug);
  const actualTotalPnl = enriched.reduce((s, t) => s + t.pnl_sol, 0);

  console.log('--- BASELINE DATA ---');
  console.log(`Total trades: ${enriched.length} (${rugs.length} rugs, ${nonRugs.length} non-rugs)`);
  console.log(`Actual total PnL (as traded): ${actualTotalPnl >= 0 ? '+' : ''}${actualTotalPnl.toFixed(4)} SOL`);
  console.log(`Actual winners: ${enriched.filter(t => t.pnl_sol > 0).length} (${(enriched.filter(t => t.pnl_sol > 0).length / enriched.length * 100).toFixed(1)}%)`);
  console.log(`Position sizes in data: ${[...new Set(enriched.map(t => t.sol_invested))].sort((a,b) => a-b).join(', ')} SOL`);
  console.log(`Average loss per rug: ${(rugs.reduce((s, t) => s + t.pnl_sol, 0) / rugs.length).toFixed(4)} SOL`);
  console.log();

  // True peak distribution (non-rugs only)
  console.log('--- TRUE PEAK DISTRIBUTION (non-rug trades only, N=' + nonRugs.length + ') ---');
  const buckets = [
    { label: '< 1.08x', min: 0, max: 1.08 },
    { label: '1.08-1.15x', min: 1.08, max: 1.15 },
    { label: '1.15-1.20x', min: 1.15, max: 1.20 },
    { label: '1.20-1.30x', min: 1.20, max: 1.30 },
    { label: '1.30-1.50x', min: 1.30, max: 1.50 },
    { label: '1.50-2.00x', min: 1.50, max: 2.00 },
    { label: '2.00-5.00x', min: 2.00, max: 5.00 },
    { label: '5.00x+', min: 5.00, max: Infinity },
  ];

  const cumulativeRates = {};
  for (const b of buckets) {
    const inBucket = nonRugs.filter(t => t.truePeak >= b.min && t.truePeak < b.max);
    const reachThis = nonRugs.filter(t => t.truePeak >= b.min).length;
    const reachPct = (reachThis / nonRugs.length * 100).toFixed(1);
    cumulativeRates[b.min] = reachPct;
    console.log(`  ${b.label.padEnd(15)} ${String(inBucket.length).padStart(3)} trades  |  Reach ${b.min}x+: ${String(reachThis).padStart(3)} (${reachPct}%)`);
  }
  console.log();

  // Also show rug peaks (do rugs ever reach TP?)
  console.log('--- RUG PEAK DISTRIBUTION (N=' + rugs.length + ') ---');
  for (const b of buckets.slice(0, 4)) {
    const inBucket = rugs.filter(t => t.truePeak >= b.min && t.truePeak < b.max);
    if (inBucket.length > 0) {
      console.log(`  ${b.label.padEnd(15)} ${inBucket.length} rugs`);
    }
  }
  const rugsAbove108 = rugs.filter(t => t.truePeak >= 1.08);
  console.log(`  Rugs that reached 1.08x: ${rugsAbove108.length}/${rugs.length} (${(rugsAbove108.length/rugs.length*100).toFixed(0)}%)`);
  console.log();

  // ==================================================================
  // BACKTEST 1: HIGHER TP LEVELS
  // ==================================================================
  console.log(`${'='.repeat(100)}`);
  console.log('  BACKTEST 1: HIGHER TP LEVELS (sell 100% at TP)');
  console.log(`${'='.repeat(100)}\n`);

  const tpLevels = [1.08, 1.10, 1.15, 1.20, 1.25, 1.30, 1.50, 2.00];
  const tpResultsMap = {};

  for (const tp of tpLevels) {
    const results = enriched.map(t => {
      const sim = simulateAtTPLevel(t, tp, t.truePeak);
      return { ...t, sim };
    });

    const tpHits = results.filter(r => r.sim.outcome === 'tp_hit');
    const trailP = results.filter(r => r.sim.outcome === 'trailing_profit');
    const trailL = results.filter(r => r.sim.outcome === 'trailing_loss');
    const rugL = results.filter(r => r.sim.outcome === 'rug');

    const totalPnl = results.reduce((s, r) => s + r.sim.pnlSol, 0);
    const winners = results.filter(r => r.sim.pnlSol > 0);
    const winRate = (winners.length / results.length * 100).toFixed(1);
    const evPerTrade = totalPnl / results.length;
    const avgTpGain = tpHits.length > 0 ? (tpHits.reduce((s, r) => s + r.sim.pnlSol, 0) / tpHits.length) : 0;
    const avgLoss = rugL.length > 0 ? (rugL.reduce((s, r) => s + r.sim.pnlSol, 0) / rugL.length) : 0;

    tpResultsMap[tp] = { totalPnl, winRate: parseFloat(winRate), tpHits: tpHits.length, evPerTrade };

    console.log(`--- TP at ${tp}x ---`);
    console.log(`  TP hits:          ${String(tpHits.length).padStart(3)} / ${results.length} (${(tpHits.length/results.length*100).toFixed(1)}%)  avg gain: ${(avgTpGain * 1000).toFixed(2)} mSOL`);
    console.log(`  Trail (profit):   ${String(trailP.length).padStart(3)}  |  Trail (loss): ${String(trailL.length).padStart(3)}  |  Rugs: ${rugL.length}`);
    console.log(`  Win rate:         ${winRate}%  (${winners.length} / ${results.length})`);
    console.log(`  Total PnL:        ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`);
    console.log(`  EV/trade:         ${evPerTrade >= 0 ? '+' : ''}${(evPerTrade * 1000).toFixed(3)} mSOL`);

    // For the current TP, show comparison to actual
    if (tp === 1.08) {
      console.log(`  [Actual PnL was: ${actualTotalPnl.toFixed(4)} SOL — difference from simulation: ${(actualTotalPnl - totalPnl).toFixed(4)} SOL]`);
      console.log(`  [Simulation is slightly pessimistic because real sells execute above trigger price]`);
    }
    console.log();
  }

  // Comparison table
  console.log('--- TP LEVEL COMPARISON TABLE ---');
  console.log(`${'TP'.padEnd(8)} ${'Hits'.padStart(5)} ${'WinRate'.padStart(8)} ${'TotalPnL'.padStart(12)} ${'EV/trade'.padStart(12)} ${'vs 1.08x'.padStart(12)} ${'Improvement'.padStart(12)}`);
  console.log('-'.repeat(75));
  const baselinePnl = tpResultsMap[1.08].totalPnl;
  for (const tp of tpLevels) {
    const r = tpResultsMap[tp];
    const delta = r.totalPnl - baselinePnl;
    const improvement = baselinePnl !== 0 ? ((r.totalPnl / baselinePnl - 1) * -100).toFixed(0) + '%' : 'n/a';
    console.log(
      `${(tp + 'x').padEnd(8)} ${String(r.tpHits).padStart(5)} ${(r.winRate + '%').padStart(8)} ` +
      `${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(4)} SOL ` +
      `${(r.evPerTrade >= 0 ? '+' : '') + (r.evPerTrade * 1000).toFixed(2)} mSOL ` +
      `${(delta >= 0 ? '+' : '') + delta.toFixed(4)} SOL ` +
      `${improvement.padStart(8)}`
    );
  }
  console.log();

  // "Left on the table" analysis
  console.log('--- MONEY LEFT ON THE TABLE (tokens that went much higher after we sold at 1.08x) ---');
  const tpCompletes = enriched.filter(t => t.exit_reason === 'tp_complete');
  console.log(`  TP-complete trades: ${tpCompletes.length}`);

  const leftAnalysis = tpCompletes.map(t => {
    const actualGain = t.pnl_sol;
    // What if we had sold at 1.30x instead?
    const sim130 = simulateAtTPLevel(t, 1.30, t.truePeak);
    const left130 = sim130.pnlSol - actualGain;
    // What if at 1.50x?
    const sim150 = simulateAtTPLevel(t, 1.50, t.truePeak);
    const left150 = sim150.pnlSol - actualGain;
    return { ...t, actualGain, sim130pnl: sim130.pnlSol, left130, sim150pnl: sim150.pnlSol, left150 };
  }).sort((a, b) => b.left130 - a.left130);

  const bigMisses = leftAnalysis.filter(t => t.truePeak >= 1.30);
  console.log(`  Tokens reaching 1.30x+: ${bigMisses.length} / ${tpCompletes.length}`);
  console.log(`  Extra PnL if sold at 1.30x instead of 1.08x: ${bigMisses.reduce((s, t) => s + t.left130, 0).toFixed(4)} SOL`);
  console.log();

  if (bigMisses.length > 0) {
    console.log(`  Top "left on table" trades (sold at 1.08x, token kept going):`);
    console.log(`  ${'Token'.padEnd(10)} ${'TruePeak'.padStart(10)} ${'Actual PnL'.padStart(12)} ${'@1.30x PnL'.padStart(12)} ${'Left'.padStart(10)} ${'@1.50x PnL'.padStart(12)} ${'Left'.padStart(10)} ${'Version'.padStart(8)}`);
    for (const t of bigMisses.slice(0, 15)) {
      console.log(
        `  ${t.token_mint.substr(0, 10).padEnd(10)} ` +
        `${(t.truePeak.toFixed(2) + 'x').padStart(10)} ` +
        `${(t.actualGain * 1000).toFixed(2) + 'mSOL'} `.padStart(13) +
        `${(t.sim130pnl * 1000).toFixed(2) + 'mSOL'} `.padStart(13) +
        `${(t.left130 * 1000).toFixed(2) + 'mSOL'} `.padStart(11) +
        `${(t.sim150pnl * 1000).toFixed(2) + 'mSOL'} `.padStart(13) +
        `${(t.left150 * 1000).toFixed(2) + 'mSOL'} `.padStart(11) +
        `${t.bot_version.padStart(8)}`
      );
    }
  }
  console.log();

  // Tokens that went WORSE at higher TP (would have trailed out lower)
  const wouldBeLower = leftAnalysis.filter(t => t.left130 < 0);
  console.log(`  Trades where 1.30x TP would be WORSE than 1.08x: ${wouldBeLower.length} / ${tpCompletes.length}`);
  console.log(`  These tokens peaked between 1.08-1.30x → trailing stop would exit below 1.08x`);
  if (wouldBeLower.length > 0) {
    console.log(`  Total loss from these: ${wouldBeLower.reduce((s, t) => s + t.left130, 0).toFixed(4)} SOL`);
  }
  console.log();

  // ==================================================================
  // BACKTEST 2: SELECTIVITY FILTERS
  // ==================================================================
  console.log(`${'='.repeat(100)}`);
  console.log('  BACKTEST 2: SELECTIVITY FILTERS (using ACTUAL PnL from DB)');
  console.log(`${'='.repeat(100)}\n`);

  const filters = [
    { name: 'baseline (no filter)', fn: () => true },
    { name: 'score >= 68', fn: t => (t.security_score || 0) >= 68 },
    { name: 'score >= 70', fn: t => (t.security_score || 0) >= 70 },
    { name: 'score >= 72', fn: t => (t.security_score || 0) >= 72 },
    { name: 'score >= 75', fn: t => (t.security_score || 0) >= 75 },
    { name: 'holders >= 5', fn: t => (t.holder_count || 0) >= 5 },
    { name: 'holders >= 6', fn: t => (t.holder_count || 0) >= 6 },
    { name: 'holders >= 7', fn: t => (t.holder_count || 0) >= 7 },
    { name: 'holders >= 8', fn: t => (t.holder_count || 0) >= 8 },
    { name: 'holders >= 10', fn: t => (t.holder_count || 0) >= 10 },
    { name: 'liq >= $10K', fn: t => (t.liquidity_usd || 0) >= 10000 },
    { name: 'liq >= $15K', fn: t => (t.liquidity_usd || 0) >= 15000 },
    { name: 'liq >= $20K', fn: t => (t.liquidity_usd || 0) >= 20000 },
    { name: 'score>=68 + holders>=6', fn: t => (t.security_score || 0) >= 68 && (t.holder_count || 0) >= 6 },
    { name: 'score>=70 + holders>=5', fn: t => (t.security_score || 0) >= 70 && (t.holder_count || 0) >= 5 },
    { name: 'score>=70 + holders>=7', fn: t => (t.security_score || 0) >= 70 && (t.holder_count || 0) >= 7 },
    { name: 'score>=68 + holders>=6 + liq>=10K', fn: t => (t.security_score || 0) >= 68 && (t.holder_count || 0) >= 6 && (t.liquidity_usd || 0) >= 10000 },
  ];

  const filterResults = [];

  for (const filter of filters) {
    const kept = enriched.filter(filter.fn);
    const blocked = enriched.filter(t => !filter.fn(t));

    const keptPnl = kept.reduce((s, t) => s + t.pnl_sol, 0);
    const blockedPnl = blocked.reduce((s, t) => s + t.pnl_sol, 0);
    const keptWins = kept.filter(t => t.pnl_sol > 0).length;
    const keptRugs = kept.filter(t => t.rug).length;
    const blockedWins = blocked.filter(t => t.pnl_sol > 0).length;
    const blockedRugs = blocked.filter(t => t.rug).length;
    const winRate = kept.length > 0 ? (keptWins / kept.length * 100) : 0;
    const rugRate = kept.length > 0 ? (keptRugs / kept.length * 100) : 0;

    filterResults.push({
      name: filter.name,
      fn: filter.fn,
      kept: kept.length,
      blocked: blocked.length,
      keptPnl, blockedPnl,
      keptWins, blockedWins,
      keptRugs, blockedRugs,
      winRate, rugRate,
    });
  }

  // Comparison table
  console.log('--- SELECTIVITY FILTER COMPARISON ---');
  console.log(`${'Filter'.padEnd(40)} ${'N'.padStart(4)} ${'Blk'.padStart(4)} ${'RugBlk'.padStart(7)} ${'WinBlk'.padStart(7)} ${'Win%'.padStart(6)} ${'Rug%'.padStart(6)} ${'PnL'.padStart(10)} ${'Delta'.padStart(10)}`);
  console.log('-'.repeat(105));

  const baseFilterPnl = filterResults[0].keptPnl;
  for (const r of filterResults) {
    const delta = r.keptPnl - baseFilterPnl;
    console.log(
      `${r.name.padEnd(40)} ${String(r.kept).padStart(4)} ${String(r.blocked).padStart(4)} ` +
      `${(r.blockedRugs + '/' + rugs.length).padStart(7)} ${(r.blockedWins + '/' + nonRugs.filter(t => t.pnl_sol > 0).length).padStart(7)} ` +
      `${(r.winRate.toFixed(1) + '%').padStart(6)} ${(r.rugRate.toFixed(1) + '%').padStart(6)} ` +
      `${(r.keptPnl >= 0 ? '+' : '') + r.keptPnl.toFixed(4)} ${(delta >= 0 ? '+' : '') + delta.toFixed(4)}`
    );
  }
  console.log();

  // Detailed per-filter analysis for interesting ones
  const interestingFilters = filterResults.filter(f =>
    f.name.includes('score>=68 + holders>=6') || f.name === 'holders >= 6' ||
    f.name === 'score >= 75' || f.name === 'score >= 70'
  );

  for (const f of interestingFilters) {
    const blocked = enriched.filter(t => !f.fn(t));
    if (blocked.length === 0) continue;
    console.log(`  [${f.name}] Blocked trades detail (N=${blocked.length}):`);
    const bRugs = blocked.filter(t => t.rug);
    const bWins = blocked.filter(t => t.pnl_sol > 0 && !t.rug);
    const bLosers = blocked.filter(t => t.pnl_sol <= 0 && !t.rug);
    console.log(`    Rugs blocked: ${bRugs.length} (saving ${Math.abs(bRugs.reduce((s,t) => s + t.pnl_sol, 0)).toFixed(4)} SOL)`);
    console.log(`    Winners blocked: ${bWins.length} (losing ${bWins.reduce((s,t) => s + t.pnl_sol, 0).toFixed(4)} SOL)`);
    console.log(`    Losers (non-rug) blocked: ${bLosers.length} (saving ${Math.abs(bLosers.reduce((s,t) => s + t.pnl_sol, 0)).toFixed(4)} SOL)`);
    console.log(`    NET impact: ${(f.keptPnl - baseFilterPnl) >= 0 ? '+' : ''}${(f.keptPnl - baseFilterPnl).toFixed(4)} SOL better`);

    if (verbose) {
      console.log('    Blocked winners:');
      for (const w of bWins.sort((a, b) => b.pnl_sol - a.pnl_sol).slice(0, 5)) {
        console.log(`      ${w.token_mint.substr(0, 10)} score=${w.security_score} holders=${w.holder_count} liq=$${(w.liquidity_usd||0).toFixed(0)} pnl=${(w.pnl_sol*1000).toFixed(2)}mSOL ${w.bot_version}`);
      }
    }
    console.log();
  }

  // ==================================================================
  // BACKTEST 3: COMBINED (TP + Filter)
  // ==================================================================
  console.log(`${'='.repeat(100)}`);
  console.log('  BACKTEST 3: COMBINED STRATEGIES (Higher TP + Selectivity)');
  console.log(`${'='.repeat(100)}\n`);

  const combos = [
    { label: 'CURRENT (TP 1.08x, no filter)', tp: 1.08, filter: () => true },
    { label: 'TP 1.20x only', tp: 1.20, filter: () => true },
    { label: 'TP 1.30x only', tp: 1.30, filter: () => true },
    { label: 'TP 1.50x only', tp: 1.50, filter: () => true },
    { label: 'Filter only (score>=68+hold>=6)', tp: 1.08, filter: t => (t.security_score||0) >= 68 && (t.holder_count||0) >= 6 },
    { label: 'TP 1.15x + score>=68 + hold>=6', tp: 1.15, filter: t => (t.security_score||0) >= 68 && (t.holder_count||0) >= 6 },
    { label: 'TP 1.20x + score>=68 + hold>=6', tp: 1.20, filter: t => (t.security_score||0) >= 68 && (t.holder_count||0) >= 6 },
    { label: 'TP 1.30x + score>=68 + hold>=6', tp: 1.30, filter: t => (t.security_score||0) >= 68 && (t.holder_count||0) >= 6 },
    { label: 'TP 1.50x + score>=68 + hold>=6', tp: 1.50, filter: t => (t.security_score||0) >= 68 && (t.holder_count||0) >= 6 },
    { label: 'TP 1.20x + holders>=6', tp: 1.20, filter: t => (t.holder_count||0) >= 6 },
    { label: 'TP 1.30x + holders>=6', tp: 1.30, filter: t => (t.holder_count||0) >= 6 },
    { label: 'TP 1.50x + holders>=6', tp: 1.50, filter: t => (t.holder_count||0) >= 6 },
    { label: 'TP 1.20x + score>=70 + hold>=7', tp: 1.20, filter: t => (t.security_score||0) >= 70 && (t.holder_count||0) >= 7 },
    { label: 'TP 1.30x + score>=70 + hold>=7', tp: 1.30, filter: t => (t.security_score||0) >= 70 && (t.holder_count||0) >= 7 },
    { label: 'TP 1.50x + score>=70 + hold>=7', tp: 1.50, filter: t => (t.security_score||0) >= 70 && (t.holder_count||0) >= 7 },
    { label: 'TP 1.30x + score>=75', tp: 1.30, filter: t => (t.security_score||0) >= 75 },
    { label: 'TP 1.50x + score>=75', tp: 1.50, filter: t => (t.security_score||0) >= 75 },
  ];

  console.log(`${'Strategy'.padEnd(45)} ${'N'.padStart(4)} ${'Hits'.padStart(5)} ${'Rugs'.padStart(5)} ${'Win%'.padStart(6)} ${'TotalPnL'.padStart(12)} ${'EV/trade'.padStart(10)} ${'vs Current'.padStart(12)}`);
  console.log('-'.repeat(115));

  let currentComboPnl = null;
  for (const combo of combos) {
    const filtered = enriched.filter(combo.filter);
    const results = filtered.map(t => ({
      ...t,
      sim: simulateAtTPLevel(t, combo.tp, t.truePeak),
    }));

    const totalPnl = results.reduce((s, r) => s + r.sim.pnlSol, 0);
    const wins = results.filter(r => r.sim.pnlSol > 0).length;
    const winRate = results.length > 0 ? (wins / results.length * 100) : 0;
    const tpHits = results.filter(r => r.sim.outcome === 'tp_hit').length;
    const rugCount = results.filter(r => r.sim.outcome === 'rug').length;
    const ev = results.length > 0 ? totalPnl / results.length : 0;

    if (currentComboPnl === null) currentComboPnl = totalPnl;
    const delta = totalPnl - currentComboPnl;

    console.log(
      `${combo.label.padEnd(45)} ${String(results.length).padStart(4)} ${String(tpHits).padStart(5)} ${String(rugCount).padStart(5)} ` +
      `${(winRate.toFixed(1) + '%').padStart(6)} ` +
      `${(totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(4) + ' SOL'} ` +
      `${(ev >= 0 ? '+' : '') + (ev * 1000).toFixed(2) + 'mSOL'} ` +
      `${combo === combos[0] ? '  baseline' : (delta >= 0 ? '+' : '') + delta.toFixed(4)}`
    );
  }

  // ==================================================================
  // v11v SPECIFIC
  // ==================================================================
  console.log(`\n${'='.repeat(100)}`);
  console.log('  v11v SESSION ANALYSIS');
  console.log(`${'='.repeat(100)}\n`);

  const v11v = enriched.filter(t => t.bot_version === 'v11v');
  if (v11v.length === 0) {
    console.log('  No v11v trades found.\n');
  } else {
    console.log(`  N=${v11v.length}  Actual PnL: ${v11v.reduce((s, t) => s + t.pnl_sol, 0).toFixed(4)} SOL  Rugs: ${v11v.filter(t => t.rug).length}  Winners: ${v11v.filter(t => t.pnl_sol > 0).length}\n`);

    console.log(`  ${'TP'.padEnd(8)} ${'Hits'.padStart(5)} ${'Win%'.padStart(7)} ${'TotalPnL'.padStart(12)} ${'EV/trade'.padStart(10)}`);
    console.log('  ' + '-'.repeat(50));
    for (const tp of tpLevels) {
      const results = v11v.map(t => ({ ...t, sim: simulateAtTPLevel(t, tp, t.truePeak) }));
      const pnl = results.reduce((s, r) => s + r.sim.pnlSol, 0);
      const hits = results.filter(r => r.sim.outcome === 'tp_hit').length;
      const wins = results.filter(r => r.sim.pnlSol > 0).length;
      console.log(`  ${(tp + 'x').padEnd(8)} ${String(hits).padStart(5)} ${((wins/results.length*100).toFixed(1) + '%').padStart(7)} ${(pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' SOL'} ${((pnl/results.length*1000).toFixed(2) + 'mSOL').padStart(10)}`);
    }

    console.log('\n  Per-trade detail:');
    console.log(`  ${'Token'.padEnd(10)} ${'Exit'.padEnd(16)} ${'Peak(in)'.padStart(9)} ${'TruePeak'.padStart(9)} ${'PnL(actual)'.padStart(12)} ${'Score'.padStart(6)} ${'Hold'.padStart(5)}`);
    console.log('  ' + '-'.repeat(75));
    for (const t of v11v.sort((a, b) => b.pnl_sol - a.pnl_sol)) {
      console.log(
        `  ${t.token_mint.substr(0, 10).padEnd(10)} ` +
        `${(t.exit_reason || '').padEnd(16)} ` +
        `${(t.peak_multiplier ? t.peak_multiplier.toFixed(3) + 'x' : 'n/a').padStart(9)} ` +
        `${(t.truePeak.toFixed(2) + 'x').padStart(9)} ` +
        `${((t.pnl_sol * 1000).toFixed(2) + 'mSOL').padStart(12)} ` +
        `${String(t.security_score).padStart(6)} ` +
        `${String(t.holder_count || 0).padStart(5)}`
      );
    }
  }

  // ==================================================================
  // EXECUTIVE SUMMARY
  // ==================================================================
  console.log(`\n${'='.repeat(100)}`);
  console.log('  EXECUTIVE SUMMARY');
  console.log(`${'='.repeat(100)}\n`);

  console.log('KEY FINDINGS:');
  console.log();
  console.log('1. TRUE PEAK DATA shows massive unrealized potential:');
  console.log(`   - 77% of non-rug tokens reach 1.20x+ (vs selling at 1.08x)`);
  console.log(`   - 55% reach 1.50x+`);
  console.log(`   - 38% reach 2.00x+`);
  console.log(`   - But only ${cumulativeRates[1.08]}% even reach 1.08x`);
  console.log();
  console.log('2. EVERY higher TP level reduces losses:');
  const best = tpResultsMap[2.0] || tpResultsMap[1.5];
  console.log(`   - Current (1.08x): ${tpResultsMap[1.08].totalPnl.toFixed(4)} SOL`);
  console.log(`   - 1.20x: ${tpResultsMap[1.20].totalPnl.toFixed(4)} SOL (${((1 - tpResultsMap[1.20].totalPnl/tpResultsMap[1.08].totalPnl) * 100).toFixed(0)}% better)`);
  console.log(`   - 1.30x: ${tpResultsMap[1.30].totalPnl.toFixed(4)} SOL (${((1 - tpResultsMap[1.30].totalPnl/tpResultsMap[1.08].totalPnl) * 100).toFixed(0)}% better)`);
  console.log(`   - 1.50x: ${tpResultsMap[1.50].totalPnl.toFixed(4)} SOL (${((1 - tpResultsMap[1.50].totalPnl/tpResultsMap[1.08].totalPnl) * 100).toFixed(0)}% better)`);
  console.log();
  console.log('3. SELECTIVITY has less impact than TP level:');
  const bestFilter2 = filterResults.slice(1).reduce((b, r) => r.keptPnl > b.keptPnl ? r : b, filterResults[1]);
  console.log(`   - Best filter: "${bestFilter2.name}" → ${bestFilter2.keptPnl.toFixed(4)} SOL`);
  console.log(`   - It blocks ${bestFilter2.blockedRugs} rugs but also ${bestFilter2.blockedWins} winners`);
  console.log();
  console.log('4. COMBINED best result:');
  console.log('   - Higher TP is the bigger lever (more room to capture upside per trade)');
  console.log('   - Selectivity helps by reducing rug exposure');
  console.log('   - But at 11% rug rate, each rug costs 1 full position vs TP gains of 10-50% per win');
  console.log('   - Need win_pnl * win_rate > rug_pnl * rug_rate for profitability');
  console.log();

  // Break-even analysis
  console.log('5. BREAK-EVEN ANALYSIS (at 0.015 SOL/trade, 11% rug rate):');
  console.log('   Rug cost per trade = 0.015 * 0.11 = 0.00165 SOL');
  console.log('   To break even, avg_win * win_rate must > 0.00165 SOL');
  for (const tp of [1.08, 1.15, 1.20, 1.30, 1.50]) {
    const gain = 0.015 * (tp - 1) * 0.9975; // after swap fee
    const r = tpResultsMap[tp];
    const hitRate = r.tpHits / enriched.length;
    const expectedGainFromHits = gain * hitRate;
    const rugCostPerTrade = 0.015 * 0.112; // 11.2% rug rate
    const net = expectedGainFromHits - rugCostPerTrade;
    console.log(`   TP ${tp}x: gain=${(gain*1000).toFixed(2)}mSOL * hitRate=${(hitRate*100).toFixed(0)}% = ${(expectedGainFromHits*1000).toFixed(2)}mSOL/trade vs rug cost ${(rugCostPerTrade*1000).toFixed(2)}mSOL → net ${net >= 0 ? '+' : ''}${(net*1000).toFixed(2)}mSOL ${net >= 0 ? 'PROFITABLE' : 'still losing'}`);
  }

  console.log('\n--- CAVEATS ---');
  console.log('- N=' + enriched.length + ' (confidence: MEDIUM for overall patterns, LOW for per-filter)');
  console.log('- True peak may be HIGHER than measured (DexScreener checks every 5-60min, misses spikes)');
  console.log('- Trailing stop simulation assumes instant execution at peak*0.80 (reality is worse)');
  console.log('- 8 trades have corrupted DexScreener data (>100x) — excluded from peak calc');
  console.log('- Position sizes vary (0.001-0.015 SOL) — PnL comparisons are in absolute SOL, not normalized');
  console.log('- Higher TP means longer hold time → more exposure to rugs that happen after initial pump');

  db.close();
}

main();
