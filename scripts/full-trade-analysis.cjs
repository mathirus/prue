/**
 * Full Trade Analysis Script
 *
 * Queries ALL closed/stopped positions from the database,
 * checks DexScreener for current price data, and produces
 * a comprehensive analysis of post-sell performance.
 *
 * Rate limit: 200ms delay between DexScreener calls (~300 req/min max)
 */

const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const DEXSCREENER_DELAY_MS = 220; // ~270 req/min, well under 300/min limit

// ── Helpers ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SniperBot-Analysis/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, error: 'JSON parse error' });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, data: null, error: 'timeout' }); });
  });
}

function formatSOL(sol) {
  if (sol === null || sol === undefined) return 'N/A';
  const sign = sol >= 0 ? '+' : '';
  return `${sign}${sol.toFixed(6)} SOL`;
}

function formatPct(pct) {
  if (pct === null || pct === undefined) return 'N/A';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function formatMultiplier(x) {
  if (x === null || x === undefined) return 'N/A';
  return `${x.toFixed(2)}x`;
}

function formatDate(ts) {
  if (!ts) return 'N/A';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDuration(ms) {
  if (!ms) return 'N/A';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hrs}h ${remMin}m`;
}

// ── Main Analysis ────────────────────────────────────────────────

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Get all closed/stopped positions with real addresses
  const positions = db.prepare(`
    SELECT
      id, token_mint, pool_address, source,
      entry_price, current_price, peak_price,
      token_amount, sol_invested, sol_returned,
      pnl_sol, pnl_pct, status, tp_levels_hit,
      security_score, opened_at, closed_at,
      exit_reason, peak_multiplier, time_to_peak_ms,
      sell_attempts, sell_successes,
      post_sell_max_multiplier, post_sell_max_usd,
      post_sell_current_usd, post_sell_check_count
    FROM positions
    WHERE status IN ('closed', 'stopped')
      AND LENGTH(pool_address) > 30
    ORDER BY opened_at ASC
  `).all();

  console.log('='.repeat(80));
  console.log('  COMPREHENSIVE TRADE ANALYSIS');
  console.log('  Database:', DB_PATH);
  console.log('  Date:', new Date().toISOString());
  console.log('='.repeat(80));
  console.log(`\nTotal positions to analyze: ${positions.length}`);
  console.log(`Fetching current data from DexScreener...\n`);

  // ── Fetch DexScreener data for each position ──
  const results = [];
  let fetchedCount = 0;
  let errorCount = 0;
  let rateLimitCount = 0;
  const seenPools = new Map(); // Cache: pool_address -> dexData

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const progress = `[${i + 1}/${positions.length}]`;

    let dexData = null;

    if (seenPools.has(pos.pool_address)) {
      dexData = seenPools.get(pos.pool_address);
      process.stdout.write(`\r${progress} Cached: ${pos.pool_address.slice(0, 8)}...`);
    } else {
      process.stdout.write(`\r${progress} Fetching: ${pos.pool_address.slice(0, 8)}...     `);

      const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${pos.pool_address}`;
      const resp = await fetchJSON(url);

      if (resp.status === 429) {
        rateLimitCount++;
        // Wait longer on rate limit
        await sleep(2000);
        const retry = await fetchJSON(url);
        if (retry.status === 200 && retry.data && retry.data.pairs && retry.data.pairs.length > 0) {
          dexData = retry.data.pairs[0];
        }
      } else if (resp.status === 200 && resp.data && resp.data.pairs && resp.data.pairs.length > 0) {
        dexData = resp.data.pairs[0];
        fetchedCount++;
      } else if (resp.status === 200 && resp.data && resp.data.pair) {
        dexData = resp.data.pair;
        fetchedCount++;
      } else {
        errorCount++;
      }

      seenPools.set(pos.pool_address, dexData);
      await sleep(DEXSCREENER_DELAY_MS);
    }

    // Compute analysis
    const analysis = analyzePosition(pos, dexData);
    results.push(analysis);
  }

  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  console.log(`\nFetch complete: ${fetchedCount} fetched, ${seenPools.size} unique pools, ${errorCount} errors, ${rateLimitCount} rate-limited\n`);

  // ── Generate Report ──
  generateReport(results);

  db.close();
}

function analyzePosition(pos, dexData) {
  const holdDuration = pos.closed_at && pos.opened_at ? pos.closed_at - pos.opened_at : null;
  const isWinner = pos.pnl_pct > 0;
  const exitReason = pos.exit_reason || 'unknown';

  // Parse TP levels hit
  let tpLevels = [];
  try { tpLevels = JSON.parse(pos.tp_levels_hit || '[]'); } catch (e) {}

  // Current state from DexScreener
  let currentPriceUsd = null;
  let currentLiquidityUsd = null;
  let priceChange24h = null;
  let volume24h = null;
  let fdv = null;
  let pairAge = null;
  let dexName = null;
  let isActive = false; // Pool still has liquidity and trades

  if (dexData) {
    currentPriceUsd = dexData.priceUsd ? parseFloat(dexData.priceUsd) : null;
    currentLiquidityUsd = dexData.liquidity ? dexData.liquidity.usd : null;
    priceChange24h = dexData.priceChange ? dexData.priceChange.h24 : null;
    volume24h = dexData.volume ? dexData.volume.h24 : null;
    fdv = dexData.fdv || null;
    dexName = dexData.dexId || null;
    pairAge = dexData.pairCreatedAt ? Date.now() - dexData.pairCreatedAt : null;

    // Consider active if has some liquidity and recent volume
    isActive = (currentLiquidityUsd > 100) && (volume24h > 0);
  }

  // Calculate post-sell performance
  // We need to compare current price vs our sell price
  // Our sell price can be estimated: entry_price * (1 + pnl_pct/100)
  // (This is approximate since we may have sold in multiple chunks)
  let sellPriceEstimate = null;
  let postSellMultiplier = null; // Current price / sell price
  let recovered = false; // For losers: did price go above entry?
  let keptGoing = false; // For winners: did price go higher than sell?

  if (pos.entry_price > 0 && pos.pnl_pct !== null) {
    // For -100% (rug), sell price is effectively 0
    if (pos.pnl_pct <= -99) {
      sellPriceEstimate = 0;
    } else {
      sellPriceEstimate = pos.entry_price * (1 + pos.pnl_pct / 100);
    }
  }

  // If we have DexScreener current price AND entry price, compute ratio
  // But prices in our DB are in SOL/token, DexScreener gives USD
  // We can't directly compare. Instead, use FDV or look at price relative patterns.
  //
  // Better approach: use DexScreener to check if pool is dead or alive,
  // and use the post_sell_max_multiplier from our own DB tracking if available.

  // Use our own post-sell tracking data if available
  if (pos.post_sell_max_multiplier) {
    postSellMultiplier = pos.post_sell_max_multiplier;
  }

  // Determine if pool is still alive based on DexScreener data
  let poolStatus = 'unknown';
  if (dexData) {
    if (currentLiquidityUsd === null || currentLiquidityUsd < 10) {
      poolStatus = 'dead'; // No liquidity
    } else if (currentLiquidityUsd < 1000) {
      poolStatus = 'dying'; // Very low liquidity
    } else if (currentLiquidityUsd < 10000) {
      poolStatus = 'low_liq'; // Low but alive
    } else if (currentLiquidityUsd < 100000) {
      poolStatus = 'alive'; // Healthy
    } else {
      poolStatus = 'thriving'; // Strong
    }
  } else {
    poolStatus = 'not_found'; // DexScreener has no data
  }

  // For tokens still alive, estimate if we missed gains or exited wisely
  // Use FDV as a rough proxy for token health
  let missedOpportunity = false;
  if (isWinner && poolStatus !== 'dead' && poolStatus !== 'not_found' && currentLiquidityUsd > 5000) {
    // Winner but pool is still healthy - might have missed more gains
    missedOpportunity = true;
  }
  if (!isWinner && poolStatus !== 'dead' && poolStatus !== 'not_found' && currentLiquidityUsd > 5000) {
    // Loser but pool recovered
    recovered = true;
  }

  return {
    id: pos.id,
    tokenMint: pos.token_mint,
    poolAddress: pos.pool_address,
    source: pos.source,
    entryPrice: pos.entry_price,
    solInvested: pos.sol_invested,
    solReturned: pos.sol_returned,
    pnlSol: pos.pnl_sol,
    pnlPct: pos.pnl_pct,
    isWinner,
    exitReason,
    tpLevels,
    securityScore: pos.security_score,
    holdDuration,
    openedAt: pos.opened_at,
    closedAt: pos.closed_at,
    peakMultiplier: pos.peak_multiplier,
    timeToPeakMs: pos.time_to_peak_ms,
    sellAttempts: pos.sell_attempts,
    sellSuccesses: pos.sell_successes,
    // DexScreener data
    currentPriceUsd,
    currentLiquidityUsd,
    priceChange24h,
    volume24h,
    fdv,
    dexName,
    pairAge,
    isActive,
    poolStatus,
    // Post-sell analysis
    postSellMaxMultiplier: pos.post_sell_max_multiplier,
    postSellMaxUsd: pos.post_sell_max_usd,
    postSellCurrentUsd: pos.post_sell_current_usd,
    postSellCheckCount: pos.post_sell_check_count,
    recovered,
    missedOpportunity,
  };
}

function generateReport(results) {
  const total = results.length;
  const winners = results.filter(r => r.isWinner);
  const losers = results.filter(r => !r.isWinner);

  console.log('='.repeat(80));
  console.log('  SECTION 1: OVERALL SUMMARY');
  console.log('='.repeat(80));

  const totalPnl = results.reduce((s, r) => s + (r.pnlSol || 0), 0);
  const totalInvested = results.reduce((s, r) => s + (r.solInvested || 0), 0);
  const totalReturned = results.reduce((s, r) => s + (r.solReturned || 0), 0);
  const avgPnlPct = results.reduce((s, r) => s + (r.pnlPct || 0), 0) / total;
  const avgHoldMs = results.filter(r => r.holdDuration).reduce((s, r) => s + r.holdDuration, 0) / results.filter(r => r.holdDuration).length;

  console.log(`  Total trades:       ${total}`);
  console.log(`  Winners:            ${winners.length} (${(winners.length / total * 100).toFixed(1)}%)`);
  console.log(`  Losers:             ${losers.length} (${(losers.length / total * 100).toFixed(1)}%)`);
  console.log(`  Total SOL invested: ${totalInvested.toFixed(6)} SOL`);
  console.log(`  Total SOL returned: ${totalReturned.toFixed(6)} SOL`);
  console.log(`  Net PnL:            ${formatSOL(totalPnl)}`);
  console.log(`  Avg PnL per trade:  ${formatSOL(totalPnl / total)}`);
  console.log(`  Avg PnL %:          ${formatPct(avgPnlPct)}`);
  console.log(`  Avg hold duration:  ${formatDuration(avgHoldMs)}`);
  console.log(`  Win rate:           ${(winners.length / total * 100).toFixed(1)}%`);

  // ── Winners summary ──
  console.log(`\n  -- Winners (${winners.length}) --`);
  if (winners.length > 0) {
    const wAvgPnl = winners.reduce((s, r) => s + r.pnlSol, 0) / winners.length;
    const wAvgPct = winners.reduce((s, r) => s + r.pnlPct, 0) / winners.length;
    const wTotalPnl = winners.reduce((s, r) => s + r.pnlSol, 0);
    const bestWin = winners.reduce((best, r) => r.pnlPct > best.pnlPct ? r : best, winners[0]);
    console.log(`  Total profit:   ${formatSOL(wTotalPnl)}`);
    console.log(`  Avg profit:     ${formatSOL(wAvgPnl)} (${formatPct(wAvgPct)})`);
    console.log(`  Best trade:     ${formatPct(bestWin.pnlPct)} (${bestWin.tokenMint.slice(0, 8)}...)`);
  }

  // ── Losers summary ──
  console.log(`\n  -- Losers (${losers.length}) --`);
  if (losers.length > 0) {
    const lAvgPnl = losers.reduce((s, r) => s + r.pnlSol, 0) / losers.length;
    const lAvgPct = losers.reduce((s, r) => s + r.pnlPct, 0) / losers.length;
    const lTotalPnl = losers.reduce((s, r) => s + r.pnlSol, 0);
    const worstLoss = losers.reduce((worst, r) => r.pnlPct < worst.pnlPct ? r : worst, losers[0]);
    const rugs = losers.filter(r => r.pnlPct <= -99);
    console.log(`  Total losses:   ${formatSOL(lTotalPnl)}`);
    console.log(`  Avg loss:       ${formatSOL(lAvgPnl)} (${formatPct(lAvgPct)})`);
    console.log(`  Worst trade:    ${formatPct(worstLoss.pnlPct)} (${worstLoss.tokenMint.slice(0, 8)}...)`);
    console.log(`  Complete rugs:  ${rugs.length} (-100% PnL)`);
  }

  // ── Section 2: By Exit Reason ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 2: ANALYSIS BY EXIT REASON');
  console.log('='.repeat(80));

  const byExitReason = {};
  for (const r of results) {
    const reason = r.exitReason;
    if (!byExitReason[reason]) {
      byExitReason[reason] = { trades: [], winners: 0, losers: 0, totalPnl: 0, rugs: 0 };
    }
    byExitReason[reason].trades.push(r);
    if (r.isWinner) byExitReason[reason].winners++;
    else byExitReason[reason].losers++;
    byExitReason[reason].totalPnl += r.pnlSol || 0;
    if (r.pnlPct <= -99) byExitReason[reason].rugs++;
  }

  for (const [reason, data] of Object.entries(byExitReason).sort((a, b) => b[1].trades.length - a[1].trades.length)) {
    const count = data.trades.length;
    const avgPnl = data.totalPnl / count;
    const avgPct = data.trades.reduce((s, r) => s + (r.pnlPct || 0), 0) / count;
    const winRate = (data.winners / count * 100).toFixed(1);
    const avgHold = data.trades.filter(t => t.holdDuration).reduce((s, t) => s + t.holdDuration, 0) / data.trades.filter(t => t.holdDuration).length;

    console.log(`\n  Exit Reason: "${reason}" (${count} trades)`);
    console.log(`    Win rate:     ${winRate}%`);
    console.log(`    Total PnL:    ${formatSOL(data.totalPnl)}`);
    console.log(`    Avg PnL:      ${formatSOL(avgPnl)} (${formatPct(avgPct)})`);
    console.log(`    Rugs (-100%): ${data.rugs}`);
    console.log(`    Avg hold:     ${formatDuration(avgHold)}`);
  }

  // ── Section 3: Pool Status (Current Health) ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 3: CURRENT POOL STATUS (DexScreener)');
  console.log('='.repeat(80));

  const byPoolStatus = {};
  for (const r of results) {
    if (!byPoolStatus[r.poolStatus]) {
      byPoolStatus[r.poolStatus] = { total: 0, winners: 0, losers: 0, trades: [] };
    }
    byPoolStatus[r.poolStatus].total++;
    if (r.isWinner) byPoolStatus[r.poolStatus].winners++;
    else byPoolStatus[r.poolStatus].losers++;
    byPoolStatus[r.poolStatus].trades.push(r);
  }

  for (const [status, data] of Object.entries(byPoolStatus).sort((a, b) => b[1].total - a[1].total)) {
    const avgLiq = data.trades.filter(t => t.currentLiquidityUsd !== null).reduce((s, t) => s + t.currentLiquidityUsd, 0) / (data.trades.filter(t => t.currentLiquidityUsd !== null).length || 1);
    const avgVol = data.trades.filter(t => t.volume24h !== null).reduce((s, t) => s + t.volume24h, 0) / (data.trades.filter(t => t.volume24h !== null).length || 1);

    console.log(`\n  Pool Status: "${status}" (${data.total} pools)`);
    console.log(`    Were winners: ${data.winners}, Were losers: ${data.losers}`);
    console.log(`    Avg liquidity now: $${avgLiq.toFixed(0)}`);
    console.log(`    Avg 24h volume:    $${avgVol.toFixed(0)}`);
  }

  // ── Section 4: Winners That Kept Going ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 4: WINNERS - DID WE SELL TOO EARLY?');
  console.log('='.repeat(80));

  const winnersAlive = winners.filter(r => r.poolStatus !== 'dead' && r.poolStatus !== 'not_found' && r.poolStatus !== 'dying');
  const winnersDead = winners.filter(r => r.poolStatus === 'dead' || r.poolStatus === 'dying');
  const winnersNotFound = winners.filter(r => r.poolStatus === 'not_found');

  console.log(`\n  Winners still alive (liq > $1K):  ${winnersAlive.length}`);
  console.log(`  Winners dead/dying:                ${winnersDead.length}`);
  console.log(`  Winners not found on DexScreener:  ${winnersNotFound.length}`);

  if (winnersAlive.length > 0) {
    console.log(`\n  -- Winners with pools still alive (potential missed gains) --`);
    // Sort by current liquidity descending
    const sorted = winnersAlive.sort((a, b) => (b.currentLiquidityUsd || 0) - (a.currentLiquidityUsd || 0));
    for (const r of sorted.slice(0, 20)) {
      const timeSinceSell = r.closedAt ? formatDuration(Date.now() - r.closedAt) : 'N/A';
      console.log(`\n    Token: ${r.tokenMint.slice(0, 12)}...`);
      console.log(`    Pool:  ${r.poolAddress.slice(0, 12)}...`);
      console.log(`    Our PnL: ${formatPct(r.pnlPct)} (${formatSOL(r.pnlSol)})`);
      console.log(`    Exit reason: ${r.exitReason}`);
      console.log(`    Sold: ${timeSinceSell} ago`);
      console.log(`    Current liq: $${(r.currentLiquidityUsd || 0).toFixed(0)}`);
      console.log(`    Current FDV: $${(r.fdv || 0).toFixed(0)}`);
      console.log(`    24h vol: $${(r.volume24h || 0).toFixed(0)}`);
      console.log(`    24h price change: ${r.priceChange24h !== null ? formatPct(r.priceChange24h) : 'N/A'}`);
      if (r.postSellMaxMultiplier) {
        console.log(`    Post-sell max: ${formatMultiplier(r.postSellMaxMultiplier)} (tracked by bot)`);
      }
    }
  }

  // ── Section 5: Losers That Recovered ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 5: LOSERS - DID WE EXIT TOO EARLY?');
  console.log('='.repeat(80));

  const losersAlive = losers.filter(r => r.poolStatus !== 'dead' && r.poolStatus !== 'not_found' && r.poolStatus !== 'dying');
  const losersDead = losers.filter(r => r.poolStatus === 'dead' || r.poolStatus === 'dying');
  const losersNotFound = losers.filter(r => r.poolStatus === 'not_found');
  const losersRecovered = losers.filter(r => r.recovered);

  console.log(`\n  Losers still alive (liq > $1K):  ${losersAlive.length}`);
  console.log(`  Losers dead/dying:               ${losersDead.length}`);
  console.log(`  Losers not found on DexScreener:  ${losersNotFound.length}`);
  console.log(`  Losers that RECOVERED (liq>$5K):  ${losersRecovered.length}`);

  if (losersAlive.length > 0) {
    console.log(`\n  -- Losers with pools still alive (premature exits?) --`);
    const sorted = losersAlive.sort((a, b) => (b.currentLiquidityUsd || 0) - (a.currentLiquidityUsd || 0));
    for (const r of sorted.slice(0, 20)) {
      const timeSinceSell = r.closedAt ? formatDuration(Date.now() - r.closedAt) : 'N/A';
      console.log(`\n    Token: ${r.tokenMint.slice(0, 12)}...`);
      console.log(`    Pool:  ${r.poolAddress.slice(0, 12)}...`);
      console.log(`    Our PnL: ${formatPct(r.pnlPct)} (${formatSOL(r.pnlSol)})`);
      console.log(`    Exit reason: ${r.exitReason}`);
      console.log(`    Sold: ${timeSinceSell} ago`);
      console.log(`    Current liq: $${(r.currentLiquidityUsd || 0).toFixed(0)}`);
      console.log(`    Current FDV: $${(r.fdv || 0).toFixed(0)}`);
      console.log(`    24h vol: $${(r.volume24h || 0).toFixed(0)}`);
      console.log(`    24h price change: ${r.priceChange24h !== null ? formatPct(r.priceChange24h) : 'N/A'}`);
      if (r.postSellMaxMultiplier) {
        console.log(`    Post-sell max: ${formatMultiplier(r.postSellMaxMultiplier)} (tracked by bot)`);
      }
    }
  }

  // ── Section 6: By Security Score Brackets ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 6: PERFORMANCE BY SECURITY SCORE');
  console.log('='.repeat(80));

  const scoreBrackets = [
    { label: '0-59', min: 0, max: 59 },
    { label: '60-69', min: 60, max: 69 },
    { label: '70-74', min: 70, max: 74 },
    { label: '75-79', min: 75, max: 79 },
    { label: '80-84', min: 80, max: 84 },
    { label: '85-89', min: 85, max: 89 },
    { label: '90-100', min: 90, max: 100 },
  ];

  for (const bracket of scoreBrackets) {
    const inBracket = results.filter(r => r.securityScore >= bracket.min && r.securityScore <= bracket.max);
    if (inBracket.length === 0) continue;

    const w = inBracket.filter(r => r.isWinner).length;
    const totalPnl = inBracket.reduce((s, r) => s + (r.pnlSol || 0), 0);
    const rugs = inBracket.filter(r => r.pnlPct <= -99).length;
    const alive = inBracket.filter(r => r.poolStatus !== 'dead' && r.poolStatus !== 'not_found' && r.poolStatus !== 'dying').length;

    console.log(`\n  Score ${bracket.label}: ${inBracket.length} trades`);
    console.log(`    Win rate: ${(w / inBracket.length * 100).toFixed(1)}% | Rugs: ${rugs} | PnL: ${formatSOL(totalPnl)}`);
    console.log(`    Pools still alive: ${alive}`);
  }

  // ── Section 7: Timing Analysis ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 7: TIMING ANALYSIS');
  console.log('='.repeat(80));

  // By hour of day (UTC)
  const byHour = {};
  for (const r of results) {
    if (!r.openedAt) continue;
    const hour = new Date(r.openedAt).getUTCHours();
    if (!byHour[hour]) byHour[hour] = { count: 0, winners: 0, pnl: 0, rugs: 0 };
    byHour[hour].count++;
    if (r.isWinner) byHour[hour].winners++;
    byHour[hour].pnl += r.pnlSol || 0;
    if (r.pnlPct <= -99) byHour[hour].rugs++;
  }

  console.log('\n  Performance by Hour (UTC):');
  console.log('  Hour | Trades | Win% | Rugs | PnL');
  console.log('  ' + '-'.repeat(55));
  for (let h = 0; h < 24; h++) {
    if (!byHour[h]) continue;
    const d = byHour[h];
    console.log(`    ${String(h).padStart(2, '0')}   | ${String(d.count).padStart(5)}  | ${(d.winners / d.count * 100).toFixed(0).padStart(3)}% | ${String(d.rugs).padStart(3)}  | ${formatSOL(d.pnl)}`);
  }

  // By hold duration brackets
  console.log('\n  Performance by Hold Duration:');
  const holdBrackets = [
    { label: '<30s', maxMs: 30000 },
    { label: '30s-1m', maxMs: 60000 },
    { label: '1-2m', maxMs: 120000 },
    { label: '2-5m', maxMs: 300000 },
    { label: '5-10m', maxMs: 600000 },
    { label: '10-30m', maxMs: 1800000 },
    { label: '30m+', maxMs: Infinity },
  ];

  let prevMax = 0;
  for (const bracket of holdBrackets) {
    const inBracket = results.filter(r => r.holdDuration >= prevMax && r.holdDuration < bracket.maxMs);
    if (inBracket.length === 0) { prevMax = bracket.maxMs; continue; }

    const w = inBracket.filter(r => r.isWinner).length;
    const pnl = inBracket.reduce((s, r) => s + (r.pnlSol || 0), 0);

    console.log(`  ${bracket.label.padEnd(8)} | ${String(inBracket.length).padStart(4)} trades | Win: ${(w / inBracket.length * 100).toFixed(0).padStart(3)}% | PnL: ${formatSOL(pnl)}`);
    prevMax = bracket.maxMs;
  }

  // ── Section 8: Post-Sell Tracking (from bot's own data) ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 8: POST-SELL TRACKING (Bot Data)');
  console.log('='.repeat(80));

  const withPostSell = results.filter(r => r.postSellMaxMultiplier !== null);
  console.log(`\n  Positions with post-sell tracking: ${withPostSell.length}`);

  if (withPostSell.length > 0) {
    const winnersPostSell = withPostSell.filter(r => r.isWinner);
    const losersPostSell = withPostSell.filter(r => !r.isWinner);

    if (winnersPostSell.length > 0) {
      const avgMaxMult = winnersPostSell.reduce((s, r) => s + r.postSellMaxMultiplier, 0) / winnersPostSell.length;
      const wentHigher = winnersPostSell.filter(r => r.postSellMaxMultiplier > 1.1); // went 10%+ higher after sell
      console.log(`\n  Winners with post-sell data: ${winnersPostSell.length}`);
      console.log(`    Avg post-sell max multiplier: ${formatMultiplier(avgMaxMult)}`);
      console.log(`    Went 10%+ higher after sell:  ${wentHigher.length} (${(wentHigher.length / winnersPostSell.length * 100).toFixed(1)}%)`);
    }

    if (losersPostSell.length > 0) {
      const avgMaxMult = losersPostSell.reduce((s, r) => s + r.postSellMaxMultiplier, 0) / losersPostSell.length;
      const recovered = losersPostSell.filter(r => r.postSellMaxMultiplier > 1.5); // went 50%+ above sell price
      console.log(`\n  Losers with post-sell data: ${losersPostSell.length}`);
      console.log(`    Avg post-sell max multiplier: ${formatMultiplier(avgMaxMult)}`);
      console.log(`    Recovered 50%+ after sell:    ${recovered.length} (${(recovered.length / losersPostSell.length * 100).toFixed(1)}%)`);
    }
  }

  // ── Section 9: TP Level Analysis ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 9: TAKE PROFIT LEVEL ANALYSIS');
  console.log('='.repeat(80));

  const withTP = results.filter(r => r.tpLevels.length > 0);
  const noTP = results.filter(r => r.tpLevels.length === 0);

  console.log(`\n  Trades hitting TP:     ${withTP.length}`);
  console.log(`  Trades without any TP: ${noTP.length}`);

  if (withTP.length > 0) {
    // Count which TP levels
    const tpCounts = {};
    for (const r of withTP) {
      for (const level of r.tpLevels) {
        tpCounts[level] = (tpCounts[level] || 0) + 1;
      }
    }
    console.log('\n  TP levels hit:');
    for (const [level, count] of Object.entries(tpCounts).sort((a, b) => a[0] - b[0])) {
      console.log(`    TP ${level}: ${count} times`);
    }

    const tpPnl = withTP.reduce((s, r) => s + (r.pnlSol || 0), 0);
    const noTPpnl = noTP.reduce((s, r) => s + (r.pnlSol || 0), 0);
    console.log(`\n  PnL from TP trades:     ${formatSOL(tpPnl)}`);
    console.log(`  PnL from non-TP trades: ${formatSOL(noTPpnl)}`);
  }

  // ── Section 10: Peak Multiplier Analysis ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 10: PEAK MULTIPLIER ANALYSIS (How high did price go?)');
  console.log('='.repeat(80));

  const withPeak = results.filter(r => r.peakMultiplier !== null && r.peakMultiplier > 0);
  if (withPeak.length > 0) {
    const avgPeak = withPeak.reduce((s, r) => s + r.peakMultiplier, 0) / withPeak.length;
    const medianPeak = withPeak.map(r => r.peakMultiplier).sort((a, b) => a - b)[Math.floor(withPeak.length / 2)];

    console.log(`\n  Trades with peak data: ${withPeak.length}`);
    console.log(`  Avg peak multiplier:  ${formatMultiplier(avgPeak)}`);
    console.log(`  Median peak:          ${formatMultiplier(medianPeak)}`);

    // How many went 2x, 3x, 5x, 10x
    const thresholds = [1.25, 1.5, 2, 3, 5, 10];
    for (const t of thresholds) {
      const count = withPeak.filter(r => r.peakMultiplier >= t).length;
      console.log(`  Reached ${t}x+: ${count} (${(count / withPeak.length * 100).toFixed(1)}%)`);
    }

    // Winners peak vs actual sell
    const winnersPeak = withPeak.filter(r => r.isWinner);
    if (winnersPeak.length > 0) {
      const avgCaptured = winnersPeak.reduce((s, r) => s + (1 + r.pnlPct / 100) / r.peakMultiplier, 0) / winnersPeak.length;
      console.log(`\n  Winners: avg % of peak captured: ${(avgCaptured * 100).toFixed(1)}%`);
    }

    // Losers peak analysis - how high did they go before crashing?
    const losersPeak = withPeak.filter(r => !r.isWinner);
    if (losersPeak.length > 0) {
      const avgLoserPeak = losersPeak.reduce((s, r) => s + r.peakMultiplier, 0) / losersPeak.length;
      const losersThatHit125 = losersPeak.filter(r => r.peakMultiplier >= 1.25).length;
      console.log(`\n  Losers: avg peak before crash: ${formatMultiplier(avgLoserPeak)}`);
      console.log(`  Losers that reached 1.25x before dropping: ${losersThatHit125} (${(losersThatHit125 / losersPeak.length * 100).toFixed(1)}%)`);
    }
  } else {
    console.log('\n  No peak multiplier data available.');
  }

  // ── Section 11: Sell Efficiency ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 11: SELL EFFICIENCY');
  console.log('='.repeat(80));

  const withSellData = results.filter(r => r.sellAttempts > 0);
  if (withSellData.length > 0) {
    const avgAttempts = withSellData.reduce((s, r) => s + r.sellAttempts, 0) / withSellData.length;
    const avgSuccesses = withSellData.reduce((s, r) => s + r.sellSuccesses, 0) / withSellData.length;
    const failedAll = withSellData.filter(r => r.sellSuccesses === 0).length;

    console.log(`\n  Trades with sell data: ${withSellData.length}`);
    console.log(`  Avg sell attempts:    ${avgAttempts.toFixed(1)}`);
    console.log(`  Avg sell successes:   ${avgSuccesses.toFixed(1)}`);
    console.log(`  Sell success rate:    ${(avgSuccesses / avgAttempts * 100).toFixed(1)}%`);
    console.log(`  Failed all sells:     ${failedAll}`);
  }

  // ── Section 12: Complete Dead Pool Analysis ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 12: POOL DEATH ANALYSIS');
  console.log('='.repeat(80));

  const deadPools = results.filter(r => r.poolStatus === 'dead' || r.poolStatus === 'not_found');
  const alivePools = results.filter(r => r.poolStatus !== 'dead' && r.poolStatus !== 'not_found');

  console.log(`\n  Dead/not found pools: ${deadPools.length} (${(deadPools.length / total * 100).toFixed(1)}%)`);
  console.log(`  Still alive pools:    ${alivePools.length} (${(alivePools.length / total * 100).toFixed(1)}%)`);

  if (alivePools.length > 0) {
    const aliveWinners = alivePools.filter(r => r.isWinner).length;
    const aliveLosers = alivePools.filter(r => !r.isWinner).length;
    console.log(`\n  Alive pools: ${aliveWinners} were winners, ${aliveLosers} were losers`);

    // Top alive pools by liquidity
    const topAlive = alivePools.sort((a, b) => (b.currentLiquidityUsd || 0) - (a.currentLiquidityUsd || 0)).slice(0, 10);
    console.log('\n  Top 10 alive pools by current liquidity:');
    for (const r of topAlive) {
      const outcome = r.isWinner ? 'WIN' : 'LOSS';
      console.log(`    ${outcome.padEnd(4)} | ${r.tokenMint.slice(0, 12)}... | PnL: ${formatPct(r.pnlPct).padStart(8)} | Liq: $${(r.currentLiquidityUsd || 0).toFixed(0).padStart(8)} | FDV: $${(r.fdv || 0).toFixed(0).padStart(10)} | Vol24h: $${(r.volume24h || 0).toFixed(0).padStart(8)}`);
    }
  }

  // ── Section 13: Time-Based PnL (by day) ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 13: DAILY PnL TIMELINE');
  console.log('='.repeat(80));

  const byDay = {};
  for (const r of results) {
    if (!r.openedAt) continue;
    const day = new Date(r.openedAt).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { trades: 0, winners: 0, pnl: 0, rugs: 0 };
    byDay[day].trades++;
    if (r.isWinner) byDay[day].winners++;
    byDay[day].pnl += r.pnlSol || 0;
    if (r.pnlPct <= -99) byDay[day].rugs++;
  }

  console.log('\n  Date       | Trades | Win% | Rugs | PnL');
  console.log('  ' + '-'.repeat(60));
  let cumulativePnl = 0;
  for (const [day, d] of Object.entries(byDay).sort()) {
    cumulativePnl += d.pnl;
    console.log(`  ${day} | ${String(d.trades).padStart(5)}  | ${(d.winners / d.trades * 100).toFixed(0).padStart(3)}% | ${String(d.rugs).padStart(3)}  | ${formatSOL(d.pnl).padStart(14)} | Cumul: ${formatSOL(cumulativePnl)}`);
  }

  // ── Section 14: Recommendations ──
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 14: STRATEGY RECOMMENDATIONS');
  console.log('='.repeat(80));

  const recommendations = [];

  // 1. Win rate analysis
  const winRate = winners.length / total * 100;
  if (winRate < 40) {
    recommendations.push(`[CRITICAL] Win rate is ${winRate.toFixed(1)}% - below 40%. Consider tightening entry filters (higher min_score, stricter liquidity requirements).`);
  }

  // 2. Rug analysis
  const rugCount = results.filter(r => r.pnlPct <= -99).length;
  const rugRate = rugCount / total * 100;
  if (rugRate > 20) {
    recommendations.push(`[CRITICAL] Rug rate is ${rugRate.toFixed(1)}% (${rugCount}/${total}). ${rugCount} trades were complete rugs (-100%). Need better rug detection or faster exit on drain signals.`);
  }

  // 3. Premature exits
  const prematureExits = losers.filter(r => r.recovered).length;
  if (prematureExits > 5) {
    recommendations.push(`[IMPORTANT] ${prematureExits} losing trades have pools still alive with >$5K liquidity. These may have been premature exits. Consider: longer hold times for tokens with strong fundamentals.`);
  }

  // 4. Missed gains
  const missedGains = winners.filter(r => r.missedOpportunity).length;
  if (missedGains > 5) {
    recommendations.push(`[IMPORTANT] ${missedGains} winning trades have pools still alive with >$5K liquidity. You may be selling too early on good tokens. Consider: larger moon bags, higher TP levels.`);
  }

  // 5. Exit reason analysis
  if (byExitReason['unknown'] && byExitReason['unknown'].trades.length > total * 0.5) {
    recommendations.push(`[WARNING] ${byExitReason['unknown'].trades.length} trades (${(byExitReason['unknown'].trades.length / total * 100).toFixed(0)}%) have no exit_reason. This makes strategy optimization difficult. Ensure all exits are properly tagged.`);
  }

  // 6. Score bracket analysis
  for (const bracket of scoreBrackets) {
    const inBracket = results.filter(r => r.securityScore >= bracket.min && r.securityScore <= bracket.max);
    if (inBracket.length < 10) continue;
    const bracketWinRate = inBracket.filter(r => r.isWinner).length / inBracket.length * 100;
    const bracketPnl = inBracket.reduce((s, r) => s + (r.pnlSol || 0), 0);
    if (bracketPnl < -0.01 && bracketWinRate < 35) {
      recommendations.push(`[SCORING] Score bracket ${bracket.label} has ${bracketWinRate.toFixed(0)}% win rate and ${formatSOL(bracketPnl)} PnL across ${inBracket.length} trades. Consider raising min_score above ${bracket.max + 1}.`);
    }
  }

  // 7. Timing recommendations
  for (const [hour, d] of Object.entries(byHour)) {
    if (d.count >= 10 && d.rugs / d.count > 0.5) {
      recommendations.push(`[TIMING] Hour ${hour} UTC has ${(d.rugs / d.count * 100).toFixed(0)}% rug rate (${d.rugs}/${d.count}). Consider avoiding trading during this hour.`);
    }
  }

  // 8. Peak capture
  if (withPeak.length > 0) {
    const winnersPeak = withPeak.filter(r => r.isWinner);
    if (winnersPeak.length > 0) {
      const avgCapture = winnersPeak.reduce((s, r) => s + (1 + r.pnlPct / 100) / r.peakMultiplier, 0) / winnersPeak.length;
      if (avgCapture < 0.5) {
        recommendations.push(`[EXIT] On winning trades, you only capture ${(avgCapture * 100).toFixed(0)}% of the peak price on average. Consider adjusting trailing stop to be tighter or adding more TP levels.`);
      }
    }

    // Losers that peaked high
    const losersPeaked = withPeak.filter(r => !r.isWinner && r.peakMultiplier >= 1.25);
    if (losersPeaked.length > 10) {
      recommendations.push(`[EXIT] ${losersPeaked.length} losing trades reached 1.25x+ before crashing. Your TP1 at 1.25x should catch some of these - verify TP1 execution speed.`);
    }
  }

  // 9. Average loss size
  if (losers.length > 0) {
    const avgLoss = losers.reduce((s, r) => s + r.pnlSol, 0) / losers.length;
    const avgWin = winners.length > 0 ? winners.reduce((s, r) => s + r.pnlSol, 0) / winners.length : 0;
    const riskReward = avgWin > 0 ? Math.abs(avgWin / avgLoss) : 0;
    if (riskReward < 1) {
      recommendations.push(`[RISK] Risk/reward ratio is ${riskReward.toFixed(2)} (avg win: ${formatSOL(avgWin)}, avg loss: ${formatSOL(avgLoss)}). Need either higher wins or smaller losses. Target R:R > 1.5.`);
    }
  }

  console.log('');
  if (recommendations.length === 0) {
    console.log('  No specific recommendations - strategy looks well-optimized for current data.');
  } else {
    for (let i = 0; i < recommendations.length; i++) {
      console.log(`  ${i + 1}. ${recommendations[i]}`);
      console.log('');
    }
  }

  console.log('='.repeat(80));
  console.log('  END OF ANALYSIS');
  console.log('='.repeat(80));
}

// ── Run ──
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
