const Database = require("better-sqlite3");
const db = new Database("data/bot.db");

// Check recent pools WITH observation_stable set
const pools = db.prepare(`
  SELECT id, substr(base_mint, 1, 8) as mint,
    dp_observation_initial_sol, dp_observation_final_sol,
    dp_observation_stable, dp_observation_drop_pct,
    datetime(detected_at/1000, 'unixepoch') as dt
  FROM detected_pools
  WHERE dp_observation_stable IS NOT NULL
  ORDER BY detected_at DESC
  LIMIT 10
`).all();
console.log("Recent pools WITH observation_stable set:");
console.table(pools);

// How many have stable set but initial_sol = null?
const broken = db.prepare(`
  SELECT COUNT(*) as cnt
  FROM detected_pools
  WHERE dp_observation_stable IS NOT NULL
  AND (dp_observation_initial_sol IS NULL OR dp_observation_initial_sol = 0)
`).get();
console.log("Pools with obs_stable set but initial_sol NULL/0:", broken);

// Check by date range
const byDate = db.prepare(`
  SELECT
    date(detected_at/1000, 'unixepoch') as day,
    COUNT(*) as total,
    SUM(CASE WHEN dp_observation_stable IS NOT NULL THEN 1 ELSE 0 END) as has_stable,
    SUM(CASE WHEN dp_observation_initial_sol > 0 THEN 1 ELSE 0 END) as has_reserve
  FROM detected_pools
  WHERE security_score > 0
  GROUP BY day
  ORDER BY day DESC
  LIMIT 7
`).all();
console.log("\nBy day (scored pools):");
console.table(byDate);

// Check most recent detected_pools that passed scoring for their observation data
const recentScored = db.prepare(`
  SELECT substr(base_mint, 1, 8) as mint, security_score,
    dp_observation_stable, dp_observation_initial_sol,
    dp_observation_drop_pct,
    datetime(detected_at/1000, 'unixepoch') as dt
  FROM detected_pools
  WHERE security_score >= 50
  ORDER BY detected_at DESC
  LIMIT 15
`).all();
console.log("\nLast 15 scored pools (score >= 50):");
console.table(recentScored);

db.close();
