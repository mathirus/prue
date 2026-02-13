/**
 * Close dust token accounts to recover rent (~0.002 SOL each).
 * Burns any remaining token balance, then closes the ATA.
 * Skips frozen Token-2022 accounts (scam airdrops).
 */
const { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createBurnInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const BATCH_SIZE = 8; // 2 instructions per ATA (burn+close) = 16 instructions max

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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const conn = new Connection(process.env.RPC_URL);
  const wallet = Keypair.fromSecretKey(decodeBase58(process.env.PRIVATE_KEY));
  const owner = wallet.publicKey;

  console.log(`Wallet: ${owner.toBase58()}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const balBefore = await conn.getBalance(owner);
  console.log(`Balance before: ${(balBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  const [splAccounts, t22Accounts] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 }),
  ]);

  const all = [
    ...splAccounts.value.map(a => ({ ...a, pid: TOKEN_PROGRAM_ID })),
    ...t22Accounts.value.map(a => ({ ...a, pid: TOKEN_2022 })),
  ];

  console.log(`Found ${all.length} token accounts\n`);

  const closable = [];
  let skippedFrozen = 0;
  let skippedWsol = 0;

  for (const acc of all) {
    const info = acc.account.data.parsed.info;
    const mint = new PublicKey(info.mint);
    const frozen = info.state === 'frozen';
    const balance = BigInt(info.tokenAmount.amount);
    const decimals = info.tokenAmount.decimals;
    const rent = acc.account.lamports;

    if (mint.equals(WSOL_MINT)) { skippedWsol++; continue; }
    if (frozen) { skippedFrozen++; continue; }

    closable.push({ ata: acc.pubkey, mint, balance, decimals, rent, programId: acc.pid });
  }

  console.log(`Closable: ${closable.length} | Frozen: ${skippedFrozen} | WSOL: ${skippedWsol}`);

  const totalRent = closable.reduce((s, a) => s + a.rent, 0);
  console.log(`Total recoverable rent: ${(totalRent / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  if (closable.length === 0) { console.log('Nothing to close!'); return; }

  let totalClosed = 0;
  let totalRecovered = 0;

  for (let i = 0; i < closable.length; i += BATCH_SIZE) {
    const batch = closable.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(closable.length / BATCH_SIZE);

    console.log(`--- Batch ${batchNum}/${totalBatches} (${batch.length} accounts) ---`);

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    );

    for (const acc of batch) {
      if (acc.balance > 0n) {
        tx.add(createBurnInstruction(acc.ata, acc.mint, owner, acc.balance, [], acc.programId));
      }
      tx.add(createCloseAccountInstruction(acc.ata, owner, owner, [], acc.programId));

      const balStr = acc.balance > 0n ? ` (burn ${acc.balance})` : '';
      console.log(`  ${acc.mint.toBase58().slice(0,12)}${balStr} → +${(acc.rent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }

    if (dryRun) {
      console.log(`  [DRY RUN] Would close ${batch.length}\n`);
      totalClosed += batch.length;
      totalRecovered += batch.reduce((s, a) => s + a.rent, 0);
      continue;
    }

    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = owner;
      tx.sign(wallet);

      // Simulate first
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        console.log(`  SIM FAILED: ${JSON.stringify(sim.value.err)}`);
        // Try individually
        for (const acc of batch) {
          try {
            const singleTx = new Transaction();
            singleTx.add(
              ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
            );
            if (acc.balance > 0n) {
              singleTx.add(createBurnInstruction(acc.ata, acc.mint, owner, acc.balance, [], acc.programId));
            }
            singleTx.add(createCloseAccountInstruction(acc.ata, owner, owner, [], acc.programId));

            const { blockhash: bh, lastValidBlockHeight: lvbh } = await conn.getLatestBlockhash('confirmed');
            singleTx.recentBlockhash = bh;
            singleTx.feePayer = owner;
            singleTx.sign(wallet);

            const simS = await conn.simulateTransaction(singleTx);
            if (simS.value.err) {
              console.log(`  SKIP ${acc.mint.toBase58().slice(0,12)}: ${JSON.stringify(simS.value.err)}`);
              continue;
            }

            const sig = await conn.sendRawTransaction(singleTx.serialize(), { skipPreflight: true });
            await conn.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: lvbh }, 'confirmed');
            console.log(`  CLOSED ${acc.mint.toBase58().slice(0,12)} ✓`);
            totalClosed++;
            totalRecovered += acc.rent;
          } catch (e) {
            console.log(`  FAIL ${acc.mint.toBase58().slice(0,12)}: ${e.message?.slice(0,80)}`);
          }
          await new Promise(r => setTimeout(r, 200));
        }
        continue;
      }

      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      console.log(`  TX: ${sig}`);
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      console.log(`  CONFIRMED ✓\n`);
      totalClosed += batch.length;
      totalRecovered += batch.reduce((s, a) => s + a.rent, 0);
    } catch (err) {
      console.log(`  ERROR: ${err.message?.slice(0,100)}\n`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const balAfter = await conn.getBalance(owner);
  console.log('\n=== SUMMARY ===');
  console.log(`Closed: ${totalClosed}/${closable.length}`);
  console.log(`Recovered: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Balance: ${(balBefore / LAMPORTS_PER_SOL).toFixed(6)} → ${(balAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Net gain: ${((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch(console.error);
