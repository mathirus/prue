#!/usr/bin/env node
/**
 * Validate tick 2 multiplier < 1.02x as rug detector
 * Tests across ALL v11o+ positions with price log data
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// === CONFIGURATION ===
const RUG_EXIT_REASONS = new Set(['rug_pull', 'max_retries', 'stranded_timeout_max_retries']);
const THRESHOLDS = [1.005, 1.01, 1.015, 1.02, 1.025, 1.03, 1.04, 1.05];

// === FETCH ALL DATA ===

// All v11o+ closed/stopped positions
const positions = db.prepare(`
  SELECT p.id, p.token_mint, p.pool_address, p.entry_price, p.current_price, p.peak_price,
         p.sol_invested, p.sol_returned, p.pnl_sol, p.pnl_pct, p.status, p.exit_reason,
         p.security_score, p.peak_multiplier, p.bot_version, p.opened_at, p.closed_at,
         p.holder_count, p.sell_attempts, p.sell_successes,
         CASE WHEN p.closed_at > 0 AND p.opened_at > 0 THEN (p.closed_at - p.opened_at) / 1000.0 ELSE NULL END as duration_s
  FROM positions p
  WHERE p.bot_version >= 'v11o' AND p.status IN ('closed', 'stopped')
  ORDER BY p.opened_at
`).all();

// All price ticks with tick number
const allTicks = db.prepare(`
  SELECT ppl.position_id, ppl.multiplier, ppl.sol_reserve, ppl.elapsed_ms,
         ppl.sell_count, ppl.buy_count, ppl.created_at,
         ROW_NUMBER() OVER (PARTITION BY ppl.position_id ORDER BY ppl.elapsed_ms) as tick_num
  FROM position_price_log ppl
  JOIN positions p ON ppl.position_id = p.id
  WHERE p.bot_version >= 'v11o' AND p.status IN ('closed', 'stopped')
  ORDER BY ppl.position_id, ppl.elapsed_ms
`).all();

// Build tick map: position_id -> { tick1: {...}, tick2: {...}, ... }
const tickMap = {};
for (const tick of allTicks) {
  if (!tickMap[tick.position_id]) tickMap[tick.position_id] = {};
  tickMap[tick.position_id][tick.tick_num] = tick;
}

// === CLASSIFY POSITIONS ===
const classified = positions.map(p => {
  const isRug = RUG_EXIT_REASONS.has(p.exit_reason);
  const isWinner = p.pnl_sol > 0;
  const category = isRug ? 'RUG' : (isWinner ? 'WINNER' : 'LOSER');

  const ticks = tickMap[p.id] || {};
  const tick1 = ticks[1] || null;
  const tick2 = ticks[2] || null;
  const tick3 = ticks[3] || null;
  const tickCount = Object.keys(ticks).length;

  return {
    ...p,
    isRug,
    isWinner,
    category,
    tick1,
    tick2,
    tick3,
    tickCount,
    tick2_mul: tick2 ? tick2.multiplier : null,
    tick2_elapsed_ms: tick2 ? tick2.elapsed_ms : null,
    hasTick2: !!tick2,
  };
});

// === SECTION 1: OVERVIEW ===
console.log('='.repeat(100));
console.log('TICK 2 RUG DETECTION VALIDATION — ALL v11o+ POSITIONS');
console.log('='.repeat(100));
console.log();

const total = classified.length;
const withTick2 = classified.filter(p => p.hasTick2).length;
const withoutTick2 = classified.filter(p => !p.hasTick2).length;
const rugs = classified.filter(p => p.isRug);
const winners = classified.filter(p => p.isWinner);
const losers = classified.filter(p => !p.isRug && !p.isWinner);

console.log(`Total positions: ${total}`);
console.log(`  With tick 2 data: ${withTick2} (${(withTick2/total*100).toFixed(1)}%)`);
console.log(`  Without tick 2 data: ${withoutTick2} (${(withoutTick2/total*100).toFixed(1)}%)`);
console.log();
console.log(`Categories:`);
console.log(`  RUG (wipeout -100%): ${rugs.length} (${(rugs.length/total*100).toFixed(1)}%)`);
console.log(`  WINNER (pnl > 0):    ${winners.length} (${(winners.length/total*100).toFixed(1)}%)`);
console.log(`  LOSER (pnl <= 0):    ${losers.length} (${(losers.length/total*100).toFixed(1)}%)`);
console.log();

// === SECTION 2: POSITIONS WITHOUT TICK 2 ===
console.log('-'.repeat(100));
console.log('POSITIONS WITHOUT TICK 2 (closed before second price check)');
console.log('-'.repeat(100));
const noTick2 = classified.filter(p => !p.hasTick2);
console.log(`\nN=${noTick2.length} positions have NO tick 2 (closed in < ~10s)`);
console.log();
const fmt = (p) => {
  const dur = p.duration_s ? `${p.duration_s.toFixed(0)}s` : '?s';
  const mul1 = p.tick1 ? p.tick1.multiplier.toFixed(4) : 'N/A';
  return `  ${p.id.substring(0,12).padEnd(13)} ${p.bot_version.padEnd(5)} ${p.category.padEnd(7)} exit=${(p.exit_reason||'').padEnd(22)} dur=${dur.padEnd(6)} tick1_mul=${mul1.padEnd(8)} pnl=${(p.pnl_sol*1000).toFixed(2)}mSOL score=${p.security_score}`;
};
for (const p of noTick2) console.log(fmt(p));
console.log(`\nBreakdown: ${noTick2.filter(p=>p.isRug).length} RUG, ${noTick2.filter(p=>p.isWinner).length} WINNER, ${noTick2.filter(p=>!p.isRug&&!p.isWinner).length} LOSER`);

// === SECTION 3: DETAILED RUG ANALYSIS ===
console.log();
console.log('-'.repeat(100));
console.log('ALL RUGS — TICK 2 MULTIPLIER DETAIL');
console.log('-'.repeat(100));
console.log();
console.log(`${'ID'.padEnd(13)} ${'Ver'.padEnd(5)} ${'Score'.padEnd(6)} ${'Dur'.padEnd(6)} ${'Ticks'.padEnd(6)} ${'T1_mul'.padEnd(9)} ${'T1_ms'.padEnd(8)} ${'T2_mul'.padEnd(9)} ${'T2_ms'.padEnd(8)} ${'T3_mul'.padEnd(9)} ${'Peak'.padEnd(8)} ${'Exit'.padEnd(25)} ${'Token'.padEnd(12)}`);
console.log('-'.repeat(130));

for (const p of rugs) {
  const dur = p.duration_s ? `${p.duration_s.toFixed(0)}s` : '?';
  const t1m = p.tick1 ? p.tick1.multiplier.toFixed(4) : 'N/A';
  const t1ms = p.tick1 ? `${p.tick1.elapsed_ms}` : '';
  const t2m = p.tick2 ? p.tick2.multiplier.toFixed(4) : 'N/A';
  const t2ms = p.tick2 ? `${p.tick2.elapsed_ms}` : '';
  const t3m = p.tick3 ? p.tick3.multiplier.toFixed(4) : 'N/A';
  const peak = p.peak_multiplier ? p.peak_multiplier.toFixed(4) : '?';
  const token = p.token_mint.substring(0, 11);

  console.log(`${p.id.substring(0,12).padEnd(13)} ${p.bot_version.padEnd(5)} ${String(p.security_score).padEnd(6)} ${dur.padEnd(6)} ${String(p.tickCount).padEnd(6)} ${t1m.padEnd(9)} ${t1ms.padEnd(8)} ${t2m.padEnd(9)} ${t2ms.padEnd(8)} ${t3m.padEnd(9)} ${peak.padEnd(8)} ${(p.exit_reason||'').padEnd(25)} ${token}`);
}

const rugsWithTick2 = rugs.filter(p => p.hasTick2);
const rugsWithoutTick2 = rugs.filter(p => !p.hasTick2);
console.log();
console.log(`Rugs WITH tick 2: ${rugsWithTick2.length}/${rugs.length}`);
console.log(`Rugs WITHOUT tick 2: ${rugsWithoutTick2.length}/${rugs.length} (died before ~10s check)`);

// === SECTION 4: THRESHOLD ANALYSIS ===
console.log();
console.log('-'.repeat(100));
console.log('THRESHOLD ANALYSIS (tick 2 multiplier)');
console.log('-'.repeat(100));
console.log();
console.log('Only positions WITH tick 2 data included.');
console.log();

const withT2 = classified.filter(p => p.hasTick2);
const rugsT2 = withT2.filter(p => p.isRug);
const winnersT2 = withT2.filter(p => p.isWinner);
const losersT2 = withT2.filter(p => !p.isRug && !p.isWinner);

console.log(`Population: ${withT2.length} total | ${rugsT2.length} RUG | ${winnersT2.length} WIN | ${losersT2.length} LOSE`);
console.log();

// For each threshold, calculate metrics
console.log(`${'Thresh'.padEnd(8)} ${'Rugs<T'.padEnd(8)} ${'%Rugs'.padEnd(8)} ${'Win<T'.padEnd(8)} ${'%Win'.padEnd(8)} ${'Lose<T'.padEnd(8)} ${'Sens%'.padEnd(8)} ${'Spec%'.padEnd(8)} ${'FPR%'.padEnd(8)} ${'PnL_block'.padEnd(12)} ${'PnL_keep'.padEnd(12)} ${'Net_PnL'.padEnd(12)} ${'N_keep'.padEnd(8)} ${'N_block'.padEnd(8)}`);
console.log('-'.repeat(140));

for (const thresh of THRESHOLDS) {
  const rugsBelowT = rugsT2.filter(p => p.tick2_mul < thresh);
  const rugsAboveT = rugsT2.filter(p => p.tick2_mul >= thresh);
  const winBelowT = winnersT2.filter(p => p.tick2_mul < thresh);
  const winAboveT = winnersT2.filter(p => p.tick2_mul >= thresh);
  const loseBelowT = losersT2.filter(p => p.tick2_mul < thresh);
  const loseAboveT = losersT2.filter(p => p.tick2_mul >= thresh);

  const belowT = withT2.filter(p => p.tick2_mul < thresh);
  const aboveT = withT2.filter(p => p.tick2_mul >= thresh);

  // Sensitivity: % of rugs caught (below threshold)
  const sensitivity = rugsT2.length > 0 ? (rugsBelowT.length / rugsT2.length * 100) : 0;
  // Specificity: % of winners correctly kept (above threshold)
  const specificity = winnersT2.length > 0 ? (winAboveT.length / winnersT2.length * 100) : 0;
  // FPR: % of winners incorrectly killed
  const fpr = winnersT2.length > 0 ? (winBelowT.length / winnersT2.length * 100) : 0;

  // PnL of blocked positions (would exit early at ~breakeven instead of their actual exit)
  // Early exit PnL: assume we sell at tick2 for roughly -2% to -5% (slippage + fees)
  // Actually: if mul < thresh, we exit. The PnL saved = their actual pnl_sol negated (we avoid the loss)
  // For rugs: we save |pnl_sol| by not holding to 0
  // For winners: we LOSE their pnl_sol by exiting early
  // Approximate: early exit at mul=tick2_mul means PnL = (tick2_mul - 1) * sol_invested - overhead
  const OVERHEAD_PER_TRADE = 0.0004; // sell overhead only (already bought)

  let pnlBlocked = 0; // PnL of positions that would be blocked (their actual PnL)
  let pnlKept = 0;    // PnL of positions kept
  let earlyExitPnl = 0; // PnL if we early-exit blocked positions at tick2 price

  for (const p of belowT) {
    pnlBlocked += p.pnl_sol;
    // Early exit: sell at tick2 multiplier
    const earlyPnl = (p.tick2_mul - 1) * p.sol_invested - OVERHEAD_PER_TRADE;
    earlyExitPnl += earlyPnl;
  }
  for (const p of aboveT) {
    pnlKept += p.pnl_sol;
  }

  // Net PnL = pnl of kept positions + early exit pnl of blocked positions
  const netPnl = pnlKept + earlyExitPnl;
  // Baseline PnL (no filter)
  const baselinePnl = withT2.reduce((s, p) => s + p.pnl_sol, 0);

  console.log(`${thresh.toFixed(3).padEnd(8)} ${String(rugsBelowT.length + '/' + rugsT2.length).padEnd(8)} ${sensitivity.toFixed(0).padEnd(8)} ${String(winBelowT.length + '/' + winnersT2.length).padEnd(8)} ${fpr.toFixed(0).padEnd(8)} ${String(loseBelowT.length + '/' + losersT2.length).padEnd(8)} ${sensitivity.toFixed(1).padEnd(8)} ${specificity.toFixed(1).padEnd(8)} ${fpr.toFixed(1).padEnd(8)} ${pnlBlocked.toFixed(4).padEnd(12)} ${pnlKept.toFixed(4).padEnd(12)} ${netPnl.toFixed(4).padEnd(12)} ${String(aboveT.length).padEnd(8)} ${String(belowT.length).padEnd(8)}`);
}

const baselinePnl = withT2.reduce((s, p) => s + p.pnl_sol, 0);
console.log();
console.log(`Baseline PnL (no filter, positions with tick2): ${baselinePnl.toFixed(4)} SOL`);

// === SECTION 5: DETAILED WINNER ANALYSIS AT 1.02x ===
console.log();
console.log('-'.repeat(100));
console.log('WINNERS WITH TICK 2 < 1.02x (would be killed by the rule)');
console.log('-'.repeat(100));
console.log();

const winnersKilled = winnersT2.filter(p => p.tick2_mul < 1.02);
if (winnersKilled.length === 0) {
  console.log('NONE! 0 winners would be killed at 1.02x threshold.');
} else {
  console.log(`${winnersKilled.length} winners would be killed:`);
  console.log();
  console.log(`${'ID'.padEnd(13)} ${'Ver'.padEnd(5)} ${'T2_mul'.padEnd(9)} ${'T2_ms'.padEnd(8)} ${'Peak'.padEnd(8)} ${'PnL_sol'.padEnd(10)} ${'PnL%'.padEnd(8)} ${'Exit'.padEnd(22)} ${'Score'.padEnd(6)} ${'Dur(s)'.padEnd(8)}`);
  for (const p of winnersKilled) {
    const dur = p.duration_s ? p.duration_s.toFixed(0) : '?';
    console.log(`${p.id.substring(0,12).padEnd(13)} ${p.bot_version.padEnd(5)} ${p.tick2_mul.toFixed(4).padEnd(9)} ${String(p.tick2_elapsed_ms).padEnd(8)} ${(p.peak_multiplier||0).toFixed(4).padEnd(8)} ${p.pnl_sol.toFixed(6).padEnd(10)} ${p.pnl_pct.toFixed(1).padEnd(8)} ${(p.exit_reason||'').padEnd(22)} ${String(p.security_score).padEnd(6)} ${dur.padEnd(8)}`);
  }
  console.log();
  console.log(`Total PnL lost from killed winners: ${winnersKilled.reduce((s,p) => s + p.pnl_sol, 0).toFixed(6)} SOL`);
}

// === SECTION 5b: NON-RUG LOSERS BELOW 1.02x ===
console.log();
console.log('-'.repeat(100));
console.log('NON-RUG LOSERS WITH TICK 2 < 1.02x (would be early-exited)');
console.log('-'.repeat(100));
console.log();

const losersKilled = losersT2.filter(p => p.tick2_mul < 1.02);
if (losersKilled.length === 0) {
  console.log('None.');
} else {
  console.log(`${losersKilled.length} non-rug losers would be early-exited:`);
  console.log();
  console.log(`${'ID'.padEnd(13)} ${'Ver'.padEnd(5)} ${'T2_mul'.padEnd(9)} ${'Actual_PnL'.padEnd(12)} ${'Early_PnL'.padEnd(12)} ${'Saved'.padEnd(10)} ${'Exit'.padEnd(22)} ${'Score'.padEnd(6)}`);
  let totalSaved = 0;
  for (const p of losersKilled) {
    const earlyPnl = (p.tick2_mul - 1) * p.sol_invested - 0.0004;
    const saved = p.pnl_sol - earlyPnl; // negative means we saved by early exit (less loss)
    totalSaved += saved;
    console.log(`${p.id.substring(0,12).padEnd(13)} ${p.bot_version.padEnd(5)} ${p.tick2_mul.toFixed(4).padEnd(9)} ${p.pnl_sol.toFixed(6).padEnd(12)} ${earlyPnl.toFixed(6).padEnd(12)} ${saved.toFixed(6).padEnd(10)} ${(p.exit_reason||'').padEnd(22)} ${String(p.security_score).padEnd(6)}`);
  }
  console.log(`\nNet saved from early-exiting losers: ${totalSaved.toFixed(6)} SOL`);
}

// === SECTION 6: RUGS ABOVE THRESHOLD ===
console.log();
console.log('-'.repeat(100));
console.log('RUGS WITH TICK 2 >= 1.02x (would ESCAPE the rule)');
console.log('-'.repeat(100));
console.log();

const rugsEscaped = rugsT2.filter(p => p.tick2_mul >= 1.02);
if (rugsEscaped.length === 0) {
  console.log('NONE! All rugs with tick 2 data are below 1.02x.');
} else {
  console.log(`${rugsEscaped.length} rugs would escape:`);
  for (const p of rugsEscaped) {
    console.log(`  ${p.id.substring(0,12)} ${p.bot_version} T2=${p.tick2_mul.toFixed(4)} peak=${(p.peak_multiplier||0).toFixed(4)} exit=${p.exit_reason} pnl=${p.pnl_sol.toFixed(4)}`);
    // Show all ticks for escaped rugs
    const ticks = tickMap[p.id] || {};
    for (const [num, t] of Object.entries(ticks)) {
      console.log(`    tick ${num}: mul=${t.multiplier.toFixed(4)} elapsed=${t.elapsed_ms}ms reserve=${t.sol_reserve ? t.sol_reserve.toFixed(1) : 'N/A'} sells=${t.sell_count}`);
    }
  }
}

// === SECTION 7: RUGS WITHOUT TICK 2 ===
console.log();
console.log('-'.repeat(100));
console.log('RUGS WITHOUT TICK 2 (died before second check)');
console.log('-'.repeat(100));
console.log();

if (rugsWithoutTick2.length === 0) {
  console.log('All rugs had tick 2 data.');
} else {
  console.log(`${rugsWithoutTick2.length} rugs had no tick 2:`);
  for (const p of rugsWithoutTick2) {
    const dur = p.duration_s ? `${p.duration_s.toFixed(0)}s` : '?';
    const t1m = p.tick1 ? p.tick1.multiplier.toFixed(4) : 'N/A';
    const t1ms = p.tick1 ? `${p.tick1.elapsed_ms}ms` : '';
    console.log(`  ${p.id.substring(0,12)} ${p.bot_version} dur=${dur} tick1=${t1m} (${t1ms}) ticks=${p.tickCount} exit=${p.exit_reason} pnl=${p.pnl_sol.toFixed(4)}`);
    const ticks = tickMap[p.id] || {};
    for (const [num, t] of Object.entries(ticks)) {
      console.log(`    tick ${num}: mul=${t.multiplier.toFixed(4)} elapsed=${t.elapsed_ms}ms reserve=${t.sol_reserve ? t.sol_reserve.toFixed(1) : 'N/A'}`);
    }
  }
  console.log();
  console.log('NOTE: These rugs cannot be caught by tick 2 rule. They need tick 1 or reserve-based detection.');
}

// === SECTION 8: VERSION BREAKDOWN ===
console.log();
console.log('-'.repeat(100));
console.log('BY VERSION — TICK 2 @ 1.02x THRESHOLD');
console.log('-'.repeat(100));
console.log();

const versions = [...new Set(classified.map(p => p.bot_version))].sort();
console.log(`${'Version'.padEnd(8)} ${'N'.padEnd(4)} ${'N_t2'.padEnd(6)} ${'Rugs'.padEnd(6)} ${'R<1.02'.padEnd(8)} ${'R>=1.02'.padEnd(8)} ${'Wins'.padEnd(6)} ${'W<1.02'.padEnd(8)} ${'W>=1.02'.padEnd(8)} ${'BasePnL'.padEnd(10)} ${'FiltPnL'.padEnd(10)} ${'Delta'.padEnd(10)}`);
console.log('-'.repeat(110));

for (const v of versions) {
  const vPos = classified.filter(p => p.bot_version === v);
  const vT2 = vPos.filter(p => p.hasTick2);
  const vRugs = vT2.filter(p => p.isRug);
  const vWins = vT2.filter(p => p.isWinner);

  const vRugsBelow = vRugs.filter(p => p.tick2_mul < 1.02);
  const vRugsAbove = vRugs.filter(p => p.tick2_mul >= 1.02);
  const vWinsBelow = vWins.filter(p => p.tick2_mul < 1.02);
  const vWinsAbove = vWins.filter(p => p.tick2_mul >= 1.02);

  const basePnl = vT2.reduce((s, p) => s + p.pnl_sol, 0);
  const keptPnl = vT2.filter(p => p.tick2_mul >= 1.02).reduce((s, p) => s + p.pnl_sol, 0);
  const earlyExitPnl = vT2.filter(p => p.tick2_mul < 1.02).reduce((s, p) => s + ((p.tick2_mul - 1) * p.sol_invested - 0.0004), 0);
  const filtPnl = keptPnl + earlyExitPnl;

  console.log(`${v.padEnd(8)} ${String(vPos.length).padEnd(4)} ${String(vT2.length).padEnd(6)} ${String(vRugs.length).padEnd(6)} ${String(vRugsBelow.length).padEnd(8)} ${String(vRugsAbove.length).padEnd(8)} ${String(vWins.length).padEnd(6)} ${String(vWinsBelow.length).padEnd(8)} ${String(vWinsAbove.length).padEnd(8)} ${basePnl.toFixed(4).padEnd(10)} ${filtPnl.toFixed(4).padEnd(10)} ${(filtPnl - basePnl).toFixed(4).padEnd(10)}`);
}

// === SECTION 9: TICK 2 DISTRIBUTION ===
console.log();
console.log('-'.repeat(100));
console.log('TICK 2 MULTIPLIER DISTRIBUTION');
console.log('-'.repeat(100));
console.log();

const buckets = [
  { label: '< 0.95', min: -Infinity, max: 0.95 },
  { label: '0.95-0.98', min: 0.95, max: 0.98 },
  { label: '0.98-1.00', min: 0.98, max: 1.00 },
  { label: '1.00-1.01', min: 1.00, max: 1.01 },
  { label: '1.01-1.02', min: 1.01, max: 1.02 },
  { label: '1.02-1.03', min: 1.02, max: 1.03 },
  { label: '1.03-1.05', min: 1.03, max: 1.05 },
  { label: '1.05-1.10', min: 1.05, max: 1.10 },
  { label: '>= 1.10', min: 1.10, max: Infinity },
];

console.log(`${'Bucket'.padEnd(12)} ${'RUG'.padEnd(6)} ${'WIN'.padEnd(6)} ${'LOSE'.padEnd(6)} ${'Total'.padEnd(6)} ${'Rug%'.padEnd(8)} ${'Win%'.padEnd(8)}`);
console.log('-'.repeat(60));

for (const b of buckets) {
  const inBucket = withT2.filter(p => p.tick2_mul >= b.min && p.tick2_mul < b.max);
  const bRugs = inBucket.filter(p => p.isRug).length;
  const bWins = inBucket.filter(p => p.isWinner).length;
  const bLose = inBucket.filter(p => !p.isRug && !p.isWinner).length;
  const bTotal = inBucket.length;
  const rugPct = bTotal > 0 ? (bRugs / bTotal * 100).toFixed(0) : '-';
  const winPct = bTotal > 0 ? (bWins / bTotal * 100).toFixed(0) : '-';

  console.log(`${b.label.padEnd(12)} ${String(bRugs).padEnd(6)} ${String(bWins).padEnd(6)} ${String(bLose).padEnd(6)} ${String(bTotal).padEnd(6)} ${rugPct.padEnd(8)} ${winPct.padEnd(8)}`);
}

// === SECTION 10: PNL IMPACT SUMMARY ===
console.log();
console.log('-'.repeat(100));
console.log('PNL IMPACT SUMMARY @ 1.02x THRESHOLD');
console.log('-'.repeat(100));
console.log();

const THRESHOLD = 1.02;
const below = withT2.filter(p => p.tick2_mul < THRESHOLD);
const above = withT2.filter(p => p.tick2_mul >= THRESHOLD);

const baseTotal = withT2.reduce((s, p) => s + p.pnl_sol, 0);
const keptPnl = above.reduce((s, p) => s + p.pnl_sol, 0);

// Early exit PnL: for positions below threshold, we sell at tick2 multiplier
// PnL = (mul - 1) * sol_invested - overhead
let earlyExitTotal = 0;
const earlyExitDetails = [];
for (const p of below) {
  const earlyPnl = (p.tick2_mul - 1) * p.sol_invested - 0.0004;
  earlyExitTotal += earlyPnl;
  earlyExitDetails.push({ ...p, earlyPnl });
}

const newTotal = keptPnl + earlyExitTotal;

console.log(`BASELINE (no tick2 filter):`);
console.log(`  N = ${withT2.length}, PnL = ${baseTotal.toFixed(6)} SOL (${(baseTotal*1000).toFixed(2)} mSOL)`);
console.log();
console.log(`WITH TICK2 < 1.02x EARLY EXIT:`);
console.log(`  Kept (tick2 >= 1.02): N=${above.length}, PnL = ${keptPnl.toFixed(6)} SOL`);
console.log(`  Early exit (tick2 < 1.02): N=${below.length}, PnL = ${earlyExitTotal.toFixed(6)} SOL`);
console.log(`    Breakdown: ${below.filter(p=>p.isRug).length} rugs saved, ${below.filter(p=>p.isWinner).length} winners killed, ${below.filter(p=>!p.isRug&&!p.isWinner).length} losers early-exited`);
console.log(`  NEW TOTAL: ${newTotal.toFixed(6)} SOL (${(newTotal*1000).toFixed(2)} mSOL)`);
console.log(`  DELTA: ${(newTotal - baseTotal).toFixed(6)} SOL (${((newTotal - baseTotal)*1000).toFixed(2)} mSOL)`);
console.log(`  IMPROVEMENT: ${baseTotal !== 0 ? ((newTotal - baseTotal) / Math.abs(baseTotal) * 100).toFixed(1) : 'N/A'}%`);
console.log();

// Also factor in the 20 positions WITHOUT tick2 (they'd still trade normally)
const noT2Pnl = classified.filter(p => !p.hasTick2).reduce((s, p) => s + p.pnl_sol, 0);
const fullBaseline = classified.reduce((s, p) => s + p.pnl_sol, 0);
const fullNew = newTotal + noT2Pnl;
console.log(`INCLUDING ${withoutTick2} POSITIONS WITHOUT TICK 2 (unaffected by rule):`);
console.log(`  Full baseline: ${fullBaseline.toFixed(6)} SOL`);
console.log(`  Full new: ${fullNew.toFixed(6)} SOL`);
console.log(`  Full delta: ${(fullNew - fullBaseline).toFixed(6)} SOL`);

// === SECTION 11: OPTIMAL THRESHOLD SEARCH ===
console.log();
console.log('-'.repeat(100));
console.log('OPTIMAL THRESHOLD SEARCH (maximizing PnL improvement)');
console.log('-'.repeat(100));
console.log();

const fineTresholds = [];
for (let t = 0.98; t <= 1.08; t += 0.005) {
  fineTresholds.push(parseFloat(t.toFixed(3)));
}

console.log(`${'Thresh'.padEnd(8)} ${'N_exit'.padEnd(8)} ${'N_keep'.padEnd(8)} ${'Rugs_caught'.padEnd(13)} ${'Wins_killed'.padEnd(13)} ${'Base_PnL'.padEnd(10)} ${'New_PnL'.padEnd(10)} ${'Delta'.padEnd(10)} ${'Sens%'.padEnd(8)} ${'Spec%'.padEnd(8)}`);
console.log('-'.repeat(110));

let bestThresh = 1.02;
let bestDelta = -Infinity;

for (const t of fineTresholds) {
  const belowT = withT2.filter(p => p.tick2_mul < t);
  const aboveT = withT2.filter(p => p.tick2_mul >= t);

  const rugsCaught = belowT.filter(p => p.isRug).length;
  const winsKilled = belowT.filter(p => p.isWinner).length;
  const sens = rugsT2.length > 0 ? (rugsCaught / rugsT2.length * 100) : 0;
  const spec = winnersT2.length > 0 ? (aboveT.filter(p => p.isWinner).length / winnersT2.length * 100) : 0;

  const kp = aboveT.reduce((s, p) => s + p.pnl_sol, 0);
  const eep = belowT.reduce((s, p) => s + ((p.tick2_mul - 1) * p.sol_invested - 0.0004), 0);
  const np = kp + eep;
  const delta = np - baseTotal;

  if (delta > bestDelta) {
    bestDelta = delta;
    bestThresh = t;
  }

  console.log(`${t.toFixed(3).padEnd(8)} ${String(belowT.length).padEnd(8)} ${String(aboveT.length).padEnd(8)} ${(rugsCaught+'/'+rugsT2.length).padEnd(13)} ${(winsKilled+'/'+winnersT2.length).padEnd(13)} ${baseTotal.toFixed(4).padEnd(10)} ${np.toFixed(4).padEnd(10)} ${delta.toFixed(4).padEnd(10)} ${sens.toFixed(1).padEnd(8)} ${spec.toFixed(1).padEnd(8)}`);
}

console.log();
console.log(`BEST THRESHOLD: ${bestThresh.toFixed(3)} (delta = +${bestDelta.toFixed(4)} SOL)`);

// === SECTION 12: TICK 1 FOR RUGS (backup signal for rugs without tick 2) ===
console.log();
console.log('-'.repeat(100));
console.log('TICK 1 ANALYSIS FOR RUGS (backup signal)');
console.log('-'.repeat(100));
console.log();

console.log(`${'ID'.padEnd(13)} ${'Ver'.padEnd(5)} ${'T1_mul'.padEnd(9)} ${'T1_ms'.padEnd(8)} ${'T2_mul'.padEnd(9)} ${'T2_ms'.padEnd(8)} ${'Has_T2'.padEnd(8)} ${'Exit'.padEnd(22)}`);
for (const p of rugs) {
  const t1m = p.tick1 ? p.tick1.multiplier.toFixed(4) : 'N/A';
  const t1ms = p.tick1 ? String(p.tick1.elapsed_ms) : '';
  const t2m = p.tick2 ? p.tick2.multiplier.toFixed(4) : 'N/A';
  const t2ms = p.tick2 ? String(p.tick2.elapsed_ms) : '';
  console.log(`${p.id.substring(0,12).padEnd(13)} ${p.bot_version.padEnd(5)} ${t1m.padEnd(9)} ${t1ms.padEnd(8)} ${t2m.padEnd(9)} ${t2ms.padEnd(8)} ${(p.hasTick2 ? 'YES' : 'NO').padEnd(8)} ${(p.exit_reason||'').padEnd(22)}`);
}

// === SECTION 13: ELAPSED TIME AT TICK 2 ===
console.log();
console.log('-'.repeat(100));
console.log('TICK 2 ELAPSED TIME DISTRIBUTION');
console.log('-'.repeat(100));
console.log();

const t2ElapsedAll = withT2.map(p => p.tick2_elapsed_ms);
const t2Min = Math.min(...t2ElapsedAll);
const t2Max = Math.max(...t2ElapsedAll);
const t2Avg = t2ElapsedAll.reduce((s, v) => s + v, 0) / t2ElapsedAll.length;
const t2Median = t2ElapsedAll.sort((a, b) => a - b)[Math.floor(t2ElapsedAll.length / 2)];

console.log(`Tick 2 elapsed_ms: min=${t2Min}, max=${t2Max}, avg=${t2Avg.toFixed(0)}, median=${t2Median}`);
console.log(`(This is the time window — if implementing, the health check fires at ~${t2Median}ms after buy)`);

// === FINAL SUMMARY ===
console.log();
console.log('='.repeat(100));
console.log('FINAL VALIDATION SUMMARY');
console.log('='.repeat(100));
console.log();

const rugsCaught102 = rugsT2.filter(p => p.tick2_mul < 1.02).length;
const totalRugs = rugs.length;
const winsSafe102 = winnersT2.filter(p => p.tick2_mul >= 1.02).length;
const totalWinsT2 = winnersT2.length;

console.log(`Dataset: N=${total} v11o+ positions (${versions.join(', ')})`);
console.log(`  ${withTick2} with tick 2 data, ${withoutTick2} without (closed <10s)`);
console.log();
console.log(`RUGS: ${totalRugs} total`);
console.log(`  ${rugsWithTick2.length} with tick 2: ${rugsCaught102}/${rugsWithTick2.length} caught by <1.02x (${(rugsCaught102/Math.max(rugsWithTick2.length,1)*100).toFixed(0)}%)`);
console.log(`  ${rugsWithoutTick2.length} without tick 2: UNCATCHABLE by this rule (need alternative)`);
console.log(`  Overall sensitivity: ${rugsCaught102}/${totalRugs} = ${(rugsCaught102/totalRugs*100).toFixed(1)}% of ALL rugs`);
console.log();
console.log(`WINNERS: ${winners.length} total, ${totalWinsT2} with tick 2`);
console.log(`  ${winsSafe102}/${totalWinsT2} safe (tick2 >= 1.02x) = ${(winsSafe102/Math.max(totalWinsT2,1)*100).toFixed(1)}% specificity`);
console.log(`  ${totalWinsT2 - winsSafe102}/${totalWinsT2} would be killed (tick2 < 1.02x) = ${((totalWinsT2-winsSafe102)/Math.max(totalWinsT2,1)*100).toFixed(1)}% false positive rate`);
console.log();
console.log(`PNL IMPACT (tick2 positions only):`);
console.log(`  Baseline: ${baseTotal.toFixed(4)} SOL`);
console.log(`  With 1.02x rule: ${(keptPnl + earlyExitTotal).toFixed(4)} SOL`);
console.log(`  Delta: +${((keptPnl + earlyExitTotal) - baseTotal).toFixed(4)} SOL`);
console.log();
console.log(`CONFIDENCE: N=${withTick2} (tick2 available), ${rugsT2.length} rugs testable`);
if (rugsT2.length < 20) {
  console.log(`  WARNING: Only ${rugsT2.length} rugs with tick 2 data. Sample is small.`);
  console.log(`  Rule of 3: With ${rugsCaught102}/${rugsT2.length} caught and 0 escaped,`);
  console.log(`  95% CI for escape rate: 0% to ${(3/rugsT2.length*100).toFixed(1)}%`);
}

db.close();
