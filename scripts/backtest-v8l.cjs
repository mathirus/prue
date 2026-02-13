/**
 * Backtest v8l scoring changes against historical trades.
 *
 * Simulates:
 * 1. Insiders penalty: -10 → -20 (3+ → -100)
 * 2. Graduation timing: <5min → -15, 5-45min → +5
 *
 * Compares v8k (original scores) vs v8l (recalculated scores)
 * to measure impact: rugs blocked, winners lost, net PnL delta.
 *
 * Usage: node scripts/backtest-v8l.cjs
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Check if v8l columns exist
  const dpCols = db.prepare('PRAGMA table_info(detected_pools)').all().map(c => c.name);
  const hasGraduation = dpCols.includes('dp_graduation_time_s');
  const hasInsiders = dpCols.includes('dp_insiders_count');
  const hasBundlePenalty = dpCols.includes('dp_bundle_penalty');

  console.log('=== v8l BACKTEST ===');
  console.log(`DB: ${DB_PATH}`);
  console.log(`v8l columns: graduation=${hasGraduation} insiders=${hasInsiders} bundle_penalty=${hasBundlePenalty}`);
  console.log('');

  // Get all trades with their scores
  const gradSelect = hasGraduation ? 'dp.dp_graduation_time_s,' : 'NULL as dp_graduation_time_s,';
  const insSelect = hasInsiders ? 'dp.dp_insiders_count,' : 'NULL as dp_insiders_count,';
  const bpSelect = hasBundlePenalty ? 'dp.dp_bundle_penalty,' : 'NULL as dp_bundle_penalty,';

  const trades = db.prepare(`
    SELECT
      p.id,
      p.token_mint,
      p.pnl_sol,
      p.pnl_pct,
      p.security_score as original_score,
      p.status,
      ${gradSelect}
      ${insSelect}
      ${bpSelect}
      dp.security_score as dp_score
    FROM positions p
    LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
    WHERE p.status IN ('closed', 'stopped')
    ORDER BY p.opened_at ASC
  `).all();

  console.log(`Total trades: ${trades.length}`);
  console.log('');

  // Classify each trade
  const MIN_SCORE = 80; // Current min_score
  let v8kTrades = 0, v8lTrades = 0;
  let v8kPnl = 0, v8lPnl = 0;
  let v8kWins = 0, v8lWins = 0;
  let v8kRugs = 0, v8lRugs = 0;
  let rugsBlocked = 0, winnersLost = 0;

  const blocked = [];
  const newlyPassed = [];

  for (const t of trades) {
    const score = t.original_score ?? t.dp_score ?? 80;
    const pnl = t.pnl_sol ?? 0;
    const pnlPct = t.pnl_pct ?? 0;
    const isRug = pnlPct <= -80;
    const isWin = pnl > 0;

    // v8k: all these trades passed the original scoring
    v8kTrades++;
    v8kPnl += pnl;
    if (isWin) v8kWins++;
    if (isRug) v8kRugs++;

    // v8l: recalculate score with new rules
    let v8lScore = score;
    let scoreChanges = [];

    // 1. Insiders penalty change: -10 → -20 (delta = -10 extra)
    //    For 3+ insiders: -10 → -100 (delta = -90 extra)
    const insiders = t.dp_insiders_count;
    if (insiders !== null && insiders >= 3) {
      v8lScore -= 90; // Was -10, now -100, delta = -90
      scoreChanges.push(`insiders(${insiders}):-90`);
    } else if (insiders !== null && insiders > 0) {
      v8lScore -= 10; // Was -10, now -20, delta = -10
      scoreChanges.push(`insiders(${insiders}):-10`);
    }

    // 2. Graduation timing
    const gradTime = t.dp_graduation_time_s;
    if (gradTime !== null && gradTime > 0 && gradTime < 300) {
      v8lScore -= 15; // <5min graduation penalty
      scoreChanges.push(`grad(${Math.floor(gradTime/60)}m):-15`);
    } else if (gradTime !== null && gradTime >= 300 && gradTime < 2700) {
      v8lScore += 5; // 5-45min organic bonus
      scoreChanges.push(`grad(${Math.floor(gradTime/60)}m):+5`);
    }

    v8lScore = Math.max(0, Math.min(100, v8lScore));

    // Would v8l have passed?
    const v8lPassed = v8lScore >= MIN_SCORE;

    if (v8lPassed) {
      v8lTrades++;
      v8lPnl += pnl;
      if (isWin) v8lWins++;
      if (isRug) v8lRugs++;
    } else {
      // This trade would have been BLOCKED by v8l
      if (isRug) {
        rugsBlocked++;
        blocked.push({ mint: t.token_mint?.slice(0, 8), pnl: pnl.toFixed(6), type: 'RUG', changes: scoreChanges.join(' '), oldScore: score, newScore: v8lScore });
      } else if (isWin) {
        winnersLost++;
        blocked.push({ mint: t.token_mint?.slice(0, 8), pnl: pnl.toFixed(6), type: 'WINNER', changes: scoreChanges.join(' '), oldScore: score, newScore: v8lScore });
      } else {
        blocked.push({ mint: t.token_mint?.slice(0, 8), pnl: pnl.toFixed(6), type: 'LOSS', changes: scoreChanges.join(' '), oldScore: score, newScore: v8lScore });
      }
    }

    // Check if any previously-blocked token would now pass (organic bonus)
    if (!v8lPassed && score < MIN_SCORE && v8lScore >= MIN_SCORE) {
      newlyPassed.push({ mint: t.token_mint?.slice(0, 8), pnl: pnl.toFixed(6), type: isRug ? 'RUG' : isWin ? 'WIN' : 'LOSS' });
    }
  }

  // Summary
  console.log('=== COMPARISON ===');
  console.log('');
  console.log(`Metric          | v8k       | v8l       | Delta`);
  console.log(`----------------|-----------|-----------|------`);
  console.log(`Trades          | ${String(v8kTrades).padEnd(9)} | ${String(v8lTrades).padEnd(9)} | ${v8lTrades - v8kTrades}`);
  console.log(`Wins            | ${String(v8kWins).padEnd(9)} | ${String(v8lWins).padEnd(9)} | ${v8lWins - v8kWins}`);
  console.log(`Rugs            | ${String(v8kRugs).padEnd(9)} | ${String(v8lRugs).padEnd(9)} | ${v8lRugs - v8kRugs}`);
  console.log(`Win Rate        | ${(v8kTrades > 0 ? (v8kWins/v8kTrades*100).toFixed(1) : 0).toString().padEnd(8)}% | ${(v8lTrades > 0 ? (v8lWins/v8lTrades*100).toFixed(1) : 0).toString().padEnd(8)}% |`);
  console.log(`Rug Rate        | ${(v8kTrades > 0 ? (v8kRugs/v8kTrades*100).toFixed(1) : 0).toString().padEnd(8)}% | ${(v8lTrades > 0 ? (v8lRugs/v8lTrades*100).toFixed(1) : 0).toString().padEnd(8)}% |`);
  console.log(`Total PnL (SOL) | ${v8kPnl.toFixed(6).padEnd(9)} | ${v8lPnl.toFixed(6).padEnd(9)} | ${(v8lPnl - v8kPnl).toFixed(6)}`);
  console.log('');
  console.log(`Rugs BLOCKED:    ${rugsBlocked}`);
  console.log(`Winners LOST:    ${winnersLost}`);
  console.log(`PnL improvement: ${(v8lPnl - v8kPnl).toFixed(6)} SOL`);
  console.log('');

  if (blocked.length > 0) {
    console.log('=== BLOCKED TRADES (by v8l) ===');
    console.log('Mint     | Type    | PnL SOL    | Score Change        | Old→New');
    console.log('---------|---------|------------|---------------------|--------');
    for (const b of blocked) {
      console.log(`${b.mint.padEnd(8)} | ${b.type.padEnd(7)} | ${b.pnl.padEnd(10)} | ${(b.changes || 'none').padEnd(19)} | ${b.oldScore}→${b.newScore}`);
    }
  }

  // Data availability stats
  console.log('\n=== DATA AVAILABILITY ===');
  const withGrad = trades.filter(t => t.dp_graduation_time_s !== null).length;
  const withIns = trades.filter(t => t.dp_insiders_count !== null).length;
  const withBp = trades.filter(t => t.dp_bundle_penalty !== null).length;
  console.log(`  graduation_time_s: ${withGrad}/${trades.length} (${(withGrad/trades.length*100).toFixed(0)}%)`);
  console.log(`  insiders_count:    ${withIns}/${trades.length} (${(withIns/trades.length*100).toFixed(0)}%)`);
  console.log(`  bundle_penalty:    ${withBp}/${trades.length} (${(withBp/trades.length*100).toFixed(0)}%)`);

  if (withGrad === 0 && withIns === 0) {
    console.log('\n  ⚠️  No v8l data yet. Backtest will be more meaningful after bot collects data with v8l.');
    console.log('  Currently showing impact based on score columns only.');
  }

  console.log('\nDone.');
  db.close();
}

main();
