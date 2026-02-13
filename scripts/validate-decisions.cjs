#!/usr/bin/env node
/**
 * Validates bot decisions by checking current prices of recent tokens
 * Both rejected and bought
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

async function fetchDexScreener(mint) {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.pairs || data.pairs.length === 0) return null;
    // Get the most liquid pair
    const pair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      priceUsd: parseFloat(pair.priceUsd || 0),
      priceNative: parseFloat(pair.priceNative || 0),
      liqUsd: pair.liquidity?.usd || 0,
      fdv: pair.fdv || 0,
      volume24h: pair.volume?.h24 || 0,
      priceChange5m: pair.priceChange?.m5 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      txns5m: pair.txns?.m5 || {},
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      alive: true
    };
  } catch (e) {
    return null;
  }
}

async function main() {
  // Get rejected tokens from last 1 hour
  const rejected = db.prepare(`
    SELECT
      base_mint,
      pool_address,
      security_score,
      dp_rejection_stage,
      rejection_reasons,
      dp_liquidity_usd,
      dp_holder_count,
      dp_top_holder_pct,
      dp_graduation_time_s,
      dp_creator_reputation,
      dp_observation_stable,
      dp_observation_drop_pct,
      pool_outcome,
      detected_at
    FROM detected_pools
    WHERE detected_at > unixepoch() - 3600
    AND security_passed = 0
    AND base_mint IS NOT NULL
    ORDER BY detected_at DESC
  `).all();

  // Get bought tokens from last 2 hours
  const bought = db.prepare(`
    SELECT
      p.token_mint as base_mint,
      p.pool_address,
      p.security_score,
      p.pnl_sol,
      p.pnl_pct,
      p.exit_reason,
      p.peak_multiplier,
      p.status,
      p.sol_invested,
      p.sol_returned,
      p.opened_at as detected_at,
      d.dp_liquidity_usd,
      d.dp_graduation_time_s,
      d.dp_creator_reputation,
      d.dp_top_holder_pct,
      d.dp_holder_count,
      d.rejection_reasons
    FROM positions p
    LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
    WHERE p.opened_at > unixepoch() - 7200
    ORDER BY p.opened_at DESC
  `).all();

  // Also get tokens that PASSED security but weren't bought (max_concurrent, etc)
  const passedNotBought = db.prepare(`
    SELECT
      base_mint,
      pool_address,
      security_score,
      dp_rejection_stage,
      rejection_reasons,
      dp_liquidity_usd,
      dp_holder_count,
      dp_top_holder_pct,
      dp_graduation_time_s,
      dp_creator_reputation,
      pool_outcome,
      detected_at
    FROM detected_pools
    WHERE detected_at > unixepoch() - 3600
    AND security_passed = 1
    AND pool_address NOT IN (SELECT pool_address FROM positions WHERE pool_address IS NOT NULL)
    AND base_mint IS NOT NULL
    ORDER BY detected_at DESC
  `).all();

  console.log(`=== TOKENS TO CHECK ===`);
  console.log(`Rejected: ${rejected.length}`);
  console.log(`Bought: ${bought.length}`);
  console.log(`Passed but not bought: ${passedNotBought.length}`);

  // Check all prices
  const allTokens = [
    ...rejected.map(t => ({ ...t, category: 'REJECTED' })),
    ...bought.map(t => ({ ...t, category: t.pnl_sol > 0 ? 'BOUGHT_WIN' : 'BOUGHT_LOSS' })),
    ...passedNotBought.map(t => ({ ...t, category: 'PASSED_NOT_BOUGHT' })),
  ];

  // Deduplicate by mint
  const seen = new Set();
  const unique = allTokens.filter(t => {
    if (seen.has(t.base_mint)) return false;
    seen.add(t.base_mint);
    return true;
  });

  console.log(`\nChecking ${unique.length} unique tokens on DexScreener...\n`);

  // Batch check with small delays to avoid rate limits
  const results = [];
  for (const token of unique) {
    const price = await fetchDexScreener(token.base_mint);
    const ageMin = ((Date.now()/1000 - token.detected_at) / 60).toFixed(0);
    results.push({ ...token, price, ageMin });
    await new Promise(r => setTimeout(r, 300)); // rate limit respect
  }

  // Display results
  console.log('='.repeat(120));
  console.log('  REJECTED TOKENS — Should we have bought them?');
  console.log('='.repeat(120));

  const rejResults = results.filter(r => r.category === 'REJECTED');
  let missedOpportunities = 0;
  let correctRejections = 0;

  for (const r of rejResults) {
    const alive = r.price && r.price.alive && r.price.liqUsd > 100;
    const status = !alive ? 'DEAD/NO_LIQ' :
                   r.price.liqUsd > (r.dp_liquidity_usd || 0) * 1.2 ? 'GROWING' :
                   r.price.liqUsd > (r.dp_liquidity_usd || 0) * 0.5 ? 'STABLE' : 'DYING';

    if (alive && r.price.liqUsd > 5000) missedOpportunities++;
    else correctRejections++;

    const reasons = (r.rejection_reasons || '').substring(0, 60);
    console.log(
      `${r.base_mint.substring(0, 10)}.. | score=${String(r.security_score || '?').padStart(3)} | ` +
      `stage=${(r.dp_rejection_stage || '?').padEnd(15)} | ` +
      `detLiq=$${(r.dp_liquidity_usd || 0).toFixed(0).padStart(6)} | ` +
      `nowLiq=$${alive ? r.price.liqUsd.toFixed(0).padStart(6) : 'DEAD'.padStart(6)} | ` +
      `${status.padEnd(11)} | ${r.ageMin}min ago`
    );
    console.log(`  reasons: ${reasons}`);
  }

  console.log(`\nRejected summary: ${correctRejections} correct rejections, ${missedOpportunities} possible missed opportunities`);

  // Passed but not bought
  if (results.filter(r => r.category === 'PASSED_NOT_BOUGHT').length > 0) {
    console.log('\n' + '='.repeat(120));
    console.log('  PASSED SECURITY BUT NOT BOUGHT (max_concurrent, etc)');
    console.log('='.repeat(120));

    for (const r of results.filter(r => r.category === 'PASSED_NOT_BOUGHT')) {
      const alive = r.price && r.price.alive && r.price.liqUsd > 100;
      const status = !alive ? 'DEAD/NO_LIQ' :
                     r.price.liqUsd > (r.dp_liquidity_usd || 0) * 1.2 ? 'GROWING' :
                     r.price.liqUsd > (r.dp_liquidity_usd || 0) * 0.5 ? 'STABLE' : 'DYING';

      const stage = r.dp_rejection_stage || 'none';
      console.log(
        `${r.base_mint.substring(0, 10)}.. | score=${String(r.security_score || '?').padStart(3)} | ` +
        `stage=${stage.padEnd(15)} | ` +
        `detLiq=$${(r.dp_liquidity_usd || 0).toFixed(0).padStart(6)} | ` +
        `nowLiq=$${alive ? r.price.liqUsd.toFixed(0).padStart(6) : 'DEAD'.padStart(6)} | ` +
        `${status.padEnd(11)} | ${r.ageMin}min ago`
      );
    }
  }

  // Bought tokens
  console.log('\n' + '='.repeat(120));
  console.log('  BOUGHT TOKENS — Were the buys good decisions?');
  console.log('='.repeat(120));

  for (const r of results.filter(r => r.category.startsWith('BOUGHT'))) {
    const alive = r.price && r.price.alive && r.price.liqUsd > 100;
    const exitInfo = r.exit_reason || r.status;
    console.log(
      `${r.base_mint.substring(0, 10)}.. | score=${String(r.security_score || '?').padStart(3)} | ` +
      `pnl=${r.pnl_pct ? (r.pnl_pct > 0 ? '+' : '') + r.pnl_pct.toFixed(1) + '%' : r.status} | ` +
      `peak=${r.peak_multiplier ? r.peak_multiplier.toFixed(2) + 'x' : '?'} | ` +
      `nowLiq=$${alive ? r.price.liqUsd.toFixed(0).padStart(6) : 'DEAD'.padStart(6)} | ` +
      `exit=${exitInfo} | ${r.ageMin}min ago`
    );
    if (alive) {
      console.log(`  Still alive: price=$${r.price.priceUsd.toFixed(8)}, vol24h=$${r.price.volume24h.toFixed(0)}, fdv=$${r.price.fdv.toFixed(0)}`);
    }
  }

  db.close();
  console.log('\nValidation complete.');
}

main().catch(console.error);
