const db = require('better-sqlite3')('data/bot.db');

// Simulate v8o scoring for recent $30K+ pools
console.log('=== SIMULATED v8o SCORES for $30K+ pools (last 6h) ===\n');

const PUMPSWAP_FALSE_POSITIVE_DANGERS = [
  'LP Unlocked', 'Single holder ownership', 'High ownership',
  'Top 10 holders high ownership', 'Low Liquidity',
  'Freeze Authority still enabled',
];

const pools = db.prepare(`
  SELECT dp.base_mint, dp.security_score as old_score, ROUND(dp.dp_liquidity_usd,0) as liq,
    dp.dp_holder_count as h, dp.dp_graduation_time_s as grad,
    dp.rejection_reasons as rej, dp.dp_insiders_count as ins,
    ta.freeze_authority_revoked as freeze, ta.mint_authority_revoked as mint,
    ta.honeypot_safe as hp, ta.lp_burned as lp, ta.rugcheck_score as rc,
    ta.top_holder_pct as top_h
  FROM detected_pools dp
  LEFT JOIN token_analysis ta ON dp.base_mint = ta.token_mint
  WHERE dp.detected_at > ? AND dp.dp_liquidity_usd >= 25000
  ORDER BY dp.detected_at DESC
`).all(Date.now() - 6 * 3600000);

console.log(`Found ${pools.length} pools with liq >= $25K in last 6h\n`);

let passCount = 0;
let total = 0;

pools.forEach(r => {
  total++;
  let score = 0;
  const penalties = [];
  const bonuses = [];

  // Base scoring
  if (r.freeze) { score += 20; bonuses.push('freeze+20'); }
  if (r.mint) { score += 20; bonuses.push('mint+20'); }
  score += 5; bonuses.push('hp_partial+5'); // PumpSwap always
  if (r.liq >= 30000) { score += 15; bonuses.push('liq+15'); }
  else if (r.liq >= 15000) { score += 5; bonuses.push('liq+5'); }

  // Holders (PumpSwap logic)
  if (r.top_h !== null) {
    const secondPct = r.top_h > 90 ? 100 - r.top_h : r.top_h;
    if (secondPct <= 50) { score += 15; bonuses.push('holders+15'); }
  }

  // LP (PumpSwap gets full)
  score += 10; bonuses.push('lp+10');

  // RugCheck bonus
  if (r.rc > 70) { score += 5; bonuses.push('rc+5'); }

  // v8o: Low holders - no penalty for $30K+
  if (r.liq < 30000 && r.h > 0 && r.h < 10) {
    score -= 15; penalties.push('low_h-15');
  }

  // Graduation (v8o: -5 instead of -15)
  if (r.grad > 0 && r.grad < 300) {
    score -= 5; penalties.push('grad-5');
  } else if (r.grad >= 300 && r.grad < 2700) {
    score += 5; bonuses.push('grad+5');
  }

  // Insiders
  if (r.ins >= 3) { score -= 100; penalties.push('ins3+-100'); }
  else if (r.ins > 0) { score -= 20; penalties.push('ins-20'); }

  score = Math.min(100, Math.max(0, score));
  const passed = score >= 80;
  if (passed) passCount++;

  const tok = r.base_mint.substring(0, 8);
  const gradStr = r.grad !== null && r.grad >= 0 ? Math.round(r.grad/60)+'min' : 'N/A';
  const status = passed ? 'PASS' : 'FAIL';

  console.log(`${status} | ${tok} | old=${r.old_score} → new=${score} | liq=$${r.liq} | h=${r.h} | grad=${gradStr} | ins=${r.ins||0}`);
  if (penalties.length) console.log(`       penalties: ${penalties.join(', ')}`);
});

console.log(`\n=== SUMMARY ===`);
console.log(`Total $25K+ pools: ${total}`);
console.log(`Would PASS v8o: ${passCount}/${total} (${Math.round(100*passCount/total)}%)`);
console.log(`Expected trades/hour: ~${(passCount / 6).toFixed(1)} (based on 6h sample)`);

db.close();
