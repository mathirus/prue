#!/usr/bin/env node
const db = require('better-sqlite3')('data/bot.db');
require('dotenv').config();

// 1. Last 24h trades
const cutoff = Date.now() - 24 * 3600 * 1000;
const last24h = db.prepare(
  "SELECT COUNT(*) as n, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs, ROUND(SUM(pnl_sol), 6) as pnl, ROUND(AVG(pnl_sol), 6) as avg_pnl FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?"
).get(cutoff);
console.log('\n=== LAST 24h ===');
console.log(JSON.stringify(last24h, null, 2));

// 2. Recent 15 trades
const recent = db.prepare(
  "SELECT id, substr(token_mint,1,8) as tok, status, ROUND(pnl_sol,6) as pnl, ROUND(pnl_pct,1) as pct, exit_reason, sell_attempts, sell_successes, datetime(opened_at/1000, 'unixepoch', 'localtime') as opened FROM positions ORDER BY opened_at DESC LIMIT 15"
).all();
console.log('\n=== RECENT 15 TRADES ===');
recent.forEach(r => console.log(`${r.opened} | ${r.tok}... | ${r.status} | ${r.pnl} SOL | ${r.pct}% | ${r.exit_reason || '-'} | sells: ${r.sell_attempts}/${r.sell_successes}`));

// 3. All-time stats
const allTime = db.prepare(
  "SELECT COUNT(*) as total, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs, ROUND(SUM(pnl_sol), 6) as pnl, ROUND(AVG(pnl_sol), 6) as avg_pnl FROM positions WHERE status IN ('closed','stopped')"
).get();
console.log('\n=== ALL TIME ===');
console.log(JSON.stringify(allTime, null, 2));

// 4. Open positions
const open = db.prepare(
  "SELECT id, substr(token_mint,1,8) as tok, status, ROUND(pnl_sol,6) as pnl, ROUND(pnl_pct,1) as pct, datetime(opened_at/1000, 'unixepoch', 'localtime') as opened FROM positions WHERE status IN ('open','partial_close')"
).all();
console.log('\n=== OPEN POSITIONS ===');
if (open.length === 0) console.log('(none)');
open.forEach(r => console.log(`${r.opened} | ${r.tok}... | ${r.status} | ${r.pnl} SOL | ${r.pct}%`));

// 5. Last 6h by hour
console.log('\n=== LAST 6h BY HOUR ===');
for (let h = 0; h < 6; h++) {
  const from = Date.now() - (h + 1) * 3600000;
  const to = Date.now() - h * 3600000;
  const row = db.prepare(
    "SELECT COUNT(*) as n, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins, ROUND(SUM(pnl_sol), 6) as pnl FROM positions WHERE status IN ('closed','stopped') AND opened_at BETWEEN ? AND ?"
  ).get(from, to);
  const label = h === 0 ? 'this hour' : `${h}h ago`;
  console.log(`${label}: ${row.n} trades, ${row.wins || 0} wins, ${row.pnl || 0} SOL`);
}

// 6. v8l specific - graduation timing, insiders, wash trading data
const v8lData = db.prepare(
  "SELECT COUNT(*) as n, SUM(CASE WHEN dp_graduation_time_s IS NOT NULL THEN 1 ELSE 0 END) as has_grad, SUM(CASE WHEN dp_insiders_count IS NOT NULL THEN 1 ELSE 0 END) as has_insiders FROM detected_pools WHERE detected_at > ?"
).get(cutoff);
console.log('\n=== v8l DATA COLLECTION (24h) ===');
console.log(JSON.stringify(v8lData, null, 2));

// 7. Balance check - check if compiled code exists
const fs = require('fs');
const compiled = fs.existsSync('dist/index.js');
const lockExists = fs.existsSync('.bot.lock');
console.log('\n=== BOT STATUS ===');
console.log('Compiled (dist/index.js):', compiled);
console.log('Lock file (.bot.lock):', lockExists);
if (lockExists) {
  const pid = fs.readFileSync('.bot.lock', 'utf8').trim();
  console.log('PID:', pid);
}

db.close();
