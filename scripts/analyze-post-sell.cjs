#!/usr/bin/env node
/**
 * Post-sell trajectory analysis using pool_outcome_checks (DexScreener snapshots).
 *
 * Uses market_cap at 5/15/30/60 min to estimate price trajectory after our sell.
 * Combined with position_price_log data for tick-level analysis during hold.
 *
 * Usage:
 *   node scripts/analyze-post-sell.cjs             # All v11o+ positions
 *   node scripts/analyze-post-sell.cjs --version v11s  # Single version
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');

// Parse args
const args = process.argv.slice(2);
const versionFilter = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Get all v11o+ positions with outcome checks
  let sql = `
    SELECT p.id, p.token_mint, p.pool_address, p.exit_reason,
           printf('%.2f', p.pnl_pct) as pnl_str, p.pnl_pct,
           p.bot_version, p.entry_price, p.sol_invested,
           p.opened_at, p.closed_at, p.peak_multiplier, p.peak_price,
           dp.id as dp_id, dp.detected_at as dp_detected_at,
           poc5.price_native as p5m, poc5.market_cap as mc5m, poc5.liquidity_usd as liq5m,
           poc15.price_native as p15m, poc15.market_cap as mc15m, poc15.liquidity_usd as liq15m,
           poc30.price_native as p30m, poc30.market_cap as mc30m, poc30.liquidity_usd as liq30m,
           poc60.price_native as p60m, poc60.market_cap as mc60m, poc60.liquidity_usd as liq60m
    FROM positions p
    LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
    LEFT JOIN pool_outcome_checks poc5 ON poc5.pool_id = dp.id AND poc5.delay_minutes = 5
    LEFT JOIN pool_outcome_checks poc15 ON poc15.pool_id = dp.id AND poc15.delay_minutes = 15
    LEFT JOIN pool_outcome_checks poc30 ON poc30.pool_id = dp.id AND poc30.delay_minutes = 30
    LEFT JOIN pool_outcome_checks poc60 ON poc60.pool_id = dp.id AND poc60.delay_minutes = 60
    WHERE p.bot_version >= 'v11o'
  `;
  if (versionFilter) sql += ` AND p.bot_version = '${versionFilter}'`;
  sql += ' ORDER BY p.opened_at';

  const positions = db.prepare(sql).all();
  console.log(`\n=== POST-SELL TRAJECTORY ANALYSIS (v11o+${versionFilter ? ` ${versionFilter}` : ''}) ===`);
  console.log(`Positions: ${positions.length}\n`);

  // For each position, estimate multiplier at each DexScreener check
  // Using price_native ratio (same unit, cancels out): mult_at_Xm = price_at_Xm / price_at_earliest_check
  // Or use market_cap ratio which is equivalent

  const results = [];
  for (const p of positions) {
    const mintShort = p.token_mint.slice(0, 8);
    const holdTimeSec = p.closed_at && p.opened_at ? (p.closed_at - p.opened_at) / 1000 : null;

    // Find earliest non-zero price to use as reference
    // We want to establish a "base" price to convert DexScreener prices to multipliers
    // The trick: use the ratio of DexScreener prices at different times
    const prices = [
      { min: 5, price: p.p5m, mcap: p.mc5m },
      { min: 15, price: p.p15m, mcap: p.mc15m },
      { min: 30, price: p.p30m, mcap: p.mc30m },
      { min: 60, price: p.p60m, mcap: p.mc60m },
    ].filter(x => x.price > 0);

    if (prices.length === 0) {
      results.push({ ...p, mintShort, holdTimeSec, mults: [], peakDexMult: null, hasOutcomeData: false });
      continue;
    }

    // Calculate multiplier relative to our entry using price_native
    // entry_price is SOL/base_unit, price_native is SOL/token
    // For PumpSwap tokens with 6 decimals: price_native = entry_price * 1e6
    // So: mult = (price_native / 1e6) / entry_price = price_native / (entry_price * 1e6)
    // But we don't know exact decimals. Instead, calibrate using our known sell price:
    //
    // We KNOW we sold at pnl_pct% profit = (1 + pnl_pct/100)x multiplier
    // The DexScreener check closest to our sell time should show approximately this price
    // So: dex_mult = dex_price / dex_entry_equivalent
    // Where dex_entry_equivalent = dex_price_at_sell / our_sell_mult

    // Find which DexScreener check is closest to our sell time
    const sellMinFromDetect = holdTimeSec != null && p.dp_detected_at
      ? (p.closed_at - p.dp_detected_at) / 60000 // minutes from detection to sell
      : holdTimeSec != null ? holdTimeSec / 60 : null;

    // Method: use ratio of DexScreener prices to find growth AFTER sell
    // First, establish the "entry equivalent" in DexScreener price space
    // If we entered at detection time, then earliest DexScreener price (~5min) already includes some movement
    // We need to convert: what was the DexScreener-equivalent price at our entry?

    // Best approach: entry_price_dex = earliest_dex_price / (earliest_dex_price / entry_price_dex)
    // We can calibrate using our known peak_multiplier and peak_price
    // peak_multiplier = peak_price / entry_price
    // So entry_price = peak_price / peak_multiplier
    // And in DexScreener space: entry_dex = dex_price_at_time / actual_mult_at_time
    //
    // Actually simplest: use mcap ratio. If mcap at 5m = X, and mcap at 30m = 2X, token doubled.
    // And if we sold at 2 minutes, the 5m mcap already incorporates our TP1 sell.
    // The question is what happened between 5m and 30m, 60m.

    // Let's compute multipliers relative to the 5-min check
    const basePrice = prices[0].price;
    const baseMcap = prices[0].mcap;
    const mults = prices.map(x => ({
      min: x.min,
      price: x.price,
      mcap: x.mcap,
      multFromBase: x.price / basePrice,
      mcapFromBase: baseMcap > 0 ? x.mcap / baseMcap : null,
    }));

    // Estimate entry-relative multiplier using price_native
    // We know our entry multiplier was 1.0x.
    // At 5min check, the token is at some price. We need to know what multiplier that represents.
    // Method: use our peak_price which is also in SOL/base_unit
    // peak_multiplier = peak_price / entry_price (both in same units)
    // So if we can find the DexScreener price at peak time, we can calibrate
    //
    // Alternative: assume token has 6 decimals (standard for PumpSwap pump.fun tokens)
    // entry_in_dex_units = entry_price * 1e6 (convert SOL/base_unit to SOL/token)
    // mult_at_5m = p5m / (entry_price * 1e6)

    const DECIMALS = 6; // Standard for pump.fun/PumpSwap tokens
    const entryInDexUnits = p.entry_price * Math.pow(10, DECIMALS);

    const entryMults = prices.map(x => ({
      min: x.min,
      multFromEntry: entryInDexUnits > 0 ? x.price / entryInDexUnits : null,
      mcap: x.mcap,
    }));

    // Sanity check: at 5min, most tokens should be between 0.5x and 5x relative to entry
    // If way off, the decimals assumption might be wrong
    const m5 = entryMults.find(x => x.min === 5);
    let peakDexMult = Math.max(...entryMults.filter(x => x.multFromEntry != null).map(x => x.multFromEntry));

    results.push({
      ...p, mintShort, holdTimeSec, mults, entryMults, peakDexMult, hasOutcomeData: true,
      sellMinFromDetect,
    });
  }

  // ──── SECTION A: Full Table ────
  console.log('='.repeat(130));
  console.log('SECTION A: DexScreener Price Trajectory (relative to our entry, assuming 6 decimals)');
  console.log('='.repeat(130));
  console.log(
    'Token'.padEnd(10) +
    'Ver'.padEnd(6) +
    'Exit'.padEnd(16) +
    'PnL%'.padStart(8) +
    'Hold'.padStart(6) +
    'OurPeak'.padStart(9) +
    ' | 5m mult'.padStart(10) +
    '15m mult'.padStart(10) +
    '30m mult'.padStart(10) +
    '60m mult'.padStart(10) +
    ' | DexPeak'.padStart(10) +
    'Verdict'.padStart(14)
  );
  console.log('-'.repeat(130));

  let stillGrowing = 0;
  let diedAfter = 0;
  let flatAfter = 0;
  let noData = 0;

  for (const r of results) {
    if (!r.hasOutcomeData) {
      noData++;
      const hold = r.holdTimeSec ? `${Math.round(r.holdTimeSec)}s` : '-';
      const ourPeak = r.peak_multiplier ? `${r.peak_multiplier.toFixed(2)}x` : '-';
      console.log(
        r.mintShort.padEnd(10) + r.bot_version.padEnd(6) +
        r.exit_reason.slice(0, 15).padEnd(16) + `+${r.pnl_str}%`.padStart(8) +
        hold.padStart(6) + ourPeak.padStart(9) +
        ' |      -         -         -         -  |     -     NO DATA'
      );
      continue;
    }

    const hold = r.holdTimeSec ? `${Math.round(r.holdTimeSec)}s` : '-';
    const ourPeak = r.peak_multiplier ? `${r.peak_multiplier.toFixed(2)}x` : '-';

    const m5 = r.entryMults.find(x => x.min === 5);
    const m15 = r.entryMults.find(x => x.min === 15);
    const m30 = r.entryMults.find(x => x.min === 30);
    const m60 = r.entryMults.find(x => x.min === 60);

    const fmt = (m) => m && m.multFromEntry != null ? `${m.multFromEntry.toFixed(2)}x` : '-';

    // Determine verdict
    let verdict = '';
    const sellMult = 1 + r.pnl_pct / 100;
    const laterChecks = r.entryMults.filter(x => x.min >= 15 && x.multFromEntry != null);
    const latestMult = laterChecks.length > 0 ? laterChecks[laterChecks.length - 1].multFromEntry : null;

    if (latestMult != null) {
      if (latestMult > sellMult * 1.1) { // 10%+ above our sell
        verdict = 'GROWING';
        stillGrowing++;
      } else if (latestMult < 0.5) {
        verdict = 'DIED';
        diedAfter++;
      } else {
        verdict = 'flat';
        flatAfter++;
      }
    }

    if (r.exit_reason === 'tp_complete' && r.peakDexMult > 1.5) verdict += ' <<<';

    console.log(
      r.mintShort.padEnd(10) + r.bot_version.padEnd(6) +
      r.exit_reason.slice(0, 15).padEnd(16) + `${r.pnl_str}%`.padStart(8) +
      hold.padStart(6) + ourPeak.padStart(9) +
      ' |' + fmt(m5).padStart(9) + fmt(m15).padStart(10) + fmt(m30).padStart(10) + fmt(m60).padStart(10) +
      ' |' + (r.peakDexMult ? `${r.peakDexMult.toFixed(2)}x` : '-').padStart(9) +
      verdict.padStart(14)
    );
  }

  console.log('-'.repeat(130));
  console.log(`Verdicts: GROWING=${stillGrowing}, DIED=${diedAfter}, flat=${flatAfter}, no data=${noData}`);

  // ──── SECTION B: tp_complete deep dive ────
  console.log('\n' + '='.repeat(90));
  console.log('SECTION B: tp_complete Positions — What Happened After We Sold at ~1.08x?');
  console.log('='.repeat(90));

  const tpComplete = results.filter(r => r.exit_reason === 'tp_complete' && r.hasOutcomeData);
  const tpAll = results.filter(r => r.exit_reason === 'tp_complete');

  console.log(`tp_complete total: ${tpAll.length}`);
  console.log(`With DexScreener data: ${tpComplete.length}\n`);

  if (tpComplete.length > 0) {
    // For each tp_complete, show the trajectory
    console.log('Token     Hold  Sold@   5m mult  15m mult  30m mult  60m mult  Peak Dex  Verdict');
    console.log('-'.repeat(90));

    let keepRunning = 0;
    let crashed = 0;

    for (const r of tpComplete) {
      const hold = r.holdTimeSec ? `${Math.round(r.holdTimeSec)}s` : '-';
      const soldAt = `${(1 + r.pnl_pct / 100).toFixed(2)}x`;

      const m5 = r.entryMults.find(x => x.min === 5);
      const m15 = r.entryMults.find(x => x.min === 15);
      const m30 = r.entryMults.find(x => x.min === 30);
      const m60 = r.entryMults.find(x => x.min === 60);

      const fmt = (m) => m && m.multFromEntry != null ? `${m.multFromEntry.toFixed(2)}x` : '-';

      const laterChecks = r.entryMults.filter(x => x.min >= 15 && x.multFromEntry != null);
      const peak = r.peakDexMult;
      let verdict = '';

      if (peak > 2.0) {
        verdict = 'RUNNER!';
        keepRunning++;
      } else if (peak > 1.15) {
        verdict = 'grew';
        keepRunning++;
      } else if (laterChecks.length > 0 && laterChecks[laterChecks.length - 1].multFromEntry < 0.5) {
        verdict = 'died';
        crashed++;
      } else {
        verdict = 'flat/slight';
      }

      console.log(
        `${r.mintShort}  ${hold.padStart(4)}  ${soldAt.padStart(5)}   ${fmt(m5).padStart(7)}  ${fmt(m15).padStart(8)}  ${fmt(m30).padStart(8)}  ${fmt(m60).padStart(8)}  ${peak ? peak.toFixed(2) + 'x' : '-'}`.padEnd(78) + verdict.padStart(12)
      );
    }

    console.log(`\nSummary: ${keepRunning} kept running, ${crashed} died, ${tpComplete.length - keepRunning - crashed} flat/slight`);
  }

  // ──── SECTION C: What-If TP1 Simulation ────
  console.log('\n' + '='.repeat(90));
  console.log('SECTION C: TP1 Level Simulation — Which level maximizes EV?');
  console.log('='.repeat(90));

  // Use ALL positions with outcome data
  const allWithData = results.filter(r => r.hasOutcomeData);
  console.log(`\nPositions with DexScreener data: ${allWithData.length}`);

  // For each position: what's the PEAK multiplier across all DexScreener checks?
  // This tells us the highest level the token reached (at 5m/15m/30m/60m snapshots)
  // Note: this underestimates the actual peak (can spike between snapshots) but it's our best data

  // Count how many positions reached each TP level (using peakDexMult)
  const posSize = 0.015;
  const overhead = 0.0011;
  const totalPositions = results.length;
  const rugs = results.filter(r => r.exit_reason === 'rug_pull' || r.exit_reason === 'stranded_timeout_max_retries' || r.exit_reason === 'max_retries');
  const rugLoss = rugs.length * posSize;

  // Also use our own peak_multiplier (from tick data during hold) for positions WITHOUT dex data
  // This gives us a lower bound since we don't know post-sell trajectory
  const peakMults = results.map(r => {
    if (r.peakDexMult && r.peakDexMult > 0) return Math.max(r.peakDexMult, r.peak_multiplier || 1);
    return r.peak_multiplier || 0;
  });

  console.log(`Rugs: ${rugs.length} (total loss: ${rugLoss.toFixed(4)} SOL)`);
  console.log(`Position size: ${posSize} SOL\n`);

  const tpLevels = [1.05, 1.08, 1.10, 1.12, 1.15, 1.20, 1.30, 1.50, 2.00];

  console.log(
    'TP Level'.padEnd(10) +
    'Would Hit'.padStart(12) +
    'Hit%'.padStart(8) +
    'Gain/Hit'.padStart(10) +
    'Tot Gain'.padStart(10) +
    'Net'.padStart(10) +
    'EV/Trade'.padStart(10) +
    '  Notes'
  );
  console.log('-'.repeat(100));

  for (const tp of tpLevels) {
    const hits = peakMults.filter(m => m >= tp);
    const hitPct = (hits.length / totalPositions * 100);
    const gainPerHit = posSize * (tp - 1) - overhead;
    const totalGain = hits.length * gainPerHit;
    const net = totalGain - rugLoss;
    const ev = net / totalPositions;

    let note = '';
    if (ev > 0) note = 'PROFITABLE';
    if (tp === 1.08) note += ' (current)';

    console.log(
      `${tp.toFixed(2)}x`.padEnd(10) +
      `${hits.length}/${totalPositions}`.padStart(12) +
      `${hitPct.toFixed(0)}%`.padStart(8) +
      `${gainPerHit.toFixed(4)}`.padStart(10) +
      `${totalGain.toFixed(4)}`.padStart(10) +
      `${net >= 0 ? '+' : ''}${net.toFixed(4)}`.padStart(10) +
      `${ev >= 0 ? '+' : ''}${ev.toFixed(5)}`.padStart(10) +
      `  ${note}`
    );
  }

  // ──── SECTION D: Break-Even ────
  console.log('\n' + '='.repeat(90));
  console.log('SECTION D: Break-Even — Hits Needed to Cover Rug Tax');
  console.log('='.repeat(90));

  for (const tp of [1.08, 1.10, 1.15, 1.20, 1.30]) {
    const gainPerHit = posSize * (tp - 1) - overhead;
    if (gainPerHit <= 0) {
      console.log(`TP ${tp}x: gain/hit=${gainPerHit.toFixed(4)} SOL — NOT ENOUGH GAIN PER HIT`);
      continue;
    }
    const hitsNeeded = Math.ceil(rugLoss / gainPerHit);
    const hitsAvailable = peakMults.filter(m => m >= tp).length;
    const ratio = hitsAvailable / hitsNeeded;
    const profitable = ratio >= 1;
    console.log(
      `TP ${tp.toFixed(2)}x: gain/hit=${gainPerHit.toFixed(4)} SOL, ` +
      `need ${hitsNeeded} hits, have ${hitsAvailable}, ` +
      `ratio ${ratio.toFixed(2)}x ${profitable ? 'PROFITABLE' : 'NOT ENOUGH'}`
    );
  }

  // ──── SECTION E: Runners we missed ────
  console.log('\n' + '='.repeat(90));
  console.log('SECTION E: Biggest Runners (DexScreener peak > 2x our entry)');
  console.log('='.repeat(90));

  const bigRunners = results
    .filter(r => r.peakDexMult > 2)
    .sort((a, b) => b.peakDexMult - a.peakDexMult);

  if (bigRunners.length === 0) {
    console.log('No positions reached 2x+ on DexScreener checks.');
  } else {
    for (const r of bigRunners) {
      const hold = r.holdTimeSec ? `${Math.round(r.holdTimeSec)}s` : '-';
      console.log(`\n  ${r.mintShort} (${r.bot_version}):`);
      console.log(`    Exit: ${r.exit_reason} at ${r.pnl_str}% (hold ${hold})`);
      console.log(`    Our peak: ${r.peak_multiplier?.toFixed(2) || '?'}x`);
      console.log(`    DexScreener peak: ${r.peakDexMult.toFixed(2)}x`);

      const m5 = r.entryMults.find(x => x.min === 5);
      const m15 = r.entryMults.find(x => x.min === 15);
      const m30 = r.entryMults.find(x => x.min === 30);
      const m60 = r.entryMults.find(x => x.min === 60);

      const fmt = (m) => m && m.multFromEntry != null ? `${m.multFromEntry.toFixed(2)}x` : '-';
      console.log(`    Trajectory: 5m=${fmt(m5)} → 15m=${fmt(m15)} → 30m=${fmt(m30)} → 60m=${fmt(m60)}`);

      if (r.exit_reason === 'tp_complete' || r.exit_reason === 'trailing_stop') {
        const actual = (r.sol_invested || 0.015) * (r.pnl_pct / 100);
        const potential = (r.sol_invested || 0.015) * (r.peakDexMult - 1) * 0.93;
        console.log(`    Actual gain: ${actual.toFixed(4)} SOL`);
        console.log(`    Potential (at DexScreener peak): ${potential.toFixed(4)} SOL`);
        console.log(`    Left on table: ${(potential - actual).toFixed(4)} SOL`);
      }
    }
  }

  // ──── SECTION F: Price calibration sanity check ────
  console.log('\n' + '='.repeat(90));
  console.log('SECTION F: Calibration Check — Our peak_multiplier vs DexScreener 5m mult');
  console.log('='.repeat(90));
  console.log('(Both should be similar order of magnitude. If DexScreener is 1000x off, decimals assumption is wrong)\n');

  const calCheck = results
    .filter(r => r.hasOutcomeData && r.peak_multiplier > 0)
    .slice(0, 20);

  console.log('Token      Our Peak   Dex@5m     Dex Peak   Ratio(Dex5m/OurPeak)');
  console.log('-'.repeat(70));

  for (const r of calCheck) {
    const m5 = r.entryMults.find(x => x.min === 5);
    const dex5m = m5?.multFromEntry;
    const ratio = dex5m && r.peak_multiplier ? (dex5m / r.peak_multiplier).toFixed(1) : '?';
    console.log(
      `${r.mintShort}   ${r.peak_multiplier.toFixed(3)}x    ${dex5m ? dex5m.toFixed(3) + 'x' : '-'.padEnd(6)}     ${r.peakDexMult ? r.peakDexMult.toFixed(3) + 'x' : '-'}     ${ratio}`
    );
  }

  db.close();
}

main();
