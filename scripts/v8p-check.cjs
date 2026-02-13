const db = require('better-sqlite3')('data/bot.db');
const cutoff = Date.now() - 5 * 60 * 1000; // last 5 min

console.log('=== v8p DATA LOGGING CHECK ===\n');

// Check new columns on recent detected_pools
const pools = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN bot_version = 'v8p' THEN 1 ELSE 0 END) as v8p_count,
    SUM(CASE WHEN dp_rejection_stage IS NOT NULL THEN 1 ELSE 0 END) as has_stage,
    SUM(CASE WHEN dp_observation_stable IS NOT NULL THEN 1 ELSE 0 END) as has_obs,
    SUM(CASE WHEN dp_wash_concentration IS NOT NULL THEN 1 ELSE 0 END) as has_wash,
    SUM(CASE WHEN dp_creator_reputation IS NOT NULL THEN 1 ELSE 0 END) as has_creator
  FROM detected_pools WHERE detected_at > ?
`).get(cutoff);
console.log('Recent pools (last 5 min):', JSON.stringify(pools, null, 2));

// Show a few examples with new data
const examples = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, bot_version as ver,
    security_score as score, rejection_reasons as rej,
    dp_rejection_stage as stage,
    dp_observation_stable as obs_stable, ROUND(dp_observation_drop_pct,1) as obs_drop,
    dp_wash_concentration as wash_conc, dp_wash_same_amount_ratio as wash_same, dp_wash_penalty as wash_pen,
    dp_creator_reputation as creator_rep, dp_creator_funding as creator_fund
  FROM detected_pools WHERE detected_at > ? AND bot_version = 'v8p'
  ORDER BY detected_at DESC LIMIT 10
`).all(cutoff);

console.log('\nRecent v8p pools with new data:');
examples.forEach(r => {
  console.log(`  ${r.tok} | score=${r.score} | rej=${r.rej || '-'} | stage=${r.stage || '-'}`);
  if (r.obs_stable !== null) console.log(`    obs: stable=${r.obs_stable} drop=${r.obs_drop}%`);
  if (r.wash_conc !== null) console.log(`    wash: conc=${r.wash_conc}% same=${r.wash_same}% pen=${r.wash_pen}`);
  if (r.creator_rep !== null) console.log(`    creator: rep=${r.creator_rep} fund=${r.creator_fund}`);
});

// Check token_analysis for buy_error column
const taCheck = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN buy_attempted = 1 THEN 1 ELSE 0 END) as attempted,
    SUM(CASE WHEN buy_error IS NOT NULL THEN 1 ELSE 0 END) as has_error
  FROM token_analysis WHERE created_at > ? AND bot_version = 'v8p'
`).get(cutoff);
console.log('\nToken analysis (v8p):', JSON.stringify(taCheck, null, 2));

// Check positions for entry_latency_ms
const posCheck = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, entry_latency_ms, bot_version
  FROM positions WHERE bot_version = 'v8p'
  ORDER BY opened_at DESC LIMIT 5
`).all();
console.log('\nv8p positions with entry_latency:', posCheck.length > 0 ? JSON.stringify(posCheck) : 'none yet');

// Open positions
const open = db.prepare("SELECT COUNT(*) as n FROM positions WHERE status = 'open'").get();
console.log('\nOpen positions:', open.n);

db.close();
