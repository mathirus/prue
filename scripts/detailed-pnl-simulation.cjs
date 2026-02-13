/**
 * DETAILED PnL simulation for the 30 filtered shadow positions.
 * Uses ACTUAL price logs (second by second) and our REAL exit strategy:
 * - TP1: sell 50% at 1.2x
 * - TP2: sell 30% at 1.5x
 * - TP3: sell 20% at 3.0x
 * - Trailing stop: 10% base, 8% post-TP1, 5% moon
 * - Stop loss: -30%
 * - Post-TP floor: price < 1.15x after TP1 → sell remaining
 * - Slow grind: 5min+ no TP + price < 1.1x → sell
 * - Timeout: 12min (15min for shadow actually)
 * - Rug detection: instant sell (simulated as 60% loss on remaining)
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'));

// Get filtered positions
const positions = db.prepare(`
  SELECT sp.*, dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL
    AND sp.security_score >= 60
    AND dp.dp_liquidity_usd >= 10000
  ORDER BY sp.opened_at
`).all();

console.log(`=== SIMULACION DETALLADA: ${positions.length} TRADES ===\n`);

const SLIPPAGE_BUY = 0.03;   // 3% buy slippage
const SLIPPAGE_SELL = 0.02;  // 2% sell slippage
const OVERHEAD = 0.0028;     // ATA + fees per trade

function simulateTrade(pos, priceLogs, positionSize) {
  if (!priceLogs.length) {
    // No price data = assume we sold at final_multiplier
    const mult = pos.final_multiplier || 1;
    const pnl = positionSize * (mult - 1) * (1 - SLIPPAGE_SELL) - OVERHEAD;
    return { pnl, exitReason: 'no_data', soldAt: mult, details: 'no price logs' };
  }

  const entryPrice = priceLogs[0].price;
  if (!entryPrice || entryPrice === 0) {
    return { pnl: -OVERHEAD, exitReason: 'no_entry', soldAt: 0, details: 'entry price 0' };
  }

  // Adjust entry for buy slippage (we buy slightly higher)
  const effectiveEntry = entryPrice * (1 + SLIPPAGE_BUY);

  let remaining = 1.0;  // fraction of position still held
  let totalSold = 0;    // SOL received from sells
  let tp1Done = false, tp2Done = false, tp3Done = false;
  let peakMult = 1.0;
  let exitReason = 'timeout';
  let exitMult = 1.0;
  const events = [];

  for (const log of priceLogs) {
    const mult = log.price / effectiveEntry;
    const elapsed = log.elapsed_ms;
    peakMult = Math.max(peakMult, mult);
    const trailingPct = tp2Done ? 0.05 : (tp1Done ? 0.08 : 0.10);

    // Rug detection (reserve drop > 50%)
    if (pos.rug_detected && log.sol_reserve && priceLogs[0].sol_reserve) {
      const reserveDrop = 1 - (log.sol_reserve / priceLogs[0].sol_reserve);
      if (reserveDrop > 0.5 && remaining > 0) {
        // Emergency sell - lose 60% of remaining
        const rugLoss = remaining * positionSize * 0.6;
        totalSold += remaining * positionSize * 0.4 * (1 - SLIPPAGE_SELL);
        events.push(`RUG@${(elapsed/1000).toFixed(0)}s: lost 60% of ${(remaining*100).toFixed(0)}% remaining`);
        remaining = 0;
        exitReason = 'rug_detected';
        exitMult = mult;
        break;
      }
    }

    // Stop loss: -30%
    if (mult <= 0.70 && remaining > 0) {
      totalSold += remaining * positionSize * mult * (1 - SLIPPAGE_SELL);
      events.push(`SL@${(elapsed/1000).toFixed(0)}s: sold ${(remaining*100).toFixed(0)}% at ${mult.toFixed(2)}x`);
      remaining = 0;
      exitReason = 'stop_loss';
      exitMult = mult;
      break;
    }

    // TP1: sell 50% at 1.2x
    if (!tp1Done && mult >= 1.2 && remaining > 0.5) {
      const sellFrac = 0.5;
      totalSold += sellFrac * positionSize * 1.2 * (1 - SLIPPAGE_SELL);
      remaining -= sellFrac;
      tp1Done = true;
      events.push(`TP1@${(elapsed/1000).toFixed(0)}s: sold 50% at 1.2x`);
    }

    // TP2: sell 30% at 1.5x
    if (!tp2Done && tp1Done && mult >= 1.5 && remaining > 0.2) {
      const sellFrac = 0.3;
      totalSold += sellFrac * positionSize * 1.5 * (1 - SLIPPAGE_SELL);
      remaining -= sellFrac;
      tp2Done = true;
      events.push(`TP2@${(elapsed/1000).toFixed(0)}s: sold 30% at 1.5x`);
    }

    // TP3: sell 20% at 3.0x
    if (!tp3Done && tp2Done && mult >= 3.0 && remaining > 0) {
      totalSold += remaining * positionSize * 3.0 * (1 - SLIPPAGE_SELL);
      remaining = 0;
      tp3Done = true;
      exitReason = 'tp3_moon';
      exitMult = mult;
      events.push(`TP3@${(elapsed/1000).toFixed(0)}s: sold all at 3.0x`);
      break;
    }

    // Trailing stop
    if (tp1Done && peakMult > 1.2 && remaining > 0) {
      const dropFromPeak = 1 - (mult / peakMult);
      if (dropFromPeak >= trailingPct) {
        totalSold += remaining * positionSize * mult * (1 - SLIPPAGE_SELL);
        events.push(`TRAIL@${(elapsed/1000).toFixed(0)}s: sold ${(remaining*100).toFixed(0)}% at ${mult.toFixed(2)}x (peak was ${peakMult.toFixed(2)}x, drop ${(dropFromPeak*100).toFixed(0)}%)`);
        remaining = 0;
        exitReason = 'trailing_stop';
        exitMult = mult;
        break;
      }
    }

    // Post-TP floor: price < 1.15x after TP1
    if (tp1Done && mult < 1.15 && remaining > 0 && elapsed > 60000) {
      totalSold += remaining * positionSize * mult * (1 - SLIPPAGE_SELL);
      events.push(`FLOOR@${(elapsed/1000).toFixed(0)}s: sold ${(remaining*100).toFixed(0)}% at ${mult.toFixed(2)}x (below 1.15x floor)`);
      remaining = 0;
      exitReason = 'post_tp_floor';
      exitMult = mult;
      break;
    }

    // Slow grind: 5min+ no TP + below 1.1x
    if (!tp1Done && elapsed > 300000 && mult < 1.1 && remaining > 0) {
      totalSold += remaining * positionSize * mult * (1 - SLIPPAGE_SELL);
      events.push(`GRIND@${(elapsed/1000).toFixed(0)}s: sold ${(remaining*100).toFixed(0)}% at ${mult.toFixed(2)}x (5min grind)`);
      remaining = 0;
      exitReason = 'slow_grind';
      exitMult = mult;
      break;
    }
  }

  // Timeout: sell remaining at last price
  if (remaining > 0 && priceLogs.length > 0) {
    const lastLog = priceLogs[priceLogs.length - 1];
    const lastMult = lastLog.price / effectiveEntry;
    totalSold += remaining * positionSize * lastMult * (1 - SLIPPAGE_SELL);
    events.push(`TIMEOUT: sold ${(remaining*100).toFixed(0)}% at ${lastMult.toFixed(2)}x`);
    exitMult = lastMult;
  }

  const pnl = totalSold - positionSize - OVERHEAD;
  return { pnl, exitReason, soldAt: exitMult, details: events.join(' | '), peakMult };
}

// Run simulation for each position size
for (const size of [0.03, 0.05]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  POSITION SIZE: ${size} SOL`);
  console.log(`${'='.repeat(60)}\n`);

  let totalPnl = 0;
  let wins = 0, losses = 0;
  const tradeResults = [];

  for (const pos of positions) {
    // Get price logs for this position
    const logs = db.prepare(`
      SELECT price, multiplier, sol_reserve, elapsed_ms
      FROM shadow_price_log
      WHERE shadow_id = ?
      ORDER BY elapsed_ms
    `).all(pos.id);

    const result = simulateTrade(pos, logs, size);
    totalPnl += result.pnl;
    if (result.pnl > 0) wins++; else losses++;

    tradeResults.push({
      mint: pos.token_mint.slice(0, 8),
      score: pos.security_score,
      rug: pos.rug_detected ? 'RUG' : 'ok',
      pnl: result.pnl,
      exit: result.exitReason,
      peak: result.peakMult || pos.peak_multiplier,
      details: result.details,
      logs: logs.length,
    });
  }

  // Print each trade
  console.log('Token    | Score | Rug | PnL        | Exit           | Peak  | Logs | Events');
  console.log('---------|-------|-----|------------|----------------|-------|------|--------');
  for (const t of tradeResults) {
    const pnlStr = (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(4);
    console.log(
      `${t.mint} | ${String(t.score).padStart(5)} | ${t.rug.padEnd(3)} | ${pnlStr.padStart(10)} | ${t.exit.padEnd(14)} | ${(t.peak||0).toFixed(2)}x | ${String(t.logs).padStart(4)} | ${t.details.slice(0, 80)}`
    );
  }

  console.log(`\n--- RESUMEN ${size} SOL ---`);
  console.log(`Trades: ${positions.length} | Wins: ${wins} | Losses: ${losses} | WR: ${(wins/positions.length*100).toFixed(0)}%`);
  console.log(`PnL TOTAL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`);
  console.log(`PnL PROMEDIO: ${(totalPnl/positions.length).toFixed(4)} SOL/trade`);

  // Best and worst
  tradeResults.sort((a, b) => b.pnl - a.pnl);
  console.log(`Mejor trade: ${tradeResults[0].mint} ${tradeResults[0].pnl >= 0 ? '+' : ''}${tradeResults[0].pnl.toFixed(4)} SOL (${tradeResults[0].exit})`);
  console.log(`Peor trade:  ${tradeResults[tradeResults.length-1].mint} ${tradeResults[tradeResults.length-1].pnl.toFixed(4)} SOL (${tradeResults[tradeResults.length-1].exit})`);

  // By exit reason
  const byExit = {};
  for (const t of tradeResults) {
    if (!byExit[t.exit]) byExit[t.exit] = { count: 0, pnl: 0 };
    byExit[t.exit].count++;
    byExit[t.exit].pnl += t.pnl;
  }
  console.log('\nPor tipo de salida:');
  for (const [exit, data] of Object.entries(byExit)) {
    console.log(`  ${exit}: N=${data.count} PnL=${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)}`);
  }
}

db.close();
