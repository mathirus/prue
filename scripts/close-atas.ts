/**
 * Close empty and dust token accounts to recover rent (~0.002 SOL each).
 *
 * - Burns any remaining token balance (dust from rugs/moon bags)
 * - Closes the ATA to recover rent back to wallet
 * - Skips frozen Token-2022 accounts (scam airdrops, can't close)
 * - Batches multiple burn+close ops per TX for efficiency
 *
 * Usage: node --env-file=.env dist/scripts/close-atas.js [--dry-run]
 */
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createBurnInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Wallet } from '../src/core/wallet.js';

const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Max instructions per TX (burn+close = 2 per ATA, keep under CU limit)
const BATCH_SIZE = 10;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const conn = new Connection(process.env.RPC_URL!);
  const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY!);
  const owner = wallet.publicKey;

  console.log(`Wallet: ${owner.toBase58()}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no TXs sent)' : 'LIVE'}\n`);

  // Fetch all token accounts for both programs
  const [splAccounts, t22Accounts] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
  ]);

  const allAccounts = [
    ...splAccounts.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t22Accounts.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM })),
  ];

  console.log(`Found ${allAccounts.length} token accounts (SPL: ${splAccounts.value.length}, T22: ${t22Accounts.value.length})\n`);

  // Filter closable accounts
  const closable: Array<{
    ata: PublicKey;
    mint: PublicKey;
    balance: bigint;
    decimals: number;
    rent: number;
    programId: PublicKey;
  }> = [];

  let skippedFrozen = 0;
  let skippedWsol = 0;

  for (const acc of allAccounts) {
    const info = acc.account.data.parsed.info;
    const mint = new PublicKey(info.mint);
    const frozen = info.state === 'frozen';
    const balance = BigInt(info.tokenAmount.amount);
    const decimals = info.tokenAmount.decimals;
    const rent = acc.account.lamports;

    // Skip WSOL (managed by the bot)
    if (mint.equals(WSOL_MINT)) {
      skippedWsol++;
      continue;
    }

    // Skip frozen (can't close)
    if (frozen) {
      skippedFrozen++;
      continue;
    }

    closable.push({
      ata: acc.pubkey,
      mint,
      balance,
      decimals,
      rent,
      programId: acc.programId,
    });
  }

  console.log(`Closable: ${closable.length} | Frozen (skip): ${skippedFrozen} | WSOL (skip): ${skippedWsol}\n`);

  if (closable.length === 0) {
    console.log('Nothing to close!');
    return;
  }

  const totalRent = closable.reduce((sum, a) => sum + a.rent, 0);
  console.log(`Total recoverable rent: ${(totalRent / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  // Process in batches
  let totalClosed = 0;
  let totalRecovered = 0;

  for (let i = 0; i < closable.length; i += BATCH_SIZE) {
    const batch = closable.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(closable.length / BATCH_SIZE);

    console.log(`--- Batch ${batchNum}/${totalBatches} (${batch.length} accounts) ---`);

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    );

    for (const acc of batch) {
      // Burn remaining tokens (if any)
      if (acc.balance > 0n) {
        tx.add(
          createBurnInstruction(
            acc.ata,
            acc.mint,
            owner,
            acc.balance,
            [],
            acc.programId,
          ),
        );
      }

      // Close account → rent goes to owner
      tx.add(
        createCloseAccountInstruction(
          acc.ata,
          owner,
          owner,
          [],
          acc.programId,
        ),
      );

      const balStr = acc.balance > 0n
        ? ` (burning ${acc.balance} tokens)`
        : '';
      console.log(`  ${acc.mint.toBase58().slice(0, 12)}...${balStr} → +${(acc.rent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }

    if (dryRun) {
      console.log(`  [DRY RUN] Would close ${batch.length} accounts\n`);
      totalClosed += batch.length;
      totalRecovered += batch.reduce((s, a) => s + a.rent, 0);
      continue;
    }

    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = owner;
      tx.sign(wallet.keypair);

      // Simulate first
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        console.log(`  SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
        console.log(`  Skipping batch (some accounts may have transfer hooks or restrictions)\n`);
        continue;
      }

      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      console.log(`  TX: ${sig}`);

      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      console.log(`  CONFIRMED ✓\n`);

      totalClosed += batch.length;
      totalRecovered += batch.reduce((s, a) => s + a.rent, 0);
    } catch (err) {
      console.log(`  ERROR: ${err}\n`);
      // Try smaller batches on failure
      if (batch.length > 1) {
        console.log('  Will retry accounts individually in next run');
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < closable.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Closed: ${totalClosed}/${closable.length} accounts`);
  console.log(`Recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  const finalBal = await conn.getBalance(owner);
  console.log(`Final balance: ${(finalBal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch(console.error);
