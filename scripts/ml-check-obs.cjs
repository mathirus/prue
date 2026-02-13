const Database = require("better-sqlite3");
const db = new Database("data/bot.db");

// Check observation data availability for scored pools
const stats = db.prepare(`
  SELECT
    CASE WHEN dp_observation_initial_sol IS NOT NULL AND dp_observation_initial_sol > 0 THEN 'has_data' ELSE 'no_data' END as status,
    COUNT(*) as cnt,
    MIN(datetime(detected_at/1000, 'unixepoch')) as first_dt,
    MAX(datetime(detected_at/1000, 'unixepoch')) as last_dt
  FROM detected_pools
  WHERE security_score > 0
  GROUP BY status
`).all();
console.log("Observation data availability (pools with score > 0):");
console.table(stats);

// Last 5 pools with observation data
const lastObs = db.prepare(`
  SELECT substr(base_mint, 1, 8) as mint, dp_observation_initial_sol, dp_observation_final_sol,
    datetime(detected_at/1000, 'unixepoch') as dt
  FROM detected_pools
  WHERE dp_observation_initial_sol > 0
  ORDER BY detected_at DESC
  LIMIT 5
`).all();
console.log("\nLast 5 pools WITH observation data:");
console.table(lastObs);

// Check what the ML tree would see for the 2 missed rugs
// 5fmxTxm9 - rug, score 80
// 2ScVAQki - rug, score 72
const rugs = db.prepare(`
  SELECT
    substr(base_mint, 1, 8) as mint,
    dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
    dp_observation_initial_sol, dp_observation_final_sol,
    dp_observation_stable, dp_observation_drop_pct,
    security_score, dp_rugcheck_score
  FROM detected_pools
  WHERE base_mint LIKE '5fmxTxm9%' OR base_mint LIKE '2ScVAQki%'
`).all();
console.log("\nMissed rugs details:");
console.table(rugs);

// What features distinguish rugs from winners in last 20 positions?
const compare = db.prepare(`
  SELECT
    CASE
      WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%' THEN 'RUG'
      WHEN p.pnl_sol > 0 THEN 'WIN'
      ELSE 'LOSS'
    END as outcome,
    COUNT(*) as cnt,
    AVG(dp.dp_liquidity_usd) as avg_liq,
    AVG(dp.dp_holder_count) as avg_holders,
    AVG(dp.dp_top_holder_pct) as avg_top_holder,
    AVG(dp.dp_rugcheck_score) as avg_rugcheck
  FROM positions p
  LEFT JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.opened_at > (SELECT MAX(opened_at) - 86400000 FROM positions)
  GROUP BY outcome
`).all();
console.log("\nOutcome comparison (last 24h):");
console.table(compare);

db.close();
