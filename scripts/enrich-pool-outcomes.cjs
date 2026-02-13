/**
 * Enrich detected_pools with actual outcomes (rug vs survivor).
 * Checks current pool state for all detected pools to determine if they rugged.
 * This gives us 3000+ training samples instead of ~168.
 *
 * Usage: node scripts/enrich-pool-outcomes.cjs [--limit 100]
 */

const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const DB_PATH = path.resolve(__dirname, '..', 'data', 'bot.db');
const RPC_URL = process.env.RPC_URL || process.env.HELIUS_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || '');

const BATCH_SIZE = 100; // getMultipleAccountsInfo limit
const DELAY_MS = 500; // Between batches to avoid rate limit

async function main() {
  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0;

  const db = new Database(DB_PATH);
  const connection = new Connection(RPC_URL, 'confirmed');

  // Add outcome columns if they don't exist
  const cols = db.prepare('PRAGMA table_info(detected_pools)').all().map(c => c.name);
  if (!cols.includes('pool_outcome')) {
    db.exec(`ALTER TABLE detected_pools ADD COLUMN pool_outcome TEXT`); // 'rug', 'survivor', 'unknown'
    db.exec(`ALTER TABLE detected_pools ADD COLUMN current_sol_reserves INTEGER`);
    db.exec(`ALTER TABLE detected_pools ADD COLUMN checked_at INTEGER`);
    console.log('Added outcome columns to detected_pools');
  }

  // Add individual feature columns for ML training (dp_ prefix to avoid collision with token_analysis joins)
  const featureCols = [
    ['dp_liquidity_usd', 'REAL'],
    ['dp_holder_count', 'INTEGER'],
    ['dp_top_holder_pct', 'REAL'],
    ['dp_honeypot_verified', 'INTEGER'],
    ['dp_mint_auth_revoked', 'INTEGER'],
    ['dp_freeze_auth_revoked', 'INTEGER'],
    ['dp_rugcheck_score', 'REAL'],
    ['dp_lp_burned', 'INTEGER'],
  ];
  for (const [colName, colType] of featureCols) {
    if (!cols.includes(colName)) {
      try {
        db.exec(`ALTER TABLE detected_pools ADD COLUMN ${colName} ${colType}`);
      } catch { /* already exists */ }
    }
  }

  // Backfill: copy features from token_analysis into detected_pools for existing records
  const backfillCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM detected_pools dp
    INNER JOIN token_analysis ta ON dp.base_mint = ta.token_mint
    WHERE dp.dp_liquidity_usd IS NULL AND ta.liquidity_usd IS NOT NULL
  `).get();
  if (backfillCount && backfillCount.cnt > 0) {
    console.log(`Backfilling ${backfillCount.cnt} detected_pools with features from token_analysis...`);
    db.prepare(`
      UPDATE detected_pools SET
        dp_liquidity_usd = (SELECT ta.liquidity_usd FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_holder_count = (SELECT ta.holder_count FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_top_holder_pct = (SELECT ta.top_holder_pct FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_honeypot_verified = (SELECT ta.honeypot_verified FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_mint_auth_revoked = (SELECT ta.mint_authority_revoked FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_freeze_auth_revoked = (SELECT ta.freeze_authority_revoked FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_rugcheck_score = (SELECT ta.rugcheck_score FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1),
        dp_lp_burned = (SELECT ta.lp_burned FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint LIMIT 1)
      WHERE dp_liquidity_usd IS NULL
        AND EXISTS (SELECT 1 FROM token_analysis ta WHERE ta.token_mint = detected_pools.base_mint AND ta.liquidity_usd IS NOT NULL)
    `).run();
    console.log('Backfill complete.');
  }

  // Get pools that haven't been checked yet
  let query = `SELECT id, pool_address, base_mint, security_score, security_passed, rejection_reasons
               FROM detected_pools
               WHERE pool_outcome IS NULL AND pool_address IS NOT NULL`;
  if (limit > 0) query += ` LIMIT ${limit}`;

  const pools = db.prepare(query).all();
  console.log(`Found ${pools.length} pools to check`);

  const updateStmt = db.prepare(`
    UPDATE detected_pools
    SET pool_outcome = ?, current_sol_reserves = ?, checked_at = ?
    WHERE id = ?
  `);

  let rugs = 0, survivors = 0, unknown = 0, errors = 0;

  // Process in batches
  for (let i = 0; i < pools.length; i += BATCH_SIZE) {
    const batch = pools.slice(i, i + BATCH_SIZE);
    const poolKeys = batch.map(p => {
      try { return new PublicKey(p.pool_address); }
      catch { return null; }
    });

    try {
      const validKeys = poolKeys.filter(k => k !== null);
      const accounts = await connection.getMultipleAccountsInfo(validKeys);

      let keyIdx = 0;
      for (let j = 0; j < batch.length; j++) {
        const pool = batch[j];
        if (!poolKeys[j]) {
          updateStmt.run('unknown', 0, Date.now(), pool.id);
          unknown++;
          continue;
        }

        const account = accounts[keyIdx++];
        if (!account || !account.data || account.data.length < 200) {
          // Pool account closed or doesn't exist = likely rug
          updateStmt.run('rug', 0, Date.now(), pool.id);
          rugs++;
          continue;
        }

        // Read SOL reserves from pool account data
        // PumpSwap pool layout: base_reserve at offset 128 (u64), quote_reserve at offset 136 (u64)
        try {
          const data = account.data;
          const baseReserve = Number(data.readBigUInt64LE(128));
          const quoteReserve = Number(data.readBigUInt64LE(136));

          // For PumpSwap pools, one of these is SOL (WSOL)
          // SOL reserve > 1 SOL = survivor, < 0.1 SOL = rug
          const solReserve = Math.max(baseReserve, quoteReserve); // SOL is usually the larger number in lamports
          const solAmount = solReserve / 1e9;

          let outcome;
          if (solAmount < 0.5) {
            outcome = 'rug';
            rugs++;
          } else if (solAmount >= 2) {
            outcome = 'survivor';
            survivors++;
          } else {
            outcome = 'unknown'; // Between 0.5 and 2 SOL, ambiguous
            unknown++;
          }

          updateStmt.run(outcome, Math.round(solReserve), Date.now(), pool.id);
        } catch (parseErr) {
          updateStmt.run('unknown', 0, Date.now(), pool.id);
          unknown++;
        }
      }
    } catch (rpcErr) {
      console.error(`Batch ${i}-${i+BATCH_SIZE} RPC error:`, rpcErr.message?.slice(0, 100));
      errors += batch.length;
      // Mark batch as unknown
      for (const pool of batch) {
        updateStmt.run('unknown', 0, Date.now(), pool.id);
      }
    }

    if (i % 500 === 0 && i > 0) {
      console.log(`Progress: ${i}/${pools.length} (rugs: ${rugs}, survivors: ${survivors}, unknown: ${unknown})`);
    }

    // Rate limit
    if (i + BATCH_SIZE < pools.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log('\n=== RESULTS ===');
  console.log(`Total checked: ${pools.length}`);
  console.log(`Rugs: ${rugs} (${((rugs/pools.length)*100).toFixed(1)}%)`);
  console.log(`Survivors: ${survivors} (${((survivors/pools.length)*100).toFixed(1)}%)`);
  console.log(`Unknown: ${unknown} (${((unknown/pools.length)*100).toFixed(1)}%)`);
  console.log(`Errors: ${errors}`);

  // Summary by security_passed
  const summary = db.prepare(`
    SELECT security_passed, pool_outcome, COUNT(*) as count
    FROM detected_pools WHERE pool_outcome IS NOT NULL
    GROUP BY security_passed, pool_outcome
    ORDER BY security_passed, pool_outcome
  `).all();

  console.log('\n=== BY SECURITY SCORE ===');
  console.log('Passed | Outcome | Count');
  summary.forEach(r => console.log(`  ${r.security_passed}    | ${(r.pool_outcome||'?').padEnd(10)} | ${r.count}`));

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
