/**
 * BACKTEST ESCÉPTICO DE SHADOW POSITIONS
 *
 * Simula trades reales con slippage, overhead, y ajustes conservadores
 * para determinar si activar live trading es rentable.
 */

const Database = require('better-sqlite3');
const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');

// CONFIG DE BACKTEST
const OVERHEAD_PER_TRADE = 0.0028; // ATA rent + TX fees
const BUY_SLIPPAGE = 0.03;  // 3% (conservador)
const SELL_SLIPPAGE = 0.02; // 2% por venta
const RUG_LOSS_PCT = 0.60;  // 60% loss en rugs
const SKIP_FIRST_N_POINTS = 2; // Entry delay realista
const TRAILING_STOP_DELAY = 1; // 1 poll extra antes de trigger

// TP/SL CONFIG (v9d/v9e)
const TP1_MULT = 1.2;
const TP2_MULT = 1.5;
const TP3_MULT = 3.0;
const TP1_SELL_PCT = 0.50;
const TP2_SELL_PCT = 0.30;
const TP3_SELL_PCT = 0.20;
const STOP_LOSS_PCT = 0.30;
const TRAILING_BASE = 0.10;    // 10% trailing stop
const TRAILING_POST_TP1 = 0.08; // 8% después de TP1
const TRAILING_POST_TP2 = 0.05; // 5% después de TP2+
const TIMEOUT_MS = 12 * 60 * 1000; // 12 minutos
const EARLY_EXIT_MS = 3 * 60 * 1000; // 3 minutos
const SLOW_GRIND_MS = 5 * 60 * 1000; // 5 minutos
const SLOW_GRIND_THRESHOLD = 1.1; // <1.1x

// Filters a testear
const FILTERS = {
  A: { name: 'ALL (sin filtro)', check: () => true },
  B: { name: 'score >= 60', check: (p) => p.security_score >= 60 },
  C: { name: 'score >= 60 AND liq >= 10K', check: (p) => p.security_score >= 60 && (p.dp_liquidity_usd || 0) >= 10000 },
  D: { name: 'score >= 75 AND liq >= 10K (old)', check: (p) => p.security_score >= 75 && (p.dp_liquidity_usd || 0) >= 10000 },
};

const POSITION_SIZES = [0.02, 0.03, 0.05]; // SOL

/**
 * Simula un trade real usando price log
 */
function simulateTrade(position, priceLog, positionSol) {
  // Skip first N points (entry delay)
  const validPrices = priceLog.slice(SKIP_FIRST_N_POINTS);
  if (validPrices.length < 3) {
    return { skipped: true, reason: 'insufficient_data' };
  }

  const entryPrice = validPrices[0].price * (1 + BUY_SLIPPAGE);
  const startTime = position.opened_at;

  let remainingPct = 1.0;
  let totalPnl = 0;
  let tp1Hit = false, tp2Hit = false, tp3Hit = false;
  let peakMult = 1.0;
  let exitReason = null;
  let exitMult = null;

  // Simulate price trajectory
  for (let i = 0; i < validPrices.length; i++) {
    const point = validPrices[i];
    const mult = point.price / entryPrice;
    const elapsedMs = point.elapsed_ms;

    if (mult > peakMult) peakMult = mult;

    // Determinar trailing stop activo
    let currentTrailing = TRAILING_BASE;
    if (tp2Hit) currentTrailing = TRAILING_POST_TP2;
    else if (tp1Hit) currentTrailing = TRAILING_POST_TP1;

    // CHECK: Rug detected (pool_outcome o rug_detected)
    if (position.pool_outcome === 'rug' || position.rug_detected) {
      // Asumimos que el rug sucede cuando detectamos caída de reserva
      // Si NO alcanzamos ningún TP, perdemos 60%
      if (!tp1Hit) {
        const exitPrice = entryPrice * (1 - RUG_LOSS_PCT);
        const pnl = (exitPrice / entryPrice - 1) * remainingPct;
        totalPnl += pnl;
        exitReason = 'rug_detected';
        exitMult = exitPrice / entryPrice;
        break;
      }
      // Si ya hicimos profit, el rug solo afecta el remanente
    }

    // CHECK: TP3
    if (!tp3Hit && mult >= TP3_MULT) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * TP3_SELL_PCT * remainingPct;
      totalPnl += pnl;
      remainingPct *= (1 - TP3_SELL_PCT);
      tp3Hit = true;
    }

    // CHECK: TP2
    if (!tp2Hit && mult >= TP2_MULT) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * TP2_SELL_PCT * remainingPct;
      totalPnl += pnl;
      remainingPct *= (1 - TP2_SELL_PCT);
      tp2Hit = true;
    }

    // CHECK: TP1
    if (!tp1Hit && mult >= TP1_MULT) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * TP1_SELL_PCT * remainingPct;
      totalPnl += pnl;
      remainingPct *= (1 - TP1_SELL_PCT);
      tp1Hit = true;
    }

    // CHECK: Stop Loss
    if (mult <= (1 - STOP_LOSS_PCT)) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * remainingPct;
      totalPnl += pnl;
      exitReason = 'stop_loss';
      exitMult = mult;
      break;
    }

    // CHECK: Trailing Stop (con delay de 1 poll)
    const trailingTrigger = peakMult * (1 - currentTrailing);
    if (i > TRAILING_STOP_DELAY && mult < trailingTrigger) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * remainingPct;
      totalPnl += pnl;
      exitReason = 'trailing_stop';
      exitMult = mult;
      break;
    }

    // CHECK: Early Exit (3min + no TP + below entry)
    if (elapsedMs >= EARLY_EXIT_MS && !tp1Hit && mult < 1.0) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * remainingPct;
      totalPnl += pnl;
      exitReason = 'early_exit';
      exitMult = mult;
      break;
    }

    // CHECK: Slow Grind (5min + no TP + < 1.1x)
    if (elapsedMs >= SLOW_GRIND_MS && !tp1Hit && mult < SLOW_GRIND_THRESHOLD) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * remainingPct;
      totalPnl += pnl;
      exitReason = 'slow_grind';
      exitMult = mult;
      break;
    }

    // CHECK: Timeout
    if (elapsedMs >= TIMEOUT_MS) {
      const sellPrice = point.price * (1 - SELL_SLIPPAGE);
      const pnl = (sellPrice / entryPrice - 1) * remainingPct;
      totalPnl += pnl;
      exitReason = 'timeout';
      exitMult = mult;
      break;
    }
  }

  // Si terminamos el loop sin exit, vendemos en último precio
  if (!exitReason) {
    const lastPoint = validPrices[validPrices.length - 1];
    const sellPrice = lastPoint.price * (1 - SELL_SLIPPAGE);
    const pnl = (sellPrice / entryPrice - 1) * remainingPct;
    totalPnl += pnl;
    exitReason = 'price_log_end';
    exitMult = lastPoint.price / entryPrice;
  }

  // PnL en SOL
  const pnlSol = totalPnl * positionSol - OVERHEAD_PER_TRADE;

  return {
    skipped: false,
    pnlPct: totalPnl * 100,
    pnlSol,
    isWin: totalPnl > 0.05, // >5% = win
    exitReason,
    exitMult,
    peakMult,
    tp1Hit,
    tp2Hit,
    tp3Hit,
  };
}

/**
 * Bootstrap resampling para confidence intervals
 */
function bootstrap(trades, iterations = 1000) {
  const pnls = trades.map(t => t.pnlSol);
  const n = pnls.length;
  const bootstrapTotals = [];

  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(Math.random() * n);
      total += pnls[idx];
    }
    bootstrapTotals.push(total);
  }

  bootstrapTotals.sort((a, b) => a - b);
  const p5 = bootstrapTotals[Math.floor(iterations * 0.05)];
  const p50 = bootstrapTotals[Math.floor(iterations * 0.50)];
  const p95 = bootstrapTotals[Math.floor(iterations * 0.95)];

  return { p5, p50, p95 };
}

/**
 * Main backtest
 */
function runBacktest() {
  console.log('='.repeat(80));
  console.log('BACKTEST ESCÉPTICO DE SHADOW POSITIONS (últimas 6 horas)');
  console.log('='.repeat(80));
  console.log('');

  // Cargar posiciones cerradas con price log (>=5 points)
  const sixHoursAgo = (Date.now() - 6 * 3600 * 1000);

  const positions = db.prepare(`
    SELECT sp.*,
           COUNT(spl.id) as price_points,
           dp.dp_liquidity_usd,
           dp.dp_holder_count,
           dp.dp_top_holder_pct,
           dp.dp_rugcheck_score,
           dp.dp_lp_burned,
           dp.dp_honeypot_verified,
           dp.dp_mint_auth_revoked,
           dp.dp_freeze_auth_revoked,
           dp.pool_outcome
    FROM shadow_positions sp
    LEFT JOIN shadow_price_log spl ON sp.id = spl.shadow_id
    LEFT JOIN detected_pools dp ON sp.pool_id = dp.id
    WHERE sp.status = 'closed'
      AND sp.opened_at > ?
    GROUP BY sp.id
    HAVING price_points >= 5
    ORDER BY sp.opened_at DESC
  `).all(sixHoursAgo);

  console.log(`📊 Total shadow positions cerradas: ${positions.length}`);
  console.log(`⏰ Período: últimas 6 horas\n`);

  if (positions.length === 0) {
    console.log('❌ No hay suficientes datos. Necesitamos más posiciones shadow.\n');
    return;
  }

  // Get price logs
  const priceLogStmt = db.prepare(`
    SELECT price, multiplier, sol_reserve, elapsed_ms, created_at
    FROM shadow_price_log
    WHERE shadow_id = ?
    ORDER BY elapsed_ms ASC
  `);

  // Run backtest para cada filtro y position size
  const results = {};

  for (const [filterKey, filter] of Object.entries(FILTERS)) {
    results[filterKey] = {};

    const filteredPositions = positions.filter(filter.check);

    for (const positionSol of POSITION_SIZES) {
      const trades = [];

      for (const pos of filteredPositions) {
        const priceLog = priceLogStmt.all(pos.id);
        const result = simulateTrade(pos, priceLog, positionSol);

        if (!result.skipped) {
          trades.push({
            poolId: pos.pool_id,
            pnlSol: result.pnlSol,
            pnlPct: result.pnlPct,
            isWin: result.isWin,
            exitReason: result.exitReason,
            peakMult: result.peakMult,
          });
        }
      }

      const n = trades.length;
      const wins = trades.filter(t => t.isWin).length;
      const losses = n - wins;
      const winRate = n > 0 ? (wins / n * 100) : 0;
      const totalPnl = trades.reduce((sum, t) => sum + t.pnlSol, 0);
      const avgPnl = n > 0 ? totalPnl / n : 0;
      const worstTrade = n > 0 ? Math.min(...trades.map(t => t.pnlSol)) : 0;
      const bestTrade = n > 0 ? Math.max(...trades.map(t => t.pnlSol)) : 0;

      // Bootstrap si N >= 8
      let bootstrap_p5 = null, bootstrap_p50 = null, bootstrap_p95 = null;
      if (n >= 8) {
        const bs = bootstrap(trades, 1000);
        bootstrap_p5 = bs.p5;
        bootstrap_p50 = bs.p50;
        bootstrap_p95 = bs.p95;
      }

      results[filterKey][positionSol] = {
        n,
        wins,
        losses,
        winRate,
        totalPnl,
        avgPnl,
        worstTrade,
        bestTrade,
        bootstrap_p5,
        bootstrap_p50,
        bootstrap_p95,
        trades,
      };
    }
  }

  // Print results
  console.log('\n' + '='.repeat(80));
  console.log('RESULTADOS DEL BACKTEST');
  console.log('='.repeat(80));

  for (const [filterKey, filter] of Object.entries(FILTERS)) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`FILTRO ${filterKey}: ${filter.name}`);
    console.log('─'.repeat(80));

    for (const positionSol of POSITION_SIZES) {
      const r = results[filterKey][positionSol];

      console.log(`\n💰 Position Size: ${positionSol} SOL`);
      console.log(`   N trades: ${r.n}`);
      console.log(`   Wins / Losses: ${r.wins} / ${r.losses}`);
      console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
      console.log(`   Total PnL: ${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(6)} SOL`);
      console.log(`   Avg PnL/trade: ${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(6)} SOL`);
      console.log(`   Worst trade: ${r.worstTrade.toFixed(6)} SOL`);
      console.log(`   Best trade: ${r.bestTrade.toFixed(6)} SOL`);

      if (r.bootstrap_p5 !== null) {
        console.log(`\n   📈 Bootstrap (1000 iter):`);
        console.log(`      P5 (pesimista): ${r.bootstrap_p5 >= 0 ? '+' : ''}${r.bootstrap_p5.toFixed(6)} SOL`);
        console.log(`      P50 (mediana):  ${r.bootstrap_p50 >= 0 ? '+' : ''}${r.bootstrap_p50.toFixed(6)} SOL`);
        console.log(`      P95 (optimista):${r.bootstrap_p95 >= 0 ? '+' : ''}${r.bootstrap_p95.toFixed(6)} SOL`);

        if (r.bootstrap_p5 < 0) {
          console.log(`      ⚠️  P5 es NEGATIVO → estrategia NO confiable`);
        } else {
          console.log(`      ✅ P5 es positivo → estrategia podría ser viable`);
        }
      }

      const profitable = r.totalPnl > 0;
      console.log(`\n   ${profitable ? '✅ RENTABLE' : '❌ PERDEDOR'}`);
    }
  }

  // CRITICAL QUESTION: Cuántos trades hasta 0
  console.log('\n' + '='.repeat(80));
  console.log('ANÁLISIS DE RIESGO: Balance actual 0.162 SOL');
  console.log('='.repeat(80));

  const currentBalance = 0.162;

  for (const positionSol of [0.03, 0.05]) {
    console.log(`\n💸 Position Size: ${positionSol} SOL`);

    // Usar filtro C (score>=60, liq>=10K) como referencia
    const r = results['C'][positionSol];

    if (r.avgPnl < 0) {
      const tradesToZero = Math.floor(currentBalance / Math.abs(r.avgPnl));
      console.log(`   Avg PnL: ${r.avgPnl.toFixed(6)} SOL (negativo)`);
      console.log(`   ⚠️  Trades hasta balance 0: ~${tradesToZero}`);
      console.log(`   ⚠️  A win rate ${r.winRate.toFixed(1)}%, estarías en 0 en ${tradesToZero} trades`);
    } else {
      console.log(`   Avg PnL: +${r.avgPnl.toFixed(6)} SOL (positivo)`);
      console.log(`   ✅ Estrategia es rentable en promedio`);
    }

    // Break-even win rate
    // Para break-even: avgWin * winRate + avgLoss * (1-winRate) - overhead = 0
    // Simplificación: necesitamos al menos que los wins compensen losses + overhead
    const avgWinPnl = r.wins > 0 ? r.trades.filter(t => t.isWin).reduce((sum, t) => sum + t.pnlSol, 0) / r.wins : 0;
    const avgLossPnl = r.losses > 0 ? r.trades.filter(t => !t.isWin).reduce((sum, t) => sum + t.pnlSol, 0) / r.losses : 0;

    if (avgWinPnl > 0 && avgLossPnl < 0) {
      // winRate * avgWin + (1-winRate) * avgLoss = 0
      // winRate * (avgWin - avgLoss) = -avgLoss
      const breakEvenWR = Math.abs(avgLossPnl) / (avgWinPnl + Math.abs(avgLossPnl)) * 100;
      console.log(`   Win rate mínimo para break-even: ${breakEvenWR.toFixed(1)}%`);

      if (r.winRate < breakEvenWR) {
        console.log(`   ❌ Win rate actual (${r.winRate.toFixed(1)}%) < mínimo (${breakEvenWR.toFixed(1)}%)`);
      } else {
        console.log(`   ✅ Win rate actual (${r.winRate.toFixed(1)}%) > mínimo (${breakEvenWR.toFixed(1)}%)`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('RECOMENDACIÓN FINAL');
  console.log('='.repeat(80));

  // Analizar el mejor filtro
  let bestFilter = null;
  let bestPnl = -Infinity;
  let bestConfig = null;

  for (const [filterKey, filter] of Object.entries(FILTERS)) {
    for (const positionSol of POSITION_SIZES) {
      const r = results[filterKey][positionSol];
      if (r.n >= 8 && r.totalPnl > bestPnl) {
        bestPnl = r.totalPnl;
        bestFilter = filterKey;
        bestConfig = { filter: filter.name, positionSol, ...r };
      }
    }
  }

  if (bestFilter && bestPnl > 0) {
    console.log(`\n✅ MEJOR CONFIGURACIÓN:`);
    console.log(`   Filtro: ${bestConfig.filter}`);
    console.log(`   Position Size: ${bestConfig.positionSol} SOL`);
    console.log(`   N trades: ${bestConfig.n}`);
    console.log(`   Win Rate: ${bestConfig.winRate.toFixed(1)}%`);
    console.log(`   Total PnL: +${bestConfig.totalPnl.toFixed(6)} SOL`);
    console.log(`   Avg PnL/trade: +${bestConfig.avgPnl.toFixed(6)} SOL`);

    if (bestConfig.bootstrap_p5 !== null) {
      console.log(`   Bootstrap P5: ${bestConfig.bootstrap_p5 >= 0 ? '+' : ''}${bestConfig.bootstrap_p5.toFixed(6)} SOL`);

      if (bestConfig.bootstrap_p5 > 0) {
        console.log(`\n   🎯 Esta configuración PODRÍA ser rentable en live trading.`);
        console.log(`   ⚠️  PERO: muestra pequeña (N=${bestConfig.n}). Necesitas más datos.`);
      } else {
        console.log(`\n   ⚠️  P5 negativo = alta varianza. Riesgo significativo.`);
      }
    }
  } else {
    console.log(`\n❌ NINGUNA configuración es consistentemente rentable.`);
    console.log(`   Recomendación: NO activar live trading todavía.`);
    console.log(`   Necesitas más datos shadow o ajustar estrategia.`);
  }

  // Exit reason breakdown (filtro C, 0.03 SOL)
  console.log(`\n\n${'─'.repeat(80)}`);
  console.log(`BREAKDOWN DE EXIT REASONS (Filtro C, 0.03 SOL)`);
  console.log('─'.repeat(80));

  const refTrades = results['C'][0.03].trades;
  const exitReasons = {};
  for (const t of refTrades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  for (const [reason, count] of Object.entries(exitReasons).sort((a, b) => b[1] - a[1])) {
    const pct = (count / refTrades.length * 100).toFixed(1);
    console.log(`   ${reason}: ${count} (${pct}%)`);
  }

  console.log('\n');
}

// Run
try {
  runBacktest();
} catch (err) {
  console.error('Error en backtest:', err);
  process.exit(1);
}
