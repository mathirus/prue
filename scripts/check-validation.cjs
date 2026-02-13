#!/usr/bin/env node
/**
 * v9m: Validation mode checker — shows real PnL + virtual PnL (scaled to reference size).
 *
 * Virtual PnL formula:
 *   trade_pct = (actual_pnl + overhead) / buy_amount  // % gain excluding overhead
 *   virtual_pnl = (trade_pct * reference_size) - overhead
 *
 * Usage: node scripts/check-validation.cjs [--from "2026-02-11"]
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'bot.db');
const REFERENCE_SIZE_SOL = 0.05;  // What we'd trade with if validated
const OVERHEAD_SOL = 0.0024;       // ATA rent + TX fees (fixed per trade)

// Parse --from flag
const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;

try {
  const db = new Database(DB_PATH, { readonly: true });

  // Get closed positions from v9m
  let query = `
    SELECT id, token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct,
           exit_reason, security_score, opened_at, closed_at, bot_version,
           sell_attempts, sell_successes, peak_multiplier
    FROM positions
    WHERE status IN ('closed', 'stopped')
      AND bot_version >= 'v9m'
  `;
  const params = [];

  if (fromDate) {
    query += ` AND opened_at >= ?`;
    params.push(new Date(fromDate).getTime());
  }

  query += ` ORDER BY opened_at ASC`;

  const positions = db.prepare(query).all(...params);

  if (positions.length === 0) {
    console.log('\n📊 No v9m trades found yet. Start the bot and wait for trades.\n');
    process.exit(0);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  📊 VALIDATION MODE — v9m Results');
  console.log('═══════════════════════════════════════════════════════════\n');

  let totalRealPnl = 0;
  let totalVirtualPnl = 0;
  let wins = 0;
  let losses = 0;

  for (const pos of positions) {
    const realPnl = pos.pnl_sol ?? 0;
    totalRealPnl += realPnl;

    // Virtual PnL: scale the % gain to reference size
    const invested = pos.sol_invested ?? 0;
    let virtualPnl = 0;
    if (invested > 0) {
      // Get the raw trade % (add back overhead to see real performance)
      const tradePct = (realPnl + OVERHEAD_SOL) / invested;
      virtualPnl = (tradePct * REFERENCE_SIZE_SOL) - OVERHEAD_SOL;
    }
    totalVirtualPnl += virtualPnl;

    if (realPnl >= 0) wins++;
    else losses++;

    const mint = pos.token_mint?.slice(0, 8) ?? '???';
    const peak = pos.peak_multiplier ? `${pos.peak_multiplier.toFixed(2)}x` : '?';
    const exit = pos.exit_reason ?? '?';
    const sellOk = `${pos.sell_successes ?? 0}/${pos.sell_attempts ?? 0}`;
    const realStr = realPnl >= 0 ? `+${realPnl.toFixed(6)}` : realPnl.toFixed(6);
    const virtStr = virtualPnl >= 0 ? `+${virtualPnl.toFixed(6)}` : virtualPnl.toFixed(6);
    const date = pos.opened_at ? new Date(pos.opened_at).toLocaleTimeString() : '?';

    console.log(`  ${date} | ${mint}... | Peak ${peak} | Exit: ${exit} | Sells: ${sellOk}`);
    console.log(`         Real: ${realStr} SOL | Virtual (0.05): ${virtStr} SOL`);
    console.log('');
  }

  const winRate = positions.length > 0 ? ((wins / positions.length) * 100).toFixed(1) : '0';

  console.log('───────────────────────────────────────────────────────────');
  console.log(`  Trades: ${positions.length} | Win Rate: ${winRate}% (${wins}W/${losses}L)`);
  console.log(`  Real PnL:    ${totalRealPnl >= 0 ? '+' : ''}${totalRealPnl.toFixed(6)} SOL (@ 0.001 SOL/trade)`);
  console.log(`  Virtual PnL: ${totalVirtualPnl >= 0 ? '+' : ''}${totalVirtualPnl.toFixed(6)} SOL (@ 0.05 SOL/trade)`);
  console.log('');

  if (positions.length >= 15) {
    if (totalVirtualPnl > 0) {
      console.log('  ✅ VALIDATION PASSED — Virtual balance positive after 15+ trades');
      console.log('     → Ready to scale to 0.05 SOL/trade');
    } else {
      console.log('  ❌ VALIDATION FAILED — Virtual balance negative after 15+ trades');
      console.log('     → Need to improve strategy before scaling');
    }
  } else {
    console.log(`  ⏳ Need ${15 - positions.length} more trades for validation (target: 15)`);
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');

  db.close();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
