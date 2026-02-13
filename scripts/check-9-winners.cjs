const db = require('better-sqlite3')('data/bot.db');
const trades = db.prepare(`
  SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct,
         entry_price, current_price, peak_multiplier, exit_reason,
         opened_at, closed_at
  FROM positions
  WHERE status IN ('closed','stopped') AND pnl_sol > 0
  ORDER BY opened_at DESC LIMIT 9
`).all();

async function main() {
  console.log('=== 9 ULTIMOS WINNERS: QUE PASO DESPUES? ===\n');

  let totalWeLeft = 0;
  let wouldHaveWon = 0;
  let wouldHaveLost = 0;

  for (const t of trades) {
    const mint = t.token_mint;
    const exitMult = t.sol_invested > 0 ? t.sol_returned / t.sol_invested : 0;
    const holdSec = Math.round((t.closed_at - t.opened_at) / 1000);
    const agoMin = Math.round((Date.now() - t.closed_at) / 60000);

    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint);
      const d = await r.json();

      if (d.pairs && d.pairs.length > 0) {
        const p = d.pairs[0];
        const mcap = p.marketCap || 0;
        const liq = p.liquidity?.usd || 0;
        const vol = p.volume?.h24 || 0;
        const txns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
        const priceNow = parseFloat(p.priceNative) || 0;
        const ch1h = p.priceChange?.h1;
        const ch6h = p.priceChange?.h6;
        const ch24h = p.priceChange?.h24;

        let multVsSell = '?';
        let extraSOL = 0;
        if (t.current_price > 0 && priceNow > 0) {
          const mult = priceNow / t.current_price;
          multVsSell = mult.toFixed(2) + 'x';
          // How much more SOL would remaining tokens be worth?
          // We sold all, so if price went up, we left money
          extraSOL = (mult - 1) * t.sol_returned;
          totalWeLeft += Math.max(0, extraSOL);
          if (mult > 1) wouldHaveWon++;
          else wouldHaveLost++;
        }

        const mcapStr = mcap > 1e6 ? '$' + (mcap / 1e6).toFixed(1) + 'M' : '$' + Math.round(mcap / 1000) + 'K';
        const liqStr = '$' + Math.round(liq / 1000) + 'K';
        const volStr = vol > 1e6 ? '$' + (vol / 1e6).toFixed(1) + 'M' : '$' + Math.round(vol / 1000) + 'K';

        const alive = mcap > 5000;
        const higher = priceNow > t.current_price;

        console.log(
          mint.slice(0, 8) + '.. ' +
          (alive ? 'VIVO' : 'MUERTO') + ' ' +
          (higher ? '📈 SUBIO' : '📉 BAJO')
        );
        console.log(
          '  Trade: exit=' + exitMult.toFixed(2) + 'x pk=' + (t.peak_multiplier || 0).toFixed(2) + 'x' +
          ' pnl=+' + (t.pnl_sol * 1000).toFixed(1) + 'mSOL hold=' + holdSec + 's' +
          ' reason=' + (t.exit_reason || '?') +
          ' (hace ' + agoMin + 'min)'
        );
        console.log(
          '  Ahora: mcap=' + mcapStr + ' liq=' + liqStr + ' vol=' + volStr + ' txns=' + txns
        );
        console.log(
          '  Precio vs venta: ' + multVsSell +
          (extraSOL > 0 ? ' (+' + (extraSOL * 1000).toFixed(1) + 'mSOL dejamos)' : '') +
          (extraSOL < 0 ? ' (bien vendido, habriamos perdido ' + (Math.abs(extraSOL) * 1000).toFixed(1) + 'mSOL)' : '')
        );
        console.log(
          '  Cambios: 1h=' + (ch1h != null ? ch1h + '%' : '?') +
          ' 6h=' + (ch6h != null ? ch6h + '%' : '?') +
          ' 24h=' + (ch24h != null ? ch24h + '%' : '?')
        );
        console.log('');
      } else {
        console.log(mint.slice(0, 8) + '.. MUERTO (no en DexScreener)');
        console.log(
          '  Trade: exit=' + exitMult.toFixed(2) + 'x pnl=+' + (t.pnl_sol * 1000).toFixed(1) + 'mSOL' +
          ' (hace ' + agoMin + 'min) → BIEN VENDIDO'
        );
        console.log('');
        wouldHaveLost++;
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(mint.slice(0, 8) + '.. ERROR: ' + e.message);
    }
  }

  console.log('=== RESUMEN ===');
  console.log('Subieron despues: ' + wouldHaveWon + '/9 (dejamos +' + (totalWeLeft * 1000).toFixed(1) + 'mSOL en la mesa)');
  console.log('Bajaron despues: ' + wouldHaveLost + '/9 (bien vendidos)');
  console.log('Conclusion: ' + (wouldHaveWon > wouldHaveLost ? 'VENDEMOS TEMPRANO' : 'VENDEMOS BIEN'));
}

main().then(() => db.close()).catch(e => { console.error(e); db.close(); });
