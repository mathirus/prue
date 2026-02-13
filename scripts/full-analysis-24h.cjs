/**
 * Full analysis of ALL trades in last 24h with DexScreener current state
 */
const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();
const h24 = now - 24 * 60 * 60 * 1000;

const trades = db.prepare(`
  SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct,
         entry_price, peak_price, peak_multiplier, time_to_peak_ms,
         tp_levels_hit, exit_reason, opened_at, closed_at,
         sell_attempts, sell_successes, entry_latency_ms
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
  ORDER BY opened_at ASC
`).all(h24);

const mints = [...new Set(trades.map(t => t.token_mint))];

async function main() {
  // Fetch DexScreener for all tokens
  console.log(`Fetching DexScreener for ${mints.length} tokens...\n`);
  const ds = {};
  for (const mint of mints) {
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint);
      const d = await r.json();
      if (d.pairs && d.pairs.length > 0) {
        const p = d.pairs[0];
        ds[mint] = {
          alive: true,
          priceNative: parseFloat(p.priceNative),
          priceUsd: parseFloat(p.priceUsd),
          marketCap: p.marketCap || 0,
          liq: p.liquidity?.usd || 0,
          vol24h: p.volume?.h24 || 0,
          txns24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
          change24h: p.priceChange?.h24,
        };
      } else {
        ds[mint] = { alive: false, marketCap: 0 };
      }
      await new Promise(r => setTimeout(r, 200));
    } catch {
      ds[mint] = { alive: false, marketCap: 0 };
    }
  }

  // ========== FULL TABLE ==========
  console.log('╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                              ANALISIS COMPLETO 24H — TODOS LOS TRADES                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝\n');

  let totalPnl = 0, totalInvested = 0;
  const categories = { win_alive: [], win_dead: [], loss_rug: [], loss_crash: [], loss_retries: [] };

  trades.forEach((t, i) => {
    const peakM = t.peak_multiplier || (t.peak_price && t.entry_price ? t.peak_price / t.entry_price : 1);
    const exitM = t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
    const dur = Math.round((t.closed_at - t.opened_at) / 1000);
    const timeToPeak = t.time_to_peak_ms ? Math.round(t.time_to_peak_ms / 1000) : null;
    const d = ds[t.token_mint] || { alive: false, marketCap: 0 };
    const win = t.pnl_sol > 0;

    totalPnl += t.pnl_sol;
    totalInvested += t.sol_invested;

    // Categorize
    if (win && d.alive && d.marketCap > 30000) categories.win_alive.push({ ...t, peakM, exitM, ds: d });
    else if (win) categories.win_dead.push({ ...t, peakM, exitM, ds: d });
    else if (t.exit_reason === 'max_retries' || t.exit_reason === 'max_retries_429') categories.loss_retries.push({ ...t, peakM, exitM, ds: d });
    else if (exitM < 0.1) categories.loss_rug.push({ ...t, peakM, exitM, ds: d });
    else categories.loss_crash.push({ ...t, peakM, exitM, ds: d });

    // Current multiplier estimate (if alive)
    let currentStatus = '';
    if (d.alive && d.marketCap > 100000) currentStatus = `VIVO $${Math.round(d.marketCap / 1000)}K`;
    else if (d.alive && d.marketCap > 30000) currentStatus = `ok $${Math.round(d.marketCap / 1000)}K`;
    else if (d.alive && d.marketCap > 5000) currentStatus = `bajo $${Math.round(d.marketCap / 1000)}K`;
    else currentStatus = 'MUERTO';

    const pnlStr = (t.pnl_sol >= 0 ? '+' : '') + (t.pnl_sol * 1000).toFixed(1);
    const tp = JSON.parse(t.tp_levels_hit || '[]');
    const reason = (t.exit_reason || '?').slice(0, 15);

    console.log(
      `#${String(i + 1).padStart(2)} ${win ? 'WIN ' : 'LOSS'} ` +
      `${t.token_mint.slice(0, 6)}.. ` +
      `${pnlStr.padStart(6)}m ` +
      `pk=${peakM.toFixed(2)}x ex=${exitM.toFixed(2)}x ` +
      `${String(dur).padStart(5)}s ` +
      `tp=${tp.length} ` +
      `${reason.padEnd(16)} ` +
      `${currentStatus}`
    );
  });

  // ========== SUMMARY ==========
  console.log('\n' + '='.repeat(80));
  console.log('RESUMEN');
  console.log('='.repeat(80));
  console.log(`Total trades: ${trades.length} | PnL: ${totalPnl.toFixed(4)} SOL | Invested: ${totalInvested.toFixed(4)} SOL`);
  console.log(`Winners: ${categories.win_alive.length + categories.win_dead.length} | Losers: ${categories.loss_rug.length + categories.loss_crash.length + categories.loss_retries.length}`);
  console.log(`Win rate: ${(100 * (categories.win_alive.length + categories.win_dead.length) / trades.length).toFixed(0)}%\n`);

  // ========== CATEGORY BREAKDOWN ==========
  function catSummary(name, arr) {
    if (arr.length === 0) return;
    const pnl = arr.reduce((s, t) => s + t.pnl_sol, 0);
    const avgPeak = arr.reduce((s, t) => s + t.peakM, 0) / arr.length;
    const avgExit = arr.reduce((s, t) => s + t.exitM, 0) / arr.length;
    console.log(`${name}: N=${arr.length} | PnL=${pnl.toFixed(4)} SOL | avgPeak=${avgPeak.toFixed(2)}x | avgExit=${avgExit.toFixed(2)}x`);
  }

  catSummary('WIN + TOKEN VIVO  ', categories.win_alive);
  catSummary('WIN + TOKEN MUERTO', categories.win_dead);
  catSummary('LOSS - RUG PULL   ', categories.loss_rug);
  catSummary('LOSS - CRASH      ', categories.loss_crash);
  catSummary('LOSS - SELL FAILED', categories.loss_retries);

  // ========== WINNERS ALIVE — Could we have held? ==========
  console.log('\n' + '='.repeat(80));
  console.log('WINNERS CON TOKEN TODAVIA VIVO — CUANTO DEJAMOS?');
  console.log('='.repeat(80) + '\n');

  let totalMissed = 0;
  categories.win_alive.forEach(t => {
    const leftOnTable = Math.max(0, (t.peakM - t.exitM) * t.sol_invested);
    totalMissed += leftOnTable;
    const mcap = t.ds.marketCap > 1000000 ? `$${(t.ds.marketCap / 1000000).toFixed(1)}M` : `$${Math.round(t.ds.marketCap / 1000)}K`;

    console.log(
      `  ${t.token_mint.slice(0, 8)}.. ` +
      `pk=${t.peakM.toFixed(2)}x ex=${t.exitM.toFixed(2)}x ` +
      `+${(t.pnl_sol * 1000).toFixed(1)}m left=${(leftOnTable * 1000).toFixed(1)}m ` +
      `| NOW: ${mcap} liq=$${Math.round(t.ds.liq / 1000)}K vol=$${Math.round(t.ds.vol24h / 1000)}K txns=${t.ds.txns24h}`
    );
  });
  console.log(`\n  Total missed (peak vs exit): ${(totalMissed * 1000).toFixed(1)} mSOL`);
  console.log(`  PERO: no sabemos si seguian subiendo o ya estaban bajando al vender`);

  // ========== LOSERS — Detailed ==========
  console.log('\n' + '='.repeat(80));
  console.log('LOSERS — DETALLE');
  console.log('='.repeat(80) + '\n');

  // Rugs
  console.log('--- RUGS (pérdida total, pool drenado) ---');
  categories.loss_rug.forEach(t => {
    const peakTime = t.time_to_peak_ms ? `${Math.round(t.time_to_peak_ms / 1000)}s` : '?';
    const mcap = t.ds.alive ? `$${Math.round(t.ds.marketCap / 1000)}K` : 'dead';
    console.log(
      `  ${t.token_mint.slice(0, 8)}.. ` +
      `pk=${t.peakM.toFixed(2)}x peakAt=${peakTime} ` +
      `loss=${(t.pnl_sol * 1000).toFixed(1)}m ` +
      `sells=${t.sell_successes}/${t.sell_attempts} ` +
      `| NOW: ${mcap}`
    );
  });

  // Crashes (had profit, lost it)
  console.log('\n--- CRASHES (tuvieron profit pero cayeron) ---');
  categories.loss_crash.forEach(t => {
    const peakTime = t.time_to_peak_ms ? `${Math.round(t.time_to_peak_ms / 1000)}s` : '?';
    const tp = JSON.parse(t.tp_levels_hit || '[]');
    const mcap = t.ds.alive ? `$${Math.round(t.ds.marketCap / 1000)}K` : 'dead';

    // If TP1@1.2x had hit, how much saved?
    let saved = 0;
    if (t.peakM >= 1.2) {
      saved = 0.5 * t.sol_invested * 0.2; // 50% sold at 1.2x = 10% profit on half
    }

    console.log(
      `  ${t.token_mint.slice(0, 8)}.. ` +
      `pk=${t.peakM.toFixed(2)}x ex=${t.exitM.toFixed(2)}x peakAt=${peakTime} ` +
      `loss=${(t.pnl_sol * 1000).toFixed(1)}m tp=${tp.length} ` +
      `| NOW: ${mcap}` +
      (saved > 0 ? ` | IF TP1@1.2x: +${(saved * 1000).toFixed(1)}m saved` : '')
    );
  });

  // Sell failures
  console.log('\n--- SELL FAILURES (no pudimos vender) ---');
  categories.loss_retries.forEach(t => {
    const mcap = t.ds.alive ? `$${Math.round(t.ds.marketCap / 1000)}K` : 'dead';
    console.log(
      `  ${t.token_mint.slice(0, 8)}.. ` +
      `pk=${t.peakM.toFixed(2)}x ` +
      `loss=${(t.pnl_sol * 1000).toFixed(1)}m ` +
      `sells=${t.sell_successes}/${t.sell_attempts} ` +
      `| NOW: ${mcap} ` +
      `| ${t.exit_reason}`
    );
  });

  // ========== KEY METRICS ==========
  console.log('\n' + '='.repeat(80));
  console.log('METRICAS CLAVE');
  console.log('='.repeat(80) + '\n');

  const winners = [...categories.win_alive, ...categories.win_dead];
  const losers = [...categories.loss_rug, ...categories.loss_crash, ...categories.loss_retries];

  const avgWinPnl = winners.reduce((s, t) => s + t.pnl_sol, 0) / winners.length;
  const avgLossPnl = losers.reduce((s, t) => s + t.pnl_sol, 0) / losers.length;

  console.log(`Avg winner: +${(avgWinPnl * 1000).toFixed(2)} mSOL`);
  console.log(`Avg loser:  ${(avgLossPnl * 1000).toFixed(2)} mSOL`);
  console.log(`R:R ratio:  ${(Math.abs(avgWinPnl) / Math.abs(avgLossPnl)).toFixed(2)}`);
  console.log(`Breakeven WR needed: ${(100 / (1 + Math.abs(avgWinPnl) / Math.abs(avgLossPnl))).toFixed(0)}%`);
  console.log(`Actual WR: ${(100 * winners.length / trades.length).toFixed(0)}%`);
  console.log(`Gap: ${winners.length / trades.length > 1 / (1 + Math.abs(avgWinPnl) / Math.abs(avgLossPnl)) ? 'ABOVE breakeven' : 'BELOW breakeven'}`);

  // Token survival
  const aliveTokens = Object.values(ds).filter(d => d.alive && d.marketCap > 50000);
  const deadTokens = Object.values(ds).filter(d => !d.alive || d.marketCap < 5000);
  console.log(`\nTokens ahora vivos (>$50K): ${aliveTokens.length}/${mints.length} (${(100 * aliveTokens.length / mints.length).toFixed(0)}%)`);
  console.log(`Tokens muertos (<$5K): ${deadTokens.length}/${mints.length} (${(100 * deadTokens.length / mints.length).toFixed(0)}%)`);

  db.close();
}

main().catch(e => console.error(e));
