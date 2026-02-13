/**
 * Burn dust + close Token-2022 ATAs to recover rent SOL.
 * Each ATA has ~0.002 SOL in rent. 128 ATAs = ~0.26 SOL recoverable.
 *
 * - Burns any remaining token balance (spam airdrops)
 * - Closes the ATA to recover rent back to wallet
 * - Skips frozen accounts (can't close)
 * - Batches of 5 (burn+close = 2 ix per ATA = 10 ix + 2 CU ix = 12 per TX)
 * - Uses pollConfirmation pattern (not confirmTransaction) for Helius free tier
 *
 * Usage: node scripts/recover-atas.cjs [--dry-run]
 */

const { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createBurnInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();

const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const BATCH_SIZE = 5; // 5 ATAs × 2 ix = 10 instructions + 2 CU = 12 total
const DRY_RUN = process.argv.includes('--dry-run');

function decodeBase58(str) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = BigInt(i);
  let result = 0n;
  for (const ch of str) result = result * 58n + ALPHABET_MAP[ch];
  const bytes = [];
  while (result > 0n) { bytes.unshift(Number(result & 0xffn)); result >>= 8n; }
  for (const ch of str) { if (ch === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

/** Poll getSignatureStatuses instead of confirmTransaction (avoids WS/429 issues) */
async function pollConfirm(conn, signature, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await conn.getSignatureStatuses([signature]);
      const status = res?.value?.[0];
      if (status) {
        if (status.err) return { ok: false, err: JSON.stringify(status.err) };
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return { ok: true };
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { ok: false, err: 'timeout' };
}

async function main() {
  // Try backup RPC first (less rate limited), fallback to primary
  const rpcUrl = process.env.RPC_URL_BACKUP || process.env.RPC_URL;
  const conn = new Connection(rpcUrl);
  const wallet = Keypair.fromSecretKey(decodeBase58(process.env.PRIVATE_KEY));
  const owner = wallet.publicKey;

  console.log(`Wallet: ${owner.toBase58()}`);
  console.log(`RPC: ${rpcUrl.slice(0, 40)}...`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const balanceBefore = await conn.getBalance(owner);
  console.log(`Balance before: ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  // Fetch all token accounts
  const [splAccounts, t22Accounts] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
  ]);

  console.log(`SPL accounts: ${splAccounts.value.length} | Token-2022: ${t22Accounts.value.length}`);

  // Find closable accounts
  const closable = [];
  let skippedFrozen = 0;
  let skippedWsol = 0;

  const allAccounts = [
    ...splAccounts.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t22Accounts.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM })),
  ];

  for (const acc of allAccounts) {
    const info = acc.account.data.parsed?.info;
    if (!info) continue;
    const mint = new PublicKey(info.mint);
    const frozen = info.state === 'frozen';
    const balance = BigInt(info.tokenAmount.amount);
    const rent = acc.account.lamports;

    if (mint.equals(WSOL_MINT)) { skippedWsol++; continue; }
    if (frozen) { skippedFrozen++; continue; }

    closable.push({ ata: acc.pubkey, mint, balance, rent, programId: acc.programId });
  }

  console.log(`\nClosable: ${closable.length} | Frozen: ${skippedFrozen} | WSOL: ${skippedWsol}`);
  const totalRent = closable.reduce((s, a) => s + a.rent, 0);
  console.log(`Recoverable rent: ${(totalRent / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  if (closable.length === 0) { console.log('Nothing to close!'); return; }

  let totalClosed = 0;
  let totalRecovered = 0;
  let failures = 0;

  for (let i = 0; i < closable.length; i += BATCH_SIZE) {
    const batch = closable.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(closable.length / BATCH_SIZE);

    console.log(`--- Batch ${batchNum}/${totalBatches} (${batch.length} ATAs) ---`);

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    );

    for (const acc of batch) {
      if (acc.balance > 0n) {
        tx.add(createBurnInstruction(acc.ata, acc.mint, owner, acc.balance, [], acc.programId));
      }
      tx.add(createCloseAccountInstruction(acc.ata, owner, owner, [], acc.programId));
      const tag = acc.balance > 0n ? ` (burn ${acc.balance})` : '';
      console.log(`  ${acc.mint.toBase58().slice(0, 12)}...${tag} → +${(acc.rent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }

    if (DRY_RUN) {
      totalClosed += batch.length;
      totalRecovered += batch.reduce((s, a) => s + a.rent, 0);
      console.log(`  [DRY RUN] ✓\n`);
      continue;
    }

    try {
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = owner;
      tx.sign(wallet);

      // Simulate first (free, catches errors)
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        console.log(`  SIM FAIL: ${JSON.stringify(sim.value.err)}`);
        // Try individually
        for (const acc of batch) {
          await closeSingle(conn, wallet, owner, acc);
        }
        continue;
      }

      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      console.log(`  TX: ${sig}`);

      const result = await pollConfirm(conn, sig, 20000);
      if (result.ok) {
        console.log(`  CONFIRMED ✓\n`);
        totalClosed += batch.length;
        totalRecovered += batch.reduce((s, a) => s + a.rent, 0);
      } else {
        console.log(`  FAILED: ${result.err}\n`);
        failures += batch.length;
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}\n`);
      failures += batch.length;
    }

    // Delay between batches
    await new Promise(r => setTimeout(r, 800));
  }

  const balanceAfter = await conn.getBalance(owner);
  console.log('\n=== SUMMARY ===');
  console.log(`Closed: ${totalClosed}/${closable.length}`);
  console.log(`Failed: ${failures}`);
  console.log(`Balance: ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(6)} → ${(balanceAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Recovered: ${((balanceAfter - balanceBefore) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

async function closeSingle(conn, wallet, owner, acc) {
  try {
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    );
    if (acc.balance > 0n) {
      tx.add(createBurnInstruction(acc.ata, acc.mint, owner, acc.balance, [], acc.programId));
    }
    tx.add(createCloseAccountInstruction(acc.ata, owner, owner, [], acc.programId));

    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    tx.sign(wallet);

    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      console.log(`    SKIP ${acc.mint.toBase58().slice(0, 8)}: sim fail ${JSON.stringify(sim.value.err)}`);
      return;
    }

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const result = await pollConfirm(conn, sig, 15000);
    if (result.ok) {
      console.log(`    CLOSED ${acc.mint.toBase58().slice(0, 8)} ✓`);
    } else {
      console.log(`    FAIL ${acc.mint.toBase58().slice(0, 8)}: ${result.err}`);
    }
  } catch (err) {
    console.log(`    ERR ${acc.mint.toBase58().slice(0, 8)}: ${err.message.slice(0, 60)}`);
  }
  await new Promise(r => setTimeout(r, 300));
}

main().catch(e => console.error('Fatal:', e));
