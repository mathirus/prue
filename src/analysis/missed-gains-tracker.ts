/**
 * Missed Gains Tracker (v8j)
 *
 * After a position closes, checks GeckoTerminal API at intervals to see
 * how high the token went AFTER we sold. This data is critical for
 * optimizing exit strategy (are we leaving 4x gains on the table?).
 *
 * GeckoTerminal API: free, no key, 30 calls/min, works with PumpSwap pools.
 */

import { getDb } from '../data/database.js';
import { logger } from '../utils/logger.js';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/pairs/solana';

// Check at 1h, 4h, 24h after close (GeckoTerminal OHLCV)
const CHECK_DELAYS_MS = [
  1 * 60 * 60 * 1000,   // 1 hour
  4 * 60 * 60 * 1000,   // 4 hours
];

// v8q: Short-interval checks via DexScreener (2min, 5min, 10min, 15min, 30min, 1h)
const SHORT_CHECK_DELAYS_MS = [
  2 * 60 * 1000,    // 2 min
  5 * 60 * 1000,    // 5 min
  10 * 60 * 1000,   // 10 min
  15 * 60 * 1000,   // 15 min
  30 * 60 * 1000,   // 30 min
  60 * 60 * 1000,   // 1 hour
];

// Rate limiter: max 25 calls/min (buffer under 30 limit)
let lastCallTimestamp = 0;
const MIN_CALL_INTERVAL_MS = 2500; // ~24 calls/min

interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Schedule missed gains checks for a closed position.
 * Called from index.ts on positionClosed event.
 */
export function scheduleMissedGainsCheck(
  poolAddress: string,
  tokenMint: string,
  positionId: string,
  entryPrice: number,
  closedAt: number,
): void {
  // GeckoTerminal OHLCV checks at 1h/4h
  for (const delay of CHECK_DELAYS_MS) {
    const checkLabel = delay < 3600000 ? `${delay / 60000}min` : `${delay / 3600000}h`;
    setTimeout(async () => {
      try {
        await checkMissedGains(poolAddress, tokenMint, positionId, entryPrice, closedAt, checkLabel);
      } catch (err) {
        logger.debug(`[missed-gains] Error checking ${positionId.slice(0, 8)} @${checkLabel}: ${err}`);
      }
    }, delay);
  }

  // v8q: Short-interval DexScreener checks at 2/5/10/15/30/60 min
  for (const delay of SHORT_CHECK_DELAYS_MS) {
    const minutes = delay / 60000;
    const label = minutes >= 60 ? `${minutes / 60}h` : `${minutes}min`;
    setTimeout(async () => {
      try {
        await shortIntervalCheck(tokenMint, positionId, label, minutes);
      } catch (err) {
        logger.debug(`[post-trade] Error @${label} for ${positionId.slice(0, 8)}: ${err}`);
      }
    }, delay);
  }

  logger.info(`[post-trade] Scheduled 6 checks for ${tokenMint.slice(0, 8)}... (2m/5m/10m/15m/30m/1h)`);
}

/**
 * v8q: Quick DexScreener check at short intervals post-close.
 * Saves to post_trade_checks table for granular analysis.
 */
async function shortIntervalCheck(
  tokenMint: string,
  positionId: string,
  label: string,
  delayMinutes: number,
): Promise<void> {
  const DEXSCREENER_TOKEN = 'https://api.dexscreener.com/latest/dex/tokens';

  try {
    const res = await fetch(`${DEXSCREENER_TOKEN}/${tokenMint}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.debug(`[post-trade] DexScreener ${res.status} for ${tokenMint.slice(0, 8)} @${label}`);
      return;
    }

    const json = await res.json() as any;
    const pairs = json?.pairs;
    if (!pairs || pairs.length === 0) {
      // Token dead — save that fact
      savePostTradeCheck(positionId, tokenMint, label, delayMinutes, {
        priceNative: 0, marketCap: 0, liq: 0, vol: 0, txns: 0, alive: false,
      });
      return;
    }

    const p = pairs[0];
    const priceNative = parseFloat(p.priceNative) || 0;
    const marketCap = p.marketCap || 0;
    const liq = p.liquidity?.usd || 0;
    const vol = p.volume?.h24 || 0;
    const txns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);

    savePostTradeCheck(positionId, tokenMint, label, delayMinutes, {
      priceNative, marketCap, liq, vol, txns, alive: true,
    });

    const mcapStr = marketCap > 1000000 ? `$${(marketCap / 1e6).toFixed(1)}M` : `$${Math.round(marketCap / 1000)}K`;
    logger.info(
      `[post-trade] ${tokenMint.slice(0, 8)}.. @${label}: ${mcapStr} liq=$${Math.round(liq / 1000)}K vol=$${Math.round(vol / 1000)}K txns=${txns}`,
    );
  } catch (err) {
    logger.debug(`[post-trade] Fetch failed for ${tokenMint.slice(0, 8)} @${label}: ${err}`);
  }
}

function savePostTradeCheck(
  positionId: string,
  tokenMint: string,
  label: string,
  delayMinutes: number,
  data: { priceNative: number; marketCap: number; liq: number; vol: number; txns: number; alive: boolean },
): void {
  try {
    const db = getDb();

    // Compute multiplier vs first check (2min baseline) — same DexScreener units, no mismatch
    let multVsSell: number | null = null;
    if (data.priceNative > 0) {
      const first = db.prepare(
        `SELECT price_native FROM post_trade_checks
         WHERE position_id = ? AND price_native > 0
         ORDER BY delay_minutes ASC LIMIT 1`
      ).get(positionId) as { price_native: number } | undefined;

      if (first && first.price_native > 0) {
        multVsSell = data.priceNative / first.price_native;
      }
    }

    db.prepare(`
      INSERT INTO post_trade_checks
        (position_id, token_mint, check_label, delay_minutes,
         price_native, market_cap, liquidity_usd, volume_24h, txns_24h,
         is_alive, multiplier_vs_sell)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      positionId, tokenMint, label, delayMinutes,
      data.priceNative, data.marketCap, data.liq, data.vol, data.txns,
      data.alive ? 1 : 0, multVsSell,
    );
  } catch (err) {
    logger.debug(`[post-trade] DB save failed: ${err}`);
  }
}

/**
 * Fetch OHLCV data from GeckoTerminal and compute max price post-sell.
 */
async function checkMissedGains(
  poolAddress: string,
  tokenMint: string,
  positionId: string,
  entryPrice: number,
  closedAt: number,
  label: string,
): Promise<void> {
  // Rate limiting
  const now = Date.now();
  const waitMs = MIN_CALL_INTERVAL_MS - (now - lastCallTimestamp);
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastCallTimestamp = Date.now();

  // Fetch hourly OHLCV from close time to now
  const hoursElapsed = Math.ceil((Date.now() - closedAt) / 3600000);
  const limit = Math.min(hoursElapsed + 1, 100);

  const url = `${GECKO_BASE}/${poolAddress}/ohlcv/hour?aggregate=1&limit=${limit}&currency=usd`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    logger.debug(`[missed-gains] GeckoTerminal returned ${response.status} for ${poolAddress.slice(0, 8)}`);
    return;
  }

  const json = await response.json() as any;
  const ohlcvList = json?.data?.attributes?.ohlcv_list;

  if (!ohlcvList || ohlcvList.length === 0) {
    logger.debug(`[missed-gains] No OHLCV data for ${poolAddress.slice(0, 8)}`);
    return;
  }

  // Parse candles: [timestamp, open, high, low, close, volume]
  const candles: OhlcvCandle[] = ohlcvList.map((c: number[]) => ({
    timestamp: c[0] * 1000, // to ms
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));

  // Filter candles AFTER close time only
  const postCloseCandles = candles.filter(c => c.timestamp >= closedAt - 3600000); // 1h buffer
  if (postCloseCandles.length === 0) {
    logger.debug(`[missed-gains] No post-close candles for ${poolAddress.slice(0, 8)}`);
    return;
  }

  // Get max high price (in USD)
  const maxHighUsd = Math.max(...postCloseCandles.map(c => c.high));
  const lastCloseUsd = postCloseCandles[postCloseCandles.length - 1]?.close ?? 0;

  // Also get the price around close time as reference
  // Find the candle closest to close time
  const closeTimeCandle = candles
    .filter(c => c.timestamp <= closedAt + 3600000)
    .sort((a, b) => Math.abs(a.timestamp - closedAt) - Math.abs(b.timestamp - closedAt))[0];

  const sellPriceUsd = closeTimeCandle?.close ?? 0;

  // Compute multiplier: how much higher did it go vs our sell price
  // v8n: Guard against near-zero sell prices (dead tokens) producing absurd multipliers
  let postSellMaxMultiplier: number | null = null;
  if (sellPriceUsd > 1e-12) {
    const rawMultiplier = maxHighUsd / sellPriceUsd;
    postSellMaxMultiplier = Math.min(rawMultiplier, 1000); // Cap at 1000x
  }

  // Also compute vs entry for absolute reference
  // entryPrice is in SOL/token_base_unit, we need USD but we can use the ratio
  // The key insight: entry_price_usd ≈ candle price at open time
  // So entry multiplier = maxHigh / earliest_candle_close
  const entryCandle = candles
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  let entryToMaxMultiplier: number | null = null;
  if (entryCandle && entryCandle.close > 0) {
    entryToMaxMultiplier = maxHighUsd / entryCandle.close;
  }

  // Save to DB
  try {
    const db = getDb();

    // Update position with missed gains data (keep max across checks)
    const existing = db.prepare(
      'SELECT post_sell_max_multiplier FROM positions WHERE id = ?'
    ).get(positionId) as { post_sell_max_multiplier: number | null } | undefined;

    const existingMult = existing?.post_sell_max_multiplier ?? 0;
    const newMult = postSellMaxMultiplier ?? 0;

    if (newMult > existingMult) {
      db.prepare(`
        UPDATE positions SET
          post_sell_max_multiplier = ?,
          post_sell_max_usd = ?,
          post_sell_current_usd = ?,
          post_sell_check_count = COALESCE(post_sell_check_count, 0) + 1,
          post_sell_last_check = ?
        WHERE id = ?
      `).run(
        postSellMaxMultiplier,
        maxHighUsd,
        lastCloseUsd,
        Date.now(),
        positionId,
      );
    } else {
      // Just update check count and current price
      db.prepare(`
        UPDATE positions SET
          post_sell_current_usd = ?,
          post_sell_check_count = COALESCE(post_sell_check_count, 0) + 1,
          post_sell_last_check = ?
        WHERE id = ?
      `).run(lastCloseUsd, Date.now(), positionId);
    }
  } catch (err) {
    logger.debug(`[missed-gains] DB update failed: ${err}`);
  }

  // Also fetch DexScreener for current price + 24h change (more reliable for recent tokens)
  let dexPriceUsd: number | null = null;
  let dexChange24h: number | null = null;
  let dexVolume24h: number | null = null;
  let dexFdv: number | null = null;
  try {
    await new Promise(r => setTimeout(r, 300)); // Rate limit
    const dexRes = await fetch(`${DEXSCREENER_BASE}/${poolAddress}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (dexRes.ok) {
      const dexJson = await dexRes.json() as any;
      const pair = dexJson?.pair;
      if (pair) {
        dexPriceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : null;
        dexChange24h = pair.priceChange?.h24 ?? null;
        dexVolume24h = pair.volume?.h24 ?? null;
        dexFdv = pair.fdv ?? null;
      }
    }
  } catch { /* non-critical */ }

  // Save DexScreener data to DB
  try {
    const db = getDb();
    db.prepare(`
      UPDATE positions SET
        post_sell_dex_price_usd = ?,
        post_sell_dex_change_24h = ?,
        post_sell_dex_volume_24h = ?,
        post_sell_dex_fdv = ?
      WHERE id = ?
    `).run(dexPriceUsd, dexChange24h, dexVolume24h, dexFdv, positionId);
  } catch { /* columns may not exist yet */ }

  const multStr = postSellMaxMultiplier ? postSellMaxMultiplier.toFixed(2) + 'x' : '?';
  const dexStr = dexChange24h !== null ? `dex24h=${dexChange24h > 0 ? '+' : ''}${dexChange24h.toFixed(0)}%` : '';
  const emoji = (dexChange24h ?? 0) >= 200 ? '🚀' : (dexChange24h ?? 0) >= 100 ? '📈' : '📊';

  logger.info(
    `[missed-gains] ${emoji} ${tokenMint.slice(0, 8)}... @${label}: ` +
    `gecko=${multStr}, ${dexStr}, ` +
    `vol=$${dexVolume24h ? Math.round(dexVolume24h) : '?'}, ` +
    `fdv=$${dexFdv ? Math.round(dexFdv) : '?'}`
  );
}

/**
 * Backfill missed gains for recently closed positions that don't have data yet.
 * Called once at startup. Only processes positions closed in the last 24h.
 */
export async function backfillMissedGains(): Promise<void> {
  try {
    const db = getDb();
    const cutoff = Date.now() - 24 * 3600000; // last 24h

    const positions = db.prepare(`
      SELECT id, pool_address, token_mint, entry_price, closed_at
      FROM positions
      WHERE status IN ('closed', 'stopped')
        AND closed_at IS NOT NULL
        AND closed_at > ?
        AND post_sell_max_multiplier IS NULL
      ORDER BY closed_at DESC
      LIMIT 20
    `).all(cutoff) as Array<{
      id: string;
      pool_address: string;
      token_mint: string;
      entry_price: number;
      closed_at: number;
    }>;

    if (positions.length === 0) {
      logger.debug('[missed-gains] No recent positions to backfill');
      return;
    }

    logger.info(`[missed-gains] Backfilling ${positions.length} recent positions...`);

    for (const pos of positions) {
      const elapsed = Date.now() - pos.closed_at;
      const label = elapsed > 12 * 3600000 ? '24h-backfill' :
                    elapsed > 2 * 3600000 ? '4h-backfill' : '1h-backfill';

      try {
        await checkMissedGains(
          pos.pool_address, pos.token_mint, pos.id,
          pos.entry_price, pos.closed_at, label,
        );
        // Rate limit: wait between requests
        await new Promise(r => setTimeout(r, 3000));
      } catch (err) {
        logger.debug(`[missed-gains] Backfill error for ${pos.id.slice(0, 8)}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`[missed-gains] Backfill failed: ${err}`);
  }
}
