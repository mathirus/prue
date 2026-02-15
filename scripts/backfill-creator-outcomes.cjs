#!/usr/bin/env node
/**
 * v11o-data: Backfill token_creators.outcome from positions data.
 *
 * Currently 96% of token_creators.outcome is 'unknown'.
 * This script joins positions (which have pnl_pct and exit_reason) with
 * token_creators (which have token_mint) to label outcomes.
 *
 * Labels:
 * - 'rug': exit_reason contains 'rug' OR pnl_pct <= -25%
 * - 'winner': pnl_pct > 0
 * - 'loser': pnl_pct <= 0 AND pnl_pct > -25% AND not rug
 * - 'breakeven': pnl_pct between -2% and 2%
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');

console.log('Backfilling token_creators.outcome from positions data...\n');

// First, show current state
const before = db.prepare(`
  SELECT outcome, COUNT(*) as cnt FROM token_creators GROUP BY outcome ORDER BY cnt DESC
`).all();
console.log('Before:');
before.forEach(r => console.log(`  ${r.outcome}: ${r.cnt}`));
console.log();

// Backfill: rug (exit_reason contains 'rug' or severe loss)
const rugResult = db.prepare(`
  UPDATE token_creators SET outcome = 'rug', pnl_pct = (
    SELECT p.pnl_pct FROM positions p WHERE p.token_mint = token_creators.token_mint
    AND p.status IN ('closed', 'stopped') ORDER BY p.opened_at DESC LIMIT 1
  )
  WHERE outcome = 'unknown'
  AND token_mint IN (
    SELECT p.token_mint FROM positions p
    WHERE p.status IN ('closed', 'stopped')
    AND (p.exit_reason LIKE '%rug%' OR p.pnl_pct <= -25)
  )
`).run();
console.log(`Labeled ${rugResult.changes} as 'rug'`);

// Backfill: winner (positive pnl)
const winResult = db.prepare(`
  UPDATE token_creators SET outcome = 'winner', pnl_pct = (
    SELECT p.pnl_pct FROM positions p WHERE p.token_mint = token_creators.token_mint
    AND p.status IN ('closed', 'stopped') ORDER BY p.opened_at DESC LIMIT 1
  )
  WHERE outcome = 'unknown'
  AND token_mint IN (
    SELECT p.token_mint FROM positions p
    WHERE p.status IN ('closed', 'stopped')
    AND p.pnl_pct > 2
  )
`).run();
console.log(`Labeled ${winResult.changes} as 'winner'`);

// Backfill: breakeven (-2% to 2%)
const beResult = db.prepare(`
  UPDATE token_creators SET outcome = 'breakeven', pnl_pct = (
    SELECT p.pnl_pct FROM positions p WHERE p.token_mint = token_creators.token_mint
    AND p.status IN ('closed', 'stopped') ORDER BY p.opened_at DESC LIMIT 1
  )
  WHERE outcome = 'unknown'
  AND token_mint IN (
    SELECT p.token_mint FROM positions p
    WHERE p.status IN ('closed', 'stopped')
    AND p.pnl_pct > -2 AND p.pnl_pct <= 2
  )
`).run();
console.log(`Labeled ${beResult.changes} as 'breakeven'`);

// Backfill: loser (negative pnl, not rug)
const loseResult = db.prepare(`
  UPDATE token_creators SET outcome = 'loser', pnl_pct = (
    SELECT p.pnl_pct FROM positions p WHERE p.token_mint = token_creators.token_mint
    AND p.status IN ('closed', 'stopped') ORDER BY p.opened_at DESC LIMIT 1
  )
  WHERE outcome = 'unknown'
  AND token_mint IN (
    SELECT p.token_mint FROM positions p
    WHERE p.status IN ('closed', 'stopped')
    AND p.pnl_pct <= -2 AND p.pnl_pct > -25
  )
`).run();
console.log(`Labeled ${loseResult.changes} as 'loser'`);

console.log();

// Show after state
const after = db.prepare(`
  SELECT outcome, COUNT(*) as cnt FROM token_creators GROUP BY outcome ORDER BY cnt DESC
`).all();
console.log('After:');
after.forEach(r => console.log(`  ${r.outcome}: ${r.cnt}`));

db.close();
console.log('\nDone!');
