import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

// Solana-specific endpoint (different from EVM)
const GOPLUS_SOLANA_API = 'https://api.gopluslabs.io/api/v1/solana/token_security';

export interface GoPlusResult {
  // Token configuration flags (Solana SPL-specific)
  isMintable: boolean;         // creator can mint more tokens
  isFreezable: boolean;        // creator can freeze accounts
  hasTransferFee: boolean;     // token has transfer fee config
  hasTransferHook: boolean;    // token has transfer hook (can block sells)
  isNonTransferable: boolean;  // token cannot be transferred
  metadataMutable: boolean;    // metadata can be changed
  balanceMutable: boolean;     // authority can mutate balances directly
  // Holder analysis
  holderCount: number;
  topHolderPct: number;        // top holder % of supply
  topHolderAddress: string | null;
  // Derived danger flags
  isDangerous: boolean;        // has any dangerous flag (transfer hook, balance mutable)
  verified: boolean;           // whether check actually returned data
  error?: string;
}

/**
 * GoPlus Security API for Solana - FREE, no API key needed.
 *
 * IMPORTANT: Solana endpoint returns SPL token config fields (mintable, freezable,
 * transfer_hook, transfer_fee, etc.) NOT EVM fields (is_honeypot, buy_tax).
 *
 * For pump.fun tokens, ALL security flags are typically identical (all clean) because
 * pump.fun tokens are created with standard safe configs. The rug pull mechanism on
 * Solana is LIQUIDITY REMOVAL, not smart contract traps.
 *
 * GoPlus IS useful for catching Token-2022 scams (transfer hooks, freeze authority,
 * balance mutation) which are a different class of attack.
 *
 * Latency: ~500-1500ms. Rate limit: 30 req/min (free tier).
 */
export async function checkGoPlus(mintAddress: PublicKey): Promise<GoPlusResult> {
  const defaultResult: GoPlusResult = {
    isMintable: false,
    isFreezable: false,
    hasTransferFee: false,
    hasTransferHook: false,
    isNonTransferable: false,
    metadataMutable: false,
    balanceMutable: false,
    holderCount: 0,
    topHolderPct: 0,
    topHolderAddress: null,
    isDangerous: false,
    verified: false,
  };

  try {
    const mint = mintAddress.toBase58();
    // v11d: Fixed URL format — API uses query params, not path params.
    // Old path format (/token_security/MINT) returned 404 silently.
    const url = `${GOPLUS_SOLANA_API}?contract_addresses=${mint}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      defaultResult.error = `HTTP ${response.status}`;
      return defaultResult;
    }

    const data = (await response.json()) as {
      code: number;
      result: Record<string, SolanaTokenData>;
    };

    if (data.code !== 1 || !data.result) {
      defaultResult.error = 'Invalid response';
      return defaultResult;
    }

    // GoPlus returns data keyed by mint address
    const tokenData = data.result[mint] ?? data.result[mint.toLowerCase()];
    if (!tokenData) {
      defaultResult.error = 'Token not indexed yet';
      logger.debug(`[goplus] ${mint.slice(0, 8)}... not indexed yet`);
      return defaultResult;
    }

    // Parse Solana-specific fields
    const isMintable = getStatus(tokenData.mintable) === '1';
    const isFreezable = getStatus(tokenData.freezable) === '1';
    const hasTransferFee = tokenData.transfer_fee != null && Object.keys(tokenData.transfer_fee).length > 0;
    const hasTransferHook = Array.isArray(tokenData.transfer_hook) && tokenData.transfer_hook.length > 0;
    const isNonTransferable = tokenData.non_transferable === '1';
    const metadataMutable = getStatus(tokenData.metadata_mutable) === '1';
    const balanceMutable = getStatus(tokenData.balance_mutable_authority) === '1';

    // Holder analysis
    const holderCount = parseInt(tokenData.holder_count ?? '0') || 0;
    let topHolderPct = 0;
    let topHolderAddress: string | null = null;
    if (Array.isArray(tokenData.holders) && tokenData.holders.length > 0) {
      const top = tokenData.holders[0];
      topHolderPct = parseFloat(top.percent ?? '0');
      topHolderAddress = top.address ?? null;
    }

    // Determine danger: these flags indicate potential scam mechanisms
    const isDangerous = hasTransferHook || balanceMutable || isNonTransferable;

    const result: GoPlusResult = {
      isMintable,
      isFreezable,
      hasTransferFee,
      hasTransferHook,
      isNonTransferable,
      metadataMutable,
      balanceMutable,
      holderCount,
      topHolderPct,
      topHolderAddress,
      isDangerous,
      verified: true,
    };

    // Log findings
    const flags: string[] = [];
    if (hasTransferHook) flags.push('TRANSFER_HOOK');
    if (balanceMutable) flags.push('BALANCE_MUTABLE');
    if (isNonTransferable) flags.push('NON_TRANSFERABLE');
    if (isMintable) flags.push('MINTABLE');
    if (isFreezable) flags.push('FREEZABLE');
    if (hasTransferFee) flags.push('TRANSFER_FEE');

    if (flags.length > 0) {
      logger.warn(`[goplus] ${mint.slice(0, 8)}... FLAGS: ${flags.join(', ')}`);
    } else {
      logger.debug(`[goplus] ${mint.slice(0, 8)}... clean config (holders=${holderCount})`);
    }

    return result;
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes('TimeoutError') || errStr.includes('abort')) {
      defaultResult.error = 'Timeout (3s)';
    } else {
      defaultResult.error = errStr;
      logger.debug(`[goplus] Check failed: ${errStr}`);
    }
    return defaultResult;
  }
}

/** Determines if a token has dangerous on-chain flags */
export function isGoPlusSafe(result: GoPlusResult): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (result.hasTransferHook) reasons.push('Transfer hook can block sells');
  if (result.balanceMutable) reasons.push('Authority can modify balances');
  if (result.isNonTransferable) reasons.push('Token is non-transferable');
  // Note: mintable/freezable are already checked by security-checker.ts
  // GoPlus catches edge cases where on-chain authority was revoked but config persists

  return {
    safe: reasons.length === 0,
    reasons,
  };
}

// Solana-specific GoPlus response shape
interface SolanaTokenData {
  mintable?: { status: string };
  freezable?: { status: string };
  closable?: { status: string };
  non_transferable?: string;
  metadata_mutable?: { status: string };
  transfer_fee?: Record<string, unknown>;
  transfer_hook?: unknown[];
  balance_mutable_authority?: { status: string };
  default_account_state_upgradable?: { status: string };
  holder_count?: string;
  holders?: Array<{ address: string; percent: string; is_locked?: number }>;
  trusted_token?: string;
  creators?: Array<{ address: string; share: number }>;
}

/** Extract status from nested GoPlus field */
function getStatus(field: { status: string } | undefined): string {
  return field?.status ?? '0';
}
