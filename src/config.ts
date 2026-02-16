import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import type { BotConfig, TakeProfitLevel, SecurityWeights, SmartTpConfig } from './types.js';

dotenvConfig();

function loadYaml(filePath: string): Record<string, unknown> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseYaml(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

function envNum(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

export function loadConfig(): BotConfig {
  const yamlPath = resolve(process.cwd(), 'config', 'default.yaml');
  const yaml = loadYaml(yamlPath) as Record<string, Record<string, unknown>>;

  const detection = (yaml.detection ?? {}) as Record<string, unknown>;
  const analysis = (yaml.analysis ?? {}) as Record<string, unknown>;
  const analysisWeights = (analysis.weights ?? {}) as Record<string, number>;
  const execution = (yaml.execution ?? {}) as Record<string, unknown>;
  const position = (yaml.position ?? {}) as Record<string, unknown>;
  const risk = (yaml.risk ?? {}) as Record<string, unknown>;
  const copyTrading = (yaml.copy_trading ?? {}) as Record<string, unknown>;
  const telegram = (yaml.telegram ?? {}) as Record<string, unknown>;
  const takeProfit = (position.take_profit ?? []) as Array<{ pct: number; at_multiplier: number }>;

  // v11b: Helius backrun rebates — append rebate-address to RPC URLs (free SOL back, no latency cost)
  const rebateAddr = env('REBATE_ADDRESS');
  const appendRebate = (url: string) => {
    if (!rebateAddr || !url.includes('helius')) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}rebate-address=${rebateAddr}`;
  };

  const config: BotConfig = {
    rpc: {
      url: appendRebate(env('RPC_URL', 'https://api.mainnet-beta.solana.com')),
      urlBackup: appendRebate(env('RPC_URL_BACKUP', 'https://api.mainnet-beta.solana.com')),
      wsUrl: env('RPC_WS_URL', 'wss://api.mainnet-beta.solana.com'),
    },
    wallet: {
      privateKey: env('PRIVATE_KEY'),
    },
    telegram: {
      botToken: env('TELEGRAM_BOT_TOKEN'),
      chatId: env('TELEGRAM_CHAT_ID'),
      adminIds: env('TELEGRAM_ADMIN_IDS')
        .split(',')
        .filter(Boolean)
        .map(Number),
      enabled: (telegram.enabled as boolean) ?? true,
      notifyDetection: (telegram.notify_detection as boolean) ?? true,
      notifyBuy: (telegram.notify_buy as boolean) ?? true,
      notifySell: (telegram.notify_sell as boolean) ?? true,
      notifyStopLoss: (telegram.notify_stop_loss as boolean) ?? true,
      notifyError: (telegram.notify_error as boolean) ?? true,
    },
    jito: {
      blockEngineUrl: env('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
      authKeypair: env('JITO_AUTH_KEYPAIR'),
    },
    redis: {
      url: env('REDIS_URL', 'redis://localhost:6379'),
    },
    detection: {
      raydiumAmmV4: (detection.raydium_amm_v4 as boolean) ?? true,
      pumpfun: (detection.pumpfun as boolean) ?? true,
      pumpswap: (detection.pumpswap as boolean) ?? true,
      pollIntervalMs: (detection.poll_interval_ms as number) ?? 2000,
      yellowstone: (() => {
        const ys = (detection.yellowstone ?? {}) as Record<string, unknown>;
        return {
          enabled: (ys.enabled as boolean) ?? false,
          endpoint: env('QUICKNODE_GRPC_ENDPOINT', (ys.endpoint as string) ?? ''),
          token: env('QUICKNODE_GRPC_TOKEN', (ys.token as string) ?? ''),
          dailyResponseLimit: (ys.daily_response_limit as number) ?? 50000,
        };
      })(),
    },
    analysis: {
      minScore: (analysis.min_score as number) ?? 60,
      minHolders: (analysis.min_holders as number) ?? 0,  // v11w: 0 = disabled
      weights: {
        freezeAuthority: analysisWeights.freeze_authority ?? 20,
        mintAuthority: analysisWeights.mint_authority ?? 20,
        honeypot: analysisWeights.honeypot ?? 20,
        liquidity: analysisWeights.liquidity ?? 15,
        holders: analysisWeights.holders ?? 15,
        lpBurned: analysisWeights.lp_burned ?? 10,
      } satisfies SecurityWeights,
      minLiquidityUsd: (analysis.min_liquidity_usd as number) ?? 5000,
      maxSingleHolderPct: (analysis.max_single_holder_pct as number) ?? 20,
      rugcheckEnabled: (analysis.rugcheck_enabled as boolean) ?? true,
      honeypotCheck: (analysis.honeypot_check as boolean) ?? true,
      observationWindow: (() => {
        const ow = (analysis.observation_window ?? {}) as Record<string, unknown>;
        return {
          enabled: (ow.enabled as boolean) ?? true,
          durationMs: (ow.duration_ms as number) ?? 20000,
          pollIntervalMs: (ow.poll_interval_ms as number) ?? 4000,
          maxDropPct: (ow.max_drop_pct as number) ?? 8,
        };
      })(),
      creatorDeepCheck: (() => {
        const cdc = (analysis.creator_deep_check ?? {}) as Record<string, unknown>;
        return {
          enabled: (cdc.enabled as boolean) ?? true,
          maxFundingHops: (cdc.max_funding_hops as number) ?? 2,
          networkThreshold: (cdc.network_threshold as number) ?? 3,
          reputationWeight: (cdc.reputation_weight as boolean) ?? true,
        };
      })(),
      mlClassifier: (() => {
        const ml = (analysis.ml_classifier ?? {}) as Record<string, unknown>;
        return {
          enabled: (ml.enabled as boolean) ?? false,
          minConfidence: (ml.min_confidence as number) ?? 0.70,
          version: (ml.version as number) ?? 1,
        };
      })(),
    },
    execution: {
      useJupiter: (execution.use_jupiter as boolean) ?? true,
      useRaydiumFallback: (execution.use_raydium_fallback as boolean) ?? true,
      useJito: (execution.use_jito as boolean) ?? true,
      jitoTipLamports: (execution.jito_tip_lamports as number) ?? 100000,
      slippageBps: (execution.slippage_bps as number) ?? 300,
      computeUnitLimit: (execution.compute_unit_limit as number) ?? 200000,
      priorityFeeMicrolamports: (execution.priority_fee_microlamports as number) ?? 50000,
      confirmTimeoutMs: (execution.confirm_timeout_ms as number) ?? 30000,
    },
    position: {
      takeProfit: takeProfit.map(
        (tp): TakeProfitLevel => ({
          pct: tp.pct,
          atMultiplier: tp.at_multiplier,
        }),
      ),
      stopLossPct: (position.stop_loss_pct as number) ?? -30,
      trailingStopPct: (position.trailing_stop_pct as number) ?? 15,
      moonBagPct: (position.moon_bag_pct as number) ?? 0,
      pricePollMs: (position.price_poll_ms as number) ?? 2000,
      timeoutMinutes: (position.timeout_minutes as number) ?? 30,
      smartTp: (() => {
        const stp = (position.smart_tp ?? {}) as Record<string, unknown>;
        return {
          enabled: (stp.enabled as boolean) ?? false,
          minPositionSol: (stp.min_position_sol as number) ?? 0.010,
          defaultSellPct: (stp.default_sell_pct as number) ?? 100,
          confidentSellPct: (stp.confident_sell_pct as number) ?? 60,
          minReserveGrowthPct: (stp.min_reserve_growth_pct as number) ?? 5,
          maxBuySellRatio: (stp.max_buy_sell_ratio as number) ?? 1.5,
          maxTimeToTp1Ms: (stp.max_time_to_tp1_ms as number) ?? 15000,
          maxCumulativeSells: (stp.max_cumulative_sells as number) ?? 20,
          minSignalsRequired: (stp.min_signals_required as number) ?? 2,
        } satisfies SmartTpConfig;
      })(),
      // v11u: Micro trailing — tight trailing in first 60s to catch ultra-fast rugs
      microTrailing: (() => {
        const mt = (position.micro_trailing ?? {}) as Record<string, unknown>;
        return {
          enabled: (mt.enabled as boolean) ?? true,
          windowMs: (mt.window_ms as number) ?? 60_000,
          minPeakMultiplier: (mt.min_peak_multiplier as number) ?? 1.01,
          dropFromPeakPct: (mt.drop_from_peak_pct as number) ?? 3,
        };
      })(),
      // v11u: Buy drought detector — detect dead demand
      buyDrought: (() => {
        const bd = (position.buy_drought ?? {}) as Record<string, unknown>;
        return {
          enabled: (bd.enabled as boolean) ?? true,
          snapshotsForTighten: (bd.snapshots_for_tighten as number) ?? 2,
          sellCountForTighten: (bd.sell_count_for_tighten as number) ?? 5,
          tightenTrailingPct: (bd.tighten_trailing_pct as number) ?? 5,
          snapshotsForEmergency: (bd.snapshots_for_emergency as number) ?? 3,
          sellCountForEmergency: (bd.sell_count_for_emergency as number) ?? 10,
        };
      })(),
    },
    risk: {
      maxPositionSol: (risk.max_position_sol as number) ?? 0.15,
      maxConcurrent: (risk.max_concurrent as number) ?? 5,
      maxTradesPerSession: (risk.max_trades_per_session as number) ?? 0,
      dailyLossLimitPct: (risk.daily_loss_limit_pct as number) ?? 10,
      dryRun: envBool('DRY_RUN', (risk.dry_run as boolean) ?? true),
      shadowMode: envBool('SHADOW_MODE', (risk.shadow_mode as boolean) ?? false),
      shadowMaxConcurrent: (risk.shadow_max_concurrent as number) ?? 20,
      shadowTimeoutMinutes: (risk.shadow_timeout_minutes as number) ?? 15,
      shadowPollMs: (risk.shadow_poll_ms as number) ?? 5000,
      pauseOnRug: envBool('PAUSE_ON_RUG', (risk.pause_on_rug as boolean) ?? false),
    },
    copyTrading: {
      enabled: (copyTrading.enabled as boolean) ?? false,
      maxCopySol: (copyTrading.max_copy_sol as number) ?? 0.1,
      minMarketCap: (copyTrading.min_market_cap as number) ?? 50000,
      delayMs: (copyTrading.delay_ms as number) ?? 500,
      minPoolBurntRatio: (copyTrading.min_pool_burnt_ratio as number) ?? 0.5,
    },
  };

  return config;
}

export function validateConfig(config: BotConfig): string[] {
  const errors: string[] = [];

  if (!config.rpc.url) errors.push('RPC_URL is required');
  if (!config.wallet.privateKey) errors.push('PRIVATE_KEY is required');
  if (config.telegram.enabled && !config.telegram.botToken) {
    errors.push('TELEGRAM_BOT_TOKEN is required when Telegram is enabled');
  }

  return errors;
}
// trigger reload vie.,  6 de feb. de 2026 09:09:29 a. m.
