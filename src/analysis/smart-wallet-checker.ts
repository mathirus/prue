import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { TOKEN_PROGRAM } from '../constants.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * v11n: Smart wallet checker — checks if known profitable wallets hold a token.
 *
 * How it works:
 * 1. Derive ATA addresses for each smart wallet + token mint (local crypto, ~5ms for 50 wallets)
 * 2. Batch check all ATAs with getMultipleAccounts (1 RPC call, ~300ms from VPS)
 * 3. Score based on tier of wallets that hold the token
 *
 * Cost: 1 RPC call (getMultipleAccounts, max 100 accounts per call)
 * Latency: ~300-500ms from VPS, ~800ms from Argentina
 *
 * Wallet list: data/smart-wallets.json, curated weekly from GMGN/Dune top traders.
 */

export type SmartWalletTier = 'elite' | 'strong' | 'consistent';

interface SmartWallet {
  address: string;
  tier: SmartWalletTier;
}

export interface SmartWalletResult {
  holdingCount: number;     // Number of smart wallets holding this token
  eliteCount: number;       // Number of 'elite' tier wallets holding
  strongCount: number;      // Number of 'strong' tier wallets holding
  consistentCount: number;  // Number of 'consistent' tier wallets holding
  bonus: number;            // Score bonus to apply (0 to +10)
  wallets: string[];        // Addresses of smart wallets holding (for logging)
}

const EMPTY_RESULT: SmartWalletResult = {
  holdingCount: 0,
  eliteCount: 0,
  strongCount: 0,
  consistentCount: 0,
  bonus: 0,
  wallets: [],
};

// Module-level cache for smart wallet list (loaded once on first call)
let smartWallets: SmartWallet[] | null = null;

/**
 * Load smart wallets from data/smart-wallets.json.
 * Cached in memory after first load.
 */
function loadSmartWallets(): SmartWallet[] {
  if (smartWallets !== null) return smartWallets;
  try {
    const filePath = join(process.cwd(), 'data', 'smart-wallets.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as { wallets: Array<{ address: string; tier: string }> };
    smartWallets = data.wallets
      .filter(w => w.address && w.tier)
      .map(w => ({
        address: w.address,
        tier: w.tier as SmartWalletTier,
      }));
    logger.info(`[smart-wallet] Loaded ${smartWallets.length} smart wallets from data/smart-wallets.json`);
    return smartWallets;
  } catch (err) {
    logger.debug(`[smart-wallet] Failed to load smart-wallets.json: ${String(err)}`);
    smartWallets = [];
    return smartWallets;
  }
}

/**
 * Derive Associated Token Address (ATA) — pure local computation, 0 RPC calls.
 * ATA = PDA([walletAddress, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM)
 */
function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ata;
}

/**
 * Check if any smart wallets hold a specific token.
 * Uses getMultipleAccounts for batch checking (1 RPC call).
 */
export async function checkSmartWallets(
  connection: Connection,
  tokenMint: PublicKey,
): Promise<SmartWalletResult> {
  const wallets = loadSmartWallets();
  if (wallets.length === 0) return EMPTY_RESULT;

  try {
    // Step 1: Derive ATAs (local crypto, ~5ms for 50 wallets)
    const ataEntries = wallets.map(w => ({
      wallet: w,
      ata: getAssociatedTokenAddressSync(tokenMint, new PublicKey(w.address)),
    }));

    // Step 2: Batch check with getMultipleAccounts (1 RPC call)
    // Solana limit: 100 accounts per call, we have <50 wallets typically
    const ataAddresses = ataEntries.map(e => e.ata);
    const accountInfos = await withAnalysisRetry(
      (conn) => conn.getMultipleAccountsInfo(ataAddresses),
      connection,
    );

    // Step 3: Count holdings by tier
    let eliteCount = 0;
    let strongCount = 0;
    let consistentCount = 0;
    const holdingWallets: string[] = [];

    for (let i = 0; i < ataEntries.length; i++) {
      const info = accountInfos[i];
      if (!info || info.data.length === 0) continue;

      // ATA exists — check if it has a non-zero balance
      // SPL Token account data: first 32 bytes = mint, next 32 = owner, next 8 = amount (u64 LE)
      if (info.data.length >= 72) {
        const amountBytes = info.data.slice(64, 72);
        const amount = Buffer.from(amountBytes).readBigUInt64LE();
        if (amount === 0n) continue; // ATA exists but empty
      }

      const wallet = ataEntries[i].wallet;
      holdingWallets.push(wallet.address);

      switch (wallet.tier) {
        case 'elite': eliteCount++; break;
        case 'strong': strongCount++; break;
        case 'consistent': consistentCount++; break;
      }
    }

    const holdingCount = holdingWallets.length;

    // Step 4: Calculate bonus
    let bonus = 0;
    if (eliteCount > 0) bonus = 10;
    else if (strongCount > 0) bonus = 7;
    else if (consistentCount > 0) bonus = 5;

    const result: SmartWalletResult = {
      holdingCount,
      eliteCount,
      strongCount,
      consistentCount,
      bonus,
      wallets: holdingWallets,
    };

    if (holdingCount > 0) {
      logger.info(
        `[smart-wallet] ${tokenMint.toBase58().slice(0, 8)}...: ${holdingCount} smart wallets holding (elite=${eliteCount} strong=${strongCount} consistent=${consistentCount}) → +${bonus}`,
      );
    } else {
      logger.debug(`[smart-wallet] ${tokenMint.toBase58().slice(0, 8)}...: 0 smart wallets holding`);
    }

    return result;
  } catch (err) {
    logger.debug(`[smart-wallet] Check failed for ${tokenMint.toBase58().slice(0, 8)}...: ${String(err)}`);
    return EMPTY_RESULT;
  }
}
