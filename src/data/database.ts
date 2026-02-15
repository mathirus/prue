import Database from 'better-sqlite3';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

const DB_PATH = resolve(process.cwd(), 'data', 'bot.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    logger.info(`[db] Opened database at ${DB_PATH}`);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('[db] Database closed');
  }
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS detected_pools (
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
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id TEXT REFERENCES detected_pools(id),
      type TEXT NOT NULL CHECK(type IN ('buy', 'sell')),
      input_mint TEXT NOT NULL,
      output_mint TEXT NOT NULL,
      input_amount REAL NOT NULL,
      output_amount REAL NOT NULL,
      price_per_token REAL,
      fee REAL DEFAULT 0,
      tx_signature TEXT,
      slot INTEGER,
      status TEXT DEFAULT 'confirmed',
      error TEXT,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      token_mint TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      pool_id TEXT REFERENCES detected_pools(id),
      source TEXT NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL DEFAULT 0,
      peak_price REAL DEFAULT 0,
      token_amount REAL NOT NULL,
      sol_invested REAL NOT NULL,
      sol_returned REAL DEFAULT 0,
      pnl_sol REAL DEFAULT 0,
      pnl_pct REAL DEFAULT 0,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial_close', 'closed', 'stopped')),
      tp_levels_hit TEXT DEFAULT '[]',
      security_score INTEGER DEFAULT 0,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      updated_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS wallet_targets (
      address TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      max_copy_sol REAL DEFAULT 0.1,
      win_rate REAL,
      total_pnl REAL,
      trades_count INTEGER DEFAULT 0,
      added_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      total_pnl_sol REAL DEFAULT 0,
      total_volume_sol REAL DEFAULT 0,
      max_drawdown_pct REAL DEFAULT 0,
      starting_balance REAL DEFAULT 0,
      ending_balance REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS token_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_mint TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      source TEXT NOT NULL,
      score INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      mint_authority_revoked INTEGER,
      freeze_authority_revoked INTEGER,
      honeypot_safe INTEGER,
      liquidity_usd REAL,
      top_holder_pct REAL,
      holder_count INTEGER,
      honeypot_verified INTEGER,
      lp_burned INTEGER,
      rugcheck_score REAL,
      detection_latency_ms INTEGER,
      buy_attempted INTEGER DEFAULT 0,
      buy_succeeded INTEGER DEFAULT 0,
      final_pnl_pct REAL,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS token_creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_wallet TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      pool_address TEXT,
      outcome TEXT DEFAULT 'unknown' CHECK(outcome IN ('unknown', 'winner', 'loser', 'rug', 'breakeven')),
      pnl_pct REAL,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000),
      UNIQUE(creator_wallet, token_mint)
    );

    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,
      win_rate REAL,
      profit_factor REAL,
      total_trades INTEGER,
      total_pnl_sol REAL,
      avg_win_pct REAL,
      avg_loss_pct REAL,
      max_drawdown_pct REAL,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_token_analysis_score ON token_analysis(score);
    CREATE INDEX IF NOT EXISTS idx_token_analysis_pnl ON token_analysis(final_pnl_pct);
    CREATE INDEX IF NOT EXISTS idx_trades_pool ON trades(pool_id);
    CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(token_mint);
    CREATE INDEX IF NOT EXISTS idx_detected_pools_created ON detected_pools(detected_at);
    CREATE INDEX IF NOT EXISTS idx_token_creators_wallet ON token_creators(creator_wallet);
    CREATE INDEX IF NOT EXISTS idx_token_creators_mint ON token_creators(token_mint);
  `);

  // Migrate: add new columns to existing tables
  const migrations = [
    `ALTER TABLE token_analysis ADD COLUMN holder_count INTEGER`,
    `ALTER TABLE token_analysis ADD COLUMN honeypot_verified INTEGER`,
    `ALTER TABLE positions ADD COLUMN holder_count INTEGER`,
    `ALTER TABLE positions ADD COLUMN liquidity_usd REAL`,
    `ALTER TABLE detected_pools ADD COLUMN rejection_reasons TEXT`,
    // Phase 1: Creator deep check columns
    `ALTER TABLE token_creators ADD COLUMN funding_source TEXT`,
    `ALTER TABLE token_creators ADD COLUMN funding_source_hop2 TEXT`,
    `ALTER TABLE token_creators ADD COLUMN wallet_age_seconds INTEGER`,
    `ALTER TABLE token_creators ADD COLUMN tx_count INTEGER`,
    `ALTER TABLE token_creators ADD COLUMN sol_balance_lamports INTEGER`,
    `ALTER TABLE token_creators ADD COLUMN reputation_score INTEGER`,
    // ML training: individual scoring features on detected_pools (saved at detection time)
    `ALTER TABLE detected_pools ADD COLUMN dp_liquidity_usd REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_holder_count INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_top_holder_pct REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_honeypot_verified INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_mint_auth_revoked INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_freeze_auth_revoked INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_rugcheck_score REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_lp_burned INTEGER`,
    // Enrichment columns (added by enrich-pool-outcomes.cjs)
    `ALTER TABLE detected_pools ADD COLUMN pool_outcome TEXT`,
    `ALTER TABLE detected_pools ADD COLUMN current_sol_reserves INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN checked_at INTEGER`,
    // v8g: Detailed exit tracking columns for strategy optimization
    `ALTER TABLE positions ADD COLUMN exit_reason TEXT`,
    `ALTER TABLE positions ADD COLUMN peak_multiplier REAL`,
    `ALTER TABLE positions ADD COLUMN time_to_peak_ms INTEGER`,
    `ALTER TABLE positions ADD COLUMN sell_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN sell_successes INTEGER DEFAULT 0`,
    // v8j: Missed gains tracker - what happened AFTER we sold
    `ALTER TABLE positions ADD COLUMN post_sell_max_multiplier REAL`,
    `ALTER TABLE positions ADD COLUMN post_sell_max_usd REAL`,
    `ALTER TABLE positions ADD COLUMN post_sell_current_usd REAL`,
    `ALTER TABLE positions ADD COLUMN post_sell_check_count INTEGER DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN post_sell_last_check INTEGER`,
    // v8j: DexScreener complementary data (more reliable for 24h stats)
    `ALTER TABLE positions ADD COLUMN post_sell_dex_price_usd REAL`,
    `ALTER TABLE positions ADD COLUMN post_sell_dex_change_24h REAL`,
    `ALTER TABLE positions ADD COLUMN post_sell_dex_volume_24h REAL`,
    `ALTER TABLE positions ADD COLUMN post_sell_dex_fdv REAL`,
    // v8l: Graduation timing, bundle penalty, insiders count for scoring & ML
    `ALTER TABLE detected_pools ADD COLUMN dp_graduation_time_s INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_bundle_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_insiders_count INTEGER`,
    // v8l: ML classifier prediction data
    `ALTER TABLE token_analysis ADD COLUMN ml_prediction TEXT`,
    `ALTER TABLE token_analysis ADD COLUMN ml_confidence REAL`,
    // v8m: Bot version tracking for every trade and rejection
    `ALTER TABLE positions ADD COLUMN bot_version TEXT`,
    `ALTER TABLE detected_pools ADD COLUMN bot_version TEXT`,
    `ALTER TABLE token_analysis ADD COLUMN bot_version TEXT`,
    // v8p: Complete data logging for analysis
    // Observation window results
    `ALTER TABLE detected_pools ADD COLUMN dp_observation_stable INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_observation_drop_pct REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_observation_initial_sol REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_observation_final_sol REAL`,
    // Wash trading metrics
    `ALTER TABLE detected_pools ADD COLUMN dp_wash_concentration REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_wash_same_amount_ratio REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_wash_penalty INTEGER`,
    // Creator deep check results
    `ALTER TABLE detected_pools ADD COLUMN dp_creator_reputation INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_creator_funding TEXT`,
    // Pipeline rejection stage (security_check, creator, ml, observation, wash_trading, max_concurrent, circuit_breaker, balance)
    `ALTER TABLE detected_pools ADD COLUMN dp_rejection_stage TEXT`,
    // Entry timing: how long from detection to buy execution
    `ALTER TABLE positions ADD COLUMN entry_latency_ms INTEGER`,
    // Buy attempt tracking on token_analysis (distinguish "rejected" vs "approved but buy failed")
    `ALTER TABLE token_analysis ADD COLUMN buy_error TEXT`,
    // v8q: Early activity metrics (data collection for rug pattern analysis)
    `ALTER TABLE detected_pools ADD COLUMN dp_early_tx_count INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_tx_velocity INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_unique_slots INTEGER`,
    // v8r: Anti-rug comprehensive upgrade
    `ALTER TABLE detected_pools ADD COLUMN dp_insider_wallets TEXT`,
    `ALTER TABLE detected_pools ADD COLUMN dp_hidden_whale_count INTEGER`,
    `ALTER TABLE positions ADD COLUMN authority_reenabled INTEGER DEFAULT 0`,
    // v8u: Sell burst tracking — how many sells detected in burst window
    `ALTER TABLE positions ADD COLUMN sell_burst_count INTEGER DEFAULT 0`,
    // v8u: ML data tracking — aggregate sell events for feature engineering
    `ALTER TABLE positions ADD COLUMN total_sell_events INTEGER DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN max_sell_burst INTEGER DEFAULT 0`,
    // v8u: ML data tracking — sell count per price snapshot for time-series analysis
    `ALTER TABLE position_price_log ADD COLUMN sell_count INTEGER DEFAULT 0`,
    // v11o: Scoring breakdown — individual penalty/bonus tracking for backtesting
    `ALTER TABLE detected_pools ADD COLUMN dp_hhi_value REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_hhi_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_concentrated_value REAL`,
    `ALTER TABLE detected_pools ADD COLUMN dp_concentrated_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_holder_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_graduation_bonus INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_obs_bonus INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_organic_bonus INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_smart_wallet_bonus INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_creator_age_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_rugcheck_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_velocity_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_insider_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_whale_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_timing_cv_penalty INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_fast_score INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_deferred_delta INTEGER`,
    `ALTER TABLE detected_pools ADD COLUMN dp_final_score INTEGER`,
    // v11o: Post-buy HHI tracking — validate if HHI delta predicts outcomes
    `ALTER TABLE positions ADD COLUMN hhi_entry REAL`,
    `ALTER TABLE positions ADD COLUMN hhi_60s REAL`,
    `ALTER TABLE positions ADD COLUMN holder_count_60s INTEGER`,
    `ALTER TABLE positions ADD COLUMN concentrated_entry REAL`,
    `ALTER TABLE positions ADD COLUMN concentrated_60s REAL`,
  ];
  for (const sql of migrations) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  // Phase 1: Scammer blacklist table + funding source index
  database.exec(`
    CREATE TABLE IF NOT EXISTS scammer_blacklist (
      wallet TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      linked_rug_count INTEGER DEFAULT 0,
      added_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_token_creators_funding ON token_creators(funding_source);
  `);

  // v8q: Post-trade price checks at short intervals
  database.exec(`
    CREATE TABLE IF NOT EXISTS post_trade_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      check_label TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL,
      price_native REAL,
      market_cap REAL,
      liquidity_usd REAL,
      volume_24h REAL,
      txns_24h INTEGER,
      is_alive INTEGER DEFAULT 1,
      multiplier_vs_entry REAL,
      multiplier_vs_sell REAL,
      checked_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_post_trade_checks_position ON post_trade_checks(position_id);
    CREATE INDEX IF NOT EXISTS idx_post_trade_checks_mint ON post_trade_checks(token_mint);
  `);

  // v8q: Intra-trade price log (snapshots every ~10s while position is open)
  database.exec(`
    CREATE TABLE IF NOT EXISTS position_price_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id TEXT NOT NULL,
      price REAL NOT NULL,
      multiplier REAL NOT NULL,
      pnl_pct REAL,
      sol_reserve REAL,
      elapsed_ms INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_price_log_position ON position_price_log(position_id);
  `);

  // v9a: Shadow mode tables for ML data collection
  database.exec(`
    CREATE TABLE IF NOT EXISTS shadow_positions (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      source TEXT NOT NULL,
      security_score INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      entry_sol_reserve REAL,
      current_price REAL DEFAULT 0,
      peak_price REAL DEFAULT 0,
      min_price REAL DEFAULT 0,
      peak_multiplier REAL DEFAULT 1,
      time_to_peak_ms INTEGER DEFAULT 0,
      tp1_hit INTEGER DEFAULT 0,
      tp1_time_ms INTEGER,
      tp2_hit INTEGER DEFAULT 0,
      tp2_time_ms INTEGER,
      tp3_hit INTEGER DEFAULT 0,
      tp3_time_ms INTEGER,
      sl_hit INTEGER DEFAULT 0,
      sl_time_ms INTEGER,
      status TEXT DEFAULT 'tracking',
      exit_reason TEXT,
      final_multiplier REAL,
      total_polls INTEGER DEFAULT 0,
      rug_detected INTEGER DEFAULT 0,
      rug_reserve_drop_pct REAL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      bot_version TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_positions_pool ON shadow_positions(pool_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_positions_status ON shadow_positions(status);
    CREATE INDEX IF NOT EXISTS idx_shadow_positions_opened ON shadow_positions(opened_at);

    CREATE TABLE IF NOT EXISTS shadow_price_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shadow_id TEXT NOT NULL,
      price REAL NOT NULL,
      multiplier REAL NOT NULL,
      sol_reserve REAL,
      elapsed_ms INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_price_log_id ON shadow_price_log(shadow_id);

    CREATE TABLE IF NOT EXISTS pool_outcome_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      check_label TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL,
      price_native REAL,
      market_cap REAL,
      liquidity_usd REAL,
      volume_24h REAL,
      txns_24h INTEGER,
      is_alive INTEGER DEFAULT 1,
      checked_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_pool_outcome_pool ON pool_outcome_checks(pool_id);
    CREATE INDEX IF NOT EXISTS idx_pool_outcome_delay ON pool_outcome_checks(delay_minutes);
  `);

  // v9e: ML prediction columns for shadow positions
  try {
    database.exec(`ALTER TABLE shadow_positions ADD COLUMN ml_prediction TEXT`);
  } catch (_) { /* column already exists */ }
  try {
    database.exec(`ALTER TABLE shadow_positions ADD COLUMN ml_confidence REAL`);
  } catch (_) { /* column already exists */ }

  // v9f: Exit ML — sell pressure tracking in shadow price log
  const shadowPriceLogMigrations = [
    `ALTER TABLE shadow_price_log ADD COLUMN sell_count INTEGER DEFAULT 0`,
    `ALTER TABLE shadow_price_log ADD COLUMN cumulative_sell_count INTEGER DEFAULT 0`,
    `ALTER TABLE shadow_price_log ADD COLUMN exit_ml_prediction TEXT`,
    `ALTER TABLE shadow_price_log ADD COLUMN exit_ml_confidence REAL`,
  ];
  for (const sql of shadowPriceLogMigrations) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  // v9f: UNIQUE constraint on token_mint to definitively prevent duplicate shadow positions
  try {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_token_unique ON shadow_positions(token_mint)`);
  } catch { /* index already exists */ }

  // v8p: Real balance tracking
  database.exec(`
    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      balance_sol REAL NOT NULL,
      event TEXT NOT NULL,
      token_mint TEXT,
      pnl_sol REAL,
      bot_version TEXT,
      created_at INTEGER DEFAULT (unixepoch('now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_balance_snapshots_created ON balance_snapshots(created_at);
  `);
}
