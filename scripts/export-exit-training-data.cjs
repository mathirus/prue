/**
 * v9f v2: Export exit ML training data from shadow_price_log time series.
 *
 * For each shadow position, computes 20 features at each time step (after 40s warmup)
 * and applies Triple Barrier labeling looking 120s into the future.
 *
 * Features (20):
 *   momentum (5): price_velocity_10s/30s/60s, multiplier, drop_from_peak
 *   reserve (4): reserve_velocity_30s, reserve_vs_entry, reserve_acceleration, reserve_momentum_60s
 *   sell pressure (2): sell_burst_30s, sell_acceleration
 *   time (2): elapsed_minutes, time_above_entry_pct
 *   volatility (2): volatility_30s, price_range_30s
 *   dynamics (1): consecutive_down_polls
 *   context (4): security_score, dp_liquidity_usd, creator_reputation, wallet_age_log
 *
 * Label: SELL (price drops 10%+ or reserve drops 30%+ in next 120s) or HOLD
 *
 * Usage: node scripts/export-exit-training-data.cjs
 * Output: data/exit-training-data.csv
 */

const Database = require('better-sqlite3');
const { writeFileSync } = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');
const OUTPUT_CSV = path.resolve(process.cwd(), 'data', 'exit-training-data.csv');

// ── Config ──────────────────────────────────────────────────────────
const MIN_POLLS_FOR_LOOKBACK = 8;      // Need 8 polls (~40s) for 30s lookback features
const LABEL_HORIZON_S = 120;           // v2: Look 120s into future (was 60s) — more SELL labels
const LABEL_PRICE_DROP_PCT = 10;       // v2: SELL if price drops 10%+ (was 15%) — catches gradual declines
const LABEL_RESERVE_DROP_PCT = 30;     // SELL if reserve drops 30%+ in horizon
const LABEL_PRICE_RISE_PCT = 10;       // HOLD if price rises 10%+ in horizon
const POLL_INTERVAL_S = 5;             // Shadow polls every 5s
const HORIZON_POLLS = Math.ceil(LABEL_HORIZON_S / POLL_INTERVAL_S);

// ── Feature computation ─────────────────────────────────────────────

/**
 * Compute velocity: (current - past) / past
 * Returns 0 if past is 0 or undefined.
 */
function velocity(current, past) {
  if (!past || past === 0) return 0;
  return (current - past) / past;
}

/**
 * Compute standard deviation of an array.
 */
function std(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute all 15 features for a single data point.
 *
 * @param {Array} logs - All price logs for this position (sorted by elapsed_ms ASC)
 * @param {number} idx - Current index in the logs array
 * @param {number} entryPrice - Entry price of the position
 * @param {number} securityScore - Security score at open time
 * @param {number} liquidityUsd - Liquidity USD from detected_pools
 * @param {number} creatorReputation - Creator reputation score
 * @param {number} walletAgeLog - log10(wallet_age_seconds + 1)
 * @returns {Object|null} Feature object or null if not enough data
 */
function computeFeatures(logs, idx, entryPrice, securityScore, liquidityUsd, creatorReputation, walletAgeLog) {
  if (idx < MIN_POLLS_FOR_LOOKBACK) return null;

  const current = logs[idx];
  const price = current.price;
  const reserve = current.sol_reserve;
  const elapsed = current.elapsed_ms;

  // Guard: skip if price or entry is 0
  if (!price || price === 0 || !entryPrice || entryPrice === 0) return null;

  // ── Momentum (5 features) ──

  // price_velocity_10s: (price[t] - price[t-2]) / price[t-2]
  const p_2 = idx >= 2 ? logs[idx - 2].price : null;
  const price_velocity_10s = p_2 ? velocity(price, p_2) : 0;

  // price_velocity_30s: (price[t] - price[t-6]) / price[t-6]
  const p_6 = idx >= 6 ? logs[idx - 6].price : null;
  const price_velocity_30s = p_6 ? velocity(price, p_6) : 0;

  // price_velocity_60s: (price[t] - price[t-12]) / price[t-12]
  const p_12 = idx >= 12 ? logs[idx - 12].price : null;
  const price_velocity_60s = p_12 ? velocity(price, p_12) : 0;

  // multiplier: current price / entry price
  const multiplier = price / entryPrice;

  // drop_from_peak: (peak - current) / peak
  let peakPrice = entryPrice;
  for (let i = 0; i <= idx; i++) {
    if (logs[i].price > peakPrice) peakPrice = logs[i].price;
  }
  const drop_from_peak = peakPrice > 0 ? (peakPrice - price) / peakPrice : 0;

  // ── Reserve (3 features) ──

  // reserve_velocity_30s: (reserve[t] - reserve[t-6]) / reserve[t-6]
  const r_6 = idx >= 6 ? logs[idx - 6].sol_reserve : null;
  const reserve_velocity_30s = (reserve && r_6) ? velocity(reserve, r_6) : 0;

  // reserve_vs_entry: current reserve / entry reserve
  const entryReserve = logs[0].sol_reserve;
  const reserve_vs_entry = (reserve && entryReserve && entryReserve > 0) ? reserve / entryReserve : 1;

  // reserve_acceleration: velocity_15s[t] - velocity_15s[t-1]
  let reserve_acceleration = 0;
  if (reserve && idx >= 4) {
    const r_3_now = idx >= 3 ? logs[idx - 3].sol_reserve : null;
    const r_3_prev = idx >= 4 ? logs[idx - 4].sol_reserve : null;
    const r_prev = logs[idx - 1].sol_reserve;
    const vel_now = r_3_now ? velocity(reserve, r_3_now) : 0;
    const vel_prev = (r_prev && r_3_prev) ? velocity(r_prev, r_3_prev) : 0;
    reserve_acceleration = vel_now - vel_prev;
  }

  // ── Sell Pressure (2 features) ──

  // sell_burst_30s: sum(sell_count últimos 6 polls)
  let sell_burst_30s = 0;
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    sell_burst_30s += logs[i].sell_count || 0;
  }

  // sell_acceleration: sells últimos 3 polls - sells 3 polls anteriores
  let sell_acceleration = 0;
  if (idx >= 6) {
    let recent = 0, older = 0;
    for (let i = idx - 2; i <= idx; i++) recent += logs[i].sell_count || 0;
    for (let i = idx - 5; i <= idx - 3; i++) older += logs[i].sell_count || 0;
    sell_acceleration = recent - older;
  }

  // ── Time (2 features) ──

  const elapsed_minutes = elapsed / 60000;

  // time_above_entry_pct: % of polls where multiplier > 1.0
  let pollsAbove = 0;
  for (let i = 0; i <= idx; i++) {
    if (logs[i].price > entryPrice) pollsAbove++;
  }
  const time_above_entry_pct = (idx + 1) > 0 ? pollsAbove / (idx + 1) : 0;

  // ── Volatility (1 feature) ──

  // volatility_30s: std(price últimos 6 polls) / mean(price últimos 6 polls)
  const recentPrices = [];
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    if (logs[i].price > 0) recentPrices.push(logs[i].price);
  }
  const meanPrice = recentPrices.length > 0 ? recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length : 1;
  const volatility_30s = meanPrice > 0 ? std(recentPrices) / meanPrice : 0;

  // ── Reserve Momentum 60s (1 feature) ──
  const r_12 = idx >= 12 ? logs[idx - 12].sol_reserve : null;
  const reserve_momentum_60s = (reserve && r_12) ? velocity(reserve, r_12) : 0;

  // ── Price Range 30s (1 feature) — captures ranging vs trending ──
  let price_range_30s = 0;
  if (recentPrices.length >= 2) {
    const maxP = Math.max(...recentPrices);
    const minP = Math.min(...recentPrices);
    price_range_30s = meanPrice > 0 ? (maxP - minP) / meanPrice : 0;
  }

  // ── Consecutive Down Polls (1 feature) ──
  let consecutive_down_polls = 0;
  for (let i = idx; i >= 1; i--) {
    if (logs[i].price < logs[i - 1].price) consecutive_down_polls++;
    else break;
  }

  // ── Context (4 features — static per trade) ──

  return {
    price_velocity_10s,
    price_velocity_30s,
    price_velocity_60s,
    multiplier,
    drop_from_peak,
    reserve_velocity_30s,
    reserve_vs_entry,
    reserve_acceleration,
    reserve_momentum_60s,
    sell_burst_30s,
    sell_acceleration,
    elapsed_minutes,
    time_above_entry_pct,
    volatility_30s,
    price_range_30s,
    consecutive_down_polls,
    security_score: securityScore ?? 0,
    dp_liquidity_usd: liquidityUsd ?? 0,
    creator_reputation: creatorReputation ?? 0,
    wallet_age_log: walletAgeLog ?? 0,
  };
}

/**
 * Apply Triple Barrier labeling: look at next HORIZON_POLLS data points.
 * First barrier hit determines label:
 *   - Price drops LABEL_PRICE_DROP_PCT% → SELL
 *   - Reserve drops LABEL_RESERVE_DROP_PCT% → SELL
 *   - Price rises LABEL_PRICE_RISE_PCT% → HOLD
 *   - None hit in horizon → HOLD
 *
 * @returns {'SELL'|'HOLD'|null} null if not enough future data
 */
function computeLabel(logs, idx) {
  const current = logs[idx];
  const currentPrice = current.price;
  const currentReserve = current.sol_reserve;

  // Need at least some future data
  if (idx + 3 > logs.length - 1) return null;

  const futureEnd = Math.min(idx + HORIZON_POLLS, logs.length - 1);

  for (let j = idx + 1; j <= futureEnd; j++) {
    const futurePrice = logs[j].price;
    const futureReserve = logs[j].sol_reserve;

    // Check price drop barrier
    if (futurePrice && currentPrice && currentPrice > 0) {
      const priceDrop = (currentPrice - futurePrice) / currentPrice * 100;
      if (priceDrop >= LABEL_PRICE_DROP_PCT) return 'SELL';
    }

    // Check reserve drop barrier
    if (futureReserve && currentReserve && currentReserve > 0) {
      const reserveDrop = (currentReserve - futureReserve) / currentReserve * 100;
      if (reserveDrop >= LABEL_RESERVE_DROP_PCT) return 'SELL';
    }

    // Check price rise barrier
    if (futurePrice && currentPrice && currentPrice > 0) {
      const priceRise = (futurePrice - currentPrice) / currentPrice * 100;
      if (priceRise >= LABEL_PRICE_RISE_PCT) return 'HOLD';
    }
  }

  // No barrier hit → HOLD
  return 'HOLD';
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  console.log('=== Exit ML Training Data Export (v9f) ===\n');

  // Get all closed shadow positions with their metadata + creator features
  const positions = db.prepare(`
    SELECT
      sp.id, sp.token_mint, sp.pool_address, sp.security_score,
      sp.entry_price, sp.entry_sol_reserve, sp.peak_multiplier,
      sp.final_multiplier, sp.exit_reason, sp.rug_detected,
      sp.opened_at, sp.closed_at, sp.total_polls,
      dp.dp_liquidity_usd, dp.security_score as dp_security_score,
      dp.dp_creator_reputation,
      tc.wallet_age_seconds, tc.tx_count, tc.reputation_score as tc_reputation
    FROM shadow_positions sp
    LEFT JOIN detected_pools dp ON sp.pool_id = dp.id
    LEFT JOIN token_creators tc ON sp.token_mint = tc.token_mint
    WHERE sp.status = 'closed'
      AND sp.entry_price > 0
      AND sp.total_polls >= ${MIN_POLLS_FOR_LOOKBACK}
    ORDER BY sp.opened_at ASC
  `).all();

  console.log(`Shadow positions (closed, >=8 polls): ${positions.length}`);

  // Check if sell_count columns exist (added in v9f, may not exist yet)
  const splCols = db.prepare("PRAGMA table_info(shadow_price_log)").all().map(c => c.name);
  const hasSellCols = splCols.includes('sell_count');
  if (!hasSellCols) {
    console.log('Note: sell_count columns not yet in shadow_price_log (pre-v9f data). Sell features will be 0.');
  }

  // Prepare the price log query (reused per position)
  const sellSelect = hasSellCols
    ? 'sell_count, cumulative_sell_count'
    : '0 as sell_count, 0 as cumulative_sell_count';
  const priceLogStmt = db.prepare(`
    SELECT price, multiplier, sol_reserve, elapsed_ms,
           ${sellSelect}
    FROM shadow_price_log
    WHERE shadow_id = ?
    ORDER BY elapsed_ms ASC
  `);

  const FEATURE_NAMES = [
    'price_velocity_10s', 'price_velocity_30s', 'price_velocity_60s',
    'multiplier', 'drop_from_peak',
    'reserve_velocity_30s', 'reserve_vs_entry', 'reserve_acceleration', 'reserve_momentum_60s',
    'sell_burst_30s', 'sell_acceleration',
    'elapsed_minutes', 'time_above_entry_pct',
    'volatility_30s', 'price_range_30s',
    'consecutive_down_polls',
    'security_score', 'dp_liquidity_usd', 'creator_reputation', 'wallet_age_log',
  ];

  const csvHeader = [
    'shadow_id', 'token_mint', ...FEATURE_NAMES, 'label', 'label_numeric',
  ].join(',');
  const csvRows = [csvHeader];

  let totalRows = 0;
  let sellLabels = 0;
  let holdLabels = 0;
  let skippedPositions = 0;
  let positionsUsed = 0;

  for (const pos of positions) {
    const logs = priceLogStmt.all(pos.id);

    if (logs.length < MIN_POLLS_FOR_LOOKBACK + 3) {
      skippedPositions++;
      continue;
    }

    positionsUsed++;
    let posRows = 0;

    // Creator context features (static per position)
    const creatorRep = pos.dp_creator_reputation ?? pos.tc_reputation ?? 0;
    const walletAge = pos.wallet_age_seconds ?? 0;
    const walletAgeLog = walletAge > 0 ? Math.log10(walletAge + 1) : 0;

    for (let i = MIN_POLLS_FOR_LOOKBACK; i < logs.length; i++) {
      const features = computeFeatures(
        logs, i, pos.entry_price, pos.security_score, pos.dp_liquidity_usd,
        creatorRep, walletAgeLog,
      );
      if (!features) continue;

      const label = computeLabel(logs, i);
      if (!label) continue; // Not enough future data

      const labelNumeric = label === 'SELL' ? 1 : 0;
      if (label === 'SELL') sellLabels++;
      else holdLabels++;

      const row = [
        pos.id.slice(0, 12),
        pos.token_mint.slice(0, 8),
        ...FEATURE_NAMES.map(f => {
          const val = features[f];
          // Round floats to 6 decimal places for CSV readability
          return typeof val === 'number' ? Number(val.toFixed(6)) : (val ?? '');
        }),
        label,
        labelNumeric,
      ];
      csvRows.push(row.join(','));
      posRows++;
      totalRows++;
    }

    if (posRows > 0 && positionsUsed % 50 === 0) {
      process.stdout.write(`  Processed ${positionsUsed}/${positions.length} positions (${totalRows} rows)...\r`);
    }
  }

  // Write CSV
  writeFileSync(OUTPUT_CSV, csvRows.join('\n'));

  // Stats
  console.log(`\n=== Export Summary ===`);
  console.log(`Positions used:     ${positionsUsed} (skipped ${skippedPositions} with too few polls)`);
  console.log(`Total data points:  ${totalRows}`);
  console.log(`SELL labels:        ${sellLabels} (${totalRows > 0 ? (sellLabels / totalRows * 100).toFixed(1) : 0}%)`);
  console.log(`HOLD labels:        ${holdLabels} (${totalRows > 0 ? (holdLabels / totalRows * 100).toFixed(1) : 0}%)`);
  console.log(`Class ratio:        1:${sellLabels > 0 ? (holdLabels / sellLabels).toFixed(1) : '?'} (SELL:HOLD)`);
  console.log(`\nOutput: ${OUTPUT_CSV}`);

  // Additional: show position-level stats
  console.log(`\n=== Position-Level Stats ===`);
  const exitReasons = db.prepare(`
    SELECT exit_reason, COUNT(*) as cnt,
           AVG(peak_multiplier) as avg_peak,
           AVG(final_multiplier) as avg_final,
           SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) as rugs
    FROM shadow_positions
    WHERE status = 'closed' AND entry_price > 0 AND total_polls >= ${MIN_POLLS_FOR_LOOKBACK}
    GROUP BY exit_reason
    ORDER BY cnt DESC
  `).all();

  console.log('Exit Reason      | Count | Avg Peak | Avg Final | Rugs');
  console.log('-----------------|-------|----------|-----------|-----');
  for (const r of exitReasons) {
    console.log(
      `${(r.exit_reason || 'unknown').padEnd(17)}| ${String(r.cnt).padEnd(6)}| ${(r.avg_peak || 0).toFixed(2).padStart(8)} | ${(r.avg_final || 0).toFixed(2).padStart(9)} | ${r.rugs}`,
    );
  }

  db.close();
  console.log('\nDone.');
}

main();
