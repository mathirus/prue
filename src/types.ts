import { PublicKey } from '@solana/web3.js';

// ─── Bot Configuration ───────────────────────────────────────────────

export interface BotConfig {
  rpc: {
    url: string;
    urlBackup: string;
    wsUrl: string;
  };
  wallet: {
    privateKey: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
    adminIds: number[];
    enabled: boolean;
    notifyDetection: boolean;
    notifyBuy: boolean;
    notifySell: boolean;
    notifyStopLoss: boolean;
    notifyError: boolean;
  };
  jito: {
    blockEngineUrl: string;
    authKeypair: string;
  };
  redis: {
    url: string;
  };
  detection: {
    raydiumAmmV4: boolean;
    pumpfun: boolean;
    pumpswap: boolean;
    pollIntervalMs: number;
    yellowstone: {
      enabled: boolean;
      endpoint: string;
      token: string;
      dailyResponseLimit: number;
    };
  };
  analysis: {
    minScore: number;
    weights: SecurityWeights;
    minLiquidityUsd: number;
    maxSingleHolderPct: number;
    rugcheckEnabled: boolean;
    honeypotCheck: boolean;
    observationWindow: {
      enabled: boolean;
      durationMs: number;
      pollIntervalMs: number;
      maxDropPct: number;
    };
    creatorDeepCheck: {
      enabled: boolean;
      maxFundingHops: number;
      networkThreshold: number;
      reputationWeight: boolean;
    };
    mlClassifier: {
      enabled: boolean;
      minConfidence: number;
      version: number;
    };
  };
  execution: {
    useJupiter: boolean;
    useRaydiumFallback: boolean;
    useJito: boolean;
    jitoTipLamports: number;
    slippageBps: number;
    computeUnitLimit: number;
    priorityFeeMicrolamports: number;
    confirmTimeoutMs: number;
  };
  position: {
    takeProfit: TakeProfitLevel[];
    stopLossPct: number;
    trailingStopPct: number;
    moonBagPct: number;
    pricePollMs: number;
    timeoutMinutes: number;
  };
  risk: {
    maxPositionSol: number;
    maxConcurrent: number;
    maxTradesPerSession: number;
    dailyLossLimitPct: number;
    dryRun: boolean;
    shadowMode: boolean;
    shadowMaxConcurrent: number;
    shadowTimeoutMinutes: number;
    shadowPollMs: number;
  };
  copyTrading: {
    enabled: boolean;
    maxCopySol: number;
    minMarketCap: number;
    delayMs: number;
    minPoolBurntRatio: number;
  };
}

export interface SecurityWeights {
  freezeAuthority: number;
  mintAuthority: number;
  honeypot: number;
  liquidity: number;
  holders: number;
  lpBurned: number;
}

export interface TakeProfitLevel {
  pct: number;
  atMultiplier: number;
}

// ─── Detection ───────────────────────────────────────────────────────

export type PoolSource = 'raydium_amm_v4' | 'raydium_clmm' | 'raydium_cpmm' | 'pumpfun' | 'pumpswap';

export interface DetectedPool {
  id: string;
  source: PoolSource;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  lpMint?: PublicKey;
  initialLiquidityBase?: number;
  initialLiquidityQuote?: number;
  detectedAt: number;
  slot: number;
  txSignature: string;
  poolCreationBlockTime?: number; // v8m: Unix timestamp from pool creation TX (for graduation timing)
  deployer?: string; // v9s: Fee payer of pool creation TX (for Tier 0 rate limiting)
}

// ─── Security Analysis ───────────────────────────────────────────────

// v11o: Scoring breakdown for backtesting — each penalty/bonus tracked individually
export interface ScoringBreakdown {
  fastScore: number;
  deferredDelta: number;
  finalScore: number;
  // Individual components
  hhiValue: number;
  hhiPenalty: number;
  concentratedValue: number;
  concentratedPenalty: number;
  holderPenalty: number;
  graduationBonus: number;
  obsBonus: number;
  organicBonus: number;
  smartWalletBonus: number;
  creatorAgePenalty: number;
  rugcheckPenalty: number;
  velocityPenalty: number;
  insiderPenalty: number;
  whalePenalty: number;
  timingCvPenalty: number;
}

export interface SecurityResult {
  mint: PublicKey;
  score: number;
  passed: boolean;
  checks: SecurityChecks;
  timestamp: number;
  breakdown?: ScoringBreakdown; // v11o: detailed scoring breakdown for DB persistence
}

export interface SecurityChecks {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  isHoneypot: boolean;
  honeypotVerified: boolean;
  liquidityUsd: number;
  liquiditySol: number;
  topHolderPct: number;
  holderCount: number;
  lpBurned: boolean;
  lpLockedPct: number;
  rugcheckScore?: number;
  rugcheckRisks?: string[];
  dangerousExtensions?: string[];
  isToken2022?: boolean; // v9r: Token-2022 program — can't sell via Jupiter
  // v8l: graduation timing, bundle data, insiders count
  graduationTimeSeconds?: number;
  bundlePenalty?: number;
  insidersCount?: number;
  // v8q: Early activity metrics (data collection)
  earlyTxCount?: number;
  txVelocity?: number;
  uniqueSlots?: number;
  // v8r: Insider graph + hidden whale data
  insiderWallets?: string[];
  hiddenWhaleCount?: number;
  // v9A: Wash trading penalty for ML feature
  washPenalty?: number;
  // v10f: Non-pool holder concentration (top5 non-pool holders as % of supply)
  nonPoolConcentration?: number;
  // v11n: HHI of non-pool holders (0-1, >0.25 = concentrated)
  holderHHI?: number;
  // v11n: Timing cluster CV of bonding curve TXs (<0.3 = bot, >0.5 = organic)
  timingClusterCV?: number;
}

// ─── Trade Execution ─────────────────────────────────────────────────

export type TradeType = 'buy' | 'sell';
export type TradeStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface TradeOrder {
  type: TradeType;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: number;
  slippageBps: number;
  useJito: boolean;
  jitoTipLamports?: number;
}

export interface TradeResult {
  success: boolean;
  txSignature?: string;
  inputAmount: number;
  outputAmount: number;
  pricePerToken: number;
  fee: number;
  slot?: number;
  timestamp: number;
  error?: string;
  poolReserves?: { solLamports: number };
  ataOverheadLamports?: number; // v8t: irrecoverable ATA rent paid for others
}

// ─── Position Management ─────────────────────────────────────────────

export type PositionStatus = 'open' | 'partial_close' | 'closed' | 'stopped';

export interface Position {
  id: string;
  poolId?: string;              // v11o-data: links to detected_pools.id for JOIN queries
  tokenMint: PublicKey;
  poolAddress: PublicKey;
  source: PoolSource;
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  tokenAmount: number;
  solInvested: number;
  solReturned: number;
  pnlSol: number;
  pnlPct: number;
  status: PositionStatus;
  tpLevelsHit: number[];
  openedAt: number;
  closedAt?: number;
  securityScore: number;
  // Extra context for post-hoc analysis
  holderCount?: number;
  liquidityUsd?: number;
  // v8g: Detailed exit tracking for strategy optimization
  exitReason?: string;       // tp_complete, trailing_stop, stop_loss, timeout, pool_drained, max_retries, rug_pull, early_exit, breakeven_floor, moon_profit_floor, manual_close, stranded_recovered_*, stranded_timeout_*, stranded_pool_drained
  peakMultiplier?: number;   // peak_price / entry_price
  timeToPeakMs?: number;     // timestamp_of_peak - opened_at
  sellAttempts: number;      // total sell attempts (including retries)
  sellSuccesses: number;     // successful sells
  // v8u: Sell burst tracking
  sellBurstCount?: number;   // number of sells detected in burst window when emergency sell triggered
  // v8u: Aggregate sell tracking for ML feature engineering
  totalSellEvents?: number;  // cumulative sells observed on pool during position lifetime
  maxSellBurst?: number;     // maximum sell count seen in any 15s window
  // v8v: Reserve tracking for smart burst detection
  entryReserveLamports?: number;   // SOL reserve at time of buy (for burst reserve comparison)
  currentReserveLamports?: number; // latest known SOL reserve (updated each price poll)
  // v8p: Entry timing
  entryLatencyMs?: number;   // detection → buy execution time in ms
}

// ─── Copy Trading ────────────────────────────────────────────────────

export interface WalletTarget {
  address: PublicKey;
  label: string;
  enabled: boolean;
  maxCopySol: number;
  winRate?: number;
  totalPnl?: number;
  tradesCount?: number;
  addedAt: number;
}

export interface WalletTrade {
  walletAddress: PublicKey;
  tokenMint: PublicKey;
  type: TradeType;
  amount: number;
  txSignature: string;
  timestamp: number;
}

// ─── Analytics ───────────────────────────────────────────────────────

export interface BotAnalytics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlSol: number;
  totalVolumeSol: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  openPositions: number;
}

// ─── Events ──────────────────────────────────────────────────────────

export interface BotEvents {
  newPool: (pool: DetectedPool) => void;
  migration: (pool: DetectedPool) => void;
  securityResult: (result: SecurityResult) => void;
  tradeExecuted: (result: TradeResult & { pool: DetectedPool }) => void;
  positionOpened: (position: Position) => void;
  positionUpdated: (position: Position) => void;
  positionClosed: (position: Position) => void;
  takeProfitHit: (position: Position, level: number) => void;
  stopLossHit: (position: Position) => void;
  walletTrade: (trade: WalletTrade) => void;
  error: (error: Error, context: string) => void;
  // v10d: Background sell completion — parallel sell race caused both to succeed
  backgroundSellCompleted: (data: { tokenMint: string; outputAmountLamports: number }) => void;
}
