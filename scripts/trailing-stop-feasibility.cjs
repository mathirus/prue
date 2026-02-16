const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

// Get all price ticks for non-rug trades with enough data
const trades = db.prepare(`
  SELECT p.id, p.bot_version, p.exit_reason, p.peak_multiplier, p.pnl_pct
  FROM positions p
  WHERE p.status IN ('closed','stopped')
  AND p.exit_reason NOT IN ('rug_pull', 'max_retries')
  AND p.exit_reason NOT LIKE 'stranded%'
  ORDER BY p.opened_at
`).all();

const tickStmt = db.prepare(`
  SELECT multiplier, elapsed_ms
  FROM position_price_log
  WHERE position_id = ?
  ORDER BY elapsed_ms
`);

console.log('\n=== TRAILING STOP FEASIBILITY ANALYSIS ===\n');
console.log('For each non-rug trade with price log data, compute:\n');
console.log('- Max drawdown from running peak (what trailing stop would have triggered)\n');

const trailResults = [];

for (const t of trades) {
  const ticks = tickStmt.all(t.id);
  if (ticks.length < 3) continue;
  
  let runningMax = 0;
  let maxDrawdown = 0;
  let maxDrawdownAt = 0;
  let peakBeforeDrawdown = 0;
  
  // Track all drawdowns from running peak
  const drawdowns = [];
  
  for (const tick of ticks) {
    if (tick.multiplier > runningMax) {
      runningMax = tick.multiplier;
    }
    if (runningMax > 1.0) {  // Only count drawdowns when we're above entry
      const dd = (runningMax - tick.multiplier) / runningMax;
      drawdowns.push(dd);
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownAt = tick.elapsed_ms;
        peakBeforeDrawdown = runningMax;
      }
    }
  }
  
  const finalMult = ticks[ticks.length - 1].multiplier;
  const peakMult = Math.max(...ticks.map(t => t.multiplier));
  
  trailResults.push({
    id: t.id,
    version: t.bot_version,
    exit: t.exit_reason,
    ticks: ticks.length,
    peakMult,
    finalMult,
    maxDrawdown,
    peakBeforeDD: peakBeforeDrawdown,
    pnlPct: t.pnl_pct
  });
}

// Sort by peak multiplier descending
trailResults.sort((a, b) => b.peakMult - a.peakMult);

console.log('ID           | Ver    | Ticks | Peak   | MaxDD% | PeakBeforeDD | Exit');
console.log('-'.repeat(85));

for (const r of trailResults) {
  const ddPct = (r.maxDrawdown * 100).toFixed(1);
  console.log(
    `${r.id.substring(0, 12).padEnd(13)}| ${r.version.padEnd(7)}| ${String(r.ticks).padStart(5)} | ${r.peakMult.toFixed(3).padStart(6)}x | ${ddPct.padStart(5)}% | ${r.peakBeforeDD.toFixed(3).padStart(12)}x | ${r.exit}`
  );
}

// Statistics
console.log('\n=== TRAILING STOP TRIGGER ANALYSIS ===\n');
console.log('If trailing stop at X%, how many trades would be stopped out before reaching their true peak?\n');

const trailPcts = [0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25];
for (const trail of trailPcts) {
  const stopped = trailResults.filter(r => r.maxDrawdown >= trail);
  const notStopped = trailResults.filter(r => r.maxDrawdown < trail);
  
  // Of those stopped, how much potential peak did they lose?
  const stoppedAvgPeak = stopped.length > 0 ? stopped.reduce((s, r) => s + r.peakMult, 0) / stopped.length : 0;
  const notStoppedAvgPeak = notStopped.length > 0 ? notStopped.reduce((s, r) => s + r.peakMult, 0) / notStopped.length : 0;
  
  console.log(
    `Trail ${(trail*100).toFixed(0).padStart(2)}%: ${stopped.length}/${trailResults.length} stopped (${(stopped.length/trailResults.length*100).toFixed(1)}%) | ` +
    `Stopped avg peak: ${stoppedAvgPeak.toFixed(3)}x | Not-stopped avg peak: ${notStoppedAvgPeak.toFixed(3)}x`
  );
}

// Key question: trades that peaked at 1.3x+ — what was their max intra-trade drawdown?
console.log('\n=== DRAWDOWN PROFILE BY PEAK RANGE ===\n');
const ranges = [
  { label: '1.0-1.1x', min: 1.0, max: 1.1 },
  { label: '1.1-1.2x', min: 1.1, max: 1.2 },
  { label: '1.2-1.5x', min: 1.2, max: 1.5 },
  { label: '1.5-2.0x', min: 1.5, max: 2.0 },
  { label: '2.0x+',    min: 2.0, max: 100 }
];

for (const range of ranges) {
  const inRange = trailResults.filter(r => r.peakMult >= range.min && r.peakMult < range.max);
  if (inRange.length === 0) continue;
  
  const avgDD = inRange.reduce((s, r) => s + r.maxDrawdown, 0) / inRange.length * 100;
  const maxDD = Math.max(...inRange.map(r => r.maxDrawdown)) * 100;
  const minDD = Math.min(...inRange.map(r => r.maxDrawdown)) * 100;
  
  console.log(`${range.label.padEnd(10)}: N=${String(inRange.length).padStart(2)} | AvgDD: ${avgDD.toFixed(1).padStart(5)}% | MinDD: ${minDD.toFixed(1).padStart(5)}% | MaxDD: ${maxDD.toFixed(1).padStart(5)}%`);
}

// CRITICAL: What would happen with a 5% trailing stop in practice?
// For trades that peak above 1.3x (where the big gains are), 
// would a 5% trail sell too early?
console.log('\n=== CRITICAL: 5% TRAILING STOP ON HIGH-PEAK TRADES ===\n');
const highPeakTrades = trailResults.filter(r => r.peakMult >= 1.3);
for (const r of highPeakTrades) {
  const wouldBeStoppedAt = r.peakBeforeDD * (1 - 0.05);  // approx
  const sellBefore = r.maxDrawdown >= 0.05 ? 'YES (stopped before true peak)' : 'NO (reached true peak)';
  console.log(`  ${r.id.substring(0,12)} peak=${r.peakMult.toFixed(2)}x, maxDD=${(r.maxDrawdown*100).toFixed(1)}%, 5% trail sells: ${sellBefore}`);
}

db.close();
