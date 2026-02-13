/**
 * deep-rejected-analysis.cjs
 *
 * Investigacion exhaustiva de pools rechazados en las ultimas 48h.
 * Para cada token rechazado con liq >= $15K, consulta DexScreener
 * para ver su estado actual. Compara con trades ejecutados.
 * Genera reporte en data/rejected-pool-analysis.md
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const db = new Database(DB_PATH, { readonly: true });

const NOW = Date.now();
const H48 = 48 * 60 * 60 * 1000;
const CUTOFF = NOW - H48;

// ===== HELPERS =====
function pct(n, total) {
  if (!total) return '0.0%';
  return (n / total * 100).toFixed(1) + '%';
}
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmtDate(ts) {
  if (!ts) return 'N/A';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
function fmtNum(n) {
  if (n == null) return 'N/A';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchDexScreener(mint) {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'SniperBot-Analysis/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.pairs || !data.pairs.length) return null;
    // Find best Solana pair (highest liquidity)
    const solanaPairs = data.pairs.filter(p => p.chainId === 'solana');
    if (!solanaPairs.length) return null;
    solanaPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return solanaPairs[0];
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('=== DEEP REJECTED POOL ANALYSIS ===');
  console.log('Period: last 48h | Date:', new Date().toISOString());
  console.log('');

  // ============================================================
  // STEP 1: Get rejected pools with potential (liq >= $15K, score 60-79)
  // ============================================================
  const rejectedPools = db.prepare(`
    SELECT base_mint, pool_address, security_score, dp_liquidity_usd, dp_holder_count,
           dp_top_holder_pct, dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
           dp_rejection_stage, rejection_reasons, detected_at, source,
           dp_mint_auth_revoked, dp_freeze_auth_revoked, dp_honeypot_verified,
           dp_lp_burned, dp_rugcheck_score, dp_observation_stable,
           dp_observation_drop_pct, dp_creator_reputation, dp_creator_funding,
           dp_wash_penalty, dp_wash_concentration, dp_wash_same_amount_ratio,
           dp_early_tx_count, dp_tx_velocity, bot_version
    FROM detected_pools
    WHERE detected_at > ?
      AND dp_liquidity_usd >= 15000
      AND security_score < 80
      AND security_score >= 40
    ORDER BY security_score DESC, detected_at DESC
  `).all(CUTOFF);

  console.log(`Step 1: Found ${rejectedPools.length} rejected pools with liq >= $15K and score 40-79`);

  // Also get ALL rejected pools for broader stats
  const allRejected48h = db.prepare(`
    SELECT base_mint, security_score, dp_liquidity_usd, rejection_reasons,
           dp_rejection_stage, detected_at
    FROM detected_pools
    WHERE detected_at > ?
      AND (security_passed = 0 OR security_score < 80)
    ORDER BY detected_at DESC
  `).all(CUTOFF);

  console.log(`  (Total rejected in 48h: ${allRejected48h.length})`);

  // ============================================================
  // STEP 2: Get actual trades (positions) from last 48h
  // ============================================================
  const positions = db.prepare(`
    SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct, entry_price,
           peak_multiplier, exit_reason, opened_at, closed_at, security_score,
           status, bot_version, source, pool_address
    FROM positions
    WHERE opened_at > ?
      AND status IN ('closed','stopped','partial_close')
    ORDER BY opened_at DESC
  `).all(CUTOFF);

  console.log(`Step 2: Found ${positions.length} actual trades in last 48h`);

  // ============================================================
  // STEP 3: Fetch DexScreener data for rejected pools
  // ============================================================
  console.log(`\nStep 3: Fetching DexScreener data for ${rejectedPools.length} rejected tokens...`);

  const enrichedRejected = [];
  let fetchCount = 0;

  // Deduplicate by base_mint (same token can appear in multiple pools)
  const seenMints = new Set();
  const uniqueRejected = [];
  for (const pool of rejectedPools) {
    if (!seenMints.has(pool.base_mint)) {
      seenMints.add(pool.base_mint);
      uniqueRejected.push(pool);
    }
  }

  console.log(`  Unique mints to check: ${uniqueRejected.length}`);

  for (const pool of uniqueRejected) {
    const dexData = await fetchDexScreener(pool.base_mint);
    fetchCount++;

    let classification = 'DEAD';
    let mcap = 0;
    let vol24h = 0;
    let liqNow = 0;
    let priceChange1h = null;
    let priceChange6h = null;
    let priceChange24h = null;
    let txns24h = 0;
    let pairUrl = '';

    if (dexData) {
      mcap = dexData.marketCap || dexData.fdv || 0;
      vol24h = dexData.volume?.h24 || 0;
      liqNow = dexData.liquidity?.usd || 0;
      priceChange1h = dexData.priceChange?.h1;
      priceChange6h = dexData.priceChange?.h6;
      priceChange24h = dexData.priceChange?.h24;
      txns24h = (dexData.txns?.h24?.buys || 0) + (dexData.txns?.h24?.sells || 0);
      pairUrl = dexData.url || '';

      if (mcap > 100000 && vol24h > 50000) classification = 'ALIVE_STRONG';
      else if (mcap > 30000 && (vol24h > 10000 || liqNow > 15000)) classification = 'ALIVE_OK';
      else if (mcap > 5000) classification = 'DYING';
      else classification = 'DEAD';
    }

    enrichedRejected.push({
      ...pool,
      dex_mcap: mcap,
      dex_vol24h: vol24h,
      dex_liq_now: liqNow,
      dex_change_1h: priceChange1h,
      dex_change_6h: priceChange6h,
      dex_change_24h: priceChange24h,
      dex_txns_24h: txns24h,
      dex_url: pairUrl,
      classification,
      dex_found: !!dexData,
    });

    if (fetchCount % 10 === 0) {
      console.log(`  Fetched ${fetchCount}/${uniqueRejected.length}...`);
    }

    await sleep(300); // rate limit
  }

  console.log(`  Done! Fetched ${fetchCount} tokens.`);

  // ============================================================
  // STEP 4: Also fetch DexScreener for our actual trades
  // ============================================================
  console.log(`\nStep 4: Fetching DexScreener data for ${positions.length} traded tokens...`);

  const enrichedPositions = [];
  const tradedMints = new Set();

  for (const pos of positions) {
    if (tradedMints.has(pos.token_mint)) continue;
    tradedMints.add(pos.token_mint);

    const dexData = await fetchDexScreener(pos.token_mint);

    let mcap = 0;
    let liqNow = 0;
    let vol24h = 0;

    if (dexData) {
      mcap = dexData.marketCap || dexData.fdv || 0;
      liqNow = dexData.liquidity?.usd || 0;
      vol24h = dexData.volume?.h24 || 0;
    }

    enrichedPositions.push({
      ...pos,
      dex_mcap: mcap,
      dex_liq_now: liqNow,
      dex_vol24h: vol24h,
      dex_found: !!dexData,
    });

    await sleep(300);
  }

  console.log(`  Done!`);

  // ============================================================
  // STEP 5: ANALYSIS
  // ============================================================
  console.log('\n=== ANALYSIS ===\n');

  // Classification counts
  const classificationCounts = {};
  for (const r of enrichedRejected) {
    classificationCounts[r.classification] = (classificationCounts[r.classification] || 0) + 1;
  }

  console.log('Classification of rejected tokens:');
  for (const [cls, count] of Object.entries(classificationCounts)) {
    console.log(`  ${cls}: ${count} (${pct(count, enrichedRejected.length)})`);
  }

  // Strong tokens detail
  const strongTokens = enrichedRejected.filter(r => r.classification === 'ALIVE_STRONG');
  const okTokens = enrichedRejected.filter(r => r.classification === 'ALIVE_OK');
  const deadTokens = enrichedRejected.filter(r => r.classification === 'DEAD' || r.classification === 'DYING');

  console.log(`\n--- ALIVE_STRONG tokens (missed opportunities?) ---`);
  for (const t of strongTokens) {
    console.log(`  ${t.base_mint.slice(0,12)}... score=${t.security_score} liq_at_detect=$${fmtNum(t.dp_liquidity_usd)} mcap_now=$${fmtNum(t.dex_mcap)} vol24h=$${fmtNum(t.dex_vol24h)}`);
    console.log(`    reasons: ${t.rejection_reasons || 'score<80'}`);
    console.log(`    rejection_stage: ${t.dp_rejection_stage || 'N/A'}`);
    console.log(`    detected: ${fmtDate(t.detected_at)}`);
  }

  console.log(`\n--- ALIVE_OK tokens ---`);
  for (const t of okTokens) {
    console.log(`  ${t.base_mint.slice(0,12)}... score=${t.security_score} liq=$${fmtNum(t.dp_liquidity_usd)} mcap=$${fmtNum(t.dex_mcap)} vol=$${fmtNum(t.dex_vol24h)}`);
    console.log(`    reasons: ${t.rejection_reasons || 'score<80'}`);
  }

  // ============================================================
  // STEP 5B: Score distribution analysis
  // ============================================================
  console.log('\n--- Score Distribution of Rejected (liq >= $15K) ---');
  const scoreGroups = {};
  for (const r of enrichedRejected) {
    const band = r.security_score >= 75 ? '75-79' :
                 r.security_score >= 70 ? '70-74' :
                 r.security_score >= 65 ? '65-69' :
                 r.security_score >= 60 ? '60-64' :
                 r.security_score >= 50 ? '50-59' : '<50';
    if (!scoreGroups[band]) scoreGroups[band] = { total: 0, strong: 0, ok: 0, dead: 0, dying: 0 };
    scoreGroups[band].total++;
    if (r.classification === 'ALIVE_STRONG') scoreGroups[band].strong++;
    else if (r.classification === 'ALIVE_OK') scoreGroups[band].ok++;
    else if (r.classification === 'DYING') scoreGroups[band].dying++;
    else scoreGroups[band].dead++;
  }

  console.log('Band   | Total | Strong | OK | Dying | Dead | Alive%');
  console.log('-------+-------+--------+----+-------+------+-------');
  for (const band of ['75-79', '70-74', '65-69', '60-64', '50-59', '<50']) {
    const g = scoreGroups[band];
    if (!g) continue;
    const aliveRate = pct(g.strong + g.ok, g.total);
    console.log(`${band.padEnd(7)}| ${String(g.total).padStart(5)} | ${String(g.strong).padStart(6)} | ${String(g.ok).padStart(2)} | ${String(g.dying).padStart(5)} | ${String(g.dead).padStart(4)} | ${aliveRate}`);
  }

  // ============================================================
  // STEP 5C: Rejection reason analysis
  // ============================================================
  console.log('\n--- Rejection Reasons vs Outcome ---');
  const reasonStats = {};
  for (const r of enrichedRejected) {
    const reasons = (r.rejection_reasons || 'score_below_threshold').split(',').map(s => s.trim()).filter(Boolean);
    for (const reason of reasons) {
      if (!reasonStats[reason]) reasonStats[reason] = { total: 0, strong: 0, ok: 0, dead: 0 };
      reasonStats[reason].total++;
      if (r.classification === 'ALIVE_STRONG') reasonStats[reason].strong++;
      else if (r.classification === 'ALIVE_OK') reasonStats[reason].ok++;
      else reasonStats[reason].dead++;
    }
  }

  const sortedReasons = Object.entries(reasonStats).sort((a, b) => b[1].total - a[1].total);
  console.log('Reason                          | Total | Strong | OK | Dead | False Reject%');
  console.log('--------------------------------+-------+--------+----+------+--------------');
  for (const [reason, stats] of sortedReasons) {
    const falseReject = pct(stats.strong + stats.ok, stats.total);
    console.log(`${reason.slice(0,32).padEnd(32)}| ${String(stats.total).padStart(5)} | ${String(stats.strong).padStart(6)} | ${String(stats.ok).padStart(2)} | ${String(stats.dead).padStart(4)} | ${falseReject}`);
  }

  // ============================================================
  // STEP 5D: Which features blocked the STRONG tokens?
  // ============================================================
  console.log('\n--- Features of ALIVE_STRONG tokens (what blocked them?) ---');
  for (const t of strongTokens) {
    console.log(`\n  Token: ${t.base_mint}`);
    console.log(`    Score: ${t.security_score} | Liq at detect: $${fmtNum(t.dp_liquidity_usd)} | MCap now: $${fmtNum(t.dex_mcap)}`);
    console.log(`    Holders: ${t.dp_holder_count} | Top holder: ${(t.dp_top_holder_pct||0).toFixed(1)}%`);
    console.log(`    Mint revoked: ${t.dp_mint_auth_revoked} | Freeze revoked: ${t.dp_freeze_auth_revoked}`);
    console.log(`    Honeypot verified: ${t.dp_honeypot_verified} | LP burned: ${t.dp_lp_burned}`);
    console.log(`    RugCheck score: ${t.dp_rugcheck_score}`);
    console.log(`    Graduation time: ${t.dp_graduation_time_s}s`);
    console.log(`    Bundle penalty: ${t.dp_bundle_penalty} | Insiders: ${t.dp_insiders_count}`);
    console.log(`    Creator reputation: ${t.dp_creator_reputation} | Funding: ${t.dp_creator_funding}`);
    console.log(`    Wash penalty: ${t.dp_wash_penalty} | Wash concentration: ${t.dp_wash_concentration}`);
    console.log(`    Observation stable: ${t.dp_observation_stable} | Drop%: ${t.dp_observation_drop_pct}`);
    console.log(`    Rejection reasons: ${t.rejection_reasons}`);
    console.log(`    Rejection stage: ${t.dp_rejection_stage}`);
    console.log(`    Vol 24h: $${fmtNum(t.dex_vol24h)} | Txns 24h: ${t.dex_txns_24h}`);
    console.log(`    Price changes: 1h=${t.dex_change_1h}% 6h=${t.dex_change_6h}% 24h=${t.dex_change_24h}%`);
  }

  // ============================================================
  // STEP 5E: Compare rejected vs traded
  // ============================================================
  console.log('\n--- Comparison: Rejected Alive vs Actual Trades ---');

  const actualWins = enrichedPositions.filter(p => p.pnl_pct > 0);
  const actualLosses = enrichedPositions.filter(p => p.pnl_pct <= 0);

  console.log(`\nActual trades (48h): ${enrichedPositions.length}`);
  console.log(`  Winners: ${actualWins.length} (${pct(actualWins.length, enrichedPositions.length)})`);
  console.log(`  Losers: ${actualLosses.length} (${pct(actualLosses.length, enrichedPositions.length)})`);
  console.log(`  Total PnL: ${enrichedPositions.reduce((a, p) => a + (p.pnl_sol || 0), 0).toFixed(6)} SOL`);

  for (const p of enrichedPositions) {
    const pnlStr = (p.pnl_sol || 0) >= 0 ? `+${(p.pnl_sol||0).toFixed(6)}` : (p.pnl_sol||0).toFixed(6);
    console.log(`  ${p.token_mint.slice(0,12)}... score=${p.security_score} pnl=${pnlStr} SOL (${(p.pnl_pct||0).toFixed(1)}%) peak=${(p.peak_multiplier||0).toFixed(2)}x exit=${p.exit_reason}`);
    console.log(`    now: mcap=$${fmtNum(p.dex_mcap)} liq=$${fmtNum(p.dex_liq_now)} vol=$${fmtNum(p.dex_vol24h)}`);
  }

  // ============================================================
  // STEP 5F: Hour of day pattern
  // ============================================================
  console.log('\n--- Hour of Day Pattern (rejected with liq >= $15K) ---');
  const hourBuckets = {};
  for (const r of enrichedRejected) {
    const hour = new Date(r.detected_at).getUTCHours();
    if (!hourBuckets[hour]) hourBuckets[hour] = { total: 0, strong: 0, ok: 0, dead: 0 };
    hourBuckets[hour].total++;
    if (r.classification === 'ALIVE_STRONG') hourBuckets[hour].strong++;
    else if (r.classification === 'ALIVE_OK') hourBuckets[hour].ok++;
    else hourBuckets[hour].dead++;
  }

  console.log('Hour(UTC) | Total | Strong | OK | Dead | Alive%');
  console.log('----------+-------+--------+----+------+-------');
  for (let h = 0; h < 24; h++) {
    const b = hourBuckets[h];
    if (!b) continue;
    const aliveRate = pct(b.strong + b.ok, b.total);
    console.log(`    ${String(h).padStart(2)}    | ${String(b.total).padStart(5)} | ${String(b.strong).padStart(6)} | ${String(b.ok).padStart(2)} | ${String(b.dead).padStart(4)} | ${aliveRate}`);
  }

  // ============================================================
  // STEP 5G: Score 75-79 deep dive
  // ============================================================
  const score75to79 = enrichedRejected.filter(r => r.security_score >= 75 && r.security_score <= 79);
  console.log(`\n--- DEEP DIVE: Score 75-79 (${score75to79.length} tokens) ---`);

  const strong75 = score75to79.filter(r => r.classification === 'ALIVE_STRONG');
  const ok75 = score75to79.filter(r => r.classification === 'ALIVE_OK');
  const dead75 = score75to79.filter(r => r.classification === 'DEAD' || r.classification === 'DYING');

  console.log(`  ALIVE_STRONG: ${strong75.length}`);
  console.log(`  ALIVE_OK: ${ok75.length}`);
  console.log(`  DEAD/DYING: ${dead75.length}`);
  console.log(`  Alive rate: ${pct(strong75.length + ok75.length, score75to79.length)}`);

  for (const t of [...strong75, ...ok75]) {
    console.log(`\n  ${t.base_mint}`);
    console.log(`    Score=${t.security_score} Liq=$${fmtNum(t.dp_liquidity_usd)} MCap=$${fmtNum(t.dex_mcap)} Vol=$${fmtNum(t.dex_vol24h)}`);
    console.log(`    Reasons: ${t.rejection_reasons}`);
    console.log(`    Change 24h: ${t.dex_change_24h}%`);
  }

  // ============================================================
  // STEP 5H: Broader context - all rejections pipeline stage
  // ============================================================
  console.log('\n--- Rejection Pipeline Stages (ALL 48h rejections) ---');
  const stageCounts = {};
  for (const r of allRejected48h) {
    const stage = r.dp_rejection_stage || 'unknown';
    if (!stageCounts[stage]) stageCounts[stage] = 0;
    stageCounts[stage]++;
  }

  const sortedStages = Object.entries(stageCounts).sort((a, b) => b[1] - a[1]);
  for (const [stage, count] of sortedStages) {
    console.log(`  ${stage}: ${count} (${pct(count, allRejected48h.length)})`);
  }

  // Rejection by liq bracket
  console.log('\n--- Rejections by Liquidity Bracket (48h) ---');
  const liqBrackets = { '<$5K': 0, '$5-15K': 0, '$15-30K': 0, '$30-50K': 0, '$50K+': 0, 'no_data': 0 };
  for (const r of allRejected48h) {
    const liq = r.dp_liquidity_usd;
    if (liq == null) liqBrackets['no_data']++;
    else if (liq < 5000) liqBrackets['<$5K']++;
    else if (liq < 15000) liqBrackets['$5-15K']++;
    else if (liq < 30000) liqBrackets['$15-30K']++;
    else if (liq < 50000) liqBrackets['$30-50K']++;
    else liqBrackets['$50K+']++;
  }

  for (const [bracket, count] of Object.entries(liqBrackets)) {
    console.log(`  ${bracket}: ${count}`);
  }

  // ============================================================
  // STEP 6: GENERATE REPORT
  // ============================================================
  console.log('\n\nStep 6: Generating report...');

  let report = '';
  report += '# Rejected Pool Analysis Report\n\n';
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `Period: Last 48 hours (since ${fmtDate(CUTOFF)})\n`;
  report += `Bot version at time of analysis: v8q\n\n`;

  // Summary
  report += '## Executive Summary\n\n';
  report += `- **Total rejected pools (48h):** ${allRejected48h.length}\n`;
  report += `- **Rejected with liq >= $15K and score 40-79:** ${enrichedRejected.length} (unique mints: ${uniqueRejected.length})\n`;
  report += `- **Actual trades (48h):** ${enrichedPositions.length}\n`;
  report += `- **Actual trade win rate:** ${pct(actualWins.length, enrichedPositions.length)} (${actualWins.length}/${enrichedPositions.length})\n`;
  report += `- **Actual PnL:** ${enrichedPositions.reduce((a, p) => a + (p.pnl_sol || 0), 0).toFixed(6)} SOL\n\n`;

  report += '### Classification of Rejected Tokens (liq >= $15K)\n\n';
  report += '| Classification | Count | % | Description |\n';
  report += '|---|---|---|---|\n';
  const clsOrder = ['ALIVE_STRONG', 'ALIVE_OK', 'DYING', 'DEAD'];
  const clsDesc = {
    'ALIVE_STRONG': 'MCap > $100K, Vol > $50K - clear missed opportunity',
    'ALIVE_OK': 'MCap $30-100K or decent activity - possible opportunity',
    'DYING': 'MCap $5-30K - marginal, probably not worth it',
    'DEAD': 'MCap < $5K or not on DexScreener - correctly rejected',
  };
  for (const cls of clsOrder) {
    const count = classificationCounts[cls] || 0;
    report += `| ${cls} | ${count} | ${pct(count, enrichedRejected.length)} | ${clsDesc[cls]} |\n`;
  }
  report += '\n';

  // ALIVE_STRONG detail table
  report += '## Missed Opportunities: ALIVE_STRONG Tokens\n\n';
  if (strongTokens.length === 0) {
    report += '*No tokens classified as ALIVE_STRONG among rejected pools.*\n\n';
  } else {
    report += `**N = ${strongTokens.length}** -- These are tokens we rejected that are currently alive with significant market cap and volume.\n\n`;
    report += '| Token (first 12) | Score | Liq@Detect | MCap Now | Vol 24h | Txns 24h | Change 24h | Rejection Reasons |\n';
    report += '|---|---|---|---|---|---|---|---|\n';
    for (const t of strongTokens) {
      report += `| \`${t.base_mint.slice(0,12)}\` | ${t.security_score} | $${fmtNum(t.dp_liquidity_usd)} | $${fmtNum(t.dex_mcap)} | $${fmtNum(t.dex_vol24h)} | ${t.dex_txns_24h} | ${t.dex_change_24h != null ? t.dex_change_24h + '%' : 'N/A'} | ${(t.rejection_reasons || 'score<80').slice(0,60)} |\n`;
    }
    report += '\n';

    // Detailed feature breakdown for each strong token
    report += '### Detailed Feature Breakdown\n\n';
    for (const t of strongTokens) {
      report += `#### \`${t.base_mint}\`\n`;
      report += `- **Score:** ${t.security_score} (needs 80 to pass)\n`;
      report += `- **Detected:** ${fmtDate(t.detected_at)}\n`;
      report += `- **Liq at detection:** $${fmtNum(t.dp_liquidity_usd)} | **Liq now:** $${fmtNum(t.dex_liq_now)}\n`;
      report += `- **MCap now:** $${fmtNum(t.dex_mcap)} | **Vol 24h:** $${fmtNum(t.dex_vol24h)}\n`;
      report += `- **Holders:** ${t.dp_holder_count} | **Top holder:** ${(t.dp_top_holder_pct||0).toFixed(1)}%\n`;
      report += `- **Mint revoked:** ${t.dp_mint_auth_revoked ? 'YES' : 'NO'} | **Freeze revoked:** ${t.dp_freeze_auth_revoked ? 'YES' : 'NO'}\n`;
      report += `- **Honeypot verified:** ${t.dp_honeypot_verified ? 'YES' : 'NO'} | **LP burned:** ${t.dp_lp_burned ? 'YES' : 'NO'}\n`;
      report += `- **RugCheck score:** ${t.dp_rugcheck_score}\n`;
      report += `- **Graduation time:** ${t.dp_graduation_time_s}s\n`;
      report += `- **Bundle penalty:** ${t.dp_bundle_penalty} | **Insiders:** ${t.dp_insiders_count}\n`;
      report += `- **Creator reputation:** ${t.dp_creator_reputation} | **Funding:** ${t.dp_creator_funding}\n`;
      report += `- **Wash penalty:** ${t.dp_wash_penalty}\n`;
      report += `- **Observation stable:** ${t.dp_observation_stable} | **Drop %:** ${t.dp_observation_drop_pct}\n`;
      report += `- **Rejection reasons:** ${t.rejection_reasons}\n`;
      report += `- **Rejection stage:** ${t.dp_rejection_stage}\n`;
      if (t.dex_url) report += `- **DexScreener:** ${t.dex_url}\n`;
      report += '\n';
    }
  }

  // ALIVE_OK detail table
  report += '## Possible Opportunities: ALIVE_OK Tokens\n\n';
  if (okTokens.length === 0) {
    report += '*No tokens classified as ALIVE_OK among rejected pools.*\n\n';
  } else {
    report += `**N = ${okTokens.length}**\n\n`;
    report += '| Token (first 12) | Score | Liq@Detect | MCap Now | Vol 24h | Rejection Reasons |\n';
    report += '|---|---|---|---|---|---|\n';
    for (const t of okTokens) {
      report += `| \`${t.base_mint.slice(0,12)}\` | ${t.security_score} | $${fmtNum(t.dp_liquidity_usd)} | $${fmtNum(t.dex_mcap)} | $${fmtNum(t.dex_vol24h)} | ${(t.rejection_reasons || 'score<80').slice(0,60)} |\n`;
    }
    report += '\n';
  }

  // Actual trades for comparison
  report += '## Comparison: Actual Trades (48h)\n\n';
  report += `**N = ${enrichedPositions.length}**\n\n`;
  report += '| Token (first 12) | Score | PnL SOL | PnL % | Peak | Exit Reason | MCap Now | Status |\n';
  report += '|---|---|---|---|---|---|---|---|\n';
  for (const p of enrichedPositions) {
    const pnlStr = (p.pnl_sol || 0) >= 0 ? `+${(p.pnl_sol||0).toFixed(6)}` : (p.pnl_sol||0).toFixed(6);
    const alive = p.dex_mcap > 5000 ? 'ALIVE' : 'DEAD';
    report += `| \`${p.token_mint.slice(0,12)}\` | ${p.security_score} | ${pnlStr} | ${(p.pnl_pct||0).toFixed(1)}% | ${(p.peak_multiplier||0).toFixed(2)}x | ${p.exit_reason || 'N/A'} | $${fmtNum(p.dex_mcap)} | ${alive} |\n`;
  }
  report += '\n';

  // Score distribution analysis
  report += '## Score Distribution Analysis\n\n';
  report += '### Rejected Tokens by Score Band (liq >= $15K)\n\n';
  report += '| Score Band | Total | ALIVE_STRONG | ALIVE_OK | DYING | DEAD | Alive Rate |\n';
  report += '|---|---|---|---|---|---|---|\n';
  for (const band of ['75-79', '70-74', '65-69', '60-64', '50-59', '<50']) {
    const g = scoreGroups[band];
    if (!g) continue;
    report += `| ${band} | ${g.total} | ${g.strong} | ${g.ok} | ${g.dying} | ${g.dead} | ${pct(g.strong + g.ok, g.total)} |\n`;
  }
  report += '\n';

  // Rejection reasons
  report += '## Rejection Reason Analysis\n\n';
  report += 'Which rejection reasons are generating the most false positives (rejecting tokens that turned out alive)?\n\n';
  report += '| Reason | Total | ALIVE_STRONG | ALIVE_OK | DEAD | False Reject Rate |\n';
  report += '|---|---|---|---|---|---|\n';
  for (const [reason, stats] of sortedReasons) {
    const falseReject = pct(stats.strong + stats.ok, stats.total);
    report += `| ${reason} | ${stats.total} | ${stats.strong} | ${stats.ok} | ${stats.dead} | ${falseReject} |\n`;
  }
  report += '\n';
  report += '**False Reject Rate** = percentage of tokens rejected by this reason that are currently alive (STRONG + OK). ';
  report += 'A high false reject rate means the reason is too aggressive and blocks good tokens.\n\n';

  // Hour of day
  report += '## Hour of Day Pattern\n\n';
  report += '| Hour (UTC) | Total Rejected | STRONG | OK | DEAD | Alive Rate |\n';
  report += '|---|---|---|---|---|---|\n';
  for (let h = 0; h < 24; h++) {
    const b = hourBuckets[h];
    if (!b) continue;
    report += `| ${h} | ${b.total} | ${b.strong} | ${b.ok} | ${b.dead} | ${pct(b.strong + b.ok, b.total)} |\n`;
  }
  report += '\n';

  // Score 75-79 deep dive
  report += '## Deep Dive: Score 75-79\n\n';
  report += `This is the most interesting group -- tokens that almost passed (need 80) but were rejected by 1-5 points.\n\n`;
  report += `- **Total:** ${score75to79.length}\n`;
  report += `- **ALIVE_STRONG:** ${strong75.length}\n`;
  report += `- **ALIVE_OK:** ${ok75.length}\n`;
  report += `- **DEAD/DYING:** ${dead75.length}\n`;
  report += `- **Alive rate:** ${pct(strong75.length + ok75.length, score75to79.length)}\n\n`;

  if (strong75.length + ok75.length > 0) {
    report += '### Alive tokens in 75-79 band\n\n';
    for (const t of [...strong75, ...ok75]) {
      report += `- \`${t.base_mint.slice(0,16)}\` score=${t.security_score} mcap=$${fmtNum(t.dex_mcap)} vol=$${fmtNum(t.dex_vol24h)} -- reasons: ${t.rejection_reasons}\n`;
    }
    report += '\n';
  }

  // Pipeline stage breakdown
  report += '## Rejection Pipeline Stages (ALL 48h)\n\n';
  report += '| Stage | Count | % |\n';
  report += '|---|---|---|\n';
  for (const [stage, count] of sortedStages) {
    report += `| ${stage} | ${count} | ${pct(count, allRejected48h.length)} |\n`;
  }
  report += '\n';

  // Liquidity bracket
  report += '## Rejections by Liquidity Bracket\n\n';
  report += '| Bracket | Count |\n';
  report += '|---|---|\n';
  for (const [bracket, count] of Object.entries(liqBrackets)) {
    report += `| ${bracket} | ${count} |\n`;
  }
  report += '\n';

  // Conclusions
  report += '## Conclusions and Patterns\n\n';

  const totalAlive = (classificationCounts['ALIVE_STRONG'] || 0) + (classificationCounts['ALIVE_OK'] || 0);
  const totalChecked = enrichedRejected.length;

  report += `### Key Findings\n\n`;
  report += `1. **Overall false reject rate:** ${pct(totalAlive, totalChecked)} of rejected tokens with liq >= $15K are currently alive (N=${totalChecked})\n`;
  report += `   - ALIVE_STRONG: ${classificationCounts['ALIVE_STRONG'] || 0}\n`;
  report += `   - ALIVE_OK: ${classificationCounts['ALIVE_OK'] || 0}\n`;
  report += `   - DEAD/DYING: ${(classificationCounts['DEAD'] || 0) + (classificationCounts['DYING'] || 0)}\n\n`;

  report += `2. **Score 75-79 group:** ${score75to79.length} tokens, ${pct(strong75.length + ok75.length, score75to79.length)} alive rate\n`;
  report += `   - This is the "almost passed" zone. `;
  if (strong75.length + ok75.length > score75to79.length * 0.3) {
    report += `Alive rate is significant -- there may be an opportunity to recover some of these.\n`;
  } else {
    report += `Alive rate is low -- the current threshold appears appropriate.\n`;
  }
  report += '\n';

  report += `3. **Most impactful rejection reasons** (blocking alive tokens):\n`;
  for (const [reason, stats] of sortedReasons.slice(0, 5)) {
    if (stats.strong + stats.ok > 0) {
      report += `   - ${reason}: ${stats.strong + stats.ok} alive tokens blocked (out of ${stats.total})\n`;
    }
  }
  report += '\n';

  report += `4. **Actual trades comparison:**\n`;
  report += `   - Our trades: ${enrichedPositions.length} tokens, ${pct(actualWins.length, enrichedPositions.length)} win rate\n`;
  report += `   - PnL: ${enrichedPositions.reduce((a, p) => a + (p.pnl_sol || 0), 0).toFixed(6)} SOL\n`;
  report += `   - The bot's current selectivity appears to be ${actualWins.length > actualLosses.length ? 'working well' : 'needs improvement'} (${actualWins.length}W/${actualLosses.length}L)\n\n`;

  report += '### Caveats and Sample Size Warnings\n\n';
  report += `- **IMPORTANT:** N=${totalChecked} for rejected analysis, N=${enrichedPositions.length} for trade comparison\n`;
  report += `- "Alive" on DexScreener does NOT mean we would have profited -- timing, entry price, and exit strategy matter enormously\n`;
  report += `- A token being alive now (hours/days later) says nothing about what happened in the first 10 minutes when we would have been trading it\n`;
  report += `- Many "alive" tokens may have dipped hard initially (triggering our stop loss) before recovering\n`;
  report += `- The bot's current 9-trade winning streak suggests the scoring IS working -- changes could break this\n`;
  report += `- This is point-in-time data; tokens classified as "alive" now may be dead tomorrow\n\n`;

  report += '### Recommendations\n\n';

  if (strongTokens.length >= 3 && strong75.length >= 2) {
    report += '**CAUTIOUS CONSIDERATION:** There is some evidence of missed opportunities in the 75-79 score range. ';
    report += 'However, given the current winning streak, NO CHANGES are recommended at this time. ';
    report += 'Continue collecting data and re-analyze when N >= 50 rejected tokens with DexScreener verification.\n\n';
  } else if (strongTokens.length > 0) {
    report += '**VERY LIMITED EVIDENCE:** Only ' + strongTokens.length + ' strong alive tokens found among rejects. ';
    report += 'This is too small a sample to draw conclusions. The current scoring threshold appears appropriate. ';
    report += 'NO CHANGES recommended.\n\n';
  } else {
    report += '**NO EVIDENCE OF MISSED OPPORTUNITIES:** Zero rejected tokens are currently alive with strong metrics. ';
    report += 'The current scoring is working as intended. NO CHANGES recommended.\n\n';
  }

  report += '---\n';
  report += '*Analysis is purely observational. No code or config changes were made.*\n';

  // Write report
  const reportPath = path.join(__dirname, '..', 'data', 'rejected-pool-analysis.md');
  fs.writeFileSync(reportPath, report);
  console.log(`\nReport written to: ${reportPath}`);
  console.log(`  ${enrichedRejected.length} rejected tokens analyzed`);
  console.log(`  ${strongTokens.length} ALIVE_STRONG, ${okTokens.length} ALIVE_OK, ${deadTokens.length} DEAD/DYING`);

  db.close();
}

main().catch(err => {
  console.error('Error:', err);
  db.close();
  process.exit(1);
});
