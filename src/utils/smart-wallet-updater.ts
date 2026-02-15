import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { withAnalysisRetry } from './analysis-rpc.js';

/**
 * v11n: Auto-refresh smart wallet list on bot startup.
 *
 * Strategy:
 * 1. Get top trending Solana tokens from DexScreener (free, no auth)
 * 2. For each token, get early pool transaction signers via Helius
 * 3. Wallets appearing as early buyers in 3+ trending tokens → "smart wallet"
 * 4. Write results to data/smart-wallets.json
 *
 * Runs on bot startup if data is stale (>7 days old).
 * Cost: ~20-50 Helius RPC calls (negligible on paid plan).
 * Latency: ~5-15s total (runs in background, doesn't block bot startup).
 */

const SMART_WALLETS_PATH = join(process.cwd(), 'data', 'smart-wallets.json');
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_TOKEN_APPEARANCES = 3; // Wallet must appear in 3+ tokens
const MAX_TOKENS_TO_ANALYZE = 12; // Analyze top 12 trending tokens
const SIGS_PER_TOKEN = 30; // Get 30 most recent TXs per token
const TXS_TO_PARSE = 15; // Parse 15 TXs per token for buyer wallets

// Known system/program addresses to exclude
const EXCLUDED_ADDRESSES = new Set([
  '11111111111111111111111111111111', // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // AToken Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // PumpFun
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'So11111111111111111111111111111111111111112', // WSOL
  'SysvarRent111111111111111111111111111111111', // Rent
  'SysvarC1ock11111111111111111111111111111111', // Clock
]);

interface DexScreenerToken {
  chainId: string;
  tokenAddress: string;
}

interface SmartWalletFile {
  description: string;
  lastUpdated: string;
  autoUpdated: boolean;
  wallets: Array<{
    address: string;
    tier: 'elite' | 'strong' | 'consistent';
    appearances: number;
    notes: string;
  }>;
  tiers: Record<string, string>;
}

/**
 * Check if smart-wallets.json needs refresh (>7 days old).
 */
function isStale(): boolean {
  try {
    if (!existsSync(SMART_WALLETS_PATH)) return true;
    const raw = readFileSync(SMART_WALLETS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { lastUpdated?: string };
    if (!data.lastUpdated) return true;
    const lastUpdated = new Date(data.lastUpdated).getTime();
    return (Date.now() - lastUpdated) > STALE_THRESHOLD_MS;
  } catch {
    return true;
  }
}

/**
 * Fetch trending Solana tokens from DexScreener (free, no auth).
 */
async function fetchTrendingTokens(): Promise<string[]> {
  const response = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DexScreener ${response.status}`);
  const data = (await response.json()) as DexScreenerToken[];

  // Filter Solana tokens, deduplicate
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const item of data) {
    if (item.chainId === 'solana' && item.tokenAddress && !seen.has(item.tokenAddress)) {
      seen.add(item.tokenAddress);
      tokens.push(item.tokenAddress);
      if (tokens.length >= MAX_TOKENS_TO_ANALYZE) break;
    }
  }
  return tokens;
}

/**
 * Get early buyer wallet addresses for a token by analyzing pool transactions.
 */
async function getEarlyBuyers(
  connection: Connection,
  tokenMint: string,
): Promise<string[]> {
  try {
    const mintPk = new PublicKey(tokenMint);

    // Get recent signatures on the token mint (captures buys, sells, transfers)
    const sigs = await withAnalysisRetry(
      (conn) => conn.getSignaturesForAddress(mintPk, { limit: SIGS_PER_TOKEN }),
      connection,
    );

    if (sigs.length === 0) return [];

    // Parse a subset of TXs to extract fee payer (= buyer) wallets
    const buyerWallets = new Set<string>();
    const sigsToparse = sigs.slice(0, TXS_TO_PARSE);

    // Batch-parse: get parsed transactions
    const txPromises = sigsToparse
      .filter(s => !s.err) // Skip failed TXs
      .map(s =>
        withAnalysisRetry(
          (conn) => conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }),
          connection,
        ).catch(() => null),
      );

    const txResults = await Promise.all(txPromises);

    for (const tx of txResults) {
      if (!tx?.transaction?.message) continue;

      // Fee payer is always the first signer = the human wallet initiating the trade
      const feePayer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();
      if (feePayer && !EXCLUDED_ADDRESSES.has(feePayer)) {
        buyerWallets.add(feePayer);
      }
    }

    return Array.from(buyerWallets);
  } catch (err) {
    logger.debug(`[smart-wallet-updater] Failed to get buyers for ${tokenMint.slice(0, 8)}...: ${String(err).slice(0, 80)}`);
    return [];
  }
}

/**
 * Main refresh function. Discovers smart wallets from trending token data.
 * Returns true if update was performed.
 */
export async function refreshSmartWallets(
  connection: Connection,
): Promise<boolean> {
  if (!isStale()) {
    logger.debug('[smart-wallet-updater] Data is fresh (<7 days), skipping refresh');
    return false;
  }

  logger.info('[smart-wallet-updater] Smart wallet data is stale, starting refresh...');

  try {
    // Step 1: Get trending tokens from DexScreener
    const trendingTokens = await fetchTrendingTokens();
    if (trendingTokens.length < 3) {
      logger.warn(`[smart-wallet-updater] Only ${trendingTokens.length} trending tokens found, skipping`);
      return false;
    }
    logger.info(`[smart-wallet-updater] Got ${trendingTokens.length} trending Solana tokens from DexScreener`);

    // Step 2: Analyze early buyers for each token (with rate limiting)
    const walletAppearances = new Map<string, number>();

    for (const token of trendingTokens) {
      const buyers = await getEarlyBuyers(connection, token);
      for (const wallet of buyers) {
        walletAppearances.set(wallet, (walletAppearances.get(wallet) || 0) + 1);
      }
      // Small delay to avoid hammering RPC
      await new Promise(r => setTimeout(r, 200));
    }

    logger.info(`[smart-wallet-updater] Found ${walletAppearances.size} unique wallets across ${trendingTokens.length} tokens`);

    // Step 3: Filter wallets appearing in 3+ trending tokens
    const smartWallets: Array<{ address: string; appearances: number }> = [];
    for (const [address, count] of walletAppearances) {
      if (count >= MIN_TOKEN_APPEARANCES) {
        smartWallets.push({ address, appearances: count });
      }
    }

    // Sort by appearances descending
    smartWallets.sort((a, b) => b.appearances - a.appearances);

    // Cap at 50 wallets
    const topWallets = smartWallets.slice(0, 50);

    if (topWallets.length === 0) {
      logger.warn('[smart-wallet-updater] No wallets found with 3+ appearances, keeping existing data');
      // Still update the timestamp so we don't retry every startup
      updateTimestamp();
      return false;
    }

    // Step 4: Assign tiers based on appearances
    const walletEntries = topWallets.map(w => ({
      address: w.address,
      tier: w.appearances >= 6 ? 'elite' as const
        : w.appearances >= 4 ? 'strong' as const
        : 'consistent' as const,
      appearances: w.appearances,
      notes: `Auto-discovered: active in ${w.appearances}/${trendingTokens.length} trending tokens`,
    }));

    // Step 5: Merge with existing manual entries (preserve manually added wallets)
    const existingManual = loadManualWallets();

    const finalWallets = [
      ...existingManual,
      ...walletEntries.filter(w => !existingManual.some(m => m.address === w.address)),
    ];

    // Step 6: Write to file
    const output: SmartWalletFile = {
      description: 'Smart wallet list for token scoring. Auto-updated weekly from DexScreener trending + on-chain analysis.',
      lastUpdated: new Date().toISOString().split('T')[0],
      autoUpdated: true,
      wallets: finalWallets,
      tiers: {
        elite: 'Active in 6+ trending tokens. Score: +10',
        strong: 'Active in 4-5 trending tokens. Score: +7',
        consistent: 'Active in 3 trending tokens. Score: +5',
      },
    };

    // Ensure data/ directory exists
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    writeFileSync(SMART_WALLETS_PATH, JSON.stringify(output, null, 2));

    const tierCounts = {
      elite: walletEntries.filter(w => w.tier === 'elite').length,
      strong: walletEntries.filter(w => w.tier === 'strong').length,
      consistent: walletEntries.filter(w => w.tier === 'consistent').length,
    };

    logger.info(
      `[smart-wallet-updater] Updated ${finalWallets.length} wallets ` +
      `(elite=${tierCounts.elite} strong=${tierCounts.strong} consistent=${tierCounts.consistent}` +
      `${existingManual.length > 0 ? ` +${existingManual.length} manual` : ''})`,
    );

    return true;
  } catch (err) {
    logger.warn(`[smart-wallet-updater] Refresh failed (non-fatal): ${String(err).slice(0, 150)}`);
    return false;
  }
}

/**
 * Load manually-added wallets (those without "Auto-discovered" in notes).
 */
function loadManualWallets(): Array<{
  address: string;
  tier: 'elite' | 'strong' | 'consistent';
  appearances: number;
  notes: string;
}> {
  try {
    if (!existsSync(SMART_WALLETS_PATH)) return [];
    const raw = readFileSync(SMART_WALLETS_PATH, 'utf-8');
    const data = JSON.parse(raw) as SmartWalletFile;
    return (data.wallets || [])
      .filter(w => !w.notes?.includes('Auto-discovered'))
      .map(w => ({
        address: w.address,
        tier: w.tier || 'consistent',
        appearances: w.appearances || 0,
        notes: w.notes || 'Manually added',
      }));
  } catch {
    return [];
  }
}

/**
 * Update just the timestamp (so we don't retry on every startup).
 */
function updateTimestamp(): void {
  try {
    if (existsSync(SMART_WALLETS_PATH)) {
      const raw = readFileSync(SMART_WALLETS_PATH, 'utf-8');
      const data = JSON.parse(raw);
      data.lastUpdated = new Date().toISOString().split('T')[0];
      writeFileSync(SMART_WALLETS_PATH, JSON.stringify(data, null, 2));
    }
  } catch { /* non-fatal */ }
}
