/**
 * Exit Timing Analysis: Are we selling too early or too late?
 */
const db = require('better-sqlite3')('data/bot.db');

// All closed positions with peak data
const trades = db.prepare(`
  SELECT id, token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct,
         entry_price, current_price, peak_price, peak_multiplier,
         time_to_peak_ms, exit_reason, opened_at, closed_at,
         sell_attempts, sell_successes, tp_levels_hit
  FROM positions
  WHERE status IN ('closed','stopped')
    AND closed_at IS NOT NULL
    AND peak_price IS NOT NULL
    AND entry_price > 0
  ORDER BY opened_at DESC
`).all();

console.log('=== EXIT TIMING ANALYSIS ===');
console.log('Total trades con peak data: ' + trades.length + '\n');

let tooEarly = 0, tooLate = 0, justRight = 0, rug = 0;
let earlyLostSOL = 0, lateList = [];

trades.forEach(t => {
  const peakM = t.peak_multiplier || (t.peak_price / t.entry_price);
  const exitM = t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
  const holdMs = t.closed_at - t.opened_at;
  const peakMs = t.time_to_peak_ms || 0;

  if (exitM < 0.1) {
    rug++; // Pool drained, no timing can fix this
    return;
  }

  if (peakM < 1.05) {
    // Never really moved, not a timing issue
    return;
  }

  // How much of the peak movement did we capture?
  const peakMove = peakM - 1; // e.g., 1.5x peak = 0.5 move
  const exitMove = exitM - 1; // e.g., 1.2x exit = 0.2 move
  const captureRatio = peakMove > 0 ? exitMove / peakMove : 0;

  // Peak happened AFTER we sold? (peak time > 80% of hold time)
  // This means we sold while still going up
  const peakNearEnd = peakMs > holdMs * 0.7;

  if (captureRatio >= 0.5) {
    justRight++;
  } else if (peakNearEnd && exitMove > 0) {
    // Peak was near end of hold + we still had profit = we sold while rising
    tooEarly++;
    earlyLostSOL += (peakM - exitM) * t.sol_invested;
  } else {
    // Peak was early, we held too long and it crashed
    tooLate++;
    lateList.push({
      mint: t.token_mint.slice(0, 8),
      peakM, exitM, captureRatio,
      peakSec: Math.round(peakMs / 1000),
      holdSec: Math.round(holdMs / 1000),
      pnl: t.pnl_sol,
      reason: t.exit_reason || '?'
    });
  }
});

const total = tooEarly + tooLate + justRight;
console.log('--- CLASIFICACION (excl rugs) ---');
console.log('OK (>50% capture):  ' + justRight + ' (' + (100 * justRight / total).toFixed(0) + '%)');
console.log('MUY TEMPRANO:       ' + tooEarly + ' (' + (100 * tooEarly / total).toFixed(0) + '%) - perdido: ' + (earlyLostSOL * 1000).toFixed(1) + ' mSOL');
console.log('MUY TARDE:          ' + tooLate + ' (' + (100 * tooLate / total).toFixed(0) + '%) - tokens crashed post-peak');
console.log('RUGS (irreparables): ' + rug);

// Detailed: TOO LATE cases (where tighter trailing would have helped)
console.log('\n--- MUY TARDE: peak temprano, despues crash ---');
lateList.slice(0, 20).forEach(t => {
  console.log(
    '  ' + t.mint + '.. pk=' + t.peakM.toFixed(2) + 'x ex=' + t.exitM.toFixed(2) + 'x ' +
    'capture=' + (t.captureRatio * 100).toFixed(0) + '% ' +
    'peakAt=' + t.peakSec + 's hold=' + t.holdSec + 's ' +
    t.reason.padEnd(16) + ' ' + (t.pnl * 1000).toFixed(1) + 'mSOL'
  );
});

// Exit reason breakdown
console.log('\n--- EXIT REASON vs RESULTADO ---');
const byReason = {};
trades.forEach(t => {
  const r = t.exit_reason || 'unknown';
  if (!byReason[r]) byReason[r] = { n: 0, wins: 0, pnl: 0, avgPeak: 0, avgExit: 0 };
  byReason[r].n++;
  if (t.pnl_sol > 0) byReason[r].wins++;
  byReason[r].pnl += t.pnl_sol;
  byReason[r].avgPeak += t.peak_multiplier || (t.peak_price / t.entry_price);
  byReason[r].avgExit += t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
});
Object.entries(byReason).sort((a, b) => b[1].n - a[1].n).forEach(([r, d]) => {
  console.log(
    '  ' + r.padEnd(22) + ' N=' + String(d.n).padStart(3) +
    ' WR=' + (100 * d.wins / d.n).toFixed(0).padStart(3) + '%' +
    ' PnL=' + (d.pnl * 1000).toFixed(1).padStart(7) + 'mSOL' +
    ' avgPk=' + (d.avgPeak / d.n).toFixed(2) + 'x' +
    ' avgEx=' + (d.avgExit / d.n).toFixed(2) + 'x'
  );
});

// Time to peak distribution for winners
console.log('\n--- WINNERS: CUANTO TARDA EN LLEGAR AL PEAK? ---');
const winners = trades.filter(t => t.pnl_sol > 0 && t.time_to_peak_ms > 0);
const brackets = [
  { label: '<30s', min: 0, max: 30000 },
  { label: '30s-2min', min: 30000, max: 120000 },
  { label: '2-5min', min: 120000, max: 300000 },
  { label: '5-10min', min: 300000, max: 600000 },
  { label: '10-15min', min: 600000, max: 900000 },
  { label: '>15min', min: 900000, max: Infinity },
];
brackets.forEach(b => {
  const inBracket = winners.filter(w => w.time_to_peak_ms >= b.min && w.time_to_peak_ms < b.max);
  if (inBracket.length === 0) return;
  const avgPeak = inBracket.reduce((s, w) => s + (w.peak_multiplier || w.peak_price / w.entry_price), 0) / inBracket.length;
  const avgExit = inBracket.reduce((s, w) => s + w.sol_returned / w.sol_invested, 0) / inBracket.length;
  console.log(
    '  ' + b.label.padEnd(10) + ' N=' + String(inBracket.length).padStart(3) +
    ' avgPk=' + avgPeak.toFixed(2) + 'x avgEx=' + avgExit.toFixed(2) + 'x' +
    ' capture=' + (100 * (avgExit - 1) / (avgPeak - 1)).toFixed(0) + '%'
  );
});

// Hold duration for winners vs losers
console.log('\n--- HOLD DURATION: WINNERS vs LOSERS ---');
const losers = trades.filter(t => t.pnl_sol <= 0 && t.closed_at && t.opened_at);
const winDurs = winners.map(w => (w.closed_at - w.opened_at) / 1000);
const loseDurs = losers.map(l => (l.closed_at - l.opened_at) / 1000);
console.log('Winners avg hold: ' + (winDurs.reduce((a, b) => a + b, 0) / winDurs.length).toFixed(0) + 's');
console.log('Losers avg hold: ' + (loseDurs.reduce((a, b) => a + b, 0) / loseDurs.length).toFixed(0) + 's');

// Trailing stop analysis: what if trailing was tighter (15%) or looser (30%)?
console.log('\n--- SIMULACION: TRAILING STOP DIFERENTE ---');
function simTrailing(pct, label) {
  let totalPnl = 0;
  trades.forEach(t => {
    const peakM = t.peak_multiplier || (t.peak_price / t.entry_price);
    const exitM = t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
    if (exitM < 0.1) { totalPnl += t.pnl_sol; return; } // rug

    // Simulated trailing: sell when price drops pct% from peak
    const trailingExit = peakM * (1 - pct / 100);
    const simExit = Math.min(trailingExit, exitM > 1 ? exitM : trailingExit);
    // Can't exit better than peak
    const simPnl = (simExit - 1) * t.sol_invested;
    totalPnl += simPnl;
  });
  console.log('  Trailing ' + label + ': PnL=' + (totalPnl * 1000).toFixed(1) + ' mSOL');
}
simTrailing(15, '15% (tighter)');
simTrailing(20, '20% (post-TP1) ');
simTrailing(25, '25% (actual)   ');
simTrailing(30, '30% (looser)   ');
simTrailing(35, '35% (very loose)');

db.close();
