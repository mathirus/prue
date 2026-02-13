// Test that the UPSERT doesn't wipe observation data
const Database = require("better-sqlite3");
const db = new Database(":memory:");

// Create table with same schema
db.exec(`CREATE TABLE detected_pools (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  base_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  base_decimals INTEGER DEFAULT 0,
  quote_decimals INTEGER DEFAULT 9,
  lp_mint TEXT,
  security_score INTEGER,
  security_passed INTEGER,
  slot INTEGER,
  tx_signature TEXT,
  detected_at INTEGER NOT NULL,
  dp_liquidity_usd REAL,
  dp_holder_count INTEGER,
  dp_top_holder_pct REAL,
  dp_honeypot_verified INTEGER,
  dp_mint_auth_revoked INTEGER,
  dp_freeze_auth_revoked INTEGER,
  dp_rugcheck_score REAL,
  dp_lp_burned INTEGER,
  dp_graduation_time_s INTEGER,
  dp_bundle_penalty INTEGER,
  dp_insiders_count INTEGER,
  dp_early_tx_count INTEGER,
  dp_tx_velocity INTEGER,
  dp_unique_slots INTEGER,
  dp_insider_wallets TEXT,
  dp_hidden_whale_count INTEGER,
  bot_version TEXT,
  dp_observation_stable INTEGER,
  dp_observation_drop_pct REAL,
  dp_observation_initial_sol REAL,
  dp_observation_final_sol REAL,
  dp_wash_concentration REAL,
  dp_wash_same_amount_ratio REAL,
  dp_wash_penalty INTEGER,
  dp_creator_reputation INTEGER,
  dp_creator_funding TEXT,
  rejection_reasons TEXT,
  dp_rejection_stage TEXT
)`);

// Step 1: First INSERT (logDetection with fastSecurity)
db.prepare(`
  INSERT INTO detected_pools
  (id, source, pool_address, base_mint, quote_mint, detected_at,
   security_score, security_passed, dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
   dp_honeypot_verified, dp_mint_auth_revoked, dp_freeze_auth_revoked, dp_rugcheck_score,
   dp_lp_burned, dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
   dp_early_tx_count, dp_tx_velocity, dp_unique_slots, dp_insider_wallets, dp_hidden_whale_count, bot_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
   security_score = excluded.security_score,
   security_passed = excluded.security_passed,
   dp_liquidity_usd = excluded.dp_liquidity_usd,
   dp_holder_count = excluded.dp_holder_count,
   dp_top_holder_pct = excluded.dp_top_holder_pct,
   dp_honeypot_verified = excluded.dp_honeypot_verified,
   dp_mint_auth_revoked = excluded.dp_mint_auth_revoked,
   dp_freeze_auth_revoked = excluded.dp_freeze_auth_revoked,
   dp_rugcheck_score = excluded.dp_rugcheck_score,
   dp_lp_burned = excluded.dp_lp_burned,
   dp_graduation_time_s = excluded.dp_graduation_time_s,
   dp_bundle_penalty = excluded.dp_bundle_penalty,
   dp_insiders_count = excluded.dp_insiders_count,
   dp_early_tx_count = excluded.dp_early_tx_count,
   dp_tx_velocity = excluded.dp_tx_velocity,
   dp_unique_slots = excluded.dp_unique_slots,
   dp_insider_wallets = excluded.dp_insider_wallets,
   dp_hidden_whale_count = excluded.dp_hidden_whale_count,
   bot_version = excluded.bot_version
`).run('test-1', 'pumpswap', 'pool1', 'mint1', 'wsol', Date.now(),
  50, 0, 7000, 10, 80.5, 0, 1, 1, 100, 0, 120, 0, 0, 5, 10, 3, null, 0, 'v11g');

console.log("After first INSERT:");
console.log(db.prepare("SELECT security_score, dp_observation_initial_sol, dp_creator_reputation FROM detected_pools WHERE id='test-1'").get());

// Step 2: UPDATE observation data
db.prepare(`UPDATE detected_pools SET dp_observation_stable = ?, dp_observation_drop_pct = ?,
  dp_observation_initial_sol = ?, dp_observation_final_sol = ? WHERE id = ?`)
  .run(1, -2.5, 155.3, 159.2, 'test-1');

console.log("\nAfter observation UPDATE:");
console.log(db.prepare("SELECT security_score, dp_observation_initial_sol, dp_observation_final_sol, dp_observation_stable FROM detected_pools WHERE id='test-1'").get());

// Step 3: UPDATE creator deep
db.prepare("UPDATE detected_pools SET dp_creator_reputation = ?, dp_creator_funding = ? WHERE id = ?")
  .run(3, 'funder123', 'test-1');

console.log("\nAfter creator deep UPDATE:");
console.log(db.prepare("SELECT security_score, dp_observation_initial_sol, dp_creator_reputation, dp_creator_funding FROM detected_pools WHERE id='test-1'").get());

// Step 4: Second logDetection (UPSERT with final security score)
db.prepare(`
  INSERT INTO detected_pools
  (id, source, pool_address, base_mint, quote_mint, detected_at,
   security_score, security_passed, dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
   dp_honeypot_verified, dp_mint_auth_revoked, dp_freeze_auth_revoked, dp_rugcheck_score,
   dp_lp_burned, dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
   dp_early_tx_count, dp_tx_velocity, dp_unique_slots, dp_insider_wallets, dp_hidden_whale_count, bot_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
   security_score = excluded.security_score,
   security_passed = excluded.security_passed,
   dp_liquidity_usd = excluded.dp_liquidity_usd,
   dp_holder_count = excluded.dp_holder_count,
   dp_top_holder_pct = excluded.dp_top_holder_pct,
   dp_honeypot_verified = excluded.dp_honeypot_verified,
   dp_mint_auth_revoked = excluded.dp_mint_auth_revoked,
   dp_freeze_auth_revoked = excluded.dp_freeze_auth_revoked,
   dp_rugcheck_score = excluded.dp_rugcheck_score,
   dp_lp_burned = excluded.dp_lp_burned,
   dp_graduation_time_s = excluded.dp_graduation_time_s,
   dp_bundle_penalty = excluded.dp_bundle_penalty,
   dp_insiders_count = excluded.dp_insiders_count,
   dp_early_tx_count = excluded.dp_early_tx_count,
   dp_tx_velocity = excluded.dp_tx_velocity,
   dp_unique_slots = excluded.dp_unique_slots,
   dp_insider_wallets = excluded.dp_insider_wallets,
   dp_hidden_whale_count = excluded.dp_hidden_whale_count,
   bot_version = excluded.bot_version
`).run('test-1', 'pumpswap', 'pool1', 'mint1', 'wsol', Date.now(),
  75, 1, 9500, 15, 72.3, 0, 1, 1, 100, 0, 120, 0, 0, 8, 15, 4, null, 0, 'v11h');

console.log("\nAfter UPSERT (second logDetection with updated security):");
const final = db.prepare("SELECT security_score, dp_observation_initial_sol, dp_observation_final_sol, dp_observation_stable, dp_creator_reputation, dp_creator_funding, dp_holder_count, bot_version FROM detected_pools WHERE id='test-1'").get();
console.log(final);

// Verify
let passed = true;
if (final.security_score !== 75) { console.log("FAIL: security_score should be 75 (updated)"); passed = false; }
if (final.dp_observation_initial_sol !== 155.3) { console.log("FAIL: dp_observation_initial_sol should be 155.3 (preserved)"); passed = false; }
if (final.dp_observation_final_sol !== 159.2) { console.log("FAIL: dp_observation_final_sol should be 159.2 (preserved)"); passed = false; }
if (final.dp_observation_stable !== 1) { console.log("FAIL: dp_observation_stable should be 1 (preserved)"); passed = false; }
if (final.dp_creator_reputation !== 3) { console.log("FAIL: dp_creator_reputation should be 3 (preserved)"); passed = false; }
if (final.dp_creator_funding !== 'funder123') { console.log("FAIL: dp_creator_funding should be funder123 (preserved)"); passed = false; }
if (final.dp_holder_count !== 15) { console.log("FAIL: dp_holder_count should be 15 (updated)"); passed = false; }
if (final.bot_version !== 'v11h') { console.log("FAIL: bot_version should be v11h (updated)"); passed = false; }

if (passed) {
  console.log("\n✅ ALL TESTS PASSED — UPSERT preserves observation/creator data while updating security");
} else {
  console.log("\n❌ TESTS FAILED");
  process.exit(1);
}

db.close();
