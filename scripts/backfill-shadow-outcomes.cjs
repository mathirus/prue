#!/usr/bin/env node
/**
 * backfill-shadow-outcomes.cjs — Fix shadow positions with missing outcomes
 *
 * Shadow positions in data-only mode (live trading) never get price updates,
 * so rug_detected/tp1_hit/etc are always 0. This script backfills the rug label
 * from detected_pools.pool_outcome (set by DexScreener checks).
 *
 * Safe to run multiple times — skips already-backfilled rows.
 *
 * Usage: node scripts/backfill-shadow-outcomes.cjs
 *        node scripts/backfill-shadow-outcomes.cjs --dry-run
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH, { readonly: dryRun });

// Show current state
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN rug_detected > 0 THEN 1 ELSE 0 END) as with_rug,
    SUM(CASE WHEN total_polls > 0 THEN 1 ELSE 0 END) as with_polls,
    SUM(CASE WHEN exit_reason IN ('rug_backfill', 'survivor_backfill') THEN 1 ELSE 0 END) as already_backfilled
  FROM shadow_positions
`).get();

console.log('Shadow positions status BEFORE:');
console.log(`  Total: ${stats.total}`);
console.log(`  With rug_detected: ${stats.with_rug}`);
console.log(`  With price polls: ${stats.with_polls}`);
console.log(`  Already backfilled: ${stats.already_backfilled}`);

// Preview what would be updated
const preview = db.prepare(`
  SELECT
    dp.pool_outcome,
    COUNT(*) as n
  FROM shadow_positions sp
  JOIN detected_pools dp ON sp.pool_id = dp.id
  WHERE dp.pool_outcome IN ('rug', 'survivor')
    AND sp.total_polls = 0
    AND sp.exit_reason NOT IN ('rug_backfill', 'survivor_backfill')
  GROUP BY dp.pool_outcome
`).all();

console.log('\nWould backfill:');
let totalToUpdate = 0;
for (const p of preview) {
  console.log(`  ${p.pool_outcome}: ${p.n}`);
  totalToUpdate += p.n;
}
console.log(`  Total: ${totalToUpdate}`);

if (dryRun) {
  console.log('\n[DRY RUN] No changes made. Remove --dry-run to apply.');
  db.close();
  process.exit(0);
}

if (totalToUpdate === 0) {
  console.log('\nNothing to backfill — all shadow positions already labeled.');
  db.close();
  process.exit(0);
}

// Execute backfill
const result = db.prepare(`
  UPDATE shadow_positions SET
    rug_detected = CASE WHEN dp.pool_outcome = 'rug' THEN 1 ELSE 0 END,
    exit_reason = CASE
      WHEN dp.pool_outcome = 'rug' THEN 'rug_backfill'
      WHEN dp.pool_outcome = 'survivor' THEN 'survivor_backfill'
      ELSE exit_reason
    END
  FROM detected_pools dp
  WHERE shadow_positions.pool_id = dp.id
    AND dp.pool_outcome IN ('rug', 'survivor')
    AND shadow_positions.total_polls = 0
    AND shadow_positions.exit_reason NOT IN ('rug_backfill', 'survivor_backfill')
`).run();

console.log(`\nBackfilled ${result.changes} shadow positions.`);

// Verify
const after = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN rug_detected > 0 THEN 1 ELSE 0 END) as with_rug,
    SUM(CASE WHEN exit_reason = 'rug_backfill' THEN 1 ELSE 0 END) as rug_backfilled,
    SUM(CASE WHEN exit_reason = 'survivor_backfill' THEN 1 ELSE 0 END) as survivor_backfilled
  FROM shadow_positions
`).get();

console.log('\nShadow positions status AFTER:');
console.log(`  Total: ${after.total}`);
console.log(`  With rug_detected: ${after.with_rug}`);
console.log(`  Rug backfilled: ${after.rug_backfilled}`);
console.log(`  Survivor backfilled: ${after.survivor_backfilled}`);
console.log(`  Remaining unlabeled: ${after.total - after.rug_backfilled - after.survivor_backfilled}`);

db.close();
console.log('\nDone.');
