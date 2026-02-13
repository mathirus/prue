const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();
const h24 = now - 24 * 60 * 60 * 1000;

const trades = db.prepare(`
  SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct,
         entry_price, peak_price, peak_multiplier, time_to_peak_ms,
         tp_levels_hit, exit_reason, opened_at, closed_at, sell_attempts
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped')
  ORDER BY opened_at DESC
`).all(h24);

const mints = [...new Set(trades.map(t => t.token_mint))];

async function main() {
  console.log(`Fetching DexScreener for ${mints.length} unique tokens...\n`);

  const results = {};
  for (const mint of mints) {
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint);
      const d = await r.json();
      if (d.pairs && d.pairs.length > 0) {
        const p = d.pairs[0];
        results[mint] = {
          alive: true,
          priceNative: parseFloat(p.priceNative),
          marketCap: p.marketCap || 0,
          liq: p.liquidity?.usd || 0,
        };
      } else {
        results[mint] = { alive: false };
      }
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      results[mint] = { alive: false };
    }
  }

  // Classify each trade
  console.log('=== TODOS LOS TRADES 24H ===\n');

  let winnersCount = 0, losersCount = 0, totalPnl = 0;

  trades.forEach((t, i) => {
    const peakM = t.peak_multiplier || (t.peak_price && t.entry_price ? t.peak_price / t.entry_price : 1);
    const exitM = t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
    const win = t.pnl_sol > 0;
    const dur = (t.closed_at - t.opened_at) / 1000;
    const ds = results[t.token_mint] || { alive: false };

    if (win) winnersCount++; else losersCount++;
    totalPnl += t.pnl_sol;

    let status;
    if (ds.alive && ds.marketCap > 50000) status = 'VIVO $' + Math.round(ds.marketCap / 1000) + 'K';
    else if (ds.alive && ds.marketCap > 10000) status = 'bajo $' + Math.round(ds.marketCap / 1000) + 'K';
    else status = 'MUERTO';

    const tp = t.tp_levels_hit || '[]';
    const reason = (t.exit_reason || '?').padEnd(18);
    const pnlStr = (t.pnl_sol >= 0 ? '+' : '') + t.pnl_sol.toFixed(4);

    console.log(
      '#' + String(i + 1).padStart(2) + ' ' + (win ? 'WIN ' : 'LOSS') +
      ' | ' + t.token_mint.slice(0, 8) + '.. | ' + pnlStr + ' SOL' +
      ' | peak=' + peakM.toFixed(2) + 'x exit=' + exitM.toFixed(2) + 'x' +
      ' | ' + Math.round(dur) + 's | ' + reason +
      ' | tp=' + tp.padEnd(7) + ' | ' + status
    );
  });

  console.log('\n=== RESUMEN 24H ===');
  console.log('Trades:', trades.length, '| W:', winnersCount, '| L:', losersCount, '| WR:', (100 * winnersCount / trades.length).toFixed(0) + '%');
  console.log('PnL total:', totalPnl.toFixed(6), 'SOL');

  // WINNERS ANALYSIS
  const winners = trades.filter(t => t.pnl_sol > 0);
  console.log('\n=== WINNERS: DETALLE ===\n');

  let totalLeftOnTable = 0;
  let tokensStillAlive = 0;

  winners.forEach(t => {
    const peakM = t.peak_multiplier || (t.peak_price / t.entry_price);
    const exitM = t.sol_returned / t.sol_invested;
    const ds = results[t.token_mint] || { alive: false };
    const tpHit = JSON.parse(t.tp_levels_hit || '[]');
    const leftOnTable = (peakM - exitM) * t.sol_invested;
    totalLeftOnTable += Math.max(0, leftOnTable);

    let status;
    if (ds.alive && ds.marketCap > 50000) { status = 'VIVO $' + Math.round(ds.marketCap / 1000) + 'K'; tokensStillAlive++; }
    else if (ds.alive && ds.marketCap > 10000) { status = 'bajo $' + Math.round(ds.marketCap / 1000) + 'K'; }
    else { status = 'MUERTO'; }

    console.log(
      '  ' + t.token_mint.slice(0, 8) + '.. peak=' + peakM.toFixed(2) + 'x exit=' + exitM.toFixed(2) + 'x' +
      ' | TP:' + tpHit.length + ' | +' + (t.pnl_sol * 1000).toFixed(1) + 'mSOL' +
      ' | left=' + (leftOnTable * 1000).toFixed(1) + 'mSOL' +
      ' | ' + status
    );
  });

  console.log('\n  Winners total PnL: +' + winners.reduce((s, t) => s + t.pnl_sol, 0).toFixed(4) + ' SOL');
  console.log('  Left on table (peak vs exit): ' + (totalLeftOnTable * 1000).toFixed(1) + ' mSOL');
  console.log('  Tokens still alive (>$50K mcap):', tokensStillAlive, '/', winners.length);

  // LOSERS WITH PROFIT ANALYSIS
  const losersWithProfit = trades.filter(t => {
    const peakM = t.peak_multiplier || (t.peak_price && t.entry_price ? t.peak_price / t.entry_price : 1);
    return t.pnl_sol <= 0 && peakM >= 1.15;
  });

  console.log('\n=== LOSERS QUE TENIAN GANANCIA (peak >= 1.15x) ===\n');

  let saveable = 0;

  losersWithProfit.forEach(t => {
    const peakM = t.peak_multiplier || (t.peak_price / t.entry_price);
    const exitM = t.sol_returned / t.sol_invested;
    const ds = results[t.token_mint] || { alive: false };
    const timeToPeak = t.time_to_peak_ms ? Math.round(t.time_to_peak_ms / 1000) + 's' : '?';

    let status;
    if (ds.alive && ds.marketCap > 10000) status = 'VIVO $' + Math.round(ds.marketCap / 1000) + 'K';
    else status = 'MUERTO';

    // If TP1@1.2x sold 30%, how much saved?
    let savedIfTP12 = 0;
    if (peakM >= 1.2) {
      savedIfTP12 = 0.3 * t.sol_invested * (1.2 - 1); // 30% sold at 1.2x
      saveable++;
    }

    console.log(
      '  ' + t.token_mint.slice(0, 8) + '.. peak=' + peakM.toFixed(2) + 'x exit=' + exitM.toFixed(2) + 'x' +
      ' | loss=' + (t.pnl_sol * 1000).toFixed(1) + 'mSOL' +
      ' | peakAt=' + timeToPeak +
      ' | ' + (t.exit_reason || '?').padEnd(15) +
      ' | ' + status +
      (savedIfTP12 > 0 ? ' | TP1@1.2x saves +' + (savedIfTP12 * 1000).toFixed(1) + 'mSOL' : '')
    );
  });

  // SIMULATION: different strategies on THESE 42 trades
  console.log('\n=== SIMULACION: ESTRATEGIAS SOBRE ESTOS ' + trades.length + ' TRADES ===\n');

  function simulate(name, tp1pct, tp1x, tp2pct, tp2x, tp3pct, tp3x) {
    let totalPnl = 0;

    trades.forEach(t => {
      const peakM = t.peak_multiplier || (t.peak_price && t.entry_price ? t.peak_price / t.entry_price : 1);
      const exitM = t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
      const inv = t.sol_invested;

      // For rugs (sell_attempts > 0 but sell_successes = 0), no TP saves you
      if (t.sol_returned === 0 || exitM < 0.05) {
        // Pure rug — check if TP1 could have triggered before rug
        if (peakM >= tp1x && t.time_to_peak_ms && t.time_to_peak_ms > 10000) {
          // TP1 might have saved partial
          const saved = tp1pct * inv * (tp1x - 1);
          const lost = (1 - tp1pct) * inv * -1; // rest is lost
          totalPnl += saved + lost;
        } else {
          totalPnl += t.pnl_sol; // Same loss
        }
        return;
      }

      if (t.pnl_sol <= 0) {
        // Loser but got some back
        if (peakM >= tp1x) {
          // TP1 triggered — sell tp1pct at tp1x
          const tp1Profit = tp1pct * inv * (tp1x - 1);
          const remainExit = (1 - tp1pct) * inv * (exitM - 1);
          totalPnl += tp1Profit + remainExit;
        } else {
          totalPnl += t.pnl_sol;
        }
        return;
      }

      // Winner
      let remaining = 1.0;
      let profit = 0;

      if (peakM >= tp1x) {
        const sell = Math.min(tp1pct, remaining);
        profit += sell * inv * (tp1x - 1);
        remaining -= sell;
      }
      if (peakM >= tp2x && remaining > 0) {
        const sell = Math.min(tp2pct, remaining);
        profit += sell * inv * (tp2x - 1);
        remaining -= sell;
      }
      if (peakM >= tp3x && remaining > 0) {
        const sell = Math.min(tp3pct, remaining);
        profit += sell * inv * (tp3x - 1);
        remaining -= sell;
      }
      if (remaining > 0) {
        // Trails to exit
        profit += remaining * inv * (exitM - 1);
      }

      totalPnl += profit;
    });

    console.log(name.padEnd(55) + '| PnL=' + totalPnl.toFixed(4).padStart(8) + ' SOL');
  }

  simulate('ACTUAL:  50%@1.3x + 25%@2.0x + 25%@4.0x',       0.50, 1.3, 0.25, 2.0, 0.25, 4.0);
  simulate('TP1 bajo: 50%@1.2x + 25%@2.0x + 25%@4.0x',      0.50, 1.2, 0.25, 2.0, 0.25, 4.0);
  simulate('TP1 bajo + menos: 30%@1.2x + 35%@2.0x + 35%@4.0x', 0.30, 1.2, 0.35, 2.0, 0.35, 4.0);
  simulate('MOONBAG: 20%@1.2x + 20%@1.5x + 60%@5.0x',       0.20, 1.2, 0.20, 1.5, 0.60, 5.0);
  simulate('CONSERV: 50%@1.15x + 25%@1.5x + 25%@3.0x',      0.50, 1.15, 0.25, 1.5, 0.25, 3.0);
  simulate('MIX: 30%@1.2x + 30%@1.5x + 40%@3.0x',           0.30, 1.2, 0.30, 1.5, 0.40, 3.0);
  simulate('PATIENT: 25%@1.3x + 25%@2.0x + 50%@5.0x',       0.25, 1.3, 0.25, 2.0, 0.50, 5.0);
  simulate('NO CHANGE (solo exit_mult real)',                  0, 999, 0, 999, 0, 999);

  // VERDICT
  console.log('\n=== VEREDICTO ESCEPTICO ===\n');

  const winners24h = trades.filter(t => t.pnl_sol > 0);
  const losers24h = trades.filter(t => t.pnl_sol <= 0);
  const rugs = losers24h.filter(t => t.sol_returned === 0 || (t.sol_returned / t.sol_invested) < 0.05);
  const nonRugLosers = losers24h.filter(t => t.sol_returned > 0 && (t.sol_returned / t.sol_invested) >= 0.05);

  console.log('24h breakdown:');
  console.log('  Winners:', winners24h.length, '- avg peak:', (winners24h.reduce((s, t) => s + (t.peak_multiplier || t.peak_price / t.entry_price), 0) / winners24h.length).toFixed(2) + 'x');
  console.log('  Rugs (total loss):', rugs.length, '- NO TP strategy saves these');
  console.log('  Non-rug losers:', nonRugLosers.length, '- these peaked but crashed');
  console.log('  Still alive tokens:', Object.values(results).filter(r => r.alive && r.marketCap > 50000).length, '/', mints.length);

  db.close();
}

main().catch(e => console.error(e));
