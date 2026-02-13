import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { getDb, closeDb } from '../../src/data/database.js';

afterAll(() => {
  closeDb();
});

describe('Database', () => {
  it('should initialize schema', () => {
    const db = getDb();
    expect(db).toBeDefined();

    // Check tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('detected_pools');
    expect(tableNames).toContain('trades');
    expect(tableNames).toContain('positions');
    expect(tableNames).toContain('wallet_targets');
    expect(tableNames).toContain('daily_stats');
  });

  it('should insert and query detected pools', () => {
    const db = getDb();
    const testId = `test-${Date.now()}`;

    db.prepare(`
      INSERT INTO detected_pools (id, source, pool_address, base_mint, quote_mint, slot, tx_signature, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testId, 'pumpswap', 'pool123', 'token123', 'wsol', 100, 'sig123', Date.now());

    const pool = db.prepare('SELECT * FROM detected_pools WHERE id = ?').get(testId) as Record<string, unknown>;
    expect(pool.source).toBe('pumpswap');
    expect(pool.base_mint).toBe('token123');
  });

  it('should insert and query trades', () => {
    const db = getDb();

    // Insert a pool first to satisfy FK constraint
    const poolId = `pool-${Date.now()}`;
    db.prepare(`
      INSERT INTO detected_pools (id, source, pool_address, base_mint, quote_mint, slot, tx_signature, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(poolId, 'pumpswap', 'pool-addr', 'token', 'wsol', 1, 'sig', Date.now());

    db.prepare(`
      INSERT INTO trades (pool_id, type, input_mint, output_mint, input_amount, output_amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(poolId, 'buy', 'wsol', 'token123', 0.1, 1000000);

    const trades = db.prepare('SELECT * FROM trades WHERE pool_id = ?').all(poolId) as Array<Record<string, unknown>>;
    expect(trades).toHaveLength(1);
    expect(trades[0].type).toBe('buy');
  });

  it('should insert and query positions', () => {
    const db = getDb();
    const posId = `pos-${Date.now()}`;

    db.prepare(`
      INSERT INTO positions (id, token_mint, pool_address, pool_id, source, entry_price, token_amount, sol_invested, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(posId, 'token123', 'pool123', null, 'pumpswap', 0.001, 1000000, 0.1, Date.now());

    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as Record<string, unknown>;
    expect(pos.source).toBe('pumpswap');
    expect(pos.status).toBe('open');
  });
});
