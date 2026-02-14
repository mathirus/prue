// v11k: Configure undici connection pool BEFORE any other imports that use fetch.
// Without this, Node.js opens unlimited TCP sockets per request, exhausting ephemeral ports
// under concurrent load (20+ RPC calls during pool analysis). Default is unlimited.
// Recommended by Triton One: https://docs.triton.one/chains/solana/web3js-socket-connection-issues
import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({
  connections: 50,          // Max connections per host (default: unlimited → port exhaustion)
  pipelining: 1,            // No HTTP pipelining (1 request at a time per connection)
  connectTimeout: 10_000,   // 10s to establish TCP connection
  bodyTimeout: 15_000,      // 15s to receive response body
  headersTimeout: 10_000,   // 10s to receive response headers
  keepAliveTimeout: 4_000,  // Close idle connections after 4s
  keepAliveMaxTimeout: 30_000, // Force-recycle connections after 30s
}));

import { loadConfig, validateConfig } from './config.js';
import { logger } from './utils/logger.js';
import { RpcManager } from './core/rpc-manager.js';
import { WebSocketManager } from './core/websocket-manager.js';
import { Wallet } from './core/wallet.js';
import { PoolDetector } from './detection/pool-detector.js';
import { PumpFunMonitor } from './detection/pumpfun-monitor.js';
import { PumpSwapMonitor } from './detection/pumpswap-monitor.js';
import { botEmitter } from './detection/event-emitter.js';
import { TokenScorer } from './analysis/token-scorer.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ──── INSTANCE LOCK ─────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCK_FILE = join(__dirname, '..', '.bot.lock');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 just checks if process exists
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    try {
      const content = readFileSync(LOCK_FILE, 'utf-8');
      const { pid, timestamp } = JSON.parse(content);

      if (isProcessRunning(pid)) {
        logger.error(`[lock] Another instance is already running (PID: ${pid}, started: ${new Date(timestamp).toISOString()})`);
        logger.error(`[lock] If this is incorrect, delete ${LOCK_FILE} and try again`);
        return false;
      }

      logger.warn(`[lock] Stale lock found (PID ${pid} not running), removing...`);
      unlinkSync(LOCK_FILE);
    } catch (err) {
      logger.warn(`[lock] Invalid lock file, removing: ${err}`);
      try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    }
  }

  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  logger.debug(`[lock] Lock acquired (PID: ${process.pid})`);
  return true;
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
      logger.debug(`[lock] Lock released`);
    }
  } catch (err) {
    logger.warn(`[lock] Failed to release lock: ${err}`);
  }
}

// ──── 3-LAYER DEDUPLICATION ─────────────────────────────────────────────────
// Layer 1: TX signatures - prevents same event from being processed twice
const seenTxSignatures = new Set<string>();
// Layer 2: Token mints - prevents reprocessing same token from different sources
const seenTokenMints = new Set<string>();
// Layer 3: Processing lock - prevents race conditions during async processing
const processingTokens = new Set<string>();

const SEEN_CACHE_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos

setInterval(() => {
  const txBefore = seenTxSignatures.size;
  seenTxSignatures.clear();
  // v9f: seenTokenMints is NOT cleared — it's the primary dedup layer.
  // At ~2K tokens/hour, memory is trivial (~200KB). Clearing it caused duplicates
  // when the same token was detected by multiple monitors after cleanup.
  // processingTokens should NOT be cleared as they represent active work.
  if (txBefore > 0) {
    logger.debug(`[cache] Limpiado: ${txBefore} TXs (seenMints=${seenTokenMints.size} retained)`);
  }
}, SEEN_CACHE_CLEANUP_INTERVAL);
import { JupiterSwap } from './execution/jupiter-swap.js';
import { RaydiumSwap } from './execution/raydium-swap.js';
import { PumpSwapSwap } from './execution/pumpswap-swap.js';
import { JitoBundler } from './execution/jito-bundler.js';
import { PositionManager } from './position/position-manager.js';
import { ShadowPositionManager } from './position/shadow-position-manager.js';
import { TradeLogger } from './data/trade-logger.js';
import { TelegramBot } from './telegram/bot.js';
import { WalletTracker } from './copy-trading/wallet-tracker.js';
import { CopyExecutor } from './copy-trading/copy-executor.js';
import { Cache } from './data/redis-cache.js';
import { closeDb } from './data/database.js';
import { CreatorTracker } from './analysis/creator-tracker.js';
import { checkCreatorWalletAge, type CreatorAgeResult } from './analysis/creator-checker.js';
import { checkAuthorities } from './analysis/security-checker.js';
import { getCreatorDeepProfile, type CreatorDeepProfile } from './analysis/creator-deep-checker.js';
import { ScammerBlacklist } from './analysis/scammer-blacklist.js';
import { AllenHarkBlacklist } from './analysis/allenhark-blacklist.js';
import { shouldBlockByClassifier } from './analysis/ml-classifier.js';
import { YellowstoneMonitor } from './detection/yellowstone-monitor.js';
import { shortenAddress, solscanTx, formatSol, solToLamports } from './utils/helpers.js';
import { startAtaCleanup, closeTokenAta } from './utils/ata-cleanup.js';
import { scheduleMissedGainsCheck, backfillMissedGains } from './analysis/missed-gains-tracker.js';
import { checkWashTrading, type WashTradingResult } from './analysis/wash-trading-detector.js';
import { WSOL_MINT } from './constants.js';
import { startBlockhashCache, stopBlockhashCache } from './utils/blockhash-cache.js';
import { withAnalysisRetry, enterSellPriority, exitSellPriority, setAtCapacity } from './utils/analysis-rpc.js';
import { startBalanceUpdater, stopBalanceUpdater, getCachedBalanceSol, setCachedBalanceLamports } from './utils/balance-cache.js';
import type { DetectedPool, TradeOrder, TradeResult } from './types.js';

// ──── GLOBAL ERROR HANDLERS (prevent crashes from 429 / RPC errors) ────────
// v9l: Enhanced crash handlers — log full stack trace to file, release lock on fatal
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
    logger.warn(`[process] Caught 429 rate limit error (non-fatal): ${msg.slice(0, 200)}`);
  } else {
    logger.error(`[process] FATAL uncaught exception: ${msg}`);
    logger.error(`[process] Stack: ${err.stack || 'no stack'}`);
    // Release lock so bot can be restarted
    releaseLock();
    // Give Winston time to flush to file, then exit
    setTimeout(() => process.exit(1), 1000);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
    logger.warn(`[process] Caught 429 rejection (non-fatal): ${msg.slice(0, 200)}`);
  } else {
    logger.error(`[process] Unhandled rejection: ${msg}`);
    if (stack) logger.error(`[process] Stack: ${stack}`);
  }
});

async function main(): Promise<void> {
  logger.info('');
  logger.info('  ╦  ╦╦╔═╗╔═╗╦═╗╔═╗╔╗╔╦╔═╗╔═╗');
  logger.info('  ╚╗╔╝║╠═╝║╣ ╠╦╝╚═╗║║║║╠═╝║╣ ');
  logger.info('   ╚╝ ╩╩  ╚═╝╩╚═╚═╝╝╚╝╩╩  ╚═╝');
  logger.info('  Solana Sniper Bot v0.1.0');
  logger.info('');

  // Acquire instance lock
  if (!acquireLock()) {
    process.exit(1);
  }

  // Load config
  const config = loadConfig();
  const errors = validateConfig(config);
  let detectionOnly = false;

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(`Config error: ${err}`);
    }
    if (!config.wallet.privateKey) {
      logger.warn('Running in DETECTION-ONLY mode (no wallet configured)');
      detectionOnly = true;
    }
  }

  // Setup RPC
  const rpcUrls = [config.rpc.url, config.rpc.urlBackup].filter(Boolean);
  const rpcManager = new RpcManager(rpcUrls, config.rpc.wsUrl);
  rpcManager.startHealthChecks();

  // Setup WebSocket
  const wsManager = new WebSocketManager(rpcManager.primaryConnection, config.rpc.wsUrl, () => rpcManager.primaryConnection);
  wsManager.startHeartbeat();

  // Setup cache
  const cache = new Cache(config.redis.url);
  await cache.init();

  // v8s: Start blockhash pre-cache (refreshes every 400ms, saves 100-300ms per TX)
  startBlockhashCache(() => rpcManager.primaryConnection);

  // Setup wallet
  let wallet: Wallet | undefined;
  if (config.wallet.privateKey) {
    try {
      wallet = new Wallet(config.wallet.privateKey);
      wallet.logInfo();
    } catch (err) {
      logger.error(`[wallet] Failed to load keypair: ${err}`);
      detectionOnly = true;
    }

    // Balance check is separate - 429 errors should NOT disable trading
    if (wallet) {
      try {
        const balance = await wallet.getBalance(rpcManager.connection);
        logger.info(`[wallet] Balance: ${formatSol(balance)} SOL`);
        // v8p: Save startup balance snapshot
        const startupLogger = new TradeLogger();
        startupLogger.logBalanceSnapshot(balance, 'startup');
        // v9w: Seed balance cache with startup value
        setCachedBalanceLamports(Math.round(balance * 1e9));
      } catch (err) {
        logger.warn(`[wallet] Balance check failed (non-fatal): ${String(err).slice(0, 100)}`);
      }
      // v9w: Start background balance updater (30s interval, uses backup RPCs)
      // v11j: Pass getter function so balance updater always uses fresh connection after reset
      startBalanceUpdater(wallet.publicKey, () => rpcManager.primaryConnection);
    }
  }

  // Setup scorer
  const scorer = new TokenScorer(() => rpcManager.connection, config);
  const tradeLogger = new TradeLogger();
  const creatorTracker = new CreatorTracker();
  const scammerBlacklist = new ScammerBlacklist();

  // v9A: AllenHark external blacklist (4,178+ known scammer wallets)
  const allenHarkBlacklist = new AllenHarkBlacklist();
  await allenHarkBlacklist.init();

  // v9g: Shadow data collection runs ALWAYS (even in live mode) for ML training
  // LiqRemovalMonitor disabled — WebSocket traffic saturates Helius free tier
  let shadowManager: ShadowPositionManager | undefined;
  let shadowLiqMonitor: import('./position/liq-removal-monitor.js').LiquidityRemovalMonitor | undefined;
  // v9h: Auto-adjust shadow settings based on mode
  // Live mode: shadow is DATA-ONLY (no RPC polling) — all RPC budget goes to real trades
  // Shadow mode: full data collection with polling
  if (!config.risk.shadowMode) {
    config.risk.shadowMaxConcurrent = 100; // Still record positions for DexScreener/ML data
    config.risk.shadowPollMs = 60000;      // Irrelevant since polling disabled, but safe default
    logger.info(`[bot] LIVE MODE: shadow DATA-ONLY (no RPC polling, DexScreener only)`);
  } else {
    config.risk.shadowMaxConcurrent = Math.max(config.risk.shadowMaxConcurrent, 200);
    config.risk.shadowPollMs = Math.min(config.risk.shadowPollMs, 5000);
  }
  shadowManager = new ShadowPositionManager(config, () => rpcManager.connection);
  // v9h: Only start price polling in shadow mode. In live mode, shadow records entry + DexScreener only.
  if (config.risk.shadowMode) {
    shadowManager.start();
  } else {
    // Start timeout checker only (no PriceMonitor polling)
    shadowManager.startDataOnly();
  }
  if (config.risk.shadowMode) {
    logger.info('[bot] SHADOW MODE: Detect + Analyze + Track virtual positions (NO buying, 0 SOL cost)');
  } else {
    logger.info('[bot] LIVE MODE: Trading active + shadow data collection running');
  }

  // Setup swap executors
  let jupiterSwap: JupiterSwap | undefined;
  let raydiumSwap: RaydiumSwap | undefined;
  let pumpSwapSwap: PumpSwapSwap | undefined;
  let jitoBundler: JitoBundler | undefined;

  if (wallet && !detectionOnly) {
    // In shadow mode, only create PumpSwapSwap (for prefetch/observe, no buying)
    pumpSwapSwap = new PumpSwapSwap(rpcManager.connection, wallet);

    if (!config.risk.shadowMode) {
      jupiterSwap = new JupiterSwap(rpcManager.connection, wallet);
      raydiumSwap = new RaydiumSwap(rpcManager.connection, wallet);

      if (config.execution.useJito) {
        jitoBundler = new JitoBundler(
          rpcManager.connection,
          wallet,
          config.jito.blockEngineUrl,
        );
      }
    }
  }

  // v11j: Recreate swap executors when RPC connection resets (they cache Connection internally)
  // Since these vars are `let`, the closures in executeBuy/executeSell read the latest reference.
  if (wallet && !detectionOnly) {
    rpcManager.onConnectionReset(() => {
      logger.info('[rpc] Connection reset — recreating swap executors with fresh Connection');
      pumpSwapSwap = new PumpSwapSwap(rpcManager.connection, wallet!);
      if (!config.risk.shadowMode) {
        jupiterSwap = new JupiterSwap(rpcManager.connection, wallet!);
        raydiumSwap = new RaydiumSwap(rpcManager.connection, wallet!);
        if (config.execution.useJito) {
          jitoBundler = new JitoBundler(rpcManager.connection, wallet!, config.jito.blockEngineUrl);
        }
      }
    });
  }

  // Buy function used by position manager and copy executor
  const executeBuy = async (order: TradeOrder): Promise<TradeResult> => {
    if (!jupiterSwap) {
      return {
        success: false, inputAmount: order.amountIn, outputAmount: 0,
        pricePerToken: 0, fee: 0, timestamp: Date.now(), error: 'No swap executor',
      };
    }
    return jupiterSwap.executeSwap(order);
  };

  // Sell function for position manager - multi-strategy fallback
  // v8w: emergency=true → parallel PumpSwap+Jupiter (saves 12s+ on rug sells)
  const executeSell = async (
    tokenMint: import('@solana/web3.js').PublicKey,
    amount: number,
    poolAddress: import('@solana/web3.js').PublicKey,
    source?: import('./types.js').PoolSource,
    emergency?: boolean,
  ): Promise<TradeResult> => {
    const noExecutor: TradeResult = {
      success: false, inputAmount: amount, outputAmount: 0,
      pricePerToken: 0, fee: 0, timestamp: Date.now(), error: 'No swap executor',
    };

    // PROTECTION: Check we have enough SOL to pay sell TX fees (~0.001 SOL minimum)
    // v9w: Use cached balance (updated every 30s in background) — zero RPC calls in sell hot path
    // Before v9w: withAnalysisRetry getBalance added 3-8s to every sell attempt
    const MIN_SOL_FOR_SELL_FEES = 0.001;
    if (wallet) {
      const cachedBal = getCachedBalanceSol();
      if (cachedBal !== null && cachedBal < MIN_SOL_FOR_SELL_FEES) {
        logger.error(`[bot] ⚠️ Balance ${formatSol(cachedBal)} SOL too low for sell fees (cached). Cannot sell.`);
        return { ...noExecutor, error: `Balance too low for sell fees: ${formatSol(cachedBal)} SOL` };
      }
      // If cache is null (not yet populated), proceed anyway — selling is critical
    }

    // v10a: PRE-SELL BALANCE CHECK — if token balance is already 0, skip all sell attempts
    // Prevents infinite emergency sell loops when tokens were sold in a previous session
    // (e.g., iSfm: sells landed on-chain but bot didn't detect → position stays open → sell burst loop)
    if (wallet) {
      try {
        const tokenAccounts = await withAnalysisRetry(
          (conn) => conn.getParsedTokenAccountsByOwner(wallet!.publicKey, { mint: tokenMint }),
          rpcManager.connection, 5_000, true,
        );
        const tokenBalance = tokenAccounts.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
        const currentTokens = tokenBalance ? Number(tokenBalance.amount) : 0;
        if (currentTokens === 0) {
          logger.info(`[bot] ✅ PRE-SELL CHECK: Token balance already 0 — position already sold, closing immediately`);
          return { success: true, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now() };
        }
        if (currentTokens < amount * 0.1) {
          logger.info(`[bot] ⚠️ PRE-SELL CHECK: Only ${currentTokens} tokens remaining (requested ${amount}), adjusting sell amount`);
          amount = currentTokens; // Sell whatever is left
        }
      } catch (preCheckErr) {
        logger.debug(`[bot] Pre-sell balance check failed: ${String(preCheckErr).slice(0, 60)}, proceeding with sell`);
        // If check fails, proceed with normal sell flow
      }
    }

    // v9y: Give sell path absolute RPC priority — pause non-sell RPC calls
    // Data: A8HV TP1 had 3 sell attempts ALL timeout because pool detection consumed RPC slots
    enterSellPriority();
    try {

    // v8l: Track errors to propagate 429 info to position manager for proper backoff
    const sellErrors: string[] = [];
    let hit429 = false;

    // v8w: EMERGENCY PARALLEL SELL — fire PumpSwap + Jupiter simultaneously
    // Safe because Solana TXs are atomic: if both succeed, second has no tokens → fails
    // Saves 12s+ vs sequential (PumpSwap timeout was 12s before Jupiter even started)
    // v10b: Added 20s timeout per strategy — GzMNK3W3 PumpSwap sell hung indefinitely → isSelling stuck forever
    if (emergency && source === 'pumpswap' && pumpSwapSwap && jupiterSwap) {
      const sellStart = Date.now();
      logger.info('[bot] 🚨 EMERGENCY PARALLEL SELL: PumpSwap (skip sim) + Jupiter 99% simultaneous');

      const EMERGENCY_SELL_TIMEOUT_MS = 20_000;
      const emergencyTimeoutResult: TradeResult = { success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: 'Emergency sell timeout (20s)' };
      const makeEmergencyTimeout = () => new Promise<TradeResult>((resolve) => setTimeout(() => resolve(emergencyTimeoutResult), EMERGENCY_SELL_TIMEOUT_MS));

      // v10e: Keep references to actual sell promises for background sell tracking
      const actualPumpPromise = pumpSwapSwap.sell(tokenMint, amount, config.execution.slippageBps, poolAddress, false, true)
        .catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult));
      const actualJupPromise = jupiterSwap.executeSwap({
        type: 'sell', inputMint: tokenMint, outputMint: WSOL_MINT,
        amountIn: amount, slippageBps: 9900, useJito: false,
      }).catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult));

      const [pumpResult, jupResult] = await Promise.allSettled([
        Promise.race([actualPumpPromise, makeEmergencyTimeout()]),
        Promise.race([actualJupPromise, makeEmergencyTimeout()]),
      ]);
      const pumpVal = pumpResult.status === 'fulfilled' ? pumpResult.value : null;
      const jupVal = jupResult.status === 'fulfilled' ? jupResult.value : null;
      const elapsed = Date.now() - sellStart;

      // v9q: If BOTH succeeded, combine results (double-sell = all tokens sold)
      if (pumpVal?.success && jupVal?.success) {
        logger.warn(`[bot] ⚠️ DOUBLE SELL (emergency): Both PumpSwap and Jupiter succeeded in ${elapsed}ms — combining results`);
        return {
          success: true,
          inputAmount: (pumpVal.inputAmount ?? 0) + (jupVal.inputAmount ?? 0),
          outputAmount: (pumpVal.outputAmount ?? 0) + (jupVal.outputAmount ?? 0),
          pricePerToken: pumpVal.pricePerToken,
          fee: (pumpVal.fee ?? 0) + (jupVal.fee ?? 0),
          timestamp: Date.now(),
          txSignature: pumpVal.txSignature ?? jupVal.txSignature,
        };
      }
      if (pumpVal?.success) {
        // v10e: Track Jupiter background sell
        actualJupPromise.then(bgResult => {
          if (bgResult.success && bgResult.outputAmount > 0) {
            logger.warn(`[bot] ⚠️ BACKGROUND SELL (emergency): Jupiter completed +${bgResult.outputAmount} lamports after PumpSwap returned`);
            botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
          }
        }).catch(() => {});
        logger.info(`[bot] ✅ Emergency PumpSwap sell succeeded in ${elapsed}ms`);
        return pumpVal;
      }
      if (jupVal?.success) {
        // v10e: Track PumpSwap background sell
        actualPumpPromise.then(bgResult => {
          if (bgResult.success && bgResult.outputAmount > 0) {
            logger.warn(`[bot] ⚠️ BACKGROUND SELL (emergency): PumpSwap completed +${bgResult.outputAmount} lamports after Jupiter returned`);
            botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
          }
        }).catch(() => {});
        logger.info(`[bot] ✅ Emergency Jupiter sell succeeded in ${elapsed}ms`);
        return jupVal;
      }

      // v10e: BOTH failed — but sells may still complete in background. Track them.
      actualPumpPromise.then(bgResult => {
        if (bgResult.success && bgResult.outputAmount > 0) {
          logger.warn(`[bot] ⚠️ BACKGROUND SELL (emergency-late): PumpSwap completed +${bgResult.outputAmount} lamports after position closed`);
          botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
        }
      }).catch(() => {});
      actualJupPromise.then(bgResult => {
        if (bgResult.success && bgResult.outputAmount > 0) {
          logger.warn(`[bot] ⚠️ BACKGROUND SELL (emergency-late): Jupiter completed +${bgResult.outputAmount} lamports after position closed`);
          botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
        }
      }).catch(() => {});

      // Both failed — try PumpSwap FORCE as last resort
      logger.warn(`[bot] Emergency parallel sell failed in ${elapsed}ms (pump: ${pumpVal?.error?.slice(0, 60)}, jup: ${jupVal?.error?.slice(0, 60)})`);
      if (pumpVal?.error) sellErrors.push(pumpVal.error);
      if (jupVal?.error) sellErrors.push(jupVal.error);
      if (pumpVal?.error && /429|rate.limit|Too many/i.test(pumpVal.error)) hit429 = true;
      if (jupVal?.error && /429|rate.limit|Too many/i.test(jupVal.error)) hit429 = true;

      // Check if pool is drained (skip force mode)
      // v9z: Added Custom:6025 (PumpSwap pool closed/depleted)
      const poolDrained = pumpVal?.error?.includes('Expected SOL output is 0') || pumpVal?.error?.includes('Pool has 0 SOL')
        || pumpVal?.error?.includes('Custom:6001') || /Custom.?:?\s*602[45]/.test(jupVal?.error ?? '') || /Custom.?:?\s*602[45]/.test(pumpVal?.error ?? '');
      if (!poolDrained) {
        logger.info('[bot] [emergency-fallback] PumpSwap FORCE (accept any amount)...');
        // v10b: Timeout on force sell too — prevents indefinite hang
        const forceResult = await Promise.race([
          pumpSwapSwap.sell(tokenMint, amount, 10000, poolAddress, true, true)
            .catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult)),
          makeEmergencyTimeout(),
        ]);
        if (forceResult.success) return forceResult;
        if (forceResult.error) sellErrors.push(forceResult.error);
        logger.warn(`[bot] PumpSwap emergency force sell failed (${forceResult.error})`);
      } else {
        logger.warn('[bot] Pool drained, skipping force mode');
      }

      // v10a: Post-sell verification for emergency path too
      if (wallet) try {
        const tokenAccounts = await withAnalysisRetry(
          (conn) => conn.getParsedTokenAccountsByOwner(wallet!.publicKey, { mint: tokenMint }),
          rpcManager.connection, 5_000, true,
        );
        const bal = tokenAccounts.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
        if (!bal || Number(bal.amount) === 0) {
          logger.info(`[bot] ✅ POST-SELL RECOVERY (emergency): Token balance is 0 — sell landed!`);
          return { success: true, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now() };
        }
      } catch { /* continue to report failure */ }

      const errorSummary = hit429
        ? 'All emergency sell strategies failed (429 rate limit)'
        : `All emergency sell strategies failed: ${sellErrors[sellErrors.length - 1]?.slice(0, 80) ?? 'unknown'}`;
      logger.error(`[bot] ${errorSummary}`);
      return { ...noExecutor, error: errorSummary };
    }

    // v9t: PARALLEL SELL — PumpSwap + Jupiter simultaneously (2 rounds × 15s = 30s max)
    // CraP data (v9s): sequential 4×30s = 2+ min cascade when all RPCs were 429
    // Double-sell risk: position manager handles it via actualSold = min(result, tokenAmount)
    // Round 1: normal slippage (parallel) → Round 2: force slippage (parallel)
    const SELL_ROUND_TIMEOUT_MS = 15_000;
    const sellTimeoutResult: TradeResult = { success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: 'Sell round timeout (15s)' };
    const makeSellTimeout = () => new Promise<TradeResult>((resolve) => setTimeout(() => resolve(sellTimeoutResult), SELL_ROUND_TIMEOUT_MS));

    if (source === 'pumpswap' && pumpSwapSwap && jupiterSwap) {
      const sellStart = Date.now();

      // Round 1: PumpSwap + Jupiter in parallel (normal slippage)
      // v10e: Keep references to actual sell promises for background sell tracking
      logger.info('[bot] [sell-R1] PumpSwap + Jupiter parallel...');
      const pumpSellPromise1 = pumpSwapSwap.sell(tokenMint, amount, config.execution.slippageBps, poolAddress)
        .catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult));
      const jupSellPromise1 = jupiterSwap.executeSwap({
        type: 'sell', inputMint: tokenMint, outputMint: WSOL_MINT,
        amountIn: amount, slippageBps: config.execution.slippageBps, useJito: false,
      }).catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult));

      const [pumpR1, jupR1] = await Promise.allSettled([
        Promise.race([pumpSellPromise1, makeSellTimeout()]),
        Promise.race([jupSellPromise1, makeSellTimeout()]),
      ]);

      const pumpVal1 = pumpR1.status === 'fulfilled' ? pumpR1.value : null;
      const jupVal1 = jupR1.status === 'fulfilled' ? jupR1.value : null;
      const r1Elapsed = Date.now() - sellStart;

      // Handle double-sell (both succeeded) — position manager deducts actual tokens sold
      if (pumpVal1?.success && jupVal1?.success) {
        logger.warn(`[bot] ⚠️ DOUBLE SELL (R1): Both PumpSwap and Jupiter succeeded in ${r1Elapsed}ms — combining`);
        return {
          success: true,
          inputAmount: (pumpVal1.inputAmount ?? 0) + (jupVal1.inputAmount ?? 0),
          outputAmount: (pumpVal1.outputAmount ?? 0) + (jupVal1.outputAmount ?? 0),
          pricePerToken: pumpVal1.pricePerToken,
          fee: (pumpVal1.fee ?? 0) + (jupVal1.fee ?? 0),
          timestamp: Date.now(),
          txSignature: pumpVal1.txSignature ?? jupVal1.txSignature,
        };
      }
      if (pumpVal1?.success) {
        // v10e: Track Jupiter background sell if it completes after PumpSwap won the race
        jupSellPromise1.then(bgResult => {
          if (bgResult.success && bgResult.outputAmount > 0) {
            logger.warn(`[bot] ⚠️ BACKGROUND SELL (R1): Jupiter completed +${bgResult.outputAmount} lamports after PumpSwap returned`);
            botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
          }
        }).catch(() => {});
        logger.info(`[bot] ✅ PumpSwap sell succeeded in ${r1Elapsed}ms`);
        return pumpVal1;
      }
      if (jupVal1?.success) {
        // v10e: Track PumpSwap background sell if it completes after Jupiter won the race
        pumpSellPromise1.then(bgResult => {
          if (bgResult.success && bgResult.outputAmount > 0) {
            logger.warn(`[bot] ⚠️ BACKGROUND SELL (R1): PumpSwap completed +${bgResult.outputAmount} lamports after Jupiter returned`);
            botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
          }
        }).catch(() => {});
        logger.info(`[bot] ✅ Jupiter sell succeeded in ${r1Elapsed}ms`);
        return jupVal1;
      }

      // Both failed — track errors
      if (pumpVal1?.error) sellErrors.push(pumpVal1.error);
      if (jupVal1?.error) sellErrors.push(jupVal1.error);
      if (pumpVal1?.error && /429|rate.limit|Too many/i.test(pumpVal1.error)) hit429 = true;
      if (jupVal1?.error && /429|rate.limit|Too many/i.test(jupVal1.error)) hit429 = true;
      logger.warn(`[bot] R1 failed in ${r1Elapsed}ms (pump: ${pumpVal1?.error?.slice(0, 50)}, jup: ${jupVal1?.error?.slice(0, 50)})`);

      // Check if pool is drained (skip force mode)
      // v9y: Fixed Custom:6024 check — JSON.stringify produces "Custom":6024 not Custom:6024
      const jupError = jupVal1?.error ?? '';
      const pumpError = pumpVal1?.error ?? '';
      // v9z: Added Custom:6025 (PumpSwap pool closed/depleted)
      const poolDrained = pumpError.includes('Expected SOL output is 0') || pumpError.includes('Pool has 0 SOL')
        || pumpError.includes('Custom:6001') || /Custom.?:?\s*602[45]/.test(jupError) || /Custom.?:?\s*602[45]/.test(pumpError);

      if (!poolDrained) {
        // Round 2: PumpSwap FORCE + Jupiter 99% in parallel
        // v10d: Cancel flag prevents double-sell (PumpSwap aborts if Jupiter already succeeded)
        logger.info('[bot] [sell-R2] PumpSwap FORCE + Jupiter 99% parallel...');
        const r2CancelFlag = { cancelled: false };

        // Keep references to ACTUAL sell promises (separate from Promise.race timeouts)
        const pumpSellPromise2 = pumpSwapSwap.sell(tokenMint, amount, 10000, poolAddress, true, false, r2CancelFlag)
          .catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult));
        const jupSellPromise2 = jupiterSwap.executeSwap({
          type: 'sell', inputMint: tokenMint, outputMint: WSOL_MINT,
          amountIn: amount, slippageBps: 9900, useJito: false,
        }).then(result => {
          if (result.success) r2CancelFlag.cancelled = true; // v10d: Cancel PumpSwap if Jupiter wins
          return result;
        }).catch((err: unknown) => ({ success: false, inputAmount: amount, outputAmount: 0, pricePerToken: 0, fee: 0, timestamp: Date.now(), error: String(err) } as TradeResult));

        const [pumpR2, jupR2] = await Promise.allSettled([
          Promise.race([pumpSellPromise2, makeSellTimeout()]),
          Promise.race([jupSellPromise2, makeSellTimeout()]),
        ]);

        const pumpVal2 = pumpR2.status === 'fulfilled' ? pumpR2.value : null;
        const jupVal2 = jupR2.status === 'fulfilled' ? jupR2.value : null;
        const r2Elapsed = Date.now() - sellStart;

        if (pumpVal2?.success && jupVal2?.success) {
          logger.warn(`[bot] ⚠️ DOUBLE SELL (R2): Both succeeded in ${r2Elapsed}ms — combining`);
          return {
            success: true,
            inputAmount: (pumpVal2.inputAmount ?? 0) + (jupVal2.inputAmount ?? 0),
            outputAmount: (pumpVal2.outputAmount ?? 0) + (jupVal2.outputAmount ?? 0),
            pricePerToken: pumpVal2.pricePerToken,
            fee: (pumpVal2.fee ?? 0) + (jupVal2.fee ?? 0),
            timestamp: Date.now(),
            txSignature: pumpVal2.txSignature ?? jupVal2.txSignature,
          };
        }
        if (pumpVal2?.success) {
          // v10d: PumpSwap won — set cancel flag and listen for Jupiter background completion
          r2CancelFlag.cancelled = true;
          jupSellPromise2.then(bgResult => {
            if (bgResult.success && bgResult.outputAmount > 0) {
              logger.warn(`[bot] ⚠️ BACKGROUND SELL: Jupiter completed +${bgResult.outputAmount} lamports after PumpSwap returned`);
              botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
            }
          }).catch(() => {});
          logger.info(`[bot] ✅ PumpSwap force sell succeeded in ${r2Elapsed}ms`);
          return pumpVal2;
        }
        if (jupVal2?.success) {
          // v10d: Jupiter won — cancel flag already set above, listen for PumpSwap background completion
          pumpSellPromise2.then(bgResult => {
            if (bgResult.success && bgResult.outputAmount > 0) {
              logger.warn(`[bot] ⚠️ BACKGROUND SELL: PumpSwap completed +${bgResult.outputAmount} lamports after Jupiter returned`);
              botEmitter.emit('backgroundSellCompleted', { tokenMint: tokenMint.toBase58(), outputAmountLamports: bgResult.outputAmount });
            }
          }).catch(() => {});
          logger.info(`[bot] ✅ Jupiter 99% sell succeeded in ${r2Elapsed}ms`);
          return jupVal2;
        }

        if (pumpVal2?.error) sellErrors.push(pumpVal2.error);
        if (jupVal2?.error) sellErrors.push(jupVal2.error);
        if (pumpVal2?.error && /429|rate.limit|Too many/i.test(pumpVal2.error)) hit429 = true;
        if (jupVal2?.error && /429|rate.limit|Too many/i.test(jupVal2.error)) hit429 = true;
      } else {
        logger.warn('[bot] Pool drained, skipping force sell attempts');
      }
    } else {
      // Fallback: only one executor available — try sequentially
      if (source === 'pumpswap' && pumpSwapSwap) {
        logger.info('[bot] [sell-1/1] PumpSwap only...');
        const result = await pumpSwapSwap.sell(tokenMint, amount, config.execution.slippageBps, poolAddress);
        if (result.success) return result;
        if (result.error) sellErrors.push(result.error);
        if (result.error && /429|rate.limit|Too many/i.test(result.error)) hit429 = true;
      }
      if (jupiterSwap) {
        logger.info('[bot] [sell-1/1] Jupiter only...');
        const result = await jupiterSwap.executeSwap({
          type: 'sell', inputMint: tokenMint, outputMint: WSOL_MINT,
          amountIn: amount, slippageBps: 9900, useJito: false,
        });
        if (result.success) return result;
        if (result.error) sellErrors.push(result.error);
        if (result.error && /429|rate.limit|Too many/i.test(result.error)) hit429 = true;
      }
    }

    // v10a: POST-SELL VERIFICATION — Before reporting failure, check if tokens were actually sold.
    // iSfm trade: both Jupiter and PumpSwap TXs landed on-chain but pollConfirmation missed them.
    // Bot looped trying to sell tokens that no longer existed for 10+ minutes.
    if (wallet) try {
      logger.info(`[bot] [post-sell-check] Verifying token balance before reporting failure...`);
      const tokenAccounts = await withAnalysisRetry(
        (conn) => conn.getParsedTokenAccountsByOwner(wallet!.publicKey, { mint: tokenMint }),
        rpcManager.connection,
        5_000,
        true, // isSellPath: bypass concurrency limiter
      );
      const tokenBalance = tokenAccounts.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
      const remainingTokens = tokenBalance ? Number(tokenBalance.amount) : 0;

      if (remainingTokens === 0) {
        // Tokens are GONE — a sell TX actually landed despite polling timeout!
        logger.info(`[bot] ✅ POST-SELL RECOVERY: Token balance is 0 — sell succeeded on-chain despite polling failures!`);
        return {
          success: true,
          inputAmount: amount,
          outputAmount: 0, // Unknown, but position manager will handle via balance diff
          pricePerToken: 0,
          fee: 0,
          timestamp: Date.now(),
          txSignature: undefined,
          // Mark as recovered so position manager knows output is approximate
          error: undefined,
        };
      } else if (remainingTokens < amount * 0.5) {
        // Partial sell — some tokens were sold (e.g., TP1 50% sell landed)
        logger.info(`[bot] ⚠️ POST-SELL PARTIAL: ${remainingTokens} tokens remaining (expected ${amount}) — partial sell landed`);
        return {
          success: true,
          inputAmount: amount - remainingTokens,
          outputAmount: 0,
          pricePerToken: 0,
          fee: 0,
          timestamp: Date.now(),
        };
      } else {
        logger.info(`[bot] [post-sell-check] Token balance: ${remainingTokens} (sell truly failed)`);
      }
    } catch (checkErr) {
      logger.warn(`[bot] [post-sell-check] Balance check failed: ${String(checkErr).slice(0, 60)}`);
      // Continue to report failure — can't verify
    }

    // v8l: Propagate 429 info so TP/SL handlers apply proper backoff
    const errorSummary = hit429
      ? 'All sell strategies failed (429 rate limit)'
      : `All sell strategies failed: ${sellErrors[sellErrors.length - 1]?.slice(0, 80) ?? 'unknown'}`;
    logger.error(`[bot] ${errorSummary}`);
    return { ...noExecutor, error: errorSummary };

    } finally {
      exitSellPriority();
    }
  };

  // Setup position manager (pass connection for PumpSwap price fallback)
  // In shadow mode, we still create it for the startup cleanup/status code to work,
  // but it won't receive any real positions
  const positionManager = new PositionManager(config, executeSell, () => rpcManager.connection);
  if (!config.risk.shadowMode) {
    positionManager.start();
  }

  // Startup cleanup: sell stale positions immediately, monitor recent ones
  // Skip in shadow mode (no real positions to clean up)
  const stuckPositions = config.risk.shadowMode ? [] : positionManager.getOpenPositions();
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  if (stuckPositions.length > 0) {
    const now = Date.now();
    const stale = stuckPositions.filter(p => (now - p.openedAt) > STALE_THRESHOLD_MS);
    const recent = stuckPositions.filter(p => (now - p.openedAt) <= STALE_THRESHOLD_MS);

    if (recent.length > 0) {
      logger.info(`[bot] Found ${recent.length} recent position(s) from previous session, will monitor via timeout/SL`);
    }

    if (stale.length > 0) {
      logger.warn(`[bot] ⚠️ ${stale.length} STALE position(s) (>30min old) - selling immediately`);
      // Sell stale positions in background (don't block startup)
      (async () => {
        for (const pos of stale) {
          const ageMin = ((now - pos.openedAt) / 60_000).toFixed(0);
          logger.warn(`[bot] Force-selling stale position ${pos.id.slice(0, 8)}... (age: ${ageMin}min)`);
          try {
            await positionManager.forceClosePosition(pos.id, 'stale_restart');
          } catch (err) {
            logger.error(`[bot] Failed to force-sell stale ${pos.id.slice(0, 8)}...: ${err}`);
          }
        }
      })();
    }
  }

  // Setup Telegram
  let telegramBot: TelegramBot | undefined;
  if (config.telegram.enabled && config.telegram.botToken && wallet) {
    telegramBot = new TelegramBot({
      config,
      wallet,
      rpcManager,
      positionManager,
      scorer,
    });
    await telegramBot.start();

    // v11g: Connect WS alerts to Telegram notifications
    wsManager.onAlert((message) => {
      telegramBot!.notificationService.sendMessage(message).catch(() => {});
    });
  }

  // Setup copy trading
  let walletTracker: WalletTracker | undefined;
  let copyExecutor: CopyExecutor | undefined;

  if (config.copyTrading.enabled && !detectionOnly) {
    walletTracker = new WalletTracker(rpcManager.primaryConnection, wsManager);
    copyExecutor = new CopyExecutor(config, executeBuy, scorer);
    await walletTracker.start();
    copyExecutor.start();
  }

  // ──── v9a: DexScreener outcome checks for ALL pools (shadow mode) ───
  function schedulePoolOutcomeChecks(poolId: string, tokenMint: string): void {
    const delays = [5, 15, 30, 60]; // minutes
    for (const min of delays) {
      const label = min >= 60 ? `${min / 60}h` : `${min}min`;
      setTimeout(async () => {
        try {
          const DEXSCREENER_TOKEN = 'https://api.dexscreener.com/latest/dex/tokens';
          const res = await fetch(`${DEXSCREENER_TOKEN}/${tokenMint}`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) return;
          const json = await res.json() as any;
          const pairs = json?.pairs;
          if (!pairs || pairs.length === 0) {
            tradeLogger.savePoolOutcomeCheck(poolId, tokenMint, label, min, {
              priceNative: 0, marketCap: 0, liquidityUsd: 0,
              volume24h: 0, txns24h: 0, alive: false,
            });
            return;
          }
          const p = pairs[0];
          tradeLogger.savePoolOutcomeCheck(poolId, tokenMint, label, min, {
            priceNative: parseFloat(p.priceNative) || 0,
            marketCap: p.marketCap || 0,
            liquidityUsd: p.liquidity?.usd || 0,
            volume24h: p.volume?.h24 || 0,
            txns24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
            alive: true,
          });
        } catch {
          // DexScreener check is non-critical
        }
      }, min * 60_000);
    }
  }

  // ──── MAIN PIPELINE ────────────────────────────────────────────────

  let poolCount = 0;
  let sessionBuyCount = 0; // Trades ejecutados en esta sesión

  // ── CIRCUIT BREAKER: Prevents fee drain from consecutive failures ──
  let consecutiveBuyFailures = 0;
  let circuitBreakerUntil = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;       // Pause after 3 consecutive failed buys
  const CIRCUIT_BREAKER_PAUSE_MS = 5 * 60 * 1000; // 5 min cooldown
  const MIN_BALANCE_FLOOR_SOL = 0.002;      // Hard stop: never trade below this (v9n: lowered for 0.001 validation trades)
  let buyInProgress = false;                 // Lock to prevent concurrent buys (race condition fix)

  // ── v9s: TIERED ANALYSIS — filter cheap before spending RPC budget ──
  // Tier 0: Deployer rate limiter (0 RPC) — blocks spam deployers
  const deployerRecentPools = new Map<string, number[]>(); // deployer → timestamps
  const DEPLOYER_RATE_WINDOW_MS = 5 * 60 * 1000; // 5 min window
  const DEPLOYER_RATE_MAX_POOLS = 2; // max pools per deployer in window

  // Tier 2: Concurrency limiter for full analysis
  let activeAnalysisCount = 0;
  // v11a: Raised 1→5. Helius paid tier (50 req/s) eliminates RPC contention.
  // 5 concurrent × ~10 calls each = 50 calls competing = well within 50 req/s limit.
  const MAX_CONCURRENT_ANALYSIS = 5;

  // Cleanup deployer rate map every 10min
  setInterval(() => {
    const now = Date.now();
    for (const [deployer, timestamps] of deployerRecentPools) {
      const valid = timestamps.filter(t => now - t < DEPLOYER_RATE_WINDOW_MS);
      if (valid.length === 0) deployerRecentPools.delete(deployer);
      else deployerRecentPools.set(deployer, valid);
    }
  }, 10 * 60 * 1000);

  botEmitter.on('newPool', async (pool: DetectedPool) => {
    const tokenKey = pool.baseMint.toBase58();
    const txKey = pool.txSignature;

    // v9f DEBUG: trace dedup layers
    const hasTx = seenTxSignatures.has(txKey);
    const hasMint = seenTokenMints.has(tokenKey);
    const hasProc = processingTokens.has(tokenKey);
    if (hasTx || hasMint || hasProc) {
      logger.warn(`[dedup] BLOCKED ${tokenKey.slice(0, 8)} from=${pool.source} | tx=${hasTx} mint=${hasMint} proc=${hasProc} | sizes: tx=${seenTxSignatures.size} mint=${seenTokenMints.size} proc=${processingTokens.size}`);
    }

    // v9h: Add mint to seenTokenMints FIRST (before TX check) to prevent race condition
    // where same token arrives with different TX signatures 229ms apart and both pass Layer 2
    if (hasTx || hasMint || hasProc) {
      return;
    }

    // Acquire ALL locks atomically BEFORE any async work
    seenTxSignatures.add(txKey);
    processingTokens.add(tokenKey);
    seenTokenMints.add(tokenKey);

    poolCount++;
    const latency = Date.now() - pool.detectedAt;

    logger.info('');
    logger.info(`===== POOL NUEVO #${poolCount} =====`);
    logger.info(`Fuente:   ${pool.source}`);
    logger.info(`Token:    ${pool.baseMint.toBase58()}`);
    logger.info(`Pool:     ${shortenAddress(pool.poolAddress)}`);
    logger.info(`TX:       ${solscanTx(pool.txSignature)}`);
    logger.info(`Latencia: ${latency}ms`);

    try {
      // Verificar si está pausado
      if (telegramBot?.isPaused) {
        logger.info('[bot] Bot PAUSADO, ignorando...');
        return;
      }

      // Skip buy-related locks in shadow mode (shadow positions don't conflict)
      if (!config.risk.shadowMode) {
        // v9j: Pause ALL analysis during active sells — free up entire RPC budget for selling
        // Data (v9i): analysis of new pools during sell burst created 429 storm (7+ RPC calls per pool
        // competing with sell attempts). Result: sells failed, position stayed open, blocked new trades.
        if (positionManager.isSelling) {
          logger.info(`[bot] ⏸️ Sell in progress, pausing analysis for ${tokenKey.slice(0, 8)} (RPC budget protection)`);
          return;
        }

        // Verificar máximo de posiciones + buy lock (prevents race condition)
        if (buyInProgress) {
          logger.info(`[bot] 🔒 Buy already in progress, skipping (race condition prevention)`);
          return;
        }
        if (positionManager.activeTradeCount >= config.risk.maxConcurrent) {
          logger.info(`[bot] Máximo de trades activos (${config.risk.maxConcurrent}) alcanzado, ignorando...`);
          return;
        }

        // Verificar límite de trades por sesión
        if (config.risk.maxTradesPerSession > 0 && sessionBuyCount >= config.risk.maxTradesPerSession) {
          logger.info(`[bot] Límite de trades por sesión (${config.risk.maxTradesPerSession}) alcanzado, solo gestionando posiciones existentes`);
          return;
        }
      }

      // Paso 0: Verificar latencia de detección
      // Si detectamos el evento por WebSocket, CONFIAMOS en que es nuevo
      // Solo rechazamos si la latencia es muy alta (podría ser evento replay)
      const MAX_DETECTION_LATENCY_MS = 30000; // 30 segundos máximo
      if (latency > MAX_DETECTION_LATENCY_MS) {
        logger.info(`[bot] ❌ Latencia muy alta (${latency}ms > ${MAX_DETECTION_LATENCY_MS}ms), posible evento viejo`);
        return;
      }
      logger.info(`[bot] ✓ Detección en tiempo real (${latency}ms de latencia)`);

      // ═══════ v9s: TIER 0 — FREE CHECKS (0 RPC calls) ═══════
      // Deployer rate limiter: skip if deployer launched 2+ pools in last 5min
      if (pool.deployer) {
        const now = Date.now();
        const recent = deployerRecentPools.get(pool.deployer) ?? [];
        // Clean old timestamps
        const filtered = recent.filter(t => now - t < DEPLOYER_RATE_WINDOW_MS);
        filtered.push(now);
        deployerRecentPools.set(pool.deployer, filtered);

        if (filtered.length > DEPLOYER_RATE_MAX_POOLS) {
          logger.info(`[tier0] ❌ Deployer ${pool.deployer.slice(0, 8)}... has ${filtered.length} pools in 5min (max ${DEPLOYER_RATE_MAX_POOLS}) → SKIP`);
          tradeLogger.logDetection(pool, { score: 0, passed: false, mint: pool.baseMint, checks: {} as any, timestamp: Date.now() });
          tradeLogger.updateRejectionReasons(pool.id, 'deployer_rate_limit');
          tradeLogger.updateRejectionStage(pool.id, 'tier0');
          // Still open shadow for data collection
          if (shadowManager) {
            shadowManager.openShadowPosition(pool, 0, 0, null, null, null, 0);
          }
          return;
        }

        // Scammer blacklist check (instant, in-memory)
        if (scammerBlacklist.isBlacklisted(pool.deployer)) {
          logger.info(`[tier0] ❌ Deployer ${pool.deployer.slice(0, 8)}... is BLACKLISTED → SKIP`);
          tradeLogger.logDetection(pool, { score: 0, passed: false, mint: pool.baseMint, checks: {} as any, timestamp: Date.now() });
          tradeLogger.updateRejectionReasons(pool.id, 'deployer_blacklisted');
          tradeLogger.updateRejectionStage(pool.id, 'tier0');
          if (shadowManager) {
            shadowManager.openShadowPosition(pool, 0, 0, null, null, null, 0);
          }
          return;
        }

        // v9A: AllenHark external blacklist check (instant, in-memory, 4,178+ wallets)
        if (allenHarkBlacklist.size > 0 && allenHarkBlacklist.isBlacklisted(pool.deployer)) {
          logger.info(`[tier0] ❌ Deployer ${pool.deployer.slice(0, 8)}... AllenHark BLACKLISTED → SKIP`);
          tradeLogger.logDetection(pool, { score: 0, passed: false, mint: pool.baseMint, checks: {} as any, timestamp: Date.now() });
          tradeLogger.updateRejectionReasons(pool.id, 'allenhark_blacklisted');
          tradeLogger.updateRejectionStage(pool.id, 'tier0');
          if (shadowManager) {
            shadowManager.openShadowPosition(pool, 0, 0, null, null, null, 0);
          }
          return;
        }
      }

      // ═══════ v9s: TIER 1 — CHEAP CHECKS (1-2 RPC calls) ═══════
      // Check Token-2022 + authorities (1 call) and pool reserves for liquidity (1 call)
      // These filter ~60% of pools before expensive Tier 2 analysis
      {
        const tier1Start = Date.now();
        // Run authority check + pool state in parallel (2 RPC calls max)
        const [authResult, poolStateResult] = await Promise.all([
          checkAuthorities(rpcManager.connection, pool.baseMint, pool.source)
            .catch(() => null),
          (pool.source === 'pumpswap' && pumpSwapSwap)
            ? pumpSwapSwap.getPoolReservesQuick(pool.poolAddress).catch(() => null)
            : Promise.resolve(null),
        ]);

        // Token-2022 instant block
        if (authResult?.isToken2022) {
          const elapsed = Date.now() - tier1Start;
          logger.warn(`[tier1] 🚨 Token-2022 BLOCKED for ${tokenKey.slice(0, 8)}... (${elapsed}ms) → SKIP`);
          tradeLogger.logDetection(pool, { score: 0, passed: false, mint: pool.baseMint, checks: { isToken2022: true } as any, timestamp: Date.now() });
          tradeLogger.updateRejectionReasons(pool.id, 'token_2022');
          tradeLogger.updateRejectionStage(pool.id, 'tier1');
          if (shadowManager) {
            shadowManager.openShadowPosition(pool, 0, 0, null, null, null, 0);
          }
          return;
        }

        // Liquidity check from reserves
        // Rough estimate: SOL price ~$80-200, minLiq=$5K → need at least ~12.5 SOL reserves
        // Using conservative $200/SOL so we don't accidentally block valid pools
        if (poolStateResult !== null) {
          const solReserveSol = poolStateResult / 1e9;
          // Pool liq = SOL reserves × SOL price × 2 (both sides)
          // At $200/SOL: 12.5 SOL = $5K. Use this as max estimate to be conservative.
          const conservativeLiqUsd = solReserveSol * 200 * 2;
          if (conservativeLiqUsd < config.analysis.minLiquidityUsd) {
            // Even at highest reasonable SOL price, liq is too low
            const elapsed = Date.now() - tier1Start;
            logger.warn(`[tier1] ❌ Pool reserves ${solReserveSol.toFixed(2)} SOL → max ~$${Math.round(conservativeLiqUsd)} < $${config.analysis.minLiquidityUsd} for ${tokenKey.slice(0, 8)}... (${elapsed}ms) → SKIP`);
            tradeLogger.logDetection(pool, { score: 0, passed: false, mint: pool.baseMint, checks: { liquidityUsd: conservativeLiqUsd } as any, timestamp: Date.now() });
            tradeLogger.updateRejectionReasons(pool.id, 'low_liq_tier1');
            tradeLogger.updateRejectionStage(pool.id, 'tier1');
            if (shadowManager) {
              shadowManager.openShadowPosition(pool, 0, 0, null, null, null, conservativeLiqUsd);
            }
            return;
          }
        }
        logger.debug(`[tier1] ✓ Passed cheap checks (${Date.now() - tier1Start}ms)`);
      }

      // ═══════ v9s: TIER 2 GATE — Concurrency limiter ═══════
      // Max N full analyses simultaneously. Drop if over limit (pool is already old).
      if (activeAnalysisCount >= MAX_CONCURRENT_ANALYSIS) {
        logger.info(`[tier2] ❌ Analysis queue full (${activeAnalysisCount}/${MAX_CONCURRENT_ANALYSIS}) → SKIP ${tokenKey.slice(0, 8)}...`);
        tradeLogger.logDetection(pool, { score: 0, passed: false, mint: pool.baseMint, checks: {} as any, timestamp: Date.now() });
        tradeLogger.updateRejectionReasons(pool.id, 'analysis_queue_full');
        tradeLogger.updateRejectionStage(pool.id, 'tier2_gate');
        if (shadowManager) {
          shadowManager.openShadowPosition(pool, 0, 0, null, null, null, 0);
        }
        return;
      }
      activeAnalysisCount++;

      // ═══════ TIER 2 — FULL ANALYSIS (5-8 RPC calls) ═══════
      try {

      // B1: Prefetch pool state + creator deep profile (runs in parallel with scoring)
      // Deep profile traces funding source (2 hops), checks blacklist, computes reputation
      let coinCreator: string | null = null;
      let creatorAge: CreatorAgeResult | null = null;
      let creatorDeepProfile: CreatorDeepProfile | null = null;
      const prefetchPromise = (pool.source === 'pumpswap' && pumpSwapSwap)
        ? pumpSwapSwap.prefetchPoolState(pool).then(async (creator) => {
            if (creator) {
              if (config.analysis.creatorDeepCheck.enabled) {
                // Deep profile: traces funding, checks blacklist, computes reputation
                // v11a: Reduced 8s→3s — Helius paid tier, no 429 cycling delays
                const DEEP_TIMEOUT_MS = 3_000;
                const deepPromise = getCreatorDeepProfile(
                  rpcManager.connection, creator, scammerBlacklist, creatorTracker,
                );
                const deepTimeout = new Promise<null>((resolve) =>
                  setTimeout(() => { logger.warn(`[creator-deep] Profile timed out (${DEEP_TIMEOUT_MS / 1000}s), skipping`); resolve(null); }, DEEP_TIMEOUT_MS),
                );
                const profile = await Promise.race([deepPromise, deepTimeout]);
                return { creator, age: null as CreatorAgeResult | null, profile };
              } else {
                // Fallback: simple age check (original behavior)
                const age = await checkCreatorWalletAge(rpcManager.connection, creator);
                return { creator, age, profile: null as CreatorDeepProfile | null };
              }
            }
            return { creator, age: null as CreatorAgeResult | null, profile: null as CreatorDeepProfile | null };
          }).catch(() => ({ creator: null as string | null, age: null as CreatorAgeResult | null, profile: null as CreatorDeepProfile | null }))
        : Promise.resolve({ creator: null as string | null, age: null as CreatorAgeResult | null, profile: null as CreatorDeepProfile | null });

      // ═══════ v9z: PHASE 1 — FAST ANALYSIS + CREATOR PREFETCH (~2-3s) ═══════
      // v9z fix: Wrap prefetch with 5s timeout — prefetchPoolState has 3 RPC fallbacks
      // that can hang 60+s if RPCs are slow, blocking the entire fast pipeline
      const PREFETCH_TIMEOUT_MS = 5_000;
      const defaultPrefetch = { creator: null as string | null, age: null as CreatorAgeResult | null, profile: null as CreatorDeepProfile | null };
      const timedPrefetch = Promise.race([
        prefetchPromise,
        new Promise<typeof defaultPrefetch>((resolve) => setTimeout(() => {
          logger.warn(`[prefetch] Creator prefetch timed out (${PREFETCH_TIMEOUT_MS / 1000}s), skipping`);
          resolve(defaultPrefetch);
        }, PREFETCH_TIMEOUT_MS)),
      ]).catch(() => defaultPrefetch);

      const [fastSecurity, prefetchResult] = await Promise.all([
        scorer.scoreFast(pool),
        timedPrefetch,
      ]);
      coinCreator = prefetchResult.creator;
      creatorAge = prefetchResult.age;
      creatorDeepProfile = prefetchResult.profile;

      // Record creator for tracking (even if we don't buy - builds history)
      if (coinCreator) {
        creatorTracker.recordCreator(coinCreator, tokenKey, pool.poolAddress.toBase58());
        if (creatorDeepProfile) {
          creatorTracker.updateDeepProfile(coinCreator, {
            fundingSource: creatorDeepProfile.fundingSource,
            fundingSourceHop2: creatorDeepProfile.fundingSourceHop2,
            walletAgeSeconds: creatorDeepProfile.walletAgeSeconds,
            txCount: creatorDeepProfile.txCount,
            solBalance: creatorDeepProfile.solBalance,
            reputationScore: creatorDeepProfile.reputationScore,
          });
        }
      }

      // Apply creator reputation to fast score
      // v11b: Minor penalties (young_wallet, -3 or less) are deferred to avoid blocking at fast stage.
      // PumpSwap base=50 = fast_min, so even -3 blocks everything. Defer small penalties to deferred phase.
      // Severe penalties (scammer network -20, new_wallet_low_balance -10) still apply at fast.
      let deferredCreatorPenalty = 0;
      if (creatorDeepProfile && config.analysis.creatorDeepCheck.reputationWeight && creatorDeepProfile.reputationScore !== 0) {
        if (creatorDeepProfile.reputationScore <= -10) {
          // Severe penalty → apply at fast stage (scammer_network -20, new_wallet_low_balance -10)
          const oldScore = fastSecurity.score;
          fastSecurity.score = Math.max(0, Math.min(100, fastSecurity.score + creatorDeepProfile.reputationScore));
          fastSecurity.passed = fastSecurity.score >= config.analysis.minScore;
          logger.info(`[bot] Creator reputation: ${creatorDeepProfile.reputationScore} (${creatorDeepProfile.reputationReason}) → score ${oldScore}→${fastSecurity.score}`);
        } else if (creatorDeepProfile.reputationScore < 0) {
          // Minor penalty → defer to deferred phase (young_wallet, etc.)
          deferredCreatorPenalty = creatorDeepProfile.reputationScore;
          logger.info(`[bot] Creator reputation: ${creatorDeepProfile.reputationScore} (${creatorDeepProfile.reputationReason}) → deferred to slow checks`);
        } else {
          // Bonus → apply at fast stage
          const oldScore = fastSecurity.score;
          fastSecurity.score = Math.max(0, Math.min(100, fastSecurity.score + creatorDeepProfile.reputationScore));
          fastSecurity.passed = fastSecurity.score >= config.analysis.minScore;
          logger.info(`[bot] Creator reputation: +${creatorDeepProfile.reputationScore} (${creatorDeepProfile.reputationReason}) → score ${oldScore}→${fastSecurity.score}`);
        }
      }

      // v9a: Schedule DexScreener outcome checks for ALL pools (even rejected ones)
      schedulePoolOutcomeChecks(pool.id, pool.baseMint.toBase58());

      // v8p: Save creator deep check results
      if (creatorDeepProfile) {
        tradeLogger.updateCreatorDeepResult(pool.id, creatorDeepProfile.reputationScore, creatorDeepProfile.fundingSource);
      }

      // Shadow helper (uses fastSecurity initially, updated to security after deferred)
      let currentScore = fastSecurity.score;
      const openShadowForRejected = () => {
        if (shadowManager) {
          const shadow = shadowManager.openShadowPosition(
            pool, currentScore, 0, null, null, null,
            fastSecurity.checks.liquidityUsd,
          );
          if (shadow) {
            logger.info(`[shadow] Tracking rejected: ${tokenKey.slice(0, 8)} | score=${currentScore}`);
          } else {
            logger.debug(`[shadow] DROPPED: ${tokenKey.slice(0, 8)} | score=${currentScore}`);
          }
        }
      };

      // ═══════ FAST REJECTION — if fast score fails, skip deferred + observation ═══════
      if (!fastSecurity.passed) {
        tradeLogger.logDetection(pool, fastSecurity);
        const reasons: string[] = [];
        if (!fastSecurity.checks.mintAuthorityRevoked) reasons.push('mint_auth');
        if (!fastSecurity.checks.freezeAuthorityRevoked) reasons.push('freeze_auth');
        if (fastSecurity.checks.isHoneypot) reasons.push('honeypot');
        if (fastSecurity.checks.liquidityUsd < config.analysis.minLiquidityUsd) reasons.push('low_liq');
        if (fastSecurity.checks.dangerousExtensions?.length) reasons.push('dangerous_ext');
        tradeLogger.updateRejectionReasons(pool.id, reasons.join(','));
        tradeLogger.updateRejectionStage(pool.id, 'fast_analysis');
        logger.info(`[bot] ❌ FAST REJECT (${fastSecurity.score}/100)`);
        openShadowForRejected();
        return;
      }

      // Hard liquidity filter
      if (fastSecurity.checks.liquidityUsd < config.analysis.minLiquidityUsd) {
        tradeLogger.logDetection(pool, fastSecurity);
        logger.info(`[bot] ❌ Liquidity $${Math.round(fastSecurity.checks.liquidityUsd)} < $${config.analysis.minLiquidityUsd} minimum`);
        tradeLogger.updateRejectionReasons(pool.id, 'low_liq_hard');
        tradeLogger.updateRejectionStage(pool.id, 'liquidity_filter');
        openShadowForRejected();
        return;
      }

      logger.info(`[bot] ✅ FAST PASS (${fastSecurity.score}/100), starting deferred + observation...`);

      // ANTI-RUG: Creator history (uses fast data only — no deferred needed)
      if (coinCreator) {
        const creatorHistory = creatorTracker.getCreatorHistory(coinCreator);
        if (creatorHistory.totalTokens > 0) {
          logger.info(`[bot] Creator ${coinCreator.slice(0, 8)}... historial: ${creatorHistory.totalTokens} tokens, ${creatorHistory.rugs} rugs, ${creatorHistory.winners} winners`);
        }
        if (creatorHistory.isRepeatRugger) {
          logger.warn(`[bot] ❌ REPEAT RUGGER detectado: ${coinCreator.slice(0, 8)}... tiene ${creatorHistory.rugs} rugs previos. Skipping.`);
          tradeLogger.logDetection(pool, fastSecurity);
          tradeLogger.updateRejectionReasons(pool.id, 'repeat_rugger');
          tradeLogger.updateRejectionStage(pool.id, 'creator_history');
          openShadowForRejected();
          return;
        }
        if (creatorHistory.winners >= 2 && creatorHistory.rugs === 0) {
          logger.info(`[bot] Creator confiable: ${coinCreator.slice(0, 8)}... tiene ${creatorHistory.winners} winners, 0 rugs`);
        }
      }

      // v9A: AllenHark check on funding source (if available from deep profile)
      if (creatorDeepProfile?.fundingSource && allenHarkBlacklist.size > 0) {
        if (allenHarkBlacklist.isBlacklisted(creatorDeepProfile.fundingSource)) {
          logger.warn(`[bot] ❌ Funding source ${creatorDeepProfile.fundingSource.slice(0, 8)}... AllenHark BLACKLISTED → SKIP`);
          tradeLogger.logDetection(pool, fastSecurity);
          tradeLogger.updateRejectionReasons(pool.id, 'allenhark_funder_blacklisted');
          tradeLogger.updateRejectionStage(pool.id, 'creator_deep');
          openShadowForRejected();
          return;
        }
      }

      // ANTI-RUG: Creator deep check (scammer network, etc.)
      if (creatorDeepProfile) {
        if (creatorDeepProfile.isKnownScammerNetwork) {
          logger.warn(`[bot] ❌ SCAMMER NETWORK: creator funded by blacklisted wallet. Skipping.`);
          tradeLogger.logDetection(pool, fastSecurity);
          tradeLogger.updateRejectionReasons(pool.id, 'scammer_network');
          tradeLogger.updateRejectionStage(pool.id, 'creator_deep');
          openShadowForRejected();
          return;
        }
        if (creatorDeepProfile.fundingNetworkSize >= config.analysis.creatorDeepCheck.networkThreshold) {
          logger.warn(`[bot] ❌ SCAM CLUSTER: funder has ${creatorDeepProfile.fundingNetworkSize} creators. Skipping.`);
          tradeLogger.logDetection(pool, fastSecurity);
          tradeLogger.updateRejectionReasons(pool.id, 'scam_cluster');
          tradeLogger.updateRejectionStage(pool.id, 'creator_deep');
          openShadowForRejected();
          return;
        }
      } else if (creatorAge && creatorAge.isSuspicious) {
        logger.warn(`[bot] ❌ SUSPICIOUS CREATOR: wallet age=${creatorAge.walletAgeSeconds}s, txs=${creatorAge.txCount}. Skipping.`);
        tradeLogger.logDetection(pool, fastSecurity);
        tradeLogger.updateRejectionReasons(pool.id, 'suspicious_creator');
        tradeLogger.updateRejectionStage(pool.id, 'creator_age');
        openShadowForRejected();
        return;
      }

      // ═══════ v9z: PHASE 2 — DEFERRED ANALYSIS starts in background ═══════
      // Runs slow checks (holders, rugcheck, bundles, insiders) during observation window
      const deferredPromise = scorer.scoreDeferred(pool, fastSecurity);

      // OBSERVATION WINDOW + WASH TRADING (v8l): run in parallel (0 extra latency)
      // Observation: watch pool reserves for ~3s to catch fast rug pulls
      // Wash trading: analyze bonding curve TXs for coordinated patterns (~500ms)
      const obsConfig = config.analysis.observationWindow;
      let washResult: WashTradingResult | null = null;
      let observationResult: { stable: boolean; dropPct: number; elapsedMs: number; initialSolReserve: number; finalSolReserve: number } | null = null;

      if (obsConfig.enabled && pool.source === 'pumpswap' && pumpSwapSwap) {
        logger.info(`[bot] 👁️ Observation window: monitoring pool for ${obsConfig.durationMs / 1000}s + wash trading check...`);

        // v9u: Global timeout (30s) prevents observation from hanging for minutes when RPCs are slow
        const OBS_GLOBAL_TIMEOUT_MS = 30_000;
        const obsTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Observation global timeout (${OBS_GLOBAL_TIMEOUT_MS / 1000}s)`)), OBS_GLOBAL_TIMEOUT_MS),
        );

        let washCheck: WashTradingResult;
        try {
          [observationResult, washCheck] = await Promise.race([
            Promise.all([
              pumpSwapSwap.observePool(pool, {
                durationMs: obsConfig.durationMs,
                pollIntervalMs: obsConfig.pollIntervalMs,
                maxDropPct: obsConfig.maxDropPct,
              }),
              checkWashTrading(rpcManager.connection, pool.baseMint),
            ]),
            obsTimeout,
          ]);
        } catch (obsErr) {
          logger.warn(`[bot] ⚠️ ${String(obsErr)} — passing through (buy sim will validate)`);
          observationResult = { stable: true, dropPct: 0, elapsedMs: OBS_GLOBAL_TIMEOUT_MS, initialSolReserve: 0, finalSolReserve: 0 };
          washCheck = { penalty: 0, walletConcentration: 0, sameAmountRatio: 0, uniqueWallets: 0, totalTxsSampled: 0 };
        }

        washResult = washCheck;

        if (!observationResult.stable) {
          // v11h: Insert row FIRST so observation + rejection UPDATEs find it
          tradeLogger.logDetection(pool, fastSecurity);
          tradeLogger.updateObservationResult(pool.id, observationResult);
          logger.warn(`[bot] ❌ Pool INESTABLE: SOL reserves dropped ${observationResult.dropPct.toFixed(1)}% in ${(observationResult.elapsedMs / 1000).toFixed(1)}s (${(observationResult.initialSolReserve / 1e9).toFixed(2)} → ${(observationResult.finalSolReserve / 1e9).toFixed(2)} SOL). Skipping.`);
          tradeLogger.updateRejectionReasons(pool.id, 'pool_unstable');
          tradeLogger.updateRejectionStage(pool.id, 'observation');
          openShadowForRejected();
          return;
        }
        logger.info(`[bot] ✅ Pool estable después de ${(observationResult.elapsedMs / 1000).toFixed(1)}s (SOL change: ${observationResult.dropPct > 0 ? '-' : '+'}${Math.abs(observationResult.dropPct).toFixed(1)}%)`);
      } else if (pool.source === 'pumpswap') {
        // Even without observation window, still run wash trading check
        washResult = await checkWashTrading(rpcManager.connection, pool.baseMint);
      }

      // ═══════ v9z: PHASE 3 — AWAIT DEFERRED RESULT ═══════
      // Deferred analysis ran in parallel with observation. Now get the result.
      const security = await deferredPromise;

      // v8r: Cross-reference insider graph wallets with creator (only available after deferred)
      if (coinCreator && security.checks.insiderWallets?.length) {
        const creatorIsInsider = security.checks.insiderWallets.includes(coinCreator);
        if (creatorIsInsider) {
          const oldScore = security.score;
          security.score = Math.max(0, security.score - 100);
          security.passed = security.score >= config.analysis.minScore;
          logger.warn(`[bot] CREATOR IS INSIDER: ${coinCreator.slice(0, 8)}... → score ${oldScore}→${security.score}`);
        }
      }

      // Log full detection with complete data — INSERT row first
      tradeLogger.logDetection(pool, security);
      botEmitter.emit('securityResult', security);

      // v11h: Save observation + wash AFTER logDetection so row exists for UPDATE
      if (observationResult) {
        tradeLogger.updateObservationResult(pool.id, observationResult);
      }
      if (washResult) {
        tradeLogger.updateWashTradingResult(pool.id, washResult);
      }

      // v9A: Set washPenalty on checks for ML feature extraction
      if (washResult) {
        security.checks.washPenalty = washResult.penalty;
      }

      // v10d: Observation window scoring — reward stable pools, penalize extreme drops
      // v11g: Total observation bonus capped at +10 (was uncapped, could reach +20)
      // HYNusnhz had score 53 inflated to 68 via +15 bonus → honeypot bought and unsellable
      let totalObservationBonus = 0;
      const OBS_BONUS_CAP = 15;
      if (observationResult) {
        const oldScore = security.score;
        if (observationResult.stable) {
          const bonus = Math.min(10, OBS_BONUS_CAP - totalObservationBonus);
          if (bonus > 0) {
            security.score = Math.min(100, security.score + bonus);
            totalObservationBonus += bonus;
          }
          logger.info(`[bot] Obs stability bonus: +${bonus} (pool stable, drop ${observationResult.dropPct.toFixed(1)}%) → score ${oldScore}→${security.score}`);
        } else if (observationResult.dropPct > 80) {
          security.score = Math.max(0, security.score - 15);
          logger.warn(`[bot] Obs extreme drop penalty: -15 (drop ${observationResult.dropPct.toFixed(1)}%) → score ${oldScore}→${security.score}`);
        }
        security.passed = security.score >= config.analysis.minScore;
      }

      // ML classifier: get prediction for logging (shadow or active mode)
      const mlResult = await shouldBlockByClassifier(security, creatorDeepProfile, 0.70, pool.source, observationResult);

      // Log detailed analysis for pattern learning
      tradeLogger.logTokenAnalysis(
        pool.baseMint.toBase58(),
        pool.poolAddress.toBase58(),
        pool.source,
        {
          score: security.score,
          passed: security.passed,
          mintAuthorityRevoked: security.checks.mintAuthorityRevoked,
          freezeAuthorityRevoked: security.checks.freezeAuthorityRevoked,
          honeypotSafe: !security.checks.isHoneypot,
          honeypotVerified: security.checks.honeypotVerified,
          liquidityUsd: security.checks.liquidityUsd,
          topHolderPct: security.checks.topHolderPct,
          holderCount: security.checks.holderCount,
          lpBurned: security.checks.lpBurned,
          rugcheckScore: security.checks.rugcheckScore,
          mlPrediction: mlResult.blocked ? 'rug' : 'safe',
          mlConfidence: mlResult.confidence,
        },
        latency,
      );

      // Update currentScore for shadow tracking
      currentScore = security.score;

      // Apply wash trading penalty to deferred score
      if (washResult && washResult.penalty < 0) {
        const oldScore = security.score;
        security.score = Math.max(0, security.score + washResult.penalty);
        security.passed = security.score >= config.analysis.minScore;
        logger.warn(`[bot] Wash trading penalty: ${washResult.penalty} (concentration=${washResult.walletConcentration}% sameAmt=${washResult.sameAmountRatio}%) → score ${oldScore}→${security.score}`);
        if (!security.passed) {
          logger.warn(`[bot] ❌ Token BLOCKED by wash trading penalty (score ${security.score} < ${config.analysis.minScore})`);
          tradeLogger.updateRejectionReasons(pool.id, 'wash_trading');
          tradeLogger.updateRejectionStage(pool.id, 'wash_trading');
          openShadowForRejected();
          return;
        }
      }

      // v9A Task 4: Observation stability bonus/caution (post-observation scoring)
      // Data (N=3456 shadow): stable (drop < 1%) = 8.2% rug, borderline (3-5%) = 19.9% rug
      // v11g: Subject to OBS_BONUS_CAP (+10 total with previous stability bonus)
      if (observationResult && pool.source === 'pumpswap') {
        const obsDrop = observationResult.dropPct;
        if (obsDrop < 1) {
          // Very stable pool: reserves barely changed → bonus (capped)
          const bonus = Math.min(5, OBS_BONUS_CAP - totalObservationBonus);
          if (bonus > 0) {
            const oldScore = security.score;
            security.score = Math.min(100, security.score + bonus);
            totalObservationBonus += bonus;
            security.passed = security.score >= config.analysis.minScore;
            logger.info(`[bot] Observation bonus: pool very stable (drop ${obsDrop.toFixed(1)}%) +${bonus} (obs total: +${totalObservationBonus}/${OBS_BONUS_CAP}) → score ${oldScore}→${security.score}`);
          }
        } else if (obsDrop >= 3 && obsDrop <= 5) {
          // Borderline stable: reserves dropped noticeably → caution (penalties not capped)
          const oldScore = security.score;
          security.score = Math.max(0, security.score - 5);
          security.passed = security.score >= config.analysis.minScore;
          logger.warn(`[bot] Observation caution: borderline stable (drop ${obsDrop.toFixed(1)}%) → score ${oldScore}→${security.score}`);
        }
      }

      // v9A Task 5: Reserve growth bonus (post-observation)
      // If reserves GREW >5% during observation → indicates organic buying
      // v11g: Subject to OBS_BONUS_CAP
      if (observationResult && observationResult.initialSolReserve > 0) {
        const reserveGrowthPct = ((observationResult.finalSolReserve - observationResult.initialSolReserve) / observationResult.initialSolReserve) * 100;
        if (reserveGrowthPct > 5) {
          const bonus = Math.min(5, OBS_BONUS_CAP - totalObservationBonus);
          if (bonus > 0) {
            const oldScore = security.score;
            security.score = Math.min(100, security.score + bonus);
            totalObservationBonus += bonus;
            security.passed = security.score >= config.analysis.minScore;
            logger.info(`[bot] Reserve growth bonus: reserves grew ${reserveGrowthPct.toFixed(1)}% +${bonus} (obs total: +${totalObservationBonus}/${OBS_BONUS_CAP}) → score ${oldScore}→${security.score}`);
          }
        }
      }

      // ML CLASSIFIER blocking check
      if (config.analysis.mlClassifier.enabled) {
        const mlActive = config.analysis.mlClassifier.minConfidence !== 0.70
          ? await shouldBlockByClassifier(security, creatorDeepProfile, config.analysis.mlClassifier.minConfidence, pool.source, observationResult)
          : mlResult;
        if (mlActive.blocked) {
          logger.warn(`[bot] ❌ ML BLOCKED: ${mlActive.reason} (${(mlActive.confidence * 100).toFixed(0)}% confidence). Skipping.`);
          tradeLogger.updateRejectionReasons(pool.id, mlActive.reason);
          tradeLogger.updateRejectionStage(pool.id, 'ml_classifier');
          openShadowForRejected();
          return;
        }
      } else if (mlResult.blocked) {
        logger.info(`[bot] [ml-shadow] Would have blocked: ${mlResult.reason} (${(mlResult.confidence * 100).toFixed(0)}%)`);
      }

      // v11b: Apply deferred creator penalty (minor negatives deferred from fast stage)
      if (deferredCreatorPenalty !== 0) {
        const oldScore = security.score;
        security.score = Math.max(0, Math.min(100, security.score + deferredCreatorPenalty));
        security.passed = security.score >= config.analysis.minScore;
        logger.info(`[bot] Creator penalty (deferred): ${deferredCreatorPenalty} → score ${oldScore}→${security.score}`);
      }

      // ═══════ FINAL DEFERRED CHECK — deferred may have lowered score below threshold ═══════
      if (!security.passed) {
        logger.warn(`[bot] ❌ DEFERRED REJECT: score ${security.score}/100 < ${config.analysis.minScore} after slow checks`);
        tradeLogger.updateRejectionReasons(pool.id, 'deferred_analysis');
        tradeLogger.updateRejectionStage(pool.id, 'deferred_analysis');
        openShadowForRejected();
        return;
      }

      // Re-check max concurrent AFTER analysis + observation WITH buyInProgress lock
      if (!config.risk.shadowMode && (buyInProgress || positionManager.activeTradeCount >= config.risk.maxConcurrent)) {
        logger.info(`[bot] Máximo de trades activos alcanzado post-análisis, ignorando`);
        tradeLogger.updateRejectionReasons(pool.id, 'max_concurrent');
        tradeLogger.updateRejectionStage(pool.id, 'max_concurrent');
        return;
      }
      if (!config.risk.shadowMode && positionManager.isSelling) {
        logger.info(`[bot] Sell in progress post-observation, skipping buy for ${tokenKey.slice(0, 8)} (sell priority)`);
        tradeLogger.updateRejectionReasons(pool.id, 'sell_in_progress');
        tradeLogger.updateRejectionStage(pool.id, 'sell_priority');
        return;
      }

      // FINAL DEDUP
      if (positionManager.hasActivePosition(pool.baseMint)) {
        logger.warn(`[bot] DEDUP-FINAL: Already have position for ${tokenKey.slice(0, 8)}..., blocking duplicate buy`);
        return;
      }

      // LOCK: Prevent any other concurrent buy from starting
      buyInProgress = true;

      // v9a: Shadow mode — open virtual position instead of buying
      if (config.risk.shadowMode && shadowManager) {
        const shadow = shadowManager.openShadowPosition(
          pool, security.score, 0, null,
          mlResult?.prediction ?? null, mlResult?.confidence ?? null,
          security.checks.liquidityUsd,
        );
        if (shadow) {
          logger.info(`[shadow] Virtual position: ${tokenKey.slice(0, 8)} | score=${security.score} | PriceMonitor will set entry on first poll`);
        } else {
          logger.info(`[shadow] Max concurrent (${config.risk.shadowMaxConcurrent}) reached, skipping`);
        }
        return;
      }

      // Paso 2: Ejecutar compra
      if (detectionOnly || config.risk.dryRun) {
        logger.info(`[bot] 🔵 SIMULACIÓN - compraría ${config.risk.maxPositionSol} SOL`);
        return;
      }

      if (!wallet) return;

      // CIRCUIT BREAKER: Stop buying if too many consecutive failures (prevents fee drain)
      if (Date.now() < circuitBreakerUntil) {
        const remainingSec = Math.ceil((circuitBreakerUntil - Date.now()) / 1000);
        logger.warn(`[bot] 🔌 Circuit breaker ACTIVE (${remainingSec}s remaining). Skipping buy.`);
        return;
      }

      // CRITICAL: Check balance BEFORE sending any TX to avoid burning fees on doomed transactions
      // Each failed TX costs ~0.0003 SOL in fees. Without this check, the bot drains the wallet in fees.
      // Buffer covers: buy priority fee (0.0001) + wrap buffer (0.0005) + 1 ATA creation (0.002) + TX fee (0.0003)
      // v9n: Lowered from 0.009 (4 ATAs) to 0.003 (1 ATA). Only 1 ATA needed per PumpSwap trade.
      // pumpswap-swap.ts has its own precise balance check as second layer.
      const FEE_BUFFER_SOL = 0.003;
      try {
        let currentBalance: number;
        // v9x: Use cached balance first (0 RPC calls, updated every 30s)
        // Under 429, wallet.getBalance(primary) hangs ~60s, adding huge latency
        const cachedBal = getCachedBalanceSol();
        if (cachedBal !== null) {
          currentBalance = cachedBal;
          logger.debug(`[bot] Balance via cache: ${formatSol(currentBalance)} SOL`);
        } else {
          // Cache not seeded yet, fall back to RPC
          try {
            currentBalance = await wallet.getBalance(rpcManager.connection);
          } catch {
            const lamports = await withAnalysisRetry(
              (conn) => conn.getBalance(wallet.publicKey),
              rpcManager.connection,
            );
            currentBalance = lamports / 1e9;
            logger.info(`[bot] Balance via fallback RPC: ${formatSol(currentBalance)} SOL`);
          }
        }

        // Hard floor: never trade below minimum
        if (currentBalance < MIN_BALANCE_FLOOR_SOL) {
          logger.error(`[bot] 🛑 Balance ${formatSol(currentBalance)} SOL below hard floor ${formatSol(MIN_BALANCE_FLOOR_SOL)} SOL. ALL TRADING STOPPED.`);
          return;
        }

        if (currentBalance < config.risk.maxPositionSol + FEE_BUFFER_SOL) {
          logger.warn(`[bot] ⚠️ Balance insuficiente: ${formatSol(currentBalance)} SOL < ${formatSol(config.risk.maxPositionSol + FEE_BUFFER_SOL)} SOL (trade + fees). Skipping.`);
          return;
        }
      } catch (err) {
        logger.warn(`[bot] Balance check failed on ALL RPCs, skipping trade: ${String(err).slice(0, 80)}`);
        return;
      }

      const amountInLamports = solToLamports(config.risk.maxPositionSol);
      let result: TradeResult;

      // LOCK: Prevent race condition where 2 pools pass max_concurrent check simultaneously
      buyInProgress = true;

      // v9p: Track if PumpSwap sent a TX (even if confirmation timed out).
      // If it did, we MUST check wallet for tokens after all attempts fail.
      let pumpswapTxWasSent = false;
      let pumpswapTxSig: string | undefined;

      if (pool.source === 'pumpswap' && pumpSwapSwap) {
        // PumpSwap direct swap (~200ms) - for pump.fun graduated tokens
        logger.info('[bot] 🚀 Attempting PumpSwap direct swap (fast path)...');
        result = await pumpSwapSwap.buyFromPool(pool, amountInLamports, config.execution.slippageBps);

        // Track if a TX was actually broadcast (confirmation timeout = TX was sent but not confirmed)
        // v10a: Updated to match new pollConfirmation error messages ("Polling timeout" and "Polling hard timeout")
        // FggZ bug: old check missed "Polling hard timeout" → fell through to Jupiter → potential double buy
        if (result.txSignature || result.error?.includes('confirmation error') || result.error?.includes('Polling')) {
          pumpswapTxWasSent = true;
          pumpswapTxSig = result.txSignature;
        }

        // v9p: If PumpSwap SENT a TX but confirmation timed out, DON'T try Jupiter.
        // The TX may have landed on-chain → Jupiter would cause a DOUBLE BUY.
        // Instead, skip to recovery check which verifies the wallet for tokens.
        if (!result.success && pumpswapTxWasSent) {
          logger.info(`[pipeline] PumpSwap TX was broadcast but not confirmed — skipping Jupiter fallback to avoid double buy`);
          // Fall through to recovery check below
        } else if (!result.success && jupiterSwap) {
          // PumpSwap failed WITHOUT sending a TX (simulation fail, balance issue, etc.) → safe to try Jupiter
          logger.warn(`[bot] PumpSwap failed before TX send (${result.error}), falling back to Jupiter...`);
          const buyOrder: TradeOrder = {
            type: 'buy',
            inputMint: WSOL_MINT,
            outputMint: pool.baseMint,
            amountIn: amountInLamports,
            slippageBps: config.execution.slippageBps,
            useJito: config.execution.useJito,
            jitoTipLamports: config.execution.jitoTipLamports,
          };
          result = await jupiterSwap.executeSwap(buyOrder);
        }
      } else if (pool.source === 'raydium_amm_v4' && raydiumSwap) {
        // Raydium direct swap (~175ms)
        logger.info('[bot] 🚀 Attempting Raydium direct swap (fast path)...');
        result = await raydiumSwap.buyFromPool(pool, amountInLamports, config.execution.slippageBps);

        // Fallback to Jupiter if Raydium fails
        if (!result.success && jupiterSwap) {
          logger.warn(`[bot] Raydium failed (${result.error}), falling back to Jupiter...`);
          const buyOrder: TradeOrder = {
            type: 'buy',
            inputMint: WSOL_MINT,
            outputMint: pool.baseMint,
            amountIn: amountInLamports,
            slippageBps: config.execution.slippageBps,
            useJito: config.execution.useJito,
            jitoTipLamports: config.execution.jitoTipLamports,
          };
          result = await jupiterSwap.executeSwap(buyOrder);
        }
      } else if (jupiterSwap) {
        // Fallback: Jupiter for any other source
        logger.info('[bot] Using Jupiter for swap...');
        const buyOrder: TradeOrder = {
          type: 'buy',
          inputMint: WSOL_MINT,
          outputMint: pool.baseMint,
          amountIn: amountInLamports,
          slippageBps: config.execution.slippageBps,
          useJito: config.execution.useJito,
          jitoTipLamports: config.execution.jitoTipLamports,
        };
        result = await jupiterSwap.executeSwap(buyOrder);
      } else {
        logger.error('[bot] No swap executor available');
        return;
      }

      tradeLogger.logTrade(
        pool.id,
        'buy',
        result,
        WSOL_MINT.toBase58(),
        pool.baseMint.toBase58(),
      );

      if (result.success) {
        sessionBuyCount++;
        consecutiveBuyFailures = 0; // Reset circuit breaker on success
        const entryLatencyMs = Date.now() - pool.detectedAt;
        logger.info(`[pipeline] BUY SUCCESS (${sessionBuyCount}/${config.risk.maxTradesPerSession || '∞'}): ${result.txSignature} | entry_latency=${entryLatencyMs}ms`);

        // Open position for management (pass reserves from buy for instant rug detection)
        const position = positionManager.openPosition(
          pool,
          result.pricePerToken,
          result.outputAmount,
          config.risk.maxPositionSol,
          security.score,
          result.poolReserves?.solLamports,
          {
            holderCount: security.checks.holderCount,
            liquidityUsd: security.checks.liquidityUsd,
            // v8r: Pass authority state for post-buy re-enablement detection
            mintAuthRevoked: security.checks.mintAuthorityRevoked,
            freezeAuthRevoked: security.checks.freezeAuthorityRevoked,
          },
        );

        // v8p: Save entry latency on position object (so savePosition preserves it)
        if (position) {
          position.entryLatencyMs = entryLatencyMs;
          tradeLogger.savePosition(position); // Re-save with entry latency included
        }
        // v11f: Signal at-capacity to pause pool parsing (saves RPC bandwidth for sells)
        if (positionManager.activeTradeCount >= config.risk.maxConcurrent) {
          setAtCapacity(true);
        }
        tradeLogger.markBuyAttempt(tokenKey, true);

        // v9g: Also open shadow position for live trades (exit ML training data)
        if (shadowManager) {
          shadowManager.openShadowPosition(
            pool, security.score, result.pricePerToken, null,
            mlResult?.prediction ?? null, mlResult?.confidence ?? null,
            security.checks.liquidityUsd,
          );
        }

        // v8p: Balance snapshot after buy
        try {
          const postBuyBalance = await wallet.getBalance(rpcManager.connection);
          tradeLogger.logBalanceSnapshot(postBuyBalance, 'buy', tokenKey);
          setCachedBalanceLamports(Math.round(postBuyBalance * 1e9)); // v9w: update cache
        } catch { /* non-fatal */ }

        // v11g: Post-buy honeypot check — simulate sell immediately after buy
        // Catches 100% of "pure honeypots" that block ALL sells (Custom:6024/6025)
        // Cost: 0 SOL (simulation is free). Latency: ~200-500ms.
        // If honeypot detected → emergency sell immediately (first sell might work for one-sell patterns)
        if (pool.source === 'pumpswap' && pumpSwapSwap) {
          const sellCheck = await pumpSwapSwap.simulateSellCheck(
            pool.baseMint, result.outputAmount, pool.poolAddress,
          );
          if (!sellCheck.sellable) {
            logger.warn(`[bot] 🚨 HONEYPOT POST-BUY: ${tokenKey.slice(0, 8)}... — ${sellCheck.error}`);
            logger.warn(`[bot] 🚨 Attempting immediate emergency sell (first sell might work)...`);
            // Try to sell everything immediately
            try {
              const emergencySell = await pumpSwapSwap.sell(
                pool.baseMint, result.outputAmount, 9500, pool.poolAddress, true, false,
              );
              if (emergencySell.success) {
                logger.info(`[bot] ✅ Honeypot emergency sell SUCCEEDED — recovered SOL`);
              } else {
                logger.warn(`[bot] ❌ Honeypot emergency sell FAILED: ${emergencySell.error}`);
              }
            } catch (sellErr) {
              logger.warn(`[bot] ❌ Honeypot emergency sell error: ${String(sellErr)}`);
            }
            // Close position regardless
            if (position) {
              await positionManager.forceClosePosition(position.id, 'honeypot_detected');
            }
            tradeLogger.updateRejectionReasons(pool.id, 'honeypot_post_buy');
            // Don't emit tradeExecuted — position is already closed
            return;
          }
        }

        botEmitter.emit('tradeExecuted', { ...result, pool });
      } else {
        // v9p: Post-buy safety check — TX may have landed despite confirmation timeout
        // This prevents stranded tokens when PumpSwap TX was broadcast but confirmation timed out.
        // Step 1: If we have a TX sig, check its on-chain status directly
        // Step 2: Check wallet for tokens as fallback
        const shouldCheckWallet = pumpswapTxWasSent || result.error?.includes('timeout') || result.error?.includes('Timeout');
        if (shouldCheckWallet && wallet) {
          // First, try to verify the TX signature directly (faster and more reliable)
          if (pumpswapTxSig) {
            logger.info(`[pipeline] Checking TX status on-chain: ${pumpswapTxSig.slice(0, 16)}...`);
            try {
              const sigStatus = await withAnalysisRetry(
                (conn) => conn.getSignatureStatus(pumpswapTxSig!),
                rpcManager.connection,
              );
              if (sigStatus.value?.confirmationStatus === 'confirmed' || sigStatus.value?.confirmationStatus === 'finalized') {
                if (!sigStatus.value.err) {
                  logger.info(`[pipeline] TX confirmed on-chain! Status: ${sigStatus.value.confirmationStatus}`);
                } else {
                  logger.info(`[pipeline] TX landed but FAILED on-chain: ${JSON.stringify(sigStatus.value.err)}`);
                  // TX failed on-chain, no tokens to recover
                  pumpswapTxWasSent = false; // Skip wallet check
                }
              } else {
                logger.info(`[pipeline] TX not yet confirmed, waiting 5s...`);
              }
            } catch (sigErr) {
              logger.warn(`[pipeline] TX status check failed: ${String(sigErr).slice(0, 80)}`);
            }
          }

          if (!pumpswapTxWasSent) {
            // TX failed on-chain, skip wallet check
          } else {
          logger.info(`[pipeline] Checking wallet for tokens (5s delay)...`);
          await new Promise(r => setTimeout(r, 5000)); // Wait for TX to finalize
          try {
            const tokenAccounts = await withAnalysisRetry(
              (conn) => conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: pool.baseMint }),
              rpcManager.connection,
            );
            const tokenBalance = tokenAccounts.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
            if (tokenBalance && Number(tokenBalance.amount) > 0) {
              const outputAmount = Number(tokenBalance.amount);
              const entryLatencyMs = Date.now() - pool.detectedAt;
              const pricePerToken = config.risk.maxPositionSol / outputAmount;
              logger.info(`[pipeline] POST-BUY RECOVERY: Found ${outputAmount} tokens! Buy succeeded despite timeout. Opening position.`);

              sessionBuyCount++;
              consecutiveBuyFailures = 0;
              circuitBreakerUntil = 0; // v9w: clear active cooldown, buy actually succeeded

              const position = positionManager.openPosition(
                pool, pricePerToken, outputAmount, config.risk.maxPositionSol, security.score,
                undefined,
                {
                  holderCount: security.checks.holderCount,
                  liquidityUsd: security.checks.liquidityUsd,
                  mintAuthRevoked: security.checks.mintAuthorityRevoked,
                  freezeAuthRevoked: security.checks.freezeAuthorityRevoked,
                },
              );

              if (position) {
                position.entryLatencyMs = entryLatencyMs;
                tradeLogger.savePosition(position);
              }
              // v11f: Signal at-capacity to pause pool parsing
              if (positionManager.activeTradeCount >= config.risk.maxConcurrent) {
                setAtCapacity(true);
              }
              tradeLogger.markBuyAttempt(tokenKey, true);
              botEmitter.emit('tradeExecuted', { ...result, success: true, outputAmount, pool });

              // Balance snapshot
              try {
                const postBuyBalance = await wallet.getBalance(rpcManager.connection);
                tradeLogger.logBalanceSnapshot(postBuyBalance, 'buy', tokenKey);
                setCachedBalanceLamports(Math.round(postBuyBalance * 1e9)); // v9w: update cache
              } catch { /* non-fatal */ }

              return; // Don't fall through to failure handling
            } else {
              logger.info(`[pipeline] Post-buy check: no tokens found, buy truly failed`);
            }
          } catch (checkErr) {
            logger.warn(`[pipeline] Post-buy token check failed: ${String(checkErr).slice(0, 80)}`);
          }
          } // close else from pumpswapTxWasSent check
        }

        // v8p: Mark buy attempt as failed in token_analysis
        tradeLogger.markBuyAttempt(tokenKey, false, result.error?.slice(0, 200));

        // Don't count balance-related errors toward circuit breaker (permanent condition, not transient)
        const isBalanceError = result.error?.includes('Insufficient') || result.error?.includes('insufficient') || result.error?.includes('Custom":1');
        if (isBalanceError) {
          logger.error(`[pipeline] BUY FAILED (balance issue, not counted toward circuit breaker): ${result.error}`);
          logger.error(`[bot] 🛑 Insufficient SOL for trade + ATA creation. Need ~${formatSol(config.risk.maxPositionSol + 0.012)} SOL minimum. Add funds to wallet.`);
        } else {
          consecutiveBuyFailures++;
          logger.error(`[pipeline] BUY FAILED (${consecutiveBuyFailures}/${MAX_CONSECUTIVE_FAILURES}): ${result.error}`);

          if (consecutiveBuyFailures >= MAX_CONSECUTIVE_FAILURES) {
            circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
            logger.error(`[bot] 🔌 Circuit breaker TRIGGERED: ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Pausing buys for ${CIRCUIT_BREAKER_PAUSE_MS / 60000} min.`);
            // Send telegram notification
            botEmitter.emit('error', new Error(`Circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive buy failures, pausing ${CIRCUIT_BREAKER_PAUSE_MS / 60000}min`), 'circuit_breaker');
          }
        }
      }
    } catch (err) {
      logger.error(`[pipeline] Error processing pool`, { error: String(err) });
      botEmitter.emit('error', err instanceof Error ? err : new Error(String(err)), 'pipeline');
    } finally {
      // v9s: Release Tier 2 concurrency slot
      activeAnalysisCount = Math.max(0, activeAnalysisCount - 1);
    } // end Tier 2 try

    } catch (err) {
      logger.error(`[pipeline] Error processing pool`, { error: String(err) });
      botEmitter.emit('error', err instanceof Error ? err : new Error(String(err)), 'pipeline');
    } finally {
      // Release processing lock
      buyInProgress = false;
      processingTokens.delete(tokenKey);
    }
  });

  botEmitter.on('migration', (pool: DetectedPool) => {
    logger.info(`[migration] ${shortenAddress(pool.baseMint)} graduated to ${pool.source}`);
  });

  botEmitter.on('error', (error: Error, context: string) => {
    logger.error(`[${context}] ${error.message}`, { stack: error.stack });
  });

  // ──── MISSED GAINS BACKFILL (check what happened to tokens we sold in last 24h) ──
  if (!detectionOnly && !config.risk.shadowMode) {
    setTimeout(() => {
      backfillMissedGains().catch(err =>
        logger.debug(`[bot] Missed gains backfill error: ${err}`),
      );
    }, 30_000); // Wait 30s after startup
  }

  // ──── ATA CLEANUP (every 15min, recovers ~0.002 SOL per dust ATA) ──────
  if (wallet && !detectionOnly && !config.risk.shadowMode) {
    // v8l: Pass active position mints to prevent burning traded tokens (CRITICAL BUG FIX)
    const getActiveTokenMints = () => {
      const mints = new Set<string>();
      for (const pos of positionManager.getOpenPositions()) {
        mints.add(pos.tokenMint.toBase58());
      }
      return mints;
    };
    startAtaCleanup(rpcManager.connection, wallet, getActiveTokenMints);

    // v8j: Close token ATA immediately after full sell to recover rent faster
    // v8j: Schedule missed gains checks (1h/4h/24h) to track what happened after we sold
    botEmitter.on('positionClosed', (position: {
      tokenMint: import('@solana/web3.js').PublicKey;
      poolAddress: import('@solana/web3.js').PublicKey;
      id: string;
      entryPrice: number;
      currentPrice: number;
      closedAt?: number;
      pnlSol?: number;
    }) => {
      // v11f: Resume pool parsing if we now have capacity
      if (positionManager.activeTradeCount < config.risk.maxConcurrent) {
        setAtCapacity(false);
      }
      closeTokenAta(rpcManager.connection, wallet!, position.tokenMint).catch(err =>
        logger.debug(`[bot] ATA close post-sell failed: ${err}`),
      );
      scheduleMissedGainsCheck(
        position.poolAddress.toBase58(),
        position.tokenMint.toBase58(),
        position.id,
        position.entryPrice,
        position.closedAt ?? Date.now(),
        position.currentPrice,  // v8q: pass sell price for post-trade tracking
      );

      // v8p: Balance snapshot after position close
      wallet!.getBalance(rpcManager.connection).then(bal => {
        tradeLogger.logBalanceSnapshot(bal, 'sell', position.tokenMint.toBase58(), position.pnlSol);
      }).catch(() => { /* non-fatal */ });
    });
  }

  // ──── START DETECTORS ───────────────────────────────────────────────

  const detectors: Array<{ start(): Promise<void>; stop(): Promise<void> }> = [];

  if (config.detection.raydiumAmmV4) {
    detectors.push(new PoolDetector(() => rpcManager.primaryConnection, wsManager));
  }
  if (config.detection.pumpfun) {
    detectors.push(new PumpFunMonitor(() => rpcManager.primaryConnection, wsManager));
  }
  if (config.detection.pumpswap) {
    detectors.push(new PumpSwapMonitor(() => rpcManager.primaryConnection, wsManager));
  }

  // Yellowstone gRPC: faster detection (primary), WS monitors are fallback
  if (config.detection.yellowstone.enabled && config.detection.yellowstone.endpoint) {
    detectors.push(new YellowstoneMonitor({
      endpoint: config.detection.yellowstone.endpoint,
      token: config.detection.yellowstone.token,
      dailyResponseLimit: config.detection.yellowstone.dailyResponseLimit,
    }));
  }

  for (const detector of detectors) {
    await detector.start();
  }

  logger.info('');
  logger.info(`[bot] ViperSnipe is LIVE`);
  logger.info(`[bot] Monitors: ${detectors.length} | Dry run: ${config.risk.dryRun} | Detection only: ${detectionOnly} | Shadow: ${config.risk.shadowMode}`)
  logger.info(`[bot] Max trades/sesión: ${config.risk.maxTradesPerSession || '∞'} | Max SOL/trade: ${config.risk.maxPositionSol}`);
  logger.info(`[bot] Copy trading: ${config.copyTrading.enabled ? 'ON' : 'OFF'} | Telegram: ${telegramBot ? 'ON' : 'OFF'}`);
  logger.info('[bot] Press Ctrl+C to stop');
  logger.info('');

  // ──── GRACEFUL SHUTDOWN ─────────────────────────────────────────────

  const shutdown = async () => {
    logger.info('');
    logger.info('[bot] Shutting down...');

    // Stop detectors first (no new pools)
    for (const detector of detectors) {
      await detector.stop();
    }

    // v9a: Stop shadow manager + v9f: Stop shadow liq monitor
    if (shadowManager) shadowManager.stop();
    if (shadowLiqMonitor) shadowLiqMonitor.stop();

    // Emergency sell: try to sell all open positions before shutdown
    const openPositions = config.risk.shadowMode ? [] : positionManager.getOpenPositions();
    if (openPositions.length > 0) {
      logger.info(`[bot] Emergency sell: ${openPositions.length} open position(s)...`);
      for (const pos of openPositions) {
        try {
          logger.info(`[bot] Emergency selling ${shortenAddress(pos.tokenMint)}...`);
          const result = await executeSell(pos.tokenMint, pos.tokenAmount, pos.poolAddress, pos.source);
          if (result.success) {
            logger.info(`[bot] Emergency sell SUCCESS: ${shortenAddress(pos.tokenMint)} → ${formatSol(result.outputAmount / 1e9)} SOL`);
          } else {
            logger.warn(`[bot] Emergency sell failed: ${shortenAddress(pos.tokenMint)} (${result.error})`);
          }
        } catch (err) {
          logger.error(`[bot] Emergency sell error: ${err}`);
        }
      }
    }

    positionManager.stop();
    stopBlockhashCache(); // v8s
    stopBalanceUpdater(); // v9w
    copyExecutor?.stop();
    await walletTracker?.stop();
    await telegramBot?.stop();
    await wsManager.shutdown();
    rpcManager.stopHealthChecks();
    await cache.close();
    closeDb();

    // Release instance lock
    releaseLock();

    logger.info(`[bot] Total pools detected: ${poolCount}`);
    logger.info('[bot] Goodbye!');
    process.exit(0);
  };

  // Track if shutdown is already in progress
  let shutdownInProgress = false;
  process.on('SIGINT', () => {
    if (shutdownInProgress) {
      // Second Ctrl+C = force exit immediately
      logger.warn('[bot] Force exit (second SIGINT)');
      releaseLock();
      process.exit(1);
    }
    shutdownInProgress = true;
    logger.info('[bot] Shutting down (Ctrl+C again to force)...');
    // Give shutdown 10s max, then force exit
    const forceTimer = setTimeout(() => {
      logger.warn('[bot] Shutdown timeout, forcing exit');
      releaseLock();
      process.exit(1);
    }, 10_000);
    forceTimer.unref();
    shutdown();
  });
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.error('Fatal error', { error: String(err), stack: err?.stack });
  releaseLock();
  process.exit(1);
});
