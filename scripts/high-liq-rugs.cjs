const db = require('better-sqlite3')('data/bot.db');

// The 3 rugs with $50K+ liquidity that would pass v8o+v8p filters
const rugMints = ['8maf8gDM', 'YCf4w4tS', '9AJJJUP8'];

console.log('=== LOS 3 RUGS DE ALTA LIQUIDEZ ($50K+) ===\n');

rugMints.forEach(mint => {
  // Position data
  const pos = db.prepare(`
    SELECT token_mint, security_score, pnl_pct, pnl_sol, sol_invested, sol_returned,
      liquidity_usd, holder_count, exit_reason, peak_multiplier, opened_at, closed_at,
      time_to_peak_ms, bot_version, status
    FROM positions WHERE token_mint LIKE ?
  `).get(mint + '%');

  // Detected pool data
  const dp = db.prepare(`
    SELECT dp_liquidity_usd, dp_holder_count, dp_top_holder_pct, dp_honeypot_verified,
      dp_mint_auth_revoked, dp_freeze_auth_revoked, dp_rugcheck_score, dp_lp_burned,
      dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
      dp_observation_stable, dp_observation_drop_pct, dp_observation_initial_sol, dp_observation_final_sol,
      dp_wash_concentration, dp_wash_same_amount_ratio, dp_wash_penalty,
      dp_creator_reputation, dp_creator_funding, dp_rejection_stage
    FROM detected_pools WHERE base_mint LIKE ?
  `).get(mint + '%');

  // Token analysis
  const ta = db.prepare(`
    SELECT score, liquidity_usd, holder_count, top_holder_pct, rugcheck_score,
      honeypot_safe, honeypot_verified, mint_authority_revoked, freeze_authority_revoked,
      lp_burned, ml_prediction, ml_confidence
    FROM token_analysis WHERE token_mint LIKE ? ORDER BY created_at DESC LIMIT 1
  `).get(mint + '%');

  if (pos) {
    const dur = pos.closed_at ? ((pos.closed_at - pos.opened_at) / 1000).toFixed(0) : '?';
    console.log(`RUG: ${pos.token_mint.slice(0,8)}`);
    console.log(`  Score: ${pos.security_score} | PnL: ${pos.pnl_pct.toFixed(1)}% | Duration: ${dur}s`);
    console.log(`  Liq: $${Math.round(pos.liquidity_usd || 0)} | Holders: ${pos.holder_count || '?'}`);
    if (ta) {
      console.log(`  TA: score=${ta.score} liq=$${Math.round(ta.liquidity_usd||0)} holders=${ta.holder_count} top=${ta.top_holder_pct?.toFixed(1)}% rc=${ta.rugcheck_score} hp_safe=${ta.honeypot_safe} hp_verified=${ta.honeypot_verified} ml=${ta.ml_prediction}(${ta.ml_confidence})`);
    }
    if (dp) {
      console.log(`  DP: liq=$${Math.round(dp.dp_liquidity_usd||0)} holders=${dp.dp_holder_count} grad=${dp.dp_graduation_time_s}s insiders=${dp.dp_insiders_count} bundle=${dp.dp_bundle_penalty}`);
      console.log(`  DP: obs_stable=${dp.dp_observation_stable} obs_drop=${dp.dp_observation_drop_pct?.toFixed(1)}% wash_conc=${dp.dp_wash_concentration?.toFixed(2)} wash_same=${dp.dp_wash_same_amount_ratio?.toFixed(2)} wash_pen=${dp.dp_wash_penalty}`);
      console.log(`  DP: creator_rep=${dp.dp_creator_reputation} creator_funding=${dp.dp_creator_funding}`);
    }
    console.log();
  }
});

// Now show the 9 v8o+v8p winners for comparison
console.log('=== LOS 9 WINNERS v8o+v8p (comparación) ===\n');

const winners = db.prepare(`
  SELECT p.token_mint, p.security_score, p.pnl_pct, p.liquidity_usd, p.holder_count,
    dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_graduation_time_s, dp.dp_insiders_count,
    dp.dp_bundle_penalty, dp.dp_observation_stable, dp.dp_observation_drop_pct,
    dp.dp_wash_concentration, dp.dp_wash_same_amount_ratio, dp.dp_wash_penalty,
    dp.dp_creator_reputation, dp.dp_creator_funding,
    ta.rugcheck_score, ta.ml_prediction, ta.ml_confidence
  FROM positions p
  LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
  LEFT JOIN token_analysis ta ON ta.token_mint = p.token_mint
  WHERE p.bot_version IN ('v8o','v8p')
  GROUP BY p.token_mint
  ORDER BY p.opened_at ASC
`).all();

winners.forEach((t, i) => {
  console.log(`WIN ${i+1}: ${t.token_mint.slice(0,8)} | +${t.pnl_pct.toFixed(1)}%`);
  console.log(`  Liq: $${Math.round(t.dp_liquidity_usd||t.liquidity_usd||0)} | Holders: ${t.dp_holder_count||t.holder_count||'?'} | RC: ${t.rugcheck_score} | Grad: ${t.dp_graduation_time_s||'?'}s`);
  console.log(`  Obs: stable=${t.dp_observation_stable} drop=${t.dp_observation_drop_pct?.toFixed(1)}% | Wash: conc=${t.dp_wash_concentration?.toFixed(2)} same=${t.dp_wash_same_amount_ratio?.toFixed(2)} pen=${t.dp_wash_penalty}`);
  console.log(`  Creator: rep=${t.dp_creator_reputation} funding=${t.dp_creator_funding} | ML: ${t.ml_prediction}(${t.ml_confidence})`);
  console.log();
});

// Summary comparison table
console.log('=== TABLA COMPARATIVA ===\n');
console.log('Metrica          | Rugs $50K+   | Winners v8o+v8p');
console.log('-'.repeat(55));

// Calculate averages for each group
const rugData = rugMints.map(mint => {
  const dp = db.prepare(`SELECT dp_liquidity_usd, dp_graduation_time_s, dp_observation_drop_pct, dp_wash_concentration, dp_creator_reputation FROM detected_pools WHERE base_mint LIKE ?`).get(mint + '%');
  return dp || {};
});

const winData = winners.map(t => ({
  dp_liquidity_usd: t.dp_liquidity_usd,
  dp_graduation_time_s: t.dp_graduation_time_s,
  dp_observation_drop_pct: t.dp_observation_drop_pct,
  dp_wash_concentration: t.dp_wash_concentration,
  dp_creator_reputation: t.dp_creator_reputation
}));

function avg(arr, key) {
  const vals = arr.filter(a => a[key] != null).map(a => a[key]);
  return vals.length ? (vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(1) : 'N/A';
}

console.log(`Liquidez avg     | $${avg(rugData, 'dp_liquidity_usd')}    | $${avg(winData, 'dp_liquidity_usd')}`);
console.log(`Graduation (s)   | ${avg(rugData, 'dp_graduation_time_s')}       | ${avg(winData, 'dp_graduation_time_s')}`);
console.log(`Obs drop %       | ${avg(rugData, 'dp_observation_drop_pct')}       | ${avg(winData, 'dp_observation_drop_pct')}`);
console.log(`Wash concentr    | ${avg(rugData, 'dp_wash_concentration')}       | ${avg(winData, 'dp_wash_concentration')}`);
console.log(`Creator rep      | ${avg(rugData, 'dp_creator_reputation')}       | ${avg(winData, 'dp_creator_reputation')}`);

db.close();
