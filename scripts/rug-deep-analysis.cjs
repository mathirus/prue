const db = require('better-sqlite3')('data/bot.db');

// DEEP ANALYSIS: Compare the rug C1sQrFF1 with similar-looking winners
console.log('=== TOKENS SIMILARES AL RUG (score=80, liq $50-60K) ===');
const similar = db.prepare(`
  SELECT d.base_mint, d.dp_graduation_time_s, d.dp_liquidity_usd, d.dp_holder_count,
         d.security_score, d.dp_observation_initial_sol, d.dp_observation_final_sol,
         d.dp_bundle_penalty, d.dp_insiders_count, d.dp_wash_concentration,
         d.dp_wash_same_amount_ratio, d.dp_wash_penalty,
         d.dp_creator_reputation, d.dp_creator_funding,
         d.dp_early_tx_count, d.dp_tx_velocity, d.dp_unique_slots,
         p.pnl_sol, p.exit_reason, p.peak_multiplier, p.entry_latency_ms
  FROM detected_pools d
  JOIN positions p ON p.token_mint = d.base_mint
  WHERE d.dp_liquidity_usd BETWEEN 40000 AND 70000
    AND d.security_score = 80
    AND p.status IN ('closed','stopped')
  ORDER BY p.opened_at DESC
`).all();

similar.forEach(t => {
  const isRug = t.exit_reason === 'rug_pull';
  console.log((isRug ? '💀 RUG ' : '✅ WIN ') + t.base_mint.slice(0, 8));
  console.log('  grad=' + t.dp_graduation_time_s + 's liq=$' + Math.round(t.dp_liquidity_usd / 1000) + 'K holders=' + t.dp_holder_count);
  console.log('  initSOL=' + t.dp_observation_initial_sol?.toFixed(1) + ' finalSOL=' + t.dp_observation_final_sol?.toFixed(1));
  console.log('  bundles=' + t.dp_bundle_penalty + ' insiders=' + t.dp_insiders_count);
  console.log('  wash: conc=' + t.dp_wash_concentration + ' same=' + t.dp_wash_same_amount_ratio + ' pen=' + t.dp_wash_penalty);
  console.log('  creator: rep=' + t.dp_creator_reputation + ' funding=' + t.dp_creator_funding);
  console.log('  early_tx=' + t.dp_early_tx_count + ' tx_vel=' + t.dp_tx_velocity + ' uniq_slots=' + t.dp_unique_slots);
  console.log('  latency=' + t.entry_latency_ms + 'ms pk=' + t.peak_multiplier?.toFixed(2) + 'x pnl=' + (t.pnl_sol * 1000).toFixed(1) + 'mSOL');
  console.log('');
});

// Rejected pools similar to rug
console.log('=== POOLS RECHAZADOS CON LIQ $40K+ (v8l+) ===');
const rejected = db.prepare(`
  SELECT base_mint, security_score, dp_liquidity_usd, dp_graduation_time_s,
         dp_holder_count, dp_observation_initial_sol, dp_rejection_stage,
         rejection_reasons, dp_bundle_penalty, dp_insiders_count
  FROM detected_pools
  WHERE security_passed = 0
    AND dp_liquidity_usd >= 40000
    AND bot_version IN ('v8l','v8m','v8n','v8o','v8p','v8q')
  ORDER BY detected_at DESC LIMIT 20
`).all();

console.log('Found:', rejected.length);
rejected.forEach(r => {
  console.log('  ' + r.base_mint.slice(0, 8) + ' score=' + r.security_score +
    ' liq=$' + Math.round(r.dp_liquidity_usd / 1000) + 'K' +
    ' grad=' + r.dp_graduation_time_s + 's' +
    ' holders=' + r.dp_holder_count +
    ' bundles=' + r.dp_bundle_penalty +
    ' insiders=' + r.dp_insiders_count +
    ' stage=' + r.dp_rejection_stage +
    ' reasons=' + (r.rejection_reasons || '').slice(0, 80));
});

// Key question: what if we check the creator wallet for the rug?
console.log('\n=== CREATOR DATA FOR RUG ===');
const creator = db.prepare(`
  SELECT * FROM token_creators WHERE token_mint LIKE 'C1sQrFF1%'
`).get();
if (creator) {
  console.log(JSON.stringify(creator, null, 2));
} else {
  console.log('No creator data found');
}

// Check if the rug creator made other tokens
if (creator) {
  const otherTokens = db.prepare(`
    SELECT token_mint, reputation_score, funding_source
    FROM token_creators WHERE creator_wallet = ?
  `).all(creator.creator_wallet);
  console.log('\nOther tokens by same creator:', otherTokens.length);
  otherTokens.forEach(t => console.log('  ' + t.token_mint.slice(0, 8) + ' rep=' + t.reputation_score + ' funding=' + t.funding_source));
}

// Overall rug rate by liquidity bracket (ALL trades, all versions)
console.log('\n=== RUG RATE BY LIQUIDITY (ALL TIME) ===');
const allTrades = db.prepare(`
  SELECT d.dp_liquidity_usd, p.pnl_sol, p.exit_reason
  FROM positions p
  JOIN detected_pools d ON d.base_mint = p.token_mint
  WHERE p.status IN ('closed','stopped')
    AND d.dp_liquidity_usd > 0
`).all();

const liqBuckets = [
  { label: '$15-25K', min: 15000, max: 25000 },
  { label: '$25-40K', min: 25000, max: 40000 },
  { label: '$40-60K', min: 40000, max: 60000 },
  { label: '$60-90K', min: 60000, max: 90000 },
  { label: '$90K+', min: 90000, max: 9999999 },
];
for (const b of liqBuckets) {
  const bucket = allTrades.filter(t => t.dp_liquidity_usd >= b.min && t.dp_liquidity_usd < b.max);
  if (bucket.length === 0) continue;
  const w = bucket.filter(t => t.pnl_sol > 0).length;
  const r = bucket.filter(t => t.exit_reason === 'rug_pull').length;
  const pnl = bucket.reduce((s, t) => s + t.pnl_sol, 0);
  console.log(b.label + ': N=' + bucket.length +
    ' win=' + Math.round(100 * w / bucket.length) + '%' +
    ' rug=' + Math.round(100 * r / bucket.length) + '%' +
    ' pnl=' + (pnl * 1000).toFixed(1) + 'mSOL' +
    ' avg=' + (pnl * 1000 / bucket.length).toFixed(1) + 'mSOL/trade');
}

// Rug speed: how fast did each rug lose all money?
console.log('\n=== RUG SPEED (time from buy to -100%) ===');
const rugs = db.prepare(`
  SELECT token_mint, opened_at, closed_at, peak_multiplier, sol_invested
  FROM positions WHERE exit_reason = 'rug_pull'
  ORDER BY opened_at DESC
`).all();
rugs.forEach(r => {
  const holdS = Math.round((r.closed_at - r.opened_at) / 1000);
  console.log('  ' + r.token_mint.slice(0, 8) + ' hold=' + holdS + 's pk=' + r.peak_multiplier?.toFixed(2) + 'x inv=' + (r.sol_invested * 1000).toFixed(0) + 'mSOL');
});

const avgHold = rugs.reduce((s, r) => s + (r.closed_at - r.opened_at), 0) / rugs.length / 1000;
console.log('Avg rug hold time: ' + avgHold.toFixed(0) + 's');

db.close();
