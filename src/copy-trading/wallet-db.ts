import { PublicKey } from '@solana/web3.js';
import { getDb } from '../data/database.js';
import type { WalletTarget } from '../types.js';

export function getAllWallets(): WalletTarget[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM wallet_targets ORDER BY added_at DESC').all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    address: new PublicKey(String(row.address)),
    label: String(row.label),
    enabled: row.enabled === 1,
    maxCopySol: Number(row.max_copy_sol),
    winRate: row.win_rate as number | undefined,
    totalPnl: row.total_pnl as number | undefined,
    tradesCount: Number(row.trades_count ?? 0),
    addedAt: Number(row.added_at),
  }));
}

export function getWallet(address: string): WalletTarget | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM wallet_targets WHERE address = ?').get(address) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    address: new PublicKey(String(row.address)),
    label: String(row.label),
    enabled: row.enabled === 1,
    maxCopySol: Number(row.max_copy_sol),
    winRate: row.win_rate as number | undefined,
    totalPnl: row.total_pnl as number | undefined,
    tradesCount: Number(row.trades_count ?? 0),
    addedAt: Number(row.added_at),
  };
}

export function upsertWallet(target: WalletTarget): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO wallet_targets
    (address, label, enabled, max_copy_sol, win_rate, total_pnl, trades_count, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    target.address.toBase58(),
    target.label,
    target.enabled ? 1 : 0,
    target.maxCopySol,
    target.winRate ?? null,
    target.totalPnl ?? null,
    target.tradesCount ?? 0,
    target.addedAt,
  );
}

export function deleteWallet(address: string): void {
  const db = getDb();
  db.prepare('DELETE FROM wallet_targets WHERE address = ?').run(address);
}

export function toggleWallet(address: string, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE wallet_targets SET enabled = ? WHERE address = ?').run(enabled ? 1 : 0, address);
}
