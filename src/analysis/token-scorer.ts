import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { checkAuthorities } from './security-checker.js';
import { checkHoneypot } from './honeypot-detector.js';
import { checkLiquidity } from './liquidity-checker.js';
import { analyzeHolders } from './holder-analyzer.js';
import { checkLpStatus } from './lp-checker.js';
import { fetchRugCheck, fetchInsiderGraph, type InsiderGraphResult } from './rugcheck-api.js';
import { checkBundledLaunch } from './bundle-detector.js';
import { checkGoPlus, isGoPlusSafe } from './goplus-checker.js';
import type { BotConfig, DetectedPool, SecurityChecks, SecurityResult } from '../types.js';
import { shortenAddress } from '../utils/helpers.js';

// v9h: Increased from 8s to 15s — 429 storms cause analysis timeouts that reject good pools
// The cost of waiting longer (15s) is far less than missing a $30K pool with score 85
const ANALYSIS_TIMEOUT_MS = 15_000;

// v9z: Fast analysis — only critical checks (auth + liq + goplus): 2 RPC + 1 HTTP = ~2-3s
// v10a: Increased from 5s to 8s — GKAX (score 65, liq $7.6K) missed by 830ms with 5s timeout
const FAST_ANALYSIS_TIMEOUT_MS = 8_000;

// v9z: Deferred analysis — slow checks (holders, rugcheck, bundle, insiders): runs during observation window
const DEFERRED_ANALYSIS_TIMEOUT_MS = 10_000;

/**
 * Wraps a promise with a timeout. Returns the result or calls defaultFn on timeout.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  defaultFn: () => T,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  let timedOut = false;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve(defaultFn()); // Call the function only when timeout fires
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch {
    clearTimeout(timeoutId!);
    if (timedOut) return defaultFn();
    throw new Error('Analysis failed');
  }
}

/**
 * Composite token security scorer.
 * Runs all checks and produces a score 0-100.
 *
 * Scoring weights (from config):
 *   freeze_authority: 20
 *   mint_authority:   20
 *   honeypot:         20
 *   liquidity:        15
 *   holders:          15
 *   lp_burned:        10
 *   (rugcheck: +5 bonus)
 */
export class TokenScorer {
  constructor(
    private readonly getConnection: () => Connection,
    private readonly config: BotConfig,
  ) {}

  private get connection(): Connection {
    return this.getConnection();
  }

  async score(pool: DetectedPool): Promise<SecurityResult> {
    const startTime = Date.now();
    logger.info(`[analisis] Analizando ${shortenAddress(pool.baseMint)}...`);

    // Wrap entire analysis with global timeout
    return withTimeout(
      this.performAnalysis(pool, startTime),
      ANALYSIS_TIMEOUT_MS,
      () => this.createFailedResult(pool.baseMint, 'Analysis timeout'),
    );
  }

  // v9z: Fast analysis — only critical checks (auth, liq, goplus) for quick pass/fail in ~2-3s
  async scoreFast(pool: DetectedPool): Promise<SecurityResult> {
    const startTime = Date.now();
    logger.info(`[analisis-fast] Analizando ${shortenAddress(pool.baseMint)}...`);
    return withTimeout(
      this.performFastAnalysis(pool, startTime),
      FAST_ANALYSIS_TIMEOUT_MS,
      () => this.createFailedResult(pool.baseMint, 'Fast analysis timeout'),
    );
  }

  // v9z: Deferred analysis — slow checks run during observation window, returns adjusted score
  async scoreDeferred(pool: DetectedPool, fastResult: SecurityResult): Promise<SecurityResult> {
    const startTime = Date.now();
    return withTimeout(
      this.performDeferredAnalysis(pool, fastResult, startTime),
      DEFERRED_ANALYSIS_TIMEOUT_MS,
      () => {
        logger.warn(`[analisis-deferred] ${shortenAddress(pool.baseMint)} timeout, using fast score only`);
        return fastResult;
      },
    );
  }

  private createFailedResult(mint: PublicKey, reason: string): SecurityResult {
    logger.warn(`[analisis] ${shortenAddress(mint)} => ${reason}, usando valores seguros`);
    return {
      mint,
      score: 0,
      passed: false,
      checks: {
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        isHoneypot: true, // Assume worst case on timeout
        honeypotVerified: false,
        liquidityUsd: 0,
        liquiditySol: 0,
        topHolderPct: 100,
        holderCount: 0,
        lpBurned: false,
        lpLockedPct: 0,
      },
      timestamp: Date.now(),
    };
  }

  private async performAnalysis(pool: DetectedPool, startTime: number): Promise<SecurityResult> {
    const { baseMint, poolAddress, lpMint } = pool;
    const weights = this.config.analysis.weights;

    // Run checks in parallel for speed
    // PumpSwap tokens: skip LP check (no LP), and Jupiter honeypot (no routes for fresh tokens)
    // BUT use GoPlus API for PumpSwap honeypot detection (indexes tokens within seconds)
    const isPumpSwap = pool.source === 'pumpswap';
    const [authorities, honeypot, liquidity, holders, lpStatus, rugcheck, bundleCheck, goplusCheck, insiderGraphCheck] = await Promise.allSettled([
      checkAuthorities(this.connection, baseMint, pool.source),
      // Jupiter honeypot: only for non-PumpSwap (Jupiter has routes for established tokens)
      this.config.analysis.honeypotCheck && !isPumpSwap
        ? checkHoneypot(baseMint)
        : Promise.resolve({ isHoneypot: false, honeypotVerified: false, buyQuoteOk: !isPumpSwap, sellQuoteOk: !isPumpSwap, buyPriceImpact: 0, sellPriceImpact: 0 }),
      checkLiquidity(this.connection, poolAddress),
      analyzeHolders(this.connection, baseMint),
      lpMint && !isPumpSwap
        ? checkLpStatus(this.connection, lpMint)
        : Promise.resolve({ lpBurned: false, lpLockedPct: 0, lpTotalSupply: 0n, lpBurnedAmount: 0n }),
      this.config.analysis.rugcheckEnabled
        ? fetchRugCheck(baseMint)
        : Promise.resolve(null),
      // Bundle detection: count bonding curve TXs to detect coordinated launches
      isPumpSwap
        ? checkBundledLaunch(this.connection, baseMint, pool.poolCreationBlockTime)
        : Promise.resolve({ txCount: -1, sameSlotCount: 0, isBundled: false, penalty: 0, graduationTimeSeconds: -1, earlyTxCount: 0, txVelocity: 0, uniqueSlots: 0, timingClusterCV: -1 }),
      // GoPlus Security API: catches Token-2022 scams (transfer hooks, balance mutation)
      // Note: for standard pump.fun tokens, GoPlus returns identical clean configs for both
      // rugs and winners - rug pulls on Solana are liquidity removal, not contract traps.
      // GoPlus IS valuable for catching the ~2% of tokens with malicious Token-2022 extensions.
      checkGoPlus(baseMint),
      // v8r: RugCheck insider network graph (separate from /report insiders count)
      isPumpSwap ? fetchInsiderGraph(baseMint) : Promise.resolve(null),
    ]);

    // Extract results with safe defaults
    const auth = authorities.status === 'fulfilled'
      ? authorities.value
      : { mintAuthorityRevoked: false, freezeAuthorityRevoked: false, mintAuthority: null, freezeAuthority: null, supply: 0n, decimals: 0, dangerousExtensions: [] as string[], isToken2022: false };

    const hp = honeypot.status === 'fulfilled'
      ? honeypot.value
      : { isHoneypot: true, honeypotVerified: false, buyQuoteOk: false, sellQuoteOk: false, buyPriceImpact: 0, sellPriceImpact: 0 };

    const liq = liquidity.status === 'fulfilled'
      ? liquidity.value
      : { liquiditySol: 0, liquidityUsd: 0, poolSolBalance: 0, poolTokenBalance: 0 };

    const hold = holders.status === 'fulfilled'
      ? holders.value
      : { topHolderPct: 100, top5HoldersPct: 100, top10HoldersPct: 100, holderCount: 0, holders: [], holderHHI: 0 };

    const lp = lpStatus.status === 'fulfilled'
      ? lpStatus.value
      : { lpBurned: false, lpLockedPct: 0, lpTotalSupply: 0n, lpBurnedAmount: 0n };

    const rc = rugcheck.status === 'fulfilled' ? rugcheck.value : null;

    const bundle = bundleCheck.status === 'fulfilled'
      ? bundleCheck.value
      : { txCount: -1, sameSlotCount: 0, isBundled: false, penalty: 0, graduationTimeSeconds: -1, earlyTxCount: 0, txVelocity: 0, uniqueSlots: 0, timingClusterCV: -1 };

    const goplus = goplusCheck.status === 'fulfilled'
      ? goplusCheck.value
      : { isMintable: false, isFreezable: false, hasTransferFee: false, hasTransferHook: false, isNonTransferable: false, metadataMutable: false, balanceMutable: false, holderCount: 0, topHolderPct: 0, topHolderAddress: null, isDangerous: false, verified: false };

    const insiderGraph: InsiderGraphResult | null = insiderGraphCheck.status === 'fulfilled'
      ? insiderGraphCheck.value
      : null;

    // Calculate score
    let score = 0;

    // Freeze authority revoked (+20)
    if (auth.freezeAuthorityRevoked) {
      score += weights.freezeAuthority;
    }

    // Mint authority revoked (+20)
    if (auth.mintAuthorityRevoked) {
      score += weights.mintAuthority;
    }

    // Not a honeypot (+15)
    // Reality: On Solana, pump.fun rug pulls are LIQUIDITY REMOVAL, not smart contract traps.
    // GoPlus can't distinguish rugs from winners (identical clean configs for both).
    // Jupiter can't verify new PumpSwap tokens (no routes).
    //
    // Strategy:
    // - GoPlus catches Token-2022 scams (transfer hooks, balance mutation) → instant fail
    // - Jupiter catches established token honeypots → full points
    // - PumpSwap unverifiable → partial credit (5 pts instead of 0 or 15)
    //   Rationale: pump.fun bonding curve enforces standard safe config, so honeypot risk
    //   is low. The REAL risk is liquidity removal which scoring can't prevent.
    //   Other checks (observation window, creator age, bundle detection) handle that.
    let honeypotVerifiedByGoPlus = false;

    // GoPlus: check for Token-2022 malicious extensions (instant fail)
    if (goplus.verified && goplus.isDangerous) {
      const gpSafety = isGoPlusSafe(goplus);
      score -= 100;
      logger.warn(`[scorer] 🚨 GoPlus DANGEROUS TOKEN: ${gpSafety.reasons.join(', ')}`);
    }

    // Jupiter honeypot verification (works for established tokens, not new PumpSwap)
    if (!hp.isHoneypot && hp.honeypotVerified) {
      score += weights.honeypot; // Full 15 points
      honeypotVerifiedByGoPlus = false; // Jupiter verified, not GoPlus
    } else if (isPumpSwap) {
      // PumpSwap: can't verify honeypot by any service.
      // Give partial credit (5 pts) - pump.fun bonding curve enforces safe token config
      const PARTIAL_HONEYPOT_CREDIT = 5;
      score += PARTIAL_HONEYPOT_CREDIT;
      logger.debug(`[scorer] PumpSwap unverifiable honeypot → +${PARTIAL_HONEYPOT_CREDIT} partial pts (not ${weights.honeypot})`);
    }

    // Liquidity check (+15, with special handling for pump.fun)
    // pump.fun tokens graduate with ~$69-100K liquidity, higher amounts are suspicious
    let liquidityWarning: string | undefined;
    if (pool.source === 'pumpfun') {
      // pump.fun specific scoring - penalize anomalous liquidity
      if (liq.liquidityUsd < 50_000) {
        score += 10; // Low for graduation
      } else if (liq.liquidityUsd <= 150_000) {
        score += 15; // Normal expected range ($50K-$150K)
      } else if (liq.liquidityUsd <= 300_000) {
        score += 10;
        liquidityWarning = `⚠️ Liquidez anómala para pumpfun: $${Math.round(liq.liquidityUsd / 1000)}K (esperado: ~$70-100K)`;
      } else {
        score += 5; // Very suspicious - potential rug pull setup
        liquidityWarning = `🚨 Liquidez MUY sospechosa para pumpfun: $${Math.round(liq.liquidityUsd / 1000)}K (5x lo normal)`;
      }
    } else if (pool.source === 'pumpswap') {
      // PumpSwap liquidity scoring (v8t - REVISED from v8m)
      // v8m data (N=62): $30K+ = 12% rug, only profitable bracket
      // BUT v8m thresholds made bot UNTRADEABLE: only 2.3% of pools have $30K+
      // ALL-TIME re-analysis (N=152): $15-20K = 64% win, 0 rugs, +0.001 (N=11)
      //   $10-15K = most pools start here (~$11.5K from bonding curve graduation)
      //   Other checks (observation 10s, creator deep, stale drain 3-poll) handle rug risk
      // v8t: Tiered scoring — let clean fresh pools trade (max 75 at $10-15K, needs min_score=75)
      // v9o: Lowered $8K→$5K. SOL at $80 → PumpFun migration liq ~$7-8K, $8K blocks everything.
      // Validation mode (0.001 SOL) = minimal risk. Other checks (creator, observation, ML) handle rug risk.
      // v11c: Liq <$1K = 82.8% rug rate (N=1,154). Eliminatory.
      if (liq.liquidityUsd < 1_000) {
        score -= 100;
        liquidityWarning = `🚨 PumpSwap liq $${Math.round(liq.liquidityUsd)} < $1K → ELIMINATORY (82.8% rug, N=1154)`;
      } else if (liq.liquidityUsd < 5_000) {
        score += 0;
        liquidityWarning = `🚨 PumpSwap liq $${Math.round(liq.liquidityUsd / 1000)}K < $5K (blocked)`;
      } else if (liq.liquidityUsd < 15_000) {
        // $8-15K: 10 pts — fresh bonding curve graduation pools (~$11.5K standard)
        // Perfect fresh pool: freeze(20)+mint(20)+hp(5)+liq(10)+hold(10)+lp(10) = 75 → passes at min_score 75
        // Any penalty (-5 to -15) blocks it → only cleanest pools pass
        score += 10;
        liquidityWarning = `⚠️ PumpSwap liq $${Math.round(liq.liquidityUsd / 1000)}K (fresh pool)`;
      } else if (liq.liquidityUsd < 30_000) {
        // $15-30K: 12 pts — pools with some organic buying
        score += 12;
      } else {
        // $30K+: full 15 pts — established pools
        score += weights.liquidity;
      }
    } else {
      // Standard scoring for other sources (raydium)
      // v11c: Liq <$1K = eliminatory for all sources
      if (liq.liquidityUsd < 1_000) {
        score -= 100;
        liquidityWarning = `🚨 Liq $${Math.round(liq.liquidityUsd)} < $1K → ELIMINATORY`;
      } else {
        const minLiq = this.config.analysis.minLiquidityUsd;
        if (liq.liquidityUsd >= minLiq) {
          score += weights.liquidity;
        } else if (liq.liquidityUsd > 0) {
          score += Math.round(weights.liquidity * (liq.liquidityUsd / minLiq));
        }
      }
    }

    // Holder concentration (+10)
    // Reverted to single sub-score: Token-2022 can't report holders reliably
    const maxHolder = this.config.analysis.maxSingleHolderPct;
    if (isPumpSwap) {
      // PumpSwap: pool vault always dominates → use second-largest holder
      const effectiveHolderPct = hold.holderCount > 1 && hold.holders.length > 1
        ? hold.holders[1].pct
        : hold.topHolderPct <= maxHolder ? hold.topHolderPct : 30;
      if (effectiveHolderPct <= maxHolder) {
        score += weights.holders;
      } else if (effectiveHolderPct <= maxHolder * 2) {
        score += Math.round(weights.holders * (1 - (effectiveHolderPct - maxHolder) / maxHolder));
      }
    } else if (hold.topHolderPct <= maxHolder) {
      score += weights.holders;
    } else if (hold.topHolderPct <= maxHolder * 2) {
      score += Math.round(weights.holders * (1 - (hold.topHolderPct - maxHolder) / maxHolder));
    }

    // Combined non-pool holder concentration penalty (PumpSwap only)
    // v11o: Reduced — hits 100% of fresh pools, doesn't discriminate (was -5 to -20, now -1 to -5)
    let combinedNonPoolPct = 0;
    if (isPumpSwap && hold.holders.length > 2) {
      const nonPoolHolders = hold.holders.slice(1, 6);
      combinedNonPoolPct = nonPoolHolders.reduce((sum, h) => sum + h.pct, 0);
      if (combinedNonPoolPct > 10) {
        let concPenalty: number;
        if (combinedNonPoolPct > 40) {
          concPenalty = 5;
        } else if (combinedNonPoolPct > 30) {
          concPenalty = 4;
        } else if (combinedNonPoolPct > 20) {
          concPenalty = 3;
        } else {
          concPenalty = 1;
        }
        score -= concPenalty;
        logger.warn(`[scorer] ⚠️ Concentrated non-pool holders: top5=${combinedNonPoolPct.toFixed(1)}% → -${concPenalty} (threshold: 10%)`);
      }
    }

    // v10d: Hidden whale detection — -15 per whale (positions 6-20, non-pool holders with >3% supply)
    // Data (N=3456 shadow): 0 whales = 10.9% rug, 1 whale = 33.3% rug, 2+ whales = 58.3% rug
    // Discrimination ratio 5.3x (58.3/10.9), coverage 16% of pools
    if (isPumpSwap && hold.holders.length > 5) {
      const nonPoolHiddenWhales = hold.holders.slice(5, 20).filter(h => h.pct > 3);
      if (nonPoolHiddenWhales.length > 0) {
        const whaleCount = nonPoolHiddenWhales.length;
        const penalty = whaleCount * -15;
        score += penalty;
        logger.warn(`[scorer] ⚠️ Hidden whales: ${whaleCount} holders >3% at positions 6-20 (penalty: ${penalty})`);
      }
    }

    // v11w: Holder killshot — hard rejection if below min_holders (blocks 5/12 rugs, saves +0.043 SOL)
    const minHolders = this.config.analysis.minHolders;
    if (minHolders > 0 && isPumpSwap && hold.holderCount !== -1 && hold.holderCount < minHolders) {
      score -= 100;
      logger.warn(`[scorer] 🚨 HOLDER KILLSHOT: ${hold.holderCount} holders < min ${minHolders} → BLOCKED`);
    }

    // Low holder count penalty (PumpSwap only) - LIQUIDITY-WEIGHTED
    // v11o: Reduced — fresh pools always have few holders, doesn't discriminate (was -25/-15/-5, now -8/-5/-2)
    if (isPumpSwap && hold.holderCount === -1) {
      score -= 10;
      logger.warn(`[scorer] ⚠️ Holder count unknown (DAS failed): penalty -10`);
    } else if (isPumpSwap && hold.holderCount > 0) {
      const highLiquidity = liq.liquidityUsd >= 30_000;
      if (highLiquidity) {
        if (hold.holderCount < 10) {
          logger.info(`[scorer] ✓ Few holders (${hold.holderCount}) but high liq ($${Math.round(liq.liquidityUsd)}) → no penalty`);
        }
      } else if (hold.holderCount <= 1) {
        score -= 8;
        logger.warn(`[scorer] ⚠️ SOLO HOLDER: ${hold.holderCount} (penalty: -8, liq: $${Math.round(liq.liquidityUsd)})`);
      } else if (hold.holderCount < 5) {
        score -= 10; // v11r: raised from -5 (yzo37DNQ rug: 3 holders, top 81%, score 67 → passed)
        logger.warn(`[scorer] ⚠️ Very few holders: ${hold.holderCount} (penalty: -10, liq: $${Math.round(liq.liquidityUsd)})`);
      } else if (hold.holderCount < 10) {
        score -= 2;
        logger.warn(`[scorer] ⚠️ Low holder count: ${hold.holderCount} (penalty: -2, liq: $${Math.round(liq.liquidityUsd)})`);
      }
    }

    // LP burned (+10 for non-PumpSwap only)
    // v10d: Removed PumpSwap LP credit entirely — LP is always "burned" by design, adds 0 discrimination
    // DB analysis (N=14,381): 100% PumpSwap tokens have lp_burned=NO, scoring gave free +5 to all
    // Compensated by observation stability bonus (+10) in index.ts
    if (isPumpSwap) {
      // No LP credit — PumpSwap doesn't use LP tokens, free points add no signal
    } else if (lp.lpBurned) {
      score += weights.lpBurned;
    } else if (lp.lpLockedPct > 50) {
      score += Math.round(weights.lpBurned * (lp.lpLockedPct / 100));
    }

    // RugCheck: bonus for clean tokens, penalty for risky ones
    // v11b: If RugCheck timed out (rc=null), apply small penalty — we can't verify safety
    if (!rc) {
      score -= 3;
      logger.warn(`[scorer] ⚠️ RugCheck timeout/unavailable → -3 penalty (can't verify safety)`);
    } else if (rc) {
      if (rc.score > 70) {
        score += 5; // Clean token bonus
      }
      // Penalize tokens with danger-level risks (insiders, known scammers, etc.)
      // PumpSwap: ignore false positive dangers that are NORMAL for this AMM:
      //   - "LP Unlocked": PumpSwap has no LP tokens by design
      //   - "Single holder ownership" / "High ownership" / "Top 10 holders": pool vault holds 90%+
      //   - "Low Liquidity": RugCheck uses different threshold, our own check is more accurate
      //   - "Freeze Authority still enabled": pump.fun revokes before graduation, RugCheck lags
      // DATA: N=38 trades, rugcheck_score 70-100 for ALL — no differentiation between winners/rugs
      //       These holder/liq dangers appear on 80%+ of PumpSwap tokens including winners
      const dangerRisks = rc.risks.filter(r => r.startsWith('danger:'));
      const PUMPSWAP_FALSE_POSITIVE_DANGERS = [
        'LP Unlocked', 'Single holder ownership', 'High ownership',
        'Top 10 holders high ownership', 'Low Liquidity',
        'Freeze Authority still enabled',
      ];
      const relevantDangers = isPumpSwap
        ? dangerRisks.filter(r => !PUMPSWAP_FALSE_POSITIVE_DANGERS.some(fp => r.includes(fp)))
        : dangerRisks;
      // v11q: "Creator history of rugged tokens" → instant kill (was hidden by -5 + +5 netting to 0)
      const creatorRugHistory = relevantDangers.some(r => r.includes('Creator history of rugged'));
      if (creatorRugHistory) {
        score -= 100;
        logger.warn(`[scorer] 🚨 RugCheck: Creator has history of rugged tokens → BLOCKED`);
      }
      if (relevantDangers.length > 0 && !creatorRugHistory) {
        score -= Math.min(15, relevantDangers.length * 5); // -5 per danger risk, max -15
        logger.warn(`[scorer] RugCheck dangers: ${relevantDangers.join(', ')}${dangerRisks.length > relevantDangers.length ? ` (ignored ${dangerRisks.length - relevantDangers.length} PumpSwap-universal)` : ''}`);
      }
      // Confirmed rug → instant fail
      if (rc.rugged) {
        score -= 100;
        logger.warn(`[scorer] 🚨 RugCheck: token confirmed RUGGED`);
      }
      // Insider network detected by graph analysis → graduated penalty (v8l)
      if (rc.insidersDetected >= 3) {
        score -= 100; // 3+ insiders = confirmed scam, block absolutely
        logger.warn(`[scorer] 🚨 RugCheck: ${rc.insidersDetected} insiders → BLOCKED`);
      } else if (rc.insidersDetected > 0) {
        score -= 20; // 1-2 insiders = strong signal (was -10 in v8k)
        logger.warn(`[scorer] ⚠️ RugCheck: ${rc.insidersDetected} insiders → -20 penalty`);
      }
    }

    // v9r: Block ALL Token-2022 tokens — Jupiter returns Custom:6024, PumpSwap times out
    // Even "safe" Token-2022 tokens without dangerous extensions are UNSELLABLE
    // FGSY (Feb 11): Token-2022, bought successfully, all sell attempts failed → stranded tokens
    if (auth.isToken2022) {
      score -= 100; // Instant fail - we cannot sell these tokens
      logger.warn(`[scorer] 🚨 Token-2022 BLOCKED: Jupiter can't sell Token-2022 tokens (Custom:6024) → REJECTED`);
    }

    // Token-2022 dangerous extensions: instant reject (-100 points)
    // PermanentDelegate, TransferHook, NonTransferable, Pausable, TransferFeeConfig
    // These allow the creator to steal tokens, block sells, or freeze transfers
    if (auth.dangerousExtensions && auth.dangerousExtensions.length > 0) {
      score -= 100; // Instant fail - these are almost always scams
      logger.warn(`[scorer] 🚨 Token-2022 DANGEROUS extensions: ${auth.dangerousExtensions.join(', ')} → score = 0`);
    }

    // Bundled launch penalty: tokens bought via coordinated buys on bonding curve
    if (bundle.penalty < 0) {
      score += bundle.penalty; // penalty is already negative
      logger.warn(`[scorer] ⚠️ Bundled launch: txCount=${bundle.txCount} sameSlot=${bundle.sameSlotCount} penalty=${bundle.penalty}`);
    }

    // Graduation timing (v11c: REVERSED based on N=13,140 data analysis)
    // DATA: fast grad 1-59s = 5.9% rug (SAFEST), negGrad (-1) = 48.5% rug (MOST DANGEROUS)
    // Fast graduation = real demand on bonding curve. Scammers don't spend SOL to graduate fast.
    // Negative graduation (-1) = no bonding curve data = token didn't go through pump.fun = HIGH RISK.
    if (bundle.graduationTimeSeconds < 0) {
      score -= 15; // No bonding curve data = 48.5% rug rate (N=4,622)
      logger.warn(`[scorer] ⚠️ No graduation data (no bonding curve) → -15 penalty`);
    } else if (bundle.graduationTimeSeconds < 60) {
      score += 3; // Fast graduation = real demand, 5.9% rug (N=2,128) — SAFEST category
      logger.info(`[scorer] ✓ Fast graduation: ${bundle.graduationTimeSeconds}s → +3 bonus (strong demand)`);
    } else if (bundle.graduationTimeSeconds < 300) {
      score += 3; // 1-5 min graduation = also safe, 5.0% rug (N=458)
      logger.info(`[scorer] ✓ Normal graduation: ${Math.floor(bundle.graduationTimeSeconds / 60)}m${bundle.graduationTimeSeconds % 60}s → +3 bonus`);
    }
    // 300s+ = 14.4% rug, no bonus no penalty (baseline)

    // v10d: TX Velocity penalty — high velocity = coordinated/bundled activity
    // Data (N=302 detected): >=50 tx/min = 73% coverage, higher rug rate
    // User spec: -20pts for high velocity (coverage ~77%)
    if (bundle.txVelocity >= 50) {
      score -= 20;
      logger.warn(`[scorer] ⚠️ TX velocity ${bundle.txVelocity} tx/min (≥50) → -20 penalty`);
    }

    // v8r: RugCheck insider graph — cross-reference insider wallets with creator
    let insiderWalletCount = 0;
    if (insiderGraph && insiderGraph.insiderWallets.length > 0) {
      insiderWalletCount = insiderGraph.insiderWallets.length;
      if (insiderWalletCount >= 5) {
        score -= 15;
        logger.warn(`[scorer] ⚠️ Insider graph: ${insiderWalletCount} insider wallets → -15 penalty`);
      }
      // Note: cross-reference with coinCreator happens in index.ts where creator is available
    }

    // v11o: HHI penalty — REDUCED from -10/-5 to -3/-1 (hits 100% of fresh pools)
    if (isPumpSwap && hold.holderHHI > 0) {
      if (hold.holderHHI > 0.5) {
        score -= 3;
        logger.warn(`[scorer] ⚠️ HHI extreme: ${hold.holderHHI.toFixed(2)} (>0.5) → -3`);
      } else if (hold.holderHHI > 0.25) {
        score -= 1;
        logger.warn(`[scorer] ⚠️ HHI high: ${hold.holderHHI.toFixed(2)} (>0.25) → -1`);
      }
    }

    // v11n: Timing cluster CV penalty — evenly-spaced TXs = bot coordinated
    if (bundle.timingClusterCV >= 0 && bundle.timingClusterCV < 0.3 && bundle.txCount >= 5) {
      score -= 5;
      logger.warn(`[scorer] ⚠️ Timing CV low: ${bundle.timingClusterCV.toFixed(2)} (<0.3, bot-like) → -5`);
    }

    // Cap at 100
    score = Math.min(100, Math.max(0, score));

    const checks: SecurityChecks = {
      mintAuthorityRevoked: auth.mintAuthorityRevoked,
      freezeAuthorityRevoked: auth.freezeAuthorityRevoked,
      isHoneypot: hp.isHoneypot || goplus.isDangerous,
      honeypotVerified: hp.honeypotVerified || honeypotVerifiedByGoPlus,
      liquidityUsd: liq.liquidityUsd,
      liquiditySol: liq.liquiditySol,
      topHolderPct: hold.topHolderPct,
      holderCount: hold.holderCount,
      lpBurned: lp.lpBurned,
      lpLockedPct: lp.lpLockedPct,
      rugcheckScore: rc?.score,
      rugcheckRisks: rc?.risks,
      dangerousExtensions: auth.dangerousExtensions?.length ? auth.dangerousExtensions : undefined,
      isToken2022: auth.isToken2022 || undefined,
      // v8l: graduation timing + bundle + insiders data for logging and ML
      graduationTimeSeconds: bundle.graduationTimeSeconds,
      bundlePenalty: bundle.penalty,
      insidersCount: rc?.insidersDetected ?? 0,
      // v8q: early activity metrics (data collection)
      earlyTxCount: bundle.earlyTxCount,
      txVelocity: bundle.txVelocity,
      uniqueSlots: bundle.uniqueSlots,
      // v8r: insider graph + hidden whale data
      insiderWallets: insiderGraph?.insiderWallets,
      hiddenWhaleCount: isPumpSwap && hold.holders.length > 5
        ? hold.holders.slice(5, 20).filter(h => h.pct > 3).length
        : undefined,
      // v10f: Non-pool concentration for future analysis
      nonPoolConcentration: combinedNonPoolPct > 0 ? combinedNonPoolPct : undefined,
      // v11n: HHI and timing CV
      holderHHI: hold.holderHHI > 0 ? hold.holderHHI : undefined,
      timingClusterCV: bundle.timingClusterCV >= 0 ? bundle.timingClusterCV : undefined,
    };

    const result: SecurityResult = {
      mint: baseMint,
      score,
      passed: score >= this.config.analysis.minScore,
      checks,
      timestamp: Date.now(),
    };

    const elapsed = Date.now() - startTime;
    logger.info(
      `[analisis] ${shortenAddress(baseMint)} => Puntaje: ${score}/100 (${result.passed ? 'APROBADO' : 'RECHAZADO'}) [${elapsed}ms]`,
    );
    const nonPoolInfo = isPumpSwap && hold.holders.length > 2
      ? ` nonPool5=${combinedNonPoolPct.toFixed(1)}%`
      : '';
    const bundleInfo = bundle.txCount >= 0
      ? ` bcTxs=${bundle.txCount}${bundle.isBundled ? '⚠' : ''}`
      : '';
    const goplusInfo = goplus.verified
      ? ` goplus=${goplus.isDangerous ? '🚨DANGER' : '✓OK'}${goplus.hasTransferHook ? ' HOOK' : ''}${goplus.balanceMutable ? ' BAL_MUT' : ''}`
      : ' goplus=N/A';
    logger.info(
      `[analisis]   mint=${auth.mintAuthorityRevoked ? '✓' : '✗'} freeze=${auth.freezeAuthorityRevoked ? '✓' : '✗'} honeypot=${hp.isHoneypot ? 'SÍ' : hp.honeypotVerified ? 'NO' : 'N/V'}${goplusInfo} liquidez=$${Math.round(liq.liquidityUsd)} holders=${hold.holderCount} top=${hold.topHolderPct.toFixed(1)}%${nonPoolInfo}${bundleInfo}`,
    );
    if (liquidityWarning) {
      logger.warn(`[analisis] ${liquidityWarning}`);
    }

    return result;
  }

  // ═══════ v9z: FAST ANALYSIS — 3 checks (2 RPC + 1 HTTP) ═══════
  private async performFastAnalysis(pool: DetectedPool, startTime: number): Promise<SecurityResult> {
    const { baseMint, poolAddress } = pool;
    const weights = this.config.analysis.weights;
    const isPumpSwap = pool.source === 'pumpswap';

    // 3 fast checks in parallel
    const [authorities, liquidity, goplusCheck] = await Promise.allSettled([
      checkAuthorities(this.connection, baseMint, pool.source),
      checkLiquidity(this.connection, poolAddress),
      checkGoPlus(baseMint),
    ]);

    const auth = authorities.status === 'fulfilled'
      ? authorities.value
      : { mintAuthorityRevoked: false, freezeAuthorityRevoked: false, mintAuthority: null, freezeAuthority: null, supply: 0n, decimals: 0, dangerousExtensions: [] as string[], isToken2022: false };
    const liq = liquidity.status === 'fulfilled'
      ? liquidity.value
      : { liquiditySol: 0, liquidityUsd: 0, poolSolBalance: 0, poolTokenBalance: 0 };
    const goplus = goplusCheck.status === 'fulfilled'
      ? goplusCheck.value
      : { isMintable: false, isFreezable: false, hasTransferFee: false, hasTransferHook: false, isNonTransferable: false, metadataMutable: false, balanceMutable: false, holderCount: 0, topHolderPct: 0, topHolderAddress: null, isDangerous: false, verified: false };

    let score = 0;

    // Freeze authority
    if (auth.freezeAuthorityRevoked) score += weights.freezeAuthority;
    // Mint authority
    if (auth.mintAuthorityRevoked) score += weights.mintAuthority;

    // GoPlus danger
    if (goplus.verified && goplus.isDangerous) {
      const gpSafety = isGoPlusSafe(goplus);
      score -= 100;
      logger.warn(`[scorer-fast] GoPlus DANGEROUS: ${gpSafety.reasons.join(', ')}`);
    }

    // Honeypot: PumpSwap partial credit, non-PumpSwap gets 0 (deferred handles Jupiter check)
    if (isPumpSwap) score += 5;

    // Liquidity scoring (same tiered logic as full analysis)
    let liquidityWarning: string | undefined;
    if (pool.source === 'pumpfun') {
      if (liq.liquidityUsd < 50_000) score += 10;
      else if (liq.liquidityUsd <= 150_000) score += 15;
      else if (liq.liquidityUsd <= 300_000) {
        score += 10;
        liquidityWarning = `PumpFun liq anómala: $${Math.round(liq.liquidityUsd / 1000)}K`;
      } else {
        score += 5;
        liquidityWarning = `PumpFun liq MUY sospechosa: $${Math.round(liq.liquidityUsd / 1000)}K`;
      }
    } else if (pool.source === 'pumpswap') {
      if (liq.liquidityUsd < 5_000) {
        score += 0;
        liquidityWarning = `PumpSwap liq $${Math.round(liq.liquidityUsd / 1000)}K < $5K`;
      } else if (liq.liquidityUsd < 15_000) {
        score += 10;
        liquidityWarning = `PumpSwap liq $${Math.round(liq.liquidityUsd / 1000)}K (fresh)`;
      } else if (liq.liquidityUsd < 30_000) {
        score += 12;
      } else {
        score += weights.liquidity;
      }
    } else {
      const minLiq = this.config.analysis.minLiquidityUsd;
      if (liq.liquidityUsd >= minLiq) score += weights.liquidity;
      else if (liq.liquidityUsd > 0) score += Math.round(weights.liquidity * (liq.liquidityUsd / minLiq));
    }

    // LP: PumpSwap no credit (always "burned" by design, adds 0 discrimination), non-PumpSwap deferred
    // v10d/v9A: Removed PumpSwap LP credit entirely — all PumpSwap tokens identical
    if (isPumpSwap) { /* no LP credit */ }

    // Token-2022 block
    if (auth.isToken2022) {
      score -= 100;
      logger.warn(`[scorer-fast] Token-2022 BLOCKED`);
    }
    if (auth.dangerousExtensions && auth.dangerousExtensions.length > 0) {
      score -= 100;
      logger.warn(`[scorer-fast] Dangerous extensions: ${auth.dangerousExtensions.join(', ')}`);
    }

    score = Math.min(100, Math.max(0, score));

    const checks: SecurityChecks = {
      mintAuthorityRevoked: auth.mintAuthorityRevoked,
      freezeAuthorityRevoked: auth.freezeAuthorityRevoked,
      isHoneypot: goplus.isDangerous,
      honeypotVerified: false,
      liquidityUsd: liq.liquidityUsd,
      liquiditySol: liq.liquiditySol,
      topHolderPct: 100, // unknown until deferred
      holderCount: 0,    // unknown until deferred
      lpBurned: isPumpSwap,
      lpLockedPct: 0,
      dangerousExtensions: auth.dangerousExtensions?.length ? auth.dangerousExtensions : undefined,
      isToken2022: auth.isToken2022 || undefined,
    };

    const elapsed = Date.now() - startTime;
    const result: SecurityResult = {
      mint: baseMint,
      score,
      // v10d: Fast analysis uses lower threshold than final min_score.
      // Fast max for PumpSwap fresh pool = 50 (freeze15+mint20+hp5+liq10).
      // Deferred adds holders(+10), rugcheck(+5), obs bonus(+10) = up to +25 more.
      // Fast threshold = min_score - 15 to allow clean tokens to reach deferred analysis.
      passed: score >= Math.max(0, this.config.analysis.minScore - 15),
      checks,
      timestamp: Date.now(),
    };

    const goplusInfo = goplus.verified
      ? ` goplus=${goplus.isDangerous ? 'DANGER' : 'OK'}${goplus.hasTransferHook ? ' HOOK' : ''}${goplus.balanceMutable ? ' BAL_MUT' : ''}`
      : ' goplus=N/A';
    const fastThreshold = Math.max(0, this.config.analysis.minScore - 15);
    logger.info(`[analisis-fast] ${shortenAddress(baseMint)} => Score: ${score}/100 (${result.passed ? 'PASA' : 'FALLA'}, fast_min=${fastThreshold}) [${elapsed}ms]`);
    logger.info(`[analisis-fast]   mint=${auth.mintAuthorityRevoked ? '✓' : '✗'} freeze=${auth.freezeAuthorityRevoked ? '✓' : '✗'}${goplusInfo} liq=$${Math.round(liq.liquidityUsd)}`);
    if (liquidityWarning) logger.warn(`[analisis-fast] ${liquidityWarning}`);

    return result;
  }

  // ═══════ v9z: DEFERRED ANALYSIS — slow checks, returns delta-adjusted score ═══════
  private async performDeferredAnalysis(pool: DetectedPool, fastResult: SecurityResult, startTime: number): Promise<SecurityResult> {
    const { baseMint, lpMint } = pool;
    const weights = this.config.analysis.weights;
    const isPumpSwap = pool.source === 'pumpswap';

    // Run slow checks in parallel (these use RPC + HTTP APIs)
    const [holders, honeypot, lpStatus, rugcheck, bundleCheck, insiderGraphCheck] = await Promise.allSettled([
      analyzeHolders(this.connection, baseMint),
      this.config.analysis.honeypotCheck && !isPumpSwap
        ? checkHoneypot(baseMint)
        : Promise.resolve({ isHoneypot: false, honeypotVerified: false, buyQuoteOk: !isPumpSwap, sellQuoteOk: !isPumpSwap, buyPriceImpact: 0, sellPriceImpact: 0 }),
      lpMint && !isPumpSwap
        ? checkLpStatus(this.connection, lpMint)
        : Promise.resolve({ lpBurned: false, lpLockedPct: 0, lpTotalSupply: 0n, lpBurnedAmount: 0n }),
      this.config.analysis.rugcheckEnabled
        ? fetchRugCheck(baseMint)
        : Promise.resolve(null),
      isPumpSwap
        ? checkBundledLaunch(this.connection, baseMint, pool.poolCreationBlockTime)
        : Promise.resolve({ txCount: -1, sameSlotCount: 0, isBundled: false, penalty: 0, graduationTimeSeconds: -1, earlyTxCount: 0, txVelocity: 0, uniqueSlots: 0, timingClusterCV: -1 }),
      isPumpSwap ? fetchInsiderGraph(baseMint) : Promise.resolve(null),
    ]);

    const hold = holders.status === 'fulfilled'
      ? holders.value
      : { topHolderPct: 100, top5HoldersPct: 100, top10HoldersPct: 100, holderCount: 0, holders: [], holderHHI: 0 };
    const hp = honeypot.status === 'fulfilled'
      ? honeypot.value
      : { isHoneypot: true, honeypotVerified: false, buyQuoteOk: false, sellQuoteOk: false, buyPriceImpact: 0, sellPriceImpact: 0 };
    const lp = lpStatus.status === 'fulfilled'
      ? lpStatus.value
      : { lpBurned: false, lpLockedPct: 0, lpTotalSupply: 0n, lpBurnedAmount: 0n };
    const rc = rugcheck.status === 'fulfilled' ? rugcheck.value : null;
    const bundle = bundleCheck.status === 'fulfilled'
      ? bundleCheck.value
      : { txCount: -1, sameSlotCount: 0, isBundled: false, penalty: 0, graduationTimeSeconds: -1, earlyTxCount: 0, txVelocity: 0, uniqueSlots: 0, timingClusterCV: -1 };
    const insiderGraph: InsiderGraphResult | null = insiderGraphCheck.status === 'fulfilled'
      ? insiderGraphCheck.value
      : null;

    // Calculate score delta from slow checks
    let delta = 0;

    // Jupiter honeypot (non-PumpSwap only — PumpSwap already has partial credit from fast)
    if (!isPumpSwap && !hp.isHoneypot && hp.honeypotVerified) {
      delta += weights.honeypot; // +15
    }

    // Holder concentration
    const maxHolder = this.config.analysis.maxSingleHolderPct;
    if (isPumpSwap) {
      const effectiveHolderPct = hold.holderCount > 1 && hold.holders.length > 1
        ? hold.holders[1].pct
        : hold.topHolderPct <= maxHolder ? hold.topHolderPct : 30;
      if (effectiveHolderPct <= maxHolder) delta += weights.holders;
      else if (effectiveHolderPct <= maxHolder * 2) delta += Math.round(weights.holders * (1 - (effectiveHolderPct - maxHolder) / maxHolder));
    } else if (hold.topHolderPct <= maxHolder) {
      delta += weights.holders;
    } else if (hold.topHolderPct <= maxHolder * 2) {
      delta += Math.round(weights.holders * (1 - (hold.topHolderPct - maxHolder) / maxHolder));
    }

    // Combined non-pool holder penalty
    // v11o: Reduced — hits 100% of fresh pools, doesn't discriminate (was -5 to -20, now -1 to -5)
    let combinedNonPoolPct = 0;
    let concentratedPenalty = 0;
    if (isPumpSwap && hold.holders.length > 2) {
      const nonPoolHolders = hold.holders.slice(1, 6);
      combinedNonPoolPct = nonPoolHolders.reduce((sum, h) => sum + h.pct, 0);
      if (combinedNonPoolPct > 10) {
        if (combinedNonPoolPct > 40) {
          concentratedPenalty = 5;
        } else if (combinedNonPoolPct > 30) {
          concentratedPenalty = 4;
        } else if (combinedNonPoolPct > 20) {
          concentratedPenalty = 3;
        } else {
          concentratedPenalty = 1;
        }
        delta -= concentratedPenalty;
        logger.warn(`[scorer-deferred] Concentrated non-pool holders: top5=${combinedNonPoolPct.toFixed(1)}% → -${concentratedPenalty}`);
      }
    }

    // v10d: Hidden whale detection — -15 per whale
    let whalePenalty = 0;
    if (isPumpSwap && hold.holders.length > 5) {
      const nonPoolHiddenWhales = hold.holders.slice(5, 20).filter(h => h.pct > 3);
      if (nonPoolHiddenWhales.length > 0) {
        const whaleCount = nonPoolHiddenWhales.length;
        whalePenalty = whaleCount * 15;
        delta -= whalePenalty;
        logger.warn(`[scorer-deferred] Hidden whales: ${whaleCount} holders >3% (penalty: -${whalePenalty})`);
      }
    }

    // v11w: Holder killshot — hard rejection if below min_holders
    const minHolders = this.config.analysis.minHolders;
    if (minHolders > 0 && isPumpSwap && hold.holderCount !== -1 && hold.holderCount < minHolders) {
      delta -= 100;
      logger.warn(`[scorer-deferred] 🚨 HOLDER KILLSHOT: ${hold.holderCount} holders < min ${minHolders} → BLOCKED`);
    }

    // Low holder count penalty
    // v11o: Reduced — fresh pools always have few holders, doesn't discriminate (was -25/-15/-5, now -8/-5/-2)
    let holderPenalty = 0;
    const liqUsd = fastResult.checks.liquidityUsd;
    if (isPumpSwap && hold.holderCount === -1) {
      holderPenalty = 10;
      delta -= holderPenalty;
      logger.warn(`[scorer-deferred] Holder count unknown (DAS failed): -10`);
    } else if (isPumpSwap && hold.holderCount > 0) {
      const highLiquidity = liqUsd >= 30_000;
      if (highLiquidity) {
        if (hold.holderCount < 10) {
          logger.info(`[scorer-deferred] Few holders (${hold.holderCount}) but high liq → no penalty`);
        }
      } else if (hold.holderCount <= 1) {
        holderPenalty = 8;
        delta -= holderPenalty;
        logger.warn(`[scorer-deferred] SOLO HOLDER: ${hold.holderCount} (-${holderPenalty}, liq: $${Math.round(liqUsd)})`);
      } else if (hold.holderCount < 5) {
        holderPenalty = 10; // v11r: raised from -5 (yzo37DNQ rug: 3 holders, top 81%)
        delta -= holderPenalty;
        logger.warn(`[scorer-deferred] Very few holders: ${hold.holderCount} (-${holderPenalty})`);
      } else if (hold.holderCount < 10) {
        holderPenalty = 2;
        delta -= holderPenalty;
        logger.warn(`[scorer-deferred] Low holders: ${hold.holderCount} (-${holderPenalty})`);
      }
    }

    // LP (non-PumpSwap only — PumpSwap has 0 LP credit, doesn't discriminate)
    if (!isPumpSwap) {
      if (lp.lpBurned) delta += weights.lpBurned;
      else if (lp.lpLockedPct > 50) delta += Math.round(weights.lpBurned * (lp.lpLockedPct / 100));
    }

    // RugCheck (v11b: timeout penalty)
    let rugcheckPenalty = 0;
    if (!rc) {
      rugcheckPenalty = 3;
      delta -= rugcheckPenalty;
      logger.warn(`[scorer-deferred] RugCheck timeout → -3`);
    } else if (rc) {
      if (rc.score > 70) { delta += 5; rugcheckPenalty -= 5; } // bonus = negative penalty
      const dangerRisks = rc.risks.filter(r => r.startsWith('danger:'));
      const PUMPSWAP_FALSE_POSITIVE_DANGERS = [
        'LP Unlocked', 'Single holder ownership', 'High ownership',
        'Top 10 holders high ownership', 'Low Liquidity',
        'Freeze Authority still enabled',
      ];
      const relevantDangers = isPumpSwap
        ? dangerRisks.filter(r => !PUMPSWAP_FALSE_POSITIVE_DANGERS.some(fp => r.includes(fp)))
        : dangerRisks;
      // v11q: "Creator history of rugged tokens" → instant kill
      const creatorRugHistory = relevantDangers.some(r => r.includes('Creator history of rugged'));
      if (creatorRugHistory) {
        rugcheckPenalty += 100;
        delta -= 100;
        logger.warn(`[scorer-deferred] 🚨 RugCheck: Creator has history of rugged tokens → BLOCKED`);
      }
      if (relevantDangers.length > 0 && !creatorRugHistory) {
        const dangerPen = Math.min(15, relevantDangers.length * 5);
        rugcheckPenalty += dangerPen;
        delta -= dangerPen;
        logger.warn(`[scorer-deferred] RugCheck dangers: ${relevantDangers.join(', ')}`);
      }
      if (rc.rugged) {
        rugcheckPenalty += 100;
        delta -= 100;
        logger.warn(`[scorer-deferred] RugCheck: RUGGED`);
      }
      if (rc.insidersDetected >= 3) {
        rugcheckPenalty += 100;
        delta -= 100;
        logger.warn(`[scorer-deferred] RugCheck: ${rc.insidersDetected} insiders → BLOCKED`);
      } else if (rc.insidersDetected > 0) {
        rugcheckPenalty += 20;
        delta -= 20;
        logger.warn(`[scorer-deferred] RugCheck: ${rc.insidersDetected} insiders → -20`);
      }
    }

    // Token-2022 block (from RugCheck — redundant with fast but defensive)
    if (rc && (rc as any).isToken2022) {
      delta -= 100;
    }

    // Bundle penalty
    if (bundle.penalty < 0) {
      delta += bundle.penalty;
      logger.warn(`[scorer-deferred] Bundle: txCount=${bundle.txCount} penalty=${bundle.penalty}`);
    }

    // Graduation timing (v11c: REVERSED — fast=safe, negGrad=dangerous)
    let graduationBonus = 0;
    if (bundle.graduationTimeSeconds < 0) {
      graduationBonus = -15;
      delta -= 15;
      logger.warn(`[scorer-deferred] No graduation data → -15`);
    } else if (bundle.graduationTimeSeconds < 60) {
      graduationBonus = 3;
      delta += 3;
      logger.info(`[scorer-deferred] Fast graduation ${bundle.graduationTimeSeconds}s → +3`);
    } else if (bundle.graduationTimeSeconds < 300) {
      graduationBonus = 3;
      delta += 3;
      logger.info(`[scorer-deferred] Normal graduation → +3`);
    }

    // v10d: TX Velocity penalty — -20 for >=50 tx/min
    let velocityPenalty = 0;
    if (bundle.txVelocity >= 50) {
      velocityPenalty = 20;
      delta -= 20;
      logger.warn(`[scorer-deferred] TX velocity ${bundle.txVelocity} tx/min (≥50) → -20`);
    }

    // Insider graph wallets
    let insiderWalletCount = 0;
    let insiderPenalty = 0;
    if (insiderGraph && insiderGraph.insiderWallets.length > 0) {
      insiderWalletCount = insiderGraph.insiderWallets.length;
      if (insiderWalletCount >= 5) {
        insiderPenalty = 15;
        delta -= 15;
        logger.warn(`[scorer-deferred] Insider graph: ${insiderWalletCount} wallets → -15`);
      }
    }

    // v11o: HHI penalty — REDUCED from -10/-5 to -3/-1 (hits 100% of fresh pools)
    let hhiPenalty = 0;
    if (isPumpSwap && hold.holderHHI > 0) {
      if (hold.holderHHI > 0.5) {
        hhiPenalty = 3;
        delta -= 3;
        logger.warn(`[scorer-deferred] HHI extreme: ${hold.holderHHI.toFixed(2)} (>0.5) → -3`);
      } else if (hold.holderHHI > 0.25) {
        hhiPenalty = 1;
        delta -= 1;
        logger.warn(`[scorer-deferred] HHI high: ${hold.holderHHI.toFixed(2)} (>0.25) → -1`);
      }
    }

    // v11n: Timing cluster CV penalty — evenly-spaced TXs = bot coordinated
    let timingCvPenalty = 0;
    if (bundle.timingClusterCV >= 0 && bundle.timingClusterCV < 0.3 && bundle.txCount >= 5) {
      timingCvPenalty = 5;
      delta -= 5;
      logger.warn(`[scorer-deferred] Timing CV low: ${bundle.timingClusterCV.toFixed(2)} (<0.3, bot-like) → -5`);
    }

    // Apply delta to fast score
    const newScore = Math.min(100, Math.max(0, fastResult.score + delta));

    // Merge checks with full data
    const checks: SecurityChecks = {
      ...fastResult.checks,
      isHoneypot: hp.isHoneypot || fastResult.checks.isHoneypot,
      honeypotVerified: hp.honeypotVerified || fastResult.checks.honeypotVerified,
      topHolderPct: hold.topHolderPct,
      holderCount: hold.holderCount,
      lpBurned: isPumpSwap || lp.lpBurned,
      lpLockedPct: lp.lpLockedPct,
      rugcheckScore: rc?.score,
      rugcheckRisks: rc?.risks,
      graduationTimeSeconds: bundle.graduationTimeSeconds,
      bundlePenalty: bundle.penalty,
      insidersCount: rc?.insidersDetected ?? 0,
      earlyTxCount: bundle.earlyTxCount,
      txVelocity: bundle.txVelocity,
      uniqueSlots: bundle.uniqueSlots,
      insiderWallets: insiderGraph?.insiderWallets,
      hiddenWhaleCount: isPumpSwap && hold.holders.length > 5
        ? hold.holders.slice(5, 20).filter(h => h.pct > 3).length
        : undefined,
      // v10f: Non-pool concentration for future analysis
      nonPoolConcentration: combinedNonPoolPct > 0 ? combinedNonPoolPct : undefined,
      // v11n: HHI and timing CV
      holderHHI: hold.holderHHI > 0 ? hold.holderHHI : undefined,
      timingClusterCV: bundle.timingClusterCV >= 0 ? bundle.timingClusterCV : undefined,
    };

    const elapsed = Date.now() - startTime;
    const result: SecurityResult = {
      mint: baseMint,
      score: newScore,
      passed: newScore >= this.config.analysis.minScore,
      checks,
      timestamp: Date.now(),
      // v11o: Scoring breakdown for DB persistence and backtesting
      breakdown: {
        fastScore: fastResult.score,
        deferredDelta: delta,
        finalScore: newScore,
        hhiValue: hold.holderHHI,
        hhiPenalty: -hhiPenalty,
        concentratedValue: combinedNonPoolPct,
        concentratedPenalty: -concentratedPenalty,
        holderPenalty: -holderPenalty,
        graduationBonus,
        obsBonus: 0,          // filled in index.ts
        organicBonus: 0,      // filled in index.ts
        smartWalletBonus: 0,  // filled in index.ts
        creatorAgePenalty: 0,  // filled in index.ts
        rugcheckPenalty: -rugcheckPenalty,
        velocityPenalty: -velocityPenalty,
        insiderPenalty: -insiderPenalty,
        whalePenalty: -whalePenalty,
        timingCvPenalty: -timingCvPenalty,
        networkRugPenalty: 0,  // filled in index.ts
      },
    };

    const nonPoolInfo = isPumpSwap && hold.holders.length > 2
      ? ` nonPool5=${combinedNonPoolPct.toFixed(1)}%`
      : '';
    const bundleInfo = bundle.txCount >= 0
      ? ` bcTxs=${bundle.txCount}${bundle.isBundled ? '⚠' : ''}`
      : '';
    const hhiInfo = hold.holderHHI > 0 ? ` HHI=${hold.holderHHI.toFixed(2)}` : '';
    const cvInfo = bundle.timingClusterCV >= 0 ? ` CV=${bundle.timingClusterCV.toFixed(2)}` : '';
    logger.info(`[analisis-deferred] ${shortenAddress(baseMint)} => ${fastResult.score}${delta >= 0 ? '+' : ''}${delta}=${newScore}/100 (${result.passed ? 'PASA' : 'FALLA'}) [${elapsed}ms]`);
    logger.info(`[analisis-deferred]   holders=${hold.holderCount} top=${hold.topHolderPct.toFixed(1)}%${nonPoolInfo}${bundleInfo}${hhiInfo}${cvInfo} rugcheck=${rc?.score ?? 'N/A'}`);

    return result;
  }
}
