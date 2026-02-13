import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { SOLSCAN_BASE } from '../constants.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function shortenAddress(address: string | PublicKey, chars = 4): string {
  const str = address.toString();
  return `${str.slice(0, chars)}...${str.slice(-chars)}`;
}

export function solscanTx(signature: string): string {
  return `${SOLSCAN_BASE}/tx/${signature}`;
}

export function solscanToken(mint: string | PublicKey): string {
  return `${SOLSCAN_BASE}/token/${mint.toString()}`;
}

export function solscanAccount(address: string | PublicKey): string {
  return `${SOLSCAN_BASE}/account/${address.toString()}`;
}

export function nowMs(): number {
  return Date.now();
}

export function formatSol(sol: number, decimals = 4): string {
  return sol.toFixed(decimals);
}

export function formatPct(pct: number, decimals = 1): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

export function formatUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(2)}`;
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isValidPublicKey(input: string): boolean {
  try {
    new PublicKey(input);
    return true;
  } catch {
    return false;
  }
}

// SOL/USD price cache
let _cachedSolPrice = 0;
let _lastSolPriceUpdate = 0;

export async function getSolPriceUsd(): Promise<number> {
  if (Date.now() - _lastSolPriceUpdate < 60_000 && _cachedSolPrice > 0) {
    return _cachedSolPrice;
  }
  try {
    const res = await fetch(
      'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await res.json() as { data?: Record<string, { price?: number }> };
    const price = data?.data?.['So11111111111111111111111111111111111111112']?.price;
    if (price && price > 0) {
      _cachedSolPrice = price;
      _lastSolPriceUpdate = Date.now();
    }
  } catch {
    // silently fail, use cached
  }
  return _cachedSolPrice;
}
