#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

const MIN_LIQ_USD = 5000;
const RUG_EXITS = ['rug_pull', 'max_retries', 'pool_drained'];
const EARLY_EXITS = ['early_exit', 'sell_burst_detected'];

function loadTrades() {
  return db.prepare(`
    SELECT p.id, p.bot_version, p.token_mint, p.exit_reason, p.pnl_pct, p.peak_multiplier, p.entry_price
    FROM positions p WHERE p.status IN ('closed','stopped') ORDER BY p.opened_at
  `).all();
}

function loadPostTradeChecks() {
  const rows = db.prepare(`
    SELECT position_id, multiplier_vs_sell, liquidity_usd
    FROM post_trade_checks WHERE multiplier_vs_sell IS NOT NULL
  `).all();
  const map = {};
  for (const r of rows) {
    if (!map[r.position_id]) map[r.position_id] = [];
    map[r.position_id].push(r);
  }
  return map;
}

function calcTruePeak(trade, postChecks) {
  let best = trade.peak_multiplier || 1.0;
  if (postChecks) {
    const sellMult = 1 + (trade.pnl_pct || 0) / 100.0;
    const liqChecks = postChecks.filter(c => c.liquidity_usd > MIN_LIQ_USD);
    if (liqChecks.length > 0) {
      const maxPost = Math.max(...liqChecks.map(c => c.multiplier_vs_sell));
      if (maxPost > 0 && maxPost < 1000) {
        const truePost = sellMult * maxPost;
        if (truePost > best) best = truePost;
      }
    }
  }
  return best;
}

function simulate(trades, tp, trail, sl) {
  const slMult = 1 - sl;
  let totalPnl = 0, wins = 0, losses = 0;

  for (const t of trades) {
    const exit = t.exit_reason || '';
    let pnl;

    if (RUG_EXITS.includes(exit) || exit.startsWith('stranded')) {
      const peak = t.peak_multiplier || 1.0;
      pnl = peak >= tp ? (tp - 1) * 100 : t.pnl_pct;
    } else if (EARLY_EXITS.includes(exit)) {
      pnl = t.pnl_pct;
    } else if (!t.truePeak || t.truePeak <= 0) {
      pnl = t.pnl_pct;
    } else if (t.truePeak >= tp) {
      pnl = (tp - 1) * 100;
    } else {
      const trailExit = Math.max(t.truePeak * (1 - trail), slMult);
      pnl = (trailExit - 1) * 100;
    }

    totalPnl += pnl || 0;
    if ((pnl || 0) > 0) wins++; else losses++;
  }

  return { totalPnl, wins, losses, avgPnl: totalPnl / trades.length, winRate: wins / trades.length * 100 };
}

// Load data
const trades = loadTrades();
const ptcMap = loadPostTradeChecks();
for (const t of trades) {
  t.truePeak = calcTruePeak(t, ptcMap[t.id]);
}

console.log(`\nGrid search over N=${trades.length} trades\n`);

// Grid search
const tps = [1.10, 1.15, 1.20, 1.25, 1.30, 1.35, 1.40, 1.50, 1.75, 2.00];
const trails = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30];
const sls = [0.20, 0.25, 0.30, 0.35, 0.40];

let results = [];

for (const tp of tps) {
  for (const trail of trails) {
    for (const sl of sls) {
      const r = simulate(trades, tp, trail, sl);
      results.push({ tp, trail, sl, ...r });
    }
  }
}

// Sort by total PnL
results.sort((a, b) => b.totalPnl - a.totalPnl);

console.log('=== TOP 30 STRATEGIES (by total PnL%) ===\n');
console.log('Rank | TP     | Trail% | SL%    | Total PnL% | Avg/Trade% | Wins | Losses | WinRate');
console.log('-'.repeat(95));

for (let i = 0; i < 30; i++) {
  const r = results[i];
  console.log(
    `${String(i + 1).padStart(4)} | ${r.tp.toFixed(2)}x | ${(r.trail * 100).toFixed(0).padStart(5)}% | ${(r.sl * 100).toFixed(0).padStart(5)}% | ` +
    `${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(1).padStart(10)}% | ` +
    `${(r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2).padStart(9)}% | ` +
    `${String(r.wins).padStart(4)} | ${String(r.losses).padStart(6)} | ${r.winRate.toFixed(1)}%`
  );
}

console.log('\n\n=== BEST STRATEGY PER TP LEVEL ===\n');
for (const tp of tps) {
  const best = results.filter(r => r.tp === tp).sort((a, b) => b.totalPnl - a.totalPnl)[0];
  const marker = best.totalPnl > 0 ? ' *** POSITIVE ***' : '';
  console.log(
    `TP ${tp.toFixed(2)}x | Trail ${(best.trail * 100).toFixed(0).padStart(2)}% | SL ${(best.sl * 100).toFixed(0).padStart(2)}% | ` +
    `PnL ${(best.totalPnl >= 0 ? '+' : '') + best.totalPnl.toFixed(1).padStart(8)}% | ` +
    `Avg ${(best.avgPnl >= 0 ? '+' : '') + best.avgPnl.toFixed(2).padStart(6)}% | ` +
    `WR ${best.winRate.toFixed(1).padStart(5)}%${marker}`
  );
}

// Show the transition: at what TP does PnL go positive?
console.log('\n\n=== PROFITABILITY FRONTIER (min TP where PnL > 0 for each trail/SL) ===\n');
for (const trail of [0.05, 0.08, 0.10, 0.12, 0.15]) {
  for (const sl of [0.25, 0.30, 0.35, 0.40]) {
    let firstPositive = null;
    for (const tp of tps) {
      const r = results.find(x => x.tp === tp && x.trail === trail && x.sl === sl);
      if (r && r.totalPnl > 0 && !firstPositive) {
        firstPositive = r;
        break;
      }
    }
    if (firstPositive) {
      console.log(`Trail ${(trail * 100).toFixed(0).padStart(2)}% + SL ${(sl * 100).toFixed(0).padStart(2)}% -> profitable at TP ${firstPositive.tp.toFixed(2)}x (PnL: +${firstPositive.totalPnl.toFixed(1)}%, WR: ${firstPositive.winRate.toFixed(1)}%)`);
    } else {
      console.log(`Trail ${(trail * 100).toFixed(0).padStart(2)}% + SL ${(sl * 100).toFixed(0).padStart(2)}% -> NEVER PROFITABLE in tested range`);
    }
  }
}

// V11x-only analysis (most recent, most relevant)
console.log('\n\n=== V11x-ONLY ANALYSIS (N=' + trades.filter(t => t.bot_version === 'v11x').length + ') ===\n');
const v11xTrades = trades.filter(t => t.bot_version === 'v11x');
if (v11xTrades.length >= 5) {
  const v11xResults = [];
  for (const tp of [1.20, 1.30, 1.50, 2.00]) {
    for (const trail of [0.05, 0.10, 0.15, 0.20]) {
      const r = simulate(v11xTrades, tp, trail, 0.30);
      v11xResults.push({ tp, trail, ...r });
    }
  }
  v11xResults.sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('TP     | Trail% | Total PnL% | Avg/Trade% | WR');
  console.log('-'.repeat(60));
  for (const r of v11xResults) {
    console.log(
      `${r.tp.toFixed(2)}x | ${(r.trail * 100).toFixed(0).padStart(5)}% | ` +
      `${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(1).padStart(10)}% | ` +
      `${(r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2).padStart(9)}% | ${r.winRate.toFixed(1)}%`
    );
  }
}

// Versions with higher TP (v11v+) analysis
console.log('\n\n=== V11v+ ANALYSIS (N=' + trades.filter(t => t.bot_version >= 'v11v').length + ', versions with TP >= 1.20x) ===\n');
const recentTrades = trades.filter(t => t.bot_version >= 'v11v');
if (recentTrades.length >= 5) {
  const recentResults = [];
  for (const tp of [1.20, 1.30, 1.50, 2.00]) {
    for (const trail of [0.05, 0.10, 0.15, 0.20]) {
      const r = simulate(recentTrades, tp, trail, 0.30);
      recentResults.push({ tp, trail, ...r });
    }
  }
  recentResults.sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('TP     | Trail% | Total PnL% | Avg/Trade% | Wins | Losses | WR');
  console.log('-'.repeat(75));
  for (const r of recentResults) {
    console.log(
      `${r.tp.toFixed(2)}x | ${(r.trail * 100).toFixed(0).padStart(5)}% | ` +
      `${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(1).padStart(10)}% | ` +
      `${(r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2).padStart(9)}% | ` +
      `${String(r.wins).padStart(4)} | ${String(r.losses).padStart(6)} | ${r.winRate.toFixed(1)}%`
    );
  }
}

db.close();
