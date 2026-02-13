/**
 * Backfill creator deep profiles for historical token_creators.
 * Traces funding source for each creator and identifies scammer clusters.
 *
 * Usage: node scripts/backfill-creator-profiles.cjs
 */

const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');
const path = require('path');
require('dotenv').config();

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

async function traceFundingSource(connection, walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 10 });
    if (sigs.length === 0) return { funder: null, age: 0, txCount: 0, balance: 0 };

    const now = Math.floor(Date.now() / 1000);
    const oldest = sigs[sigs.length - 1];
    const age = oldest.blockTime ? now - oldest.blockTime : 0;

    // Get balance
    const balance = await connection.getBalance(pubkey);

    // Trace funder from oldest TX
    let funder = null;
    try {
      const tx = await connection.getParsedTransaction(oldest.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta && tx.transaction.message.accountKeys) {
        const keys = tx.transaction.message.accountKeys.map(k =>
          typeof k === 'string' ? k : k.pubkey.toBase58()
        );
        let maxDrop = 0;
        let funderIdx = -1;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i] === walletAddress) continue;
          const drop = tx.meta.preBalances[i] - tx.meta.postBalances[i];
          if (drop > maxDrop) {
            maxDrop = drop;
            funderIdx = i;
          }
        }
        if (funderIdx >= 0 && maxDrop > 10000) {
          funder = keys[funderIdx];
        }
      }
    } catch { /* ignore individual TX errors */ }

    return { funder, age, txCount: sigs.length, balance };
  } catch (err) {
    console.error(`  Error tracing ${walletAddress.slice(0, 8)}...: ${err.message?.slice(0, 80)}`);
    return { funder: null, age: -1, txCount: -1, balance: 0 };
  }
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const connection = new Connection(RPC_URL, 'confirmed');

  // Get all unique creators without funding_source
  const creators = db.prepare(`
    SELECT DISTINCT creator_wallet FROM token_creators
    WHERE funding_source IS NULL
    ORDER BY created_at ASC
  `).all();

  console.log(`Found ${creators.length} creators to backfill\n`);

  const updateStmt = db.prepare(`
    UPDATE token_creators
    SET funding_source = ?, wallet_age_seconds = ?, tx_count = ?, sol_balance_lamports = ?
    WHERE creator_wallet = ?
  `);

  let processed = 0;
  let withFunder = 0;

  for (const { creator_wallet } of creators) {
    const { funder, age, txCount, balance } = await traceFundingSource(connection, creator_wallet);

    updateStmt.run(funder, age, txCount, balance, creator_wallet);
    processed++;
    if (funder) withFunder++;

    console.log(`[${processed}/${creators.length}] ${creator_wallet.slice(0, 8)}... funder=${funder?.slice(0, 8) ?? 'N/A'} age=${age}s txs=${txCount} bal=${(balance / 1e9).toFixed(3)}`);

    // Rate limit: 200ms between requests to avoid 429
    await new Promise(r => setTimeout(r, 200));
  }

  // Analyze clusters
  console.log('\n=== FUNDING SOURCE CLUSTERS ===\n');
  const clusters = db.prepare(`
    SELECT funding_source, COUNT(DISTINCT creator_wallet) as creator_count,
           SUM(CASE WHEN outcome = 'rug' THEN 1 ELSE 0 END) as rug_count,
           SUM(CASE WHEN outcome = 'winner' THEN 1 ELSE 0 END) as win_count
    FROM token_creators
    WHERE funding_source IS NOT NULL
    GROUP BY funding_source
    HAVING creator_count >= 2
    ORDER BY rug_count DESC, creator_count DESC
  `).all();

  for (const c of clusters) {
    const rugPct = c.creator_count > 0 ? ((c.rug_count / c.creator_count) * 100).toFixed(0) : '0';
    console.log(`Funder ${c.funding_source.slice(0, 12)}... → ${c.creator_count} creators, ${c.rug_count} rugs (${rugPct}%), ${c.win_count} wins`);
  }

  console.log(`\nDone: ${processed} processed, ${withFunder} with funding source, ${clusters.length} clusters found`);
  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
