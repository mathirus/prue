#!/usr/bin/env node
/**
 * Investigates what the creator wallet does BEFORE and DURING a rug pull
 * Goal: Find if there's a detectable signal before the drain
 */
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const Database = require('better-sqlite3');
const path = require('path');

const conn = new Connection(process.env.RPC_URL);
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

async function investigateCreatorDrain(tokenMint, label) {
  console.log(`\n${'='.repeat(100)}`);
  console.log(`  ${label}`);
  console.log(`  Token: ${tokenMint}`);
  console.log('='.repeat(100));

  // 1. Find creator wallet from DB
  const creator = db.prepare(
    "SELECT creator_wallet, funding_source, wallet_age_seconds, tx_count FROM token_creators WHERE token_mint = ?"
  ).get(tokenMint);

  if (!creator) {
    console.log('  Creator wallet NOT in DB');
    return;
  }

  console.log(`  Creator: ${creator.creator_wallet}`);
  console.log(`  Funding source: ${creator.funding_source || 'unknown'}`);
  console.log(`  Wallet age: ${creator.wallet_age_seconds}s, TX count: ${creator.tx_count}`);

  // 2. Find pool address
  const pool = db.prepare(
    "SELECT pool_address, detected_at FROM detected_pools WHERE base_mint = ? LIMIT 1"
  ).get(tokenMint);

  if (!pool) {
    console.log('  Pool NOT in DB');
    return;
  }

  console.log(`  Pool: ${pool.pool_address}`);
  console.log(`  Detected at: ${new Date(pool.detected_at).toISOString()}`);

  // 3. Find position info (when we bought/sold)
  const pos = db.prepare(
    "SELECT opened_at, closed_at, exit_reason, pnl_pct, peak_multiplier, sell_attempts, sell_successes FROM positions WHERE token_mint = ? LIMIT 1"
  ).get(tokenMint);

  if (pos) {
    const holdTime = pos.closed_at ? ((pos.closed_at - pos.opened_at) / 1000).toFixed(0) : '?';
    console.log(`  Position: opened=${new Date(pos.opened_at).toISOString()}, held=${holdTime}s`);
    console.log(`  Exit: ${pos.exit_reason} | pnl=${pos.pnl_pct ? pos.pnl_pct.toFixed(1) : '?'}% | peak=${pos.peak_multiplier ? pos.peak_multiplier.toFixed(2) : '?'}x | sells=${pos.sell_attempts}/${pos.sell_successes}`);
  }

  // 4. Get creator wallet transactions around the time of the rug
  console.log(`\n  --- CREATOR WALLET ACTIVITY ---`);
  try {
    const creatorPk = new PublicKey(creator.creator_wallet);
    const sigs = await conn.getSignaturesForAddress(creatorPk, { limit: 30 });

    if (sigs.length === 0) {
      console.log('  No transactions found for creator wallet');
      return;
    }

    // Show timeline
    const detectedTime = pool.detected_at / 1000; // convert to seconds
    const openedTime = pos ? pos.opened_at / 1000 : detectedTime;
    const closedTime = pos && pos.closed_at ? pos.closed_at / 1000 : openedTime + 60;

    console.log(`  Timeline reference:`);
    console.log(`    Pool detected: T=0`);
    console.log(`    We bought: T+${((openedTime - detectedTime)).toFixed(0)}s`);
    if (pos && pos.closed_at) {
      console.log(`    Position closed: T+${((closedTime - detectedTime)).toFixed(0)}s`);
    }

    console.log(`\n  Creator transactions (relative to pool detection):`);

    for (const sig of sigs) {
      const relTime = sig.blockTime - detectedTime;
      const relLabel = relTime >= 0 ? `T+${relTime.toFixed(0)}s` : `T${relTime.toFixed(0)}s`;
      const status = sig.err ? 'FAILED' : 'OK';

      // Mark interesting time windows
      let marker = '';
      if (relTime >= -10 && relTime <= 0) marker = ' ← BEFORE POOL';
      if (relTime >= 0 && relTime <= 5) marker = ' ← POOL CREATION WINDOW';
      if (pos && relTime >= (openedTime - detectedTime) && relTime <= (closedTime - detectedTime)) marker = ' ← WHILE WE HELD';
      if (pos && pos.closed_at && Math.abs(relTime - (closedTime - detectedTime)) < 5) marker = ' ← AROUND RUG TIME';

      console.log(`    ${relLabel.padStart(8)} | ${status.padEnd(6)} | ${sig.signature.substring(0, 30)}...${marker}`);
    }

    // 5. Inspect the likely drain transaction (around when our sell failed)
    if (pos && pos.closed_at) {
      console.log(`\n  --- DRAIN TRANSACTION ANALYSIS ---`);
      // Find TX closest to when we got rugged
      const rugTime = closedTime;
      let closestSig = null;
      let closestDiff = Infinity;

      for (const sig of sigs) {
        const diff = Math.abs(sig.blockTime - rugTime);
        if (diff < closestDiff && !sig.err) {
          closestDiff = diff;
          closestSig = sig;
        }
      }

      if (closestSig) {
        console.log(`  Closest creator TX to rug: ${closestSig.signature.substring(0, 40)}...`);
        console.log(`  Time diff from rug: ${(closestSig.blockTime - rugTime).toFixed(0)}s`);

        try {
          const tx = await conn.getParsedTransaction(closestSig.signature, { maxSupportedTransactionVersion: 0 });
          if (tx) {
            // Check what programs were called
            const instructions = tx.transaction.message.instructions;
            console.log(`  Instructions in drain TX:`);
            for (const ix of instructions) {
              if (ix.programId) {
                const prog = ix.programId.toBase58();
                const progName =
                  prog === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' ? 'PumpSwap AMM' :
                  prog === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? 'SPL Token' :
                  prog === '11111111111111111111111111111111' ? 'System' :
                  prog === 'ComputeBudget111111111111111111111111111111' ? 'ComputeBudget' :
                  prog;
                const ixName = ix.parsed ? ix.parsed.type : (ix.data ? 'raw' : '?');
                console.log(`    ${progName} -> ${ixName}`);
              }
            }

            // Check SOL balance changes
            if (tx.meta) {
              const preBalances = tx.meta.preBalances;
              const postBalances = tx.meta.postBalances;
              const accounts = tx.transaction.message.accountKeys;

              console.log(`  SOL balance changes:`);
              for (let i = 0; i < Math.min(accounts.length, 5); i++) {
                const change = (postBalances[i] - preBalances[i]) / 1e9;
                if (Math.abs(change) > 0.001) {
                  const addr = accounts[i].pubkey ? accounts[i].pubkey.toBase58() : accounts[i].toBase58();
                  const isCreator = addr === creator.creator_wallet;
                  console.log(`    ${addr.substring(0, 20)}... ${change > 0 ? '+' : ''}${change.toFixed(4)} SOL ${isCreator ? '← CREATOR' : ''}`);
                }
              }

              // Log messages
              const logs = tx.meta.logMessages || [];
              const interestingLogs = logs.filter(l =>
                l.includes('Instruction:') || l.includes('withdraw') || l.includes('remove') ||
                l.includes('Sell') || l.includes('Buy') || l.includes('swap')
              );
              if (interestingLogs.length > 0) {
                console.log(`  Relevant logs:`);
                interestingLogs.forEach(l => console.log(`    ${l}`));
              }
            }
          }
        } catch (e) {
          console.log(`  Error parsing drain TX: ${e.message.substring(0, 80)}`);
        }
      }
    }

  } catch (e) {
    console.log(`  Error: ${e.message.substring(0, 100)}`);
  }

  await new Promise(r => setTimeout(r, 1000));
}

async function main() {
  console.log('CREATOR DRAIN PATTERN INVESTIGATION');
  console.log('Goal: Find if creators show detectable activity BEFORE draining\n');

  // Recent rug pulls where we have creator data
  const rugs = db.prepare(`
    SELECT p.token_mint, p.exit_reason, p.pnl_pct, p.peak_multiplier, p.sell_attempts, p.sell_successes
    FROM positions p
    WHERE p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%'
    ORDER BY p.opened_at DESC
    LIMIT 8
  `).all();

  for (const rug of rugs) {
    const label = `${rug.exit_reason} | pnl=${(rug.pnl_pct||0).toFixed(0)}% | peak=${(rug.peak_multiplier||0).toFixed(2)}x | sells=${rug.sell_attempts}/${rug.sell_successes}`;
    await investigateCreatorDrain(rug.token_mint, label);
  }

  console.log('\n' + '='.repeat(100));
  console.log('  INVESTIGATION COMPLETE');
  console.log('='.repeat(100));

  db.close();
}

main().catch(console.error);
