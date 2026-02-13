#!/usr/bin/env node
/**
 * Backfill missed gains for ALL historical positions.
 * Uses GeckoTerminal API (free, 30 calls/min) to check max price post-sell.
 *
 * Usage: node scripts/backfill-missed-gains.cjs [--limit N] [--days N]
 */
const Database = require('better-sqlite3');
const { resolve } = require('path');

const DB_PATH = resolve(__dirname, '..', 'data', 'bot.db');
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';

// Parse args
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const daysIdx = args.indexOf('--days');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 100;
const DAYS = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 7;

async function main() {
  const db = new Database(DB_PATH);

  // Add columns if they don't exist
  const migrations = [
    'ALTER TABLE positions ADD COLUMN post_sell_max_multiplier REAL',
    'ALTER TABLE positions ADD COLUMN post_sell_max_usd REAL',
    'ALTER TABLE positions ADD COLUMN post_sell_current_usd REAL',
    'ALTER TABLE positions ADD COLUMN post_sell_check_count INTEGER DEFAULT 0',
    'ALTER TABLE positions ADD COLUMN post_sell_last_check INTEGER',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* already exists */ }
  }

  const cutoff = Date.now() - DAYS * 24 * 3600000;

  const positions = db.prepare(`
    SELECT id, pool_address, token_mint, entry_price, closed_at, pnl_pct, exit_reason
    FROM positions
    WHERE status IN ('closed', 'stopped')
      AND closed_at IS NOT NULL
      AND closed_at > ?
      AND (post_sell_max_multiplier IS NULL OR post_sell_check_count < 2)
    ORDER BY closed_at DESC
    LIMIT ?
  `).all(cutoff, LIMIT);

  console.log(`Found ${positions.length} positions to backfill (last ${DAYS} days, limit ${LIMIT})`);

  let checked = 0;
  let found = 0;
  let bigMoves = 0;

  for (const pos of positions) {
    try {
      const result = await fetchPostSellData(pos.pool_address, pos.closed_at);

      if (result) {
        found++;
        const { maxHigh, lastClose, sellPrice, candles } = result;

        let postSellMult = null;
        if (sellPrice > 0) {
          postSellMult = maxHigh / sellPrice;
        }

        if (postSellMult && postSellMult >= 2.0) bigMoves++;

        // Save to DB
        const existing = db.prepare('SELECT post_sell_max_multiplier FROM positions WHERE id = ?').get(pos.id);
        const existingMult = existing?.post_sell_max_multiplier ?? 0;

        if ((postSellMult ?? 0) > existingMult) {
          db.prepare(`
            UPDATE positions SET
              post_sell_max_multiplier = ?,
              post_sell_max_usd = ?,
              post_sell_current_usd = ?,
              post_sell_check_count = COALESCE(post_sell_check_count, 0) + 1,
              post_sell_last_check = ?
            WHERE id = ?
          `).run(postSellMult, maxHigh, lastClose, Date.now(), pos.id);
        } else {
          db.prepare(`
            UPDATE positions SET
              post_sell_check_count = COALESCE(post_sell_check_count, 0) + 1,
              post_sell_last_check = ?
            WHERE id = ?
          `).run(Date.now(), pos.id);
        }

        const multStr = postSellMult ? postSellMult.toFixed(2) + 'x' : '?';
        const emoji = (postSellMult ?? 0) >= 3.0 ? '🚀🚀' : (postSellMult ?? 0) >= 2.0 ? '🚀' : (postSellMult ?? 0) >= 1.5 ? '📈' : '📊';
        console.log(
          `${emoji} ${pos.token_mint.slice(0, 8)}... | post-sell: ${multStr} | ` +
          `pnl: ${pos.pnl_pct?.toFixed(1)}% | ${pos.exit_reason || '?'} | ` +
          `candles: ${candles}`
        );
      } else {
        console.log(`   ${pos.token_mint.slice(0, 8)}... | No OHLCV data`);
      }
    } catch (err) {
      console.log(`   ${pos.token_mint.slice(0, 8)}... | Error: ${err.message?.slice(0, 60)}`);
    }

    checked++;

    // Rate limit: 2.5s between calls (24/min, under 30 limit)
    await new Promise(r => setTimeout(r, 2500));

    // Progress every 10
    if (checked % 10 === 0) {
      console.log(`--- Progress: ${checked}/${positions.length} checked, ${found} with data, ${bigMoves} big moves (2x+) ---`);
    }
  }

  console.log('');
  console.log('=== BACKFILL COMPLETE ===');
  console.log(`Checked: ${checked}`);
  console.log(`With data: ${found}`);
  console.log(`Big moves (2x+ post-sell): ${bigMoves}`);

  // Summary report
  const report = db.prepare(`
    SELECT
      CASE
        WHEN post_sell_max_multiplier >= 4.0 THEN '4x+'
        WHEN post_sell_max_multiplier >= 3.0 THEN '3-4x'
        WHEN post_sell_max_multiplier >= 2.0 THEN '2-3x'
        WHEN post_sell_max_multiplier >= 1.5 THEN '1.5-2x'
        WHEN post_sell_max_multiplier >= 1.0 THEN '1-1.5x'
        WHEN post_sell_max_multiplier IS NOT NULL THEN '<1x (dumped)'
        ELSE 'no data'
      END as tier,
      COUNT(*) as n,
      ROUND(AVG(pnl_pct), 1) as avg_pnl
    FROM positions
    WHERE status IN ('closed', 'stopped') AND closed_at > ?
    GROUP BY tier
    ORDER BY
      CASE tier
        WHEN '4x+' THEN 1
        WHEN '3-4x' THEN 2
        WHEN '2-3x' THEN 3
        WHEN '1.5-2x' THEN 4
        WHEN '1-1.5x' THEN 5
        WHEN '<1x (dumped)' THEN 6
        ELSE 7
      END
  `).all(cutoff);

  console.log('');
  console.log('=== POST-SELL PRICE DISTRIBUTION ===');
  for (const r of report) {
    console.log(`${r.tier.padEnd(15)} | N=${String(r.n).padEnd(4)} | avg PnL: ${r.avg_pnl}%`);
  }

  db.close();
}

async function fetchPostSellData(poolAddress, closedAt) {
  const hoursElapsed = Math.ceil((Date.now() - closedAt) / 3600000);
  const limit = Math.min(hoursElapsed + 1, 100);

  const url = `${GECKO_BASE}/${poolAddress}/ohlcv/hour?aggregate=1&limit=${limit}&currency=usd`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) return null;

  const json = await response.json();
  const ohlcvList = json?.data?.attributes?.ohlcv_list;

  if (!ohlcvList || ohlcvList.length === 0) return null;

  // Candles: [timestamp, open, high, low, close, volume]
  const candles = ohlcvList.map(c => ({
    timestamp: c[0] * 1000,
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));

  // Post-close candles
  const postClose = candles.filter(c => c.timestamp >= closedAt - 3600000);
  if (postClose.length === 0) return null;

  const maxHigh = Math.max(...postClose.map(c => c.high));
  const lastClose = postClose[postClose.length - 1]?.close ?? 0;

  // Sell price: candle closest to close time
  const sellCandle = candles
    .filter(c => c.timestamp <= closedAt + 3600000)
    .sort((a, b) => Math.abs(a.timestamp - closedAt) - Math.abs(b.timestamp - closedAt))[0];

  return {
    maxHigh,
    lastClose,
    sellPrice: sellCandle?.close ?? 0,
    candles: postClose.length,
  };
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
