/**
 * Periodic ATA cleanup: burns dust tokens and closes empty/dust ATAs to recover rent.
 * Each ATA holds ~0.002 SOL in rent. After a trade, leftover dust tokens prevent closing.
 * This module runs hourly to burn dust + close ATAs automatically.
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
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Wallet } from '../core/wallet.js';
import { logger } from './logger.js';

const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const BATCH_SIZE = 8;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // v8j: was 1h → 15min (recover rent 4x faster)

export function startAtaCleanup(
  connection: Connection,
  wallet: Wallet,
  getActiveTokenMints?: () => Set<string>,
): void {
  // Run first cleanup after 2 minutes (v8j: was 5min → 2min)
  setTimeout(() => {
    cleanupDustAtas(connection, wallet, getActiveTokenMints).catch(err =>
      logger.warn(`[ata-cleanup] Error: ${err.message?.slice(0, 100)}`),
    );
  }, 2 * 60 * 1000);

  // Then every 15min
  setInterval(() => {
    cleanupDustAtas(connection, wallet, getActiveTokenMints).catch(err =>
      logger.warn(`[ata-cleanup] Error: ${err.message?.slice(0, 100)}`),
    );
  }, CLEANUP_INTERVAL_MS);

  logger.info('[ata-cleanup] Scheduled (first in 2min, then every 15min)');
}

/**
 * Close a single token ATA immediately after selling 100% of tokens.
 * Recovers ~0.002 SOL rent. Burns any dust before closing.
 * v8j: called after each full sell to avoid rent accumulation.
 */
export async function closeTokenAta(
  connection: Connection,
  wallet: Wallet,
  tokenMint: PublicKey,
): Promise<boolean> {
  const owner = wallet.publicKey;
  try {
    const ata = await getAssociatedTokenAddress(tokenMint, owner);
    const accInfo = await connection.getAccountInfo(ata);
    if (!accInfo) return false; // ATA doesn't exist

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    );

    // Parse balance - if there's dust, burn it first
    const parsed = await connection.getParsedAccountInfo(ata);
    if (parsed.value) {
      const data = (parsed.value.data as any)?.parsed?.info;
      if (data) {
        const balance = BigInt(data.tokenAmount?.amount ?? '0');
        const programId = accInfo.owner;
        if (balance > 0n) {
          tx.add(createBurnInstruction(ata, tokenMint, owner, balance, [], programId));
        }
        tx.add(createCloseAccountInstruction(ata, owner, owner, [], programId));
      }
    }

    if (tx.instructions.length <= 2) return false; // Only compute budget, no actual instructions

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    tx.sign(wallet.keypair);

    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      logger.debug(`[ata-close] Sim failed for ${tokenMint.toBase58().slice(0, 8)}: ${JSON.stringify(sim.value.err)}`);
      return false;
    }

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    logger.info(`[ata-close] Closed ATA for ${tokenMint.toBase58().slice(0, 8)}... recovered ~0.002 SOL`);
    return true;
  } catch (err) {
    logger.debug(`[ata-close] Failed for ${tokenMint.toBase58().slice(0, 8)}: ${(err as Error).message?.slice(0, 80)}`);
    return false;
  }
}

async function cleanupDustAtas(
  connection: Connection,
  wallet: Wallet,
  getActiveTokenMints?: () => Set<string>,
): Promise<void> {
  const owner = wallet.publicKey;

  // v8l: Get active position mints to SKIP (CRITICAL: never burn tokens we're trading)
  const activeMints = getActiveTokenMints?.() ?? new Set<string>();
  if (activeMints.size > 0) {
    logger.debug(`[ata-cleanup] Skipping ${activeMints.size} active position mint(s)`);
  }

  const [splAccounts, t22Accounts] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
  ]);

  const allAccounts = [
    ...splAccounts.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t22Accounts.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM })),
  ];

  const closable: Array<{
    ata: PublicKey;
    mint: PublicKey;
    balance: bigint;
    rent: number;
    programId: PublicKey;
  }> = [];

  for (const acc of allAccounts) {
    const info = acc.account.data.parsed.info;
    const mint = new PublicKey(info.mint);

    // Skip WSOL and frozen accounts
    if (mint.equals(WSOL_MINT)) continue;
    if (info.state === 'frozen') continue;

    // v8l: CRITICAL - Skip tokens with active positions (prevents burning traded tokens)
    if (activeMints.has(mint.toBase58())) {
      logger.info(`[ata-cleanup] SKIPPING active position: ${mint.toBase58().slice(0, 8)}...`);
      continue;
    }

    closable.push({
      ata: acc.pubkey,
      mint,
      balance: BigInt(info.tokenAmount.amount),
      rent: acc.account.lamports,
      programId: acc.programId,
    });
  }

  if (closable.length === 0) return;

  const totalRent = closable.reduce((s, a) => s + a.rent, 0);
  logger.info(`[ata-cleanup] Found ${closable.length} closable ATAs (${(totalRent / LAMPORTS_PER_SOL).toFixed(4)} SOL recoverable)`);

  let totalClosed = 0;

  for (let i = 0; i < closable.length; i += BATCH_SIZE) {
    // v10b: RE-CHECK active mints before each batch — prevents race condition where
    // a buy happens between initial scan and close TX (2Qp1H1Ju bug: cleanup burned 5380 tokens)
    const freshActiveMints = getActiveTokenMints?.() ?? new Set<string>();
    const batch = closable.slice(i, i + BATCH_SIZE).filter(acc => {
      if (freshActiveMints.has(acc.mint.toBase58())) {
        logger.warn(`[ata-cleanup] RACE CONDITION PREVENTED: ${acc.mint.toBase58().slice(0, 8)}... became active since scan — SKIPPING`);
        return false;
      }
      return true;
    });
    if (batch.length === 0) continue;

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    );

    for (const acc of batch) {
      if (acc.balance > 0n) {
        tx.add(createBurnInstruction(acc.ata, acc.mint, owner, acc.balance, [], acc.programId));
      }
      tx.add(createCloseAccountInstruction(acc.ata, owner, owner, [], acc.programId));
    }

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = owner;
      tx.sign(wallet.keypair);

      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        logger.debug(`[ata-cleanup] Batch sim failed: ${JSON.stringify(sim.value.err)}`);
        continue;
      }

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      totalClosed += batch.length;
    } catch (err) {
      logger.debug(`[ata-cleanup] Batch error: ${(err as Error).message?.slice(0, 80)}`);
    }

    // Delay between batches
    if (i + BATCH_SIZE < closable.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (totalClosed > 0) {
    const recovered = closable.slice(0, totalClosed).reduce((s, a) => s + a.rent, 0);
    logger.info(`[ata-cleanup] Closed ${totalClosed}/${closable.length} ATAs, recovered ${(recovered / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }
}
