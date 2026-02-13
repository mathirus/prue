import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { RUGCHECK_API_BASE } from '../constants.js';

export interface RugCheckResult {
  score: number;
  risks: string[];
  topHolders: Array<{ address: string; pct: number }>;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpLocked: boolean;
  isVerified: boolean;
  rugged: boolean;
  insidersDetected: number;
}

/**
 * Fetches token security report from RugCheck.xyz API.
 * Strategy: Try full /report (3.5s) for insider data → fallback to /report/summary (2.5s) for basic risks.
 * This improves success rate from ~30% to ~70%+ since /report/summary is much lighter.
 */
export async function fetchRugCheck(mintAddress: PublicKey): Promise<RugCheckResult | null> {
  const mint = mintAddress.toBase58();

  // Try full /report first (has rugged + graphInsidersDetected)
  try {
    const result = await fetchWithRetry(`${RUGCHECK_API_BASE}/tokens/${mint}/report`, 3_500);
    if (result) {
      const parsed = parseReport(result, true);
      if (parsed) {
        if (parsed.rugged) {
          logger.warn(`[rugcheck] 🚨 Token ${mint.slice(0, 8)}... confirmed RUGGED`);
        }
        if (parsed.insidersDetected > 0) {
          logger.warn(`[rugcheck] ⚠️ Token ${mint.slice(0, 8)}...: ${parsed.insidersDetected} insiders detected`);
        }
        return parsed;
      }
    }
  } catch {
    // Full report failed (timeout/error) - try summary fallback
    logger.debug(`[rugcheck] Full report failed for ${mint.slice(0, 8)}..., trying summary...`);
  }

  // Fallback: /report/summary (lighter, faster, no insider data)
  try {
    const result = await fetchWithRetry(`${RUGCHECK_API_BASE}/tokens/${mint}/report/summary`, 2_500);
    if (result) {
      const parsed = parseReport(result, false);
      if (parsed) {
        logger.debug(`[rugcheck] Got summary for ${mint.slice(0, 8)}... (no insider data)`);
        return parsed;
      }
    }
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes('timeout') || errMsg.includes('Timeout') || errMsg.includes('aborted')) {
      logger.warn(`[rugcheck] Timeout for ${mint.slice(0, 8)}... (RugCheck API slow, non-fatal)`);
    } else {
      logger.warn(`[rugcheck] Failed for ${mint.slice(0, 8)}...: ${errMsg.slice(0, 100)}`);
    }
  }

  return null;
}

/**
 * Fetch URL with timeout and single 429 retry.
 * Returns parsed JSON or null (404). Throws on timeout/error.
 */
async function fetchWithRetry(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Retry once on 429 rate limit
  if (response.status === 429) {
    logger.debug(`[rugcheck] Rate limited, retrying in 1s...`);
    await new Promise(r => setTimeout(r, 1000));
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 2_500)),
    });
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    logger.warn(`[rugcheck] API error: ${response.status}`);
    return null;
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Parse RugCheck response (works for both /report and /report/summary).
 * @param isFullReport - true if from /report (has rugged/insiders fields)
 */
function parseReport(data: Record<string, unknown>, isFullReport: boolean): RugCheckResult | null {
  const risks: string[] = [];
  const riskEntries = (data.risks ?? []) as Array<{ name: string; level: string }>;
  for (const risk of riskEntries) {
    if (risk.level === 'danger' || risk.level === 'warn') {
      risks.push(`${risk.level}: ${risk.name}`);
    }
  }

  const topHolders = ((data.topHolders ?? []) as Array<{ address: string; pct: number }>)
    .slice(0, 10)
    .map((h) => ({
      address: h.address,
      pct: h.pct ?? 0,
    }));

  const overallScore = mapRugCheckScore(data.score as string | number | undefined);

  // Insider detection only available in full /report
  let rugged = false;
  let insidersDetected = 0;
  if (isFullReport) {
    rugged = (data.rugged as boolean) ?? false;
    const rawInsiders = data.graphInsidersDetected;
    insidersDetected = typeof rawInsiders === 'number'
      ? rawInsiders
      : (rawInsiders ? 1 : 0);
  }

  return {
    score: overallScore,
    risks,
    topHolders,
    mintAuthority: (data.mintAuthority as string) ?? null,
    freezeAuthority: (data.freezeAuthority as string) ?? null,
    lpLocked: (data.lpLocked as boolean) ?? false,
    isVerified: (data.verified as boolean) ?? false,
    rugged,
    insidersDetected,
  };
}

export interface InsiderGraphResult {
  insiderWallets: string[];
  totalConnections: number;
}

/**
 * v8r: Fetch insider network graph from RugCheck API.
 * Returns the list of insider wallets connected to a token.
 * This data is separate from the /report endpoint's insidersDetected count.
 * Cost: 1 HTTP call (free API), 3s timeout.
 */
export async function fetchInsiderGraph(mintAddress: PublicKey): Promise<InsiderGraphResult | null> {
  const mint = mintAddress.toBase58();
  try {
    const response = await fetch(`${RUGCHECK_API_BASE}/tokens/${mint}/insiders/graph`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as Record<string, unknown>;

    // Parse insider wallets from the graph response
    // The API returns nodes/edges structure; extract wallet addresses
    const nodes = (data.nodes ?? data.wallets ?? []) as Array<{ address?: string; id?: string; wallet?: string }>;
    const insiderWallets = nodes
      .map(n => n.address ?? n.id ?? n.wallet ?? '')
      .filter(addr => addr.length > 10 && addr !== '11111111111111111111111111111111');

    const edges = (data.edges ?? data.connections ?? []) as Array<unknown>;

    logger.debug(`[rugcheck] Insider graph for ${mint.slice(0, 8)}...: ${insiderWallets.length} wallets, ${edges.length} connections`);

    return {
      insiderWallets,
      totalConnections: edges.length,
    };
  } catch {
    // Non-fatal — endpoint may not exist or be unavailable
    return null;
  }
}

function mapRugCheckScore(score: string | number | undefined): number {
  if (typeof score === 'number') return Math.min(100, Math.max(0, score));

  switch (score) {
    case 'Good':
      return 85;
    case 'Warning':
      return 50;
    case 'Danger':
      return 15;
    default:
      return 0;
  }
}
