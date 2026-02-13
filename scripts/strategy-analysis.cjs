const db = require('better-sqlite3')('data/bot.db', { readonly: true });

// ALL closed trades with real investment
const allTrades = db.prepare(`
  SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct, exit_reason,
         peak_multiplier, entry_latency_ms, security_score, sell_attempts, sell_successes,
         bot_version, opened_at, closed_at, status, liquidity_usd
  FROM positions
  WHERE status IN ('closed','stopped') AND sol_invested > 0
  ORDER BY opened_at
`).all();

console.log(`\n=== STRATEGY ANALYSIS (${allTrades.length} trades) ===\n`);

// Categorize trades by what ACTUALLY happened price-wise
let priceWins = 0;    // peak >= 1.2x (reached TP1)
let priceLosses = 0;  // peak < 1.0x (never went up)
let pricePartial = 0; // peak 1.0-1.2x (went up but not enough)
let rugs = 0;

allTrades.forEach(t => {
  const peak = t.peak_multiplier || 0;
  if (peak >= 1.2) priceWins++;
  else if (peak >= 1.0) pricePartial++;
  else priceLosses++;
  if (/rug|hard_stop|stale_restart|sell_hung/.test(t.exit_reason || '')) rugs++;
});

console.log('--- TOKEN SELECTION (did price go up?) ---');
console.log(`  Reached TP1 (1.2x+): ${priceWins}/${allTrades.length} (${(priceWins/allTrades.length*100).toFixed(0)}%)`);
console.log(`  Went up but <1.2x:   ${pricePartial}/${allTrades.length} (${(pricePartial/allTrades.length*100).toFixed(0)}%)`);
console.log(`  Never went up:       ${priceLosses}/${allTrades.length} (${(priceLosses/allTrades.length*100).toFixed(0)}%)`);
console.log(`  Rugs/hard stops:     ${rugs}/${allTrades.length} (${(rugs/allTrades.length*100).toFixed(0)}%)`);

console.log('\n--- PEAK DISTRIBUTION ---');
const peaks = allTrades.map(t => t.peak_multiplier || 0).sort((a,b) => b-a);
console.log(`  Top 5 peaks: ${peaks.slice(0,5).map(p => p.toFixed(2)+'x').join(', ')}`);
console.log(`  Median peak: ${peaks[Math.floor(peaks.length/2)]?.toFixed(2)}x`);
console.log(`  Avg peak: ${(peaks.reduce((s,p) => s+p, 0) / peaks.length).toFixed(2)}x`);
console.log(`  Reached 1.5x+: ${peaks.filter(p => p >= 1.5).length}/${allTrades.length}`);
console.log(`  Reached 2.0x+: ${peaks.filter(p => p >= 2.0).length}/${allTrades.length}`);
console.log(`  Reached 3.0x+: ${peaks.filter(p => p >= 3.0).length}/${allTrades.length}`);

console.log('\n--- ENTRY LATENCY ---');
const latencies = allTrades.filter(t => t.entry_latency_ms > 0 && t.entry_latency_ms < 120000).map(t => t.entry_latency_ms);
if (latencies.length > 0) {
  latencies.sort((a,b) => a-b);
  console.log(`  Min: ${(latencies[0]/1000).toFixed(1)}s | Median: ${(latencies[Math.floor(latencies.length/2)]/1000).toFixed(1)}s | Max: ${(latencies[latencies.length-1]/1000).toFixed(1)}s`);
  console.log(`  <20s: ${latencies.filter(l => l < 20000).length} | 20-30s: ${latencies.filter(l => l >= 20000 && l < 30000).length} | 30-60s: ${latencies.filter(l => l >= 30000 && l < 60000).length} | >60s: ${latencies.filter(l => l >= 60000).length}`);

  // Latency vs peak correlation
  const fast = allTrades.filter(t => t.entry_latency_ms > 0 && t.entry_latency_ms < 20000);
  const med = allTrades.filter(t => t.entry_latency_ms >= 20000 && t.entry_latency_ms < 40000);
  const slow = allTrades.filter(t => t.entry_latency_ms >= 40000);
  if (fast.length > 0) {
    const fastWins = fast.filter(t => (t.peak_multiplier || 0) >= 1.2).length;
    console.log(`  <20s latency: ${fast.length} trades, ${fastWins} reached TP1 (${(fastWins/fast.length*100).toFixed(0)}%), avg peak ${(fast.reduce((s,t)=>s+(t.peak_multiplier||0),0)/fast.length).toFixed(2)}x`);
  }
  if (med.length > 0) {
    const medWins = med.filter(t => (t.peak_multiplier || 0) >= 1.2).length;
    console.log(`  20-40s latency: ${med.length} trades, ${medWins} reached TP1 (${(medWins/med.length*100).toFixed(0)}%), avg peak ${(med.reduce((s,t)=>s+(t.peak_multiplier||0),0)/med.length).toFixed(2)}x`);
  }
  if (slow.length > 0) {
    const slowWins = slow.filter(t => (t.peak_multiplier || 0) >= 1.2).length;
    console.log(`  40s+ latency: ${slow.length} trades, ${slowWins} reached TP1 (${(slowWins/slow.length*100).toFixed(0)}%), avg peak ${(slow.reduce((s,t)=>s+(t.peak_multiplier||0),0)/slow.length).toFixed(2)}x`);
  }
}

// By version (recent only)
console.log('\n--- BY VERSION (recent) ---');
const byVersion = {};
allTrades.forEach(t => {
  const v = t.bot_version || 'unknown';
  if (!byVersion[v]) byVersion[v] = { trades: 0, wins: 0, rugs: 0, pnl: 0, peaks: [] };
  byVersion[v].trades++;
  if ((t.peak_multiplier || 0) >= 1.2) byVersion[v].wins++;
  if (/rug|hard_stop|stale_restart|sell_hung/.test(t.exit_reason || '')) byVersion[v].rugs++;
  byVersion[v].pnl += t.pnl_sol || 0;
  byVersion[v].peaks.push(t.peak_multiplier || 0);
});
Object.entries(byVersion).sort((a,b) => a[0].localeCompare(b[0])).forEach(([v, d]) => {
  const avgPeak = d.peaks.reduce((s,p) => s+p, 0) / d.peaks.length;
  console.log(`  ${v.padEnd(6)}: ${d.trades} trades, ${d.wins}W/${d.rugs}R, avg peak ${avgPeak.toFixed(2)}x, pnl=${d.pnl.toFixed(6)} SOL`);
});

// SELL EXECUTION analysis
console.log('\n--- SELL EXECUTION ---');
const withSells = allTrades.filter(t => t.sell_attempts > 0);
const totalAttempts = withSells.reduce((s,t) => s + t.sell_attempts, 0);
const totalSuccesses = withSells.reduce((s,t) => s + t.sell_successes, 0);
console.log(`  Overall sell rate: ${totalSuccesses}/${totalAttempts} (${totalAttempts > 0 ? (totalSuccesses/totalAttempts*100).toFixed(0) : 0}%)`);

// Exit reason distribution
console.log('\n--- EXIT REASONS ---');
const exitReasons = {};
allTrades.forEach(t => {
  const r = t.exit_reason || 'unknown';
  exitReasons[r] = (exitReasons[r] || 0) + 1;
});
Object.entries(exitReasons).sort((a,b) => b[1]-a[1]).forEach(([reason, count]) => {
  console.log(`  ${reason.padEnd(30)} ${count} (${(count/allTrades.length*100).toFixed(0)}%)`);
});

// THEORETICAL PNL with perfect sells, at different trade sizes
console.log('\n--- THEORETICAL PNL (perfect sells at peak, accounting for overhead) ---');
[0.001, 0.01, 0.05, 0.10].forEach(tradeSize => {
  let totalPnl = 0;
  const overhead = 0.0024; // ATA + fees

  allTrades.forEach(t => {
    const peak = t.peak_multiplier || 0;
    if (peak >= 1.2) {
      // TP1 at 1.2x (50%), rest at peak (capped at 3x for TP3)
      const tp1Return = tradeSize * 0.5 * 1.2;
      const restReturn = tradeSize * 0.5 * Math.min(peak, 3.0);
      totalPnl += (tp1Return + restReturn) - tradeSize - overhead;
    } else if (peak > 0) {
      // Sold near peak (optimistic) or SL
      const exitMult = Math.max(peak * 0.9, 0.7); // assume we exit at 90% of peak or SL at 0.7
      totalPnl += (tradeSize * exitMult) - tradeSize - overhead;
    } else {
      // Rug
      totalPnl += -tradeSize - overhead;
    }
  });

  const perTrade = totalPnl / allTrades.length;
  const overheadPct = (overhead / tradeSize * 100).toFixed(0);
  console.log(`  ${tradeSize.toFixed(3)} SOL/trade (overhead ${overheadPct}%): net ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL over ${allTrades.length} trades (${perTrade >= 0 ? '+' : ''}${perTrade.toFixed(4)}/trade)`);
});

// What if RPC was reliable? (remove trades with >60s latency, assume sell always works)
console.log('\n--- WHAT IF: Paid RPC (fast sells, <30s latency) ---');
const goodLatency = allTrades.filter(t => !t.entry_latency_ms || t.entry_latency_ms < 60000);
const goodPeaks = goodLatency.map(t => t.peak_multiplier || 0);
const goodWins = goodPeaks.filter(p => p >= 1.2).length;
console.log(`  Trades without latency bugs: ${goodLatency.length}/${allTrades.length}`);
console.log(`  TP1 hit rate (good latency): ${goodWins}/${goodLatency.length} (${(goodWins/goodLatency.length*100).toFixed(0)}%)`);
console.log(`  Avg peak (good latency): ${(goodPeaks.reduce((s,p)=>s+p,0)/goodPeaks.length).toFixed(2)}x`);

// Monthly projection at 0.05 SOL
const tradesPerDay = 3; // conservative
const daysPerMonth = 30;
const monthlyTrades = tradesPerDay * daysPerMonth;
const winRate = goodWins / goodLatency.length;
const avgWinPeak = goodPeaks.filter(p => p >= 1.2).reduce((s,p) => s+p, 0) / goodWins;
const tradeSize = 0.05;
const overhead = 0.003; // at 0.05 trades
const avgWinReturn = tradeSize * 0.5 * 1.2 + tradeSize * 0.5 * Math.min(avgWinPeak, 3.0) - tradeSize - overhead;
const avgLossReturn = -tradeSize * 0.3 - overhead; // SL at -30%
const expectedPerTrade = winRate * avgWinReturn + (1 - winRate) * avgLossReturn;
console.log(`\n  Monthly projection (${tradesPerDay}/day at ${tradeSize} SOL):`);
console.log(`    Win rate: ${(winRate*100).toFixed(0)}% | Avg win peak: ${avgWinPeak.toFixed(2)}x`);
console.log(`    Avg win return: ${avgWinReturn >= 0 ? '+' : ''}${avgWinReturn.toFixed(4)} SOL`);
console.log(`    Avg loss return: ${avgLossReturn.toFixed(4)} SOL`);
console.log(`    Expected per trade: ${expectedPerTrade >= 0 ? '+' : ''}${expectedPerTrade.toFixed(4)} SOL`);
console.log(`    Monthly (${monthlyTrades} trades): ${(expectedPerTrade * monthlyTrades) >= 0 ? '+' : ''}${(expectedPerTrade * monthlyTrades).toFixed(4)} SOL`);

db.close();
