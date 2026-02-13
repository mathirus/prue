const db = require('better-sqlite3')('data/bot.db', { readonly: true });

// Only recent versions (v9o+) with real data
const recentVersions = ['v9o','v9p','v9q','v9r','v9s','v9t','v9u','v9v','v9w','v9x','v9y','v9z',
  'v10a','v10b','v10c','v10d'];

const allTrades = db.prepare(`
  SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct, exit_reason,
         peak_multiplier, entry_latency_ms, security_score, sell_attempts, sell_successes,
         bot_version, opened_at, closed_at, status, liquidity_usd
  FROM positions
  WHERE status IN ('closed','stopped') AND sol_invested > 0
  ORDER BY opened_at
`).all();

const recent = allTrades.filter(t => recentVersions.includes(t.bot_version));
const old = allTrades.filter(t => !recentVersions.includes(t.bot_version));

console.log(`\n=== ESTRATEGIA: VERSIONES RECIENTES (${recent.length} trades, v9o+) vs ANTIGUAS (${old.length}) ===\n`);

// --- TOKEN SELECTION ---
function analyzeGroup(trades, label) {
  if (trades.length === 0) return;

  let tp1 = 0, partial = 0, never = 0, rugs = 0;
  trades.forEach(t => {
    const peak = t.peak_multiplier || 0;
    if (peak >= 1.2) tp1++;
    else if (peak >= 1.0) partial++;
    else never++;
    if (/rug|hard_stop|stale_restart|sell_hung|pool_drained/.test(t.exit_reason || '')) rugs++;
  });

  const peaks = trades.map(t => t.peak_multiplier || 0).filter(p => p < 100).sort((a,b) => b-a); // filter outliers
  const totalPnl = trades.reduce((s,t) => s + (t.pnl_sol || 0), 0);
  const wins = trades.filter(t => (t.pnl_sol || 0) > 0).length;
  const losses = trades.filter(t => (t.pnl_sol || 0) <= 0).length;

  console.log(`--- ${label} (${trades.length} trades) ---`);
  console.log(`  Alcanzó TP1 (1.2x+): ${tp1}/${trades.length} (${(tp1/trades.length*100).toFixed(0)}%)`);
  console.log(`  Subió pero <1.2x:    ${partial}/${trades.length} (${(partial/trades.length*100).toFixed(0)}%)`);
  console.log(`  Nunca subió:         ${never}/${trades.length} (${(never/trades.length*100).toFixed(0)}%)`);
  console.log(`  Rugs/pool drained:   ${rugs}/${trades.length} (${(rugs/trades.length*100).toFixed(0)}%)`);
  console.log(`  PnL REAL total:      ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(6)} SOL (${wins}W/${losses}L)`);

  if (peaks.length > 0) {
    console.log(`  Top peaks: ${peaks.slice(0,5).map(p => p.toFixed(2)+'x').join(', ')}`);
    console.log(`  Mediana peak: ${peaks[Math.floor(peaks.length/2)]?.toFixed(2)}x`);
    console.log(`  Avg peak: ${(peaks.reduce((s,p) => s+p, 0) / peaks.length).toFixed(2)}x`);
    console.log(`  >= 1.5x: ${peaks.filter(p => p >= 1.5).length} | >= 2.0x: ${peaks.filter(p => p >= 2.0).length} | >= 3.0x: ${peaks.filter(p => p >= 3.0).length}`);
  }

  // Sell success rate
  const withSells = trades.filter(t => t.sell_attempts > 0);
  const totalAttempts = withSells.reduce((s,t) => s + t.sell_attempts, 0);
  const totalSuccesses = withSells.reduce((s,t) => s + t.sell_successes, 0);
  console.log(`  Sells: ${totalSuccesses}/${totalAttempts} (${totalAttempts > 0 ? (totalSuccesses/totalAttempts*100).toFixed(0) : 0}%)`);
  console.log();
}

analyzeGroup(recent, 'VERSIONES RECIENTES (v9o+)');
analyzeGroup(old, 'VERSIONES ANTIGUAS');

// --- ENTRY LATENCY ANALYSIS (recent only) ---
console.log('--- ENTRY LATENCY vs RESULTADO (versiones recientes) ---');
const latencies = recent.filter(t => t.entry_latency_ms > 0 && t.entry_latency_ms < 300000);
const fast = latencies.filter(t => t.entry_latency_ms < 20000);
const med = latencies.filter(t => t.entry_latency_ms >= 20000 && t.entry_latency_ms < 40000);
const slow = latencies.filter(t => t.entry_latency_ms >= 40000);

[['<20s', fast], ['20-40s', med], ['40s+', slow]].forEach(([label, group]) => {
  if (group.length === 0) return;
  const wins = group.filter(t => (t.peak_multiplier || 0) >= 1.2).length;
  const avgPeak = group.reduce((s,t) => s + Math.min(t.peak_multiplier || 0, 100), 0) / group.length;
  const pnl = group.reduce((s,t) => s + (t.pnl_sol || 0), 0);
  console.log(`  ${label}: ${group.length} trades, ${wins} TP1 (${(wins/group.length*100).toFixed(0)}%), avg peak ${avgPeak.toFixed(2)}x, PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)}`);
});

// --- EXIT REASONS (recent only) ---
console.log('\n--- EXIT REASONS (versiones recientes) ---');
const exitReasons = {};
recent.forEach(t => {
  const r = t.exit_reason || 'unknown';
  exitReasons[r] = (exitReasons[r] || 0) + 1;
});
Object.entries(exitReasons).sort((a,b) => b[1]-a[1]).forEach(([reason, count]) => {
  console.log(`  ${reason.padEnd(35)} ${count} (${(count/recent.length*100).toFixed(0)}%)`);
});

// --- THEORETICAL PNL: If sells always worked at TP1 (recent trades) ---
console.log('\n--- THEORETICAL: Si sells siempre funcionaran (versiones recientes) ---');
[0.001, 0.01, 0.05, 0.10].forEach(tradeSize => {
  let totalPnl = 0;
  const overhead = 0.0024;

  recent.forEach(t => {
    const peak = Math.min(t.peak_multiplier || 0, 100); // cap outliers
    if (peak >= 1.2) {
      // TP1: sell 50% at 1.2x, rest at min(peak, 3.0)
      const tp1Return = tradeSize * 0.5 * 1.2;
      const restReturn = tradeSize * 0.5 * Math.min(peak, 3.0);
      totalPnl += (tp1Return + restReturn) - tradeSize - overhead;
    } else if (peak > 0) {
      const exitMult = Math.max(peak * 0.9, 0.7);
      totalPnl += (tradeSize * exitMult) - tradeSize - overhead;
    } else {
      totalPnl += -tradeSize - overhead;
    }
  });

  const perTrade = totalPnl / recent.length;
  console.log(`  ${tradeSize.toFixed(3)} SOL/trade: net ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL sobre ${recent.length} trades (${perTrade >= 0 ? '+' : ''}${perTrade.toFixed(4)}/trade)`);
});

// --- v10c SPECIFICALLY: Double-sell impact ---
console.log('\n--- v10c TRADES (double-sell bug) ---');
const v10c = recent.filter(t => t.bot_version === 'v10c');
v10c.forEach(t => {
  console.log(`  ${t.token_mint?.slice(0,8)} | peak ${(t.peak_multiplier||0).toFixed(2)}x | PnL ${t.pnl_sol?.toFixed(6)} (${t.pnl_pct?.toFixed(1)}%) | sells ${t.sell_successes}/${t.sell_attempts} | exit: ${t.exit_reason}`);
});
console.log(`  NOTA: PnL incorrecto por double-sell (sol_returned no incluye venta PumpSwap background)`);

// --- Monthly projection with RECENT data ---
console.log('\n--- PROYECCIÓN MENSUAL (datos recientes, TEÓRICA) ---');
const recentPeaks = recent.map(t => Math.min(t.peak_multiplier || 0, 100));
const recentWinRate = recentPeaks.filter(p => p >= 1.2).length / recent.length;
const recentAvgWinPeak = recentPeaks.filter(p => p >= 1.2).length > 0
  ? recentPeaks.filter(p => p >= 1.2).reduce((s,p) => s+p, 0) / recentPeaks.filter(p => p >= 1.2).length
  : 0;

const sizes = [0.01, 0.05, 0.10];
sizes.forEach(tradeSize => {
  const overhead = 0.003;
  const avgWinReturn = tradeSize * 0.5 * 1.2 + tradeSize * 0.5 * Math.min(recentAvgWinPeak, 3.0) - tradeSize - overhead;
  const avgLossReturn = -tradeSize * 0.3 - overhead; // SL -30%
  const expectedPerTrade = recentWinRate * avgWinReturn + (1 - recentWinRate) * avgLossReturn;
  const monthly = expectedPerTrade * 90; // 3/day * 30 days

  console.log(`  ${tradeSize.toFixed(2)} SOL/trade (3/día):`);
  console.log(`    Win rate: ${(recentWinRate*100).toFixed(0)}% | Avg win peak: ${recentAvgWinPeak.toFixed(2)}x`);
  console.log(`    EV/trade: ${expectedPerTrade >= 0 ? '+' : ''}${expectedPerTrade.toFixed(4)} SOL`);
  console.log(`    Mensual (90 trades): ${monthly >= 0 ? '+' : ''}${monthly.toFixed(4)} SOL`);
});

// --- KEY ISSUES ---
console.log('\n--- PROBLEMAS CLAVE IDENTIFICADOS ---');
const sellFailedTrades = recent.filter(t => t.sell_attempts > 0 && t.sell_successes === 0);
const doubleSellTrades = recent.filter(t => t.exit_reason === 'tp_complete' && t.pnl_pct < -20);
console.log(`  Trades donde SELL NUNCA funcionó: ${sellFailedTrades.length}/${recent.length}`);
console.log(`  Trades con PnL sospechoso (tp_complete pero >-20%): ${doubleSellTrades.length}`);
console.log(`  Trades que llegaron a TP1 pero PnL negativo: ${recent.filter(t => (t.peak_multiplier||0) >= 1.2 && t.pnl_sol < 0).length}`);

db.close();
