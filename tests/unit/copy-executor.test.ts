import { describe, it, expect } from 'vitest';

describe('Copy Trading Modules', () => {
  it('should export WalletTracker class', async () => {
    const mod = await import('../../src/copy-trading/wallet-tracker.js');
    expect(mod.WalletTracker).toBeDefined();
  });

  it('should export analyzeWallet function', async () => {
    const mod = await import('../../src/copy-trading/wallet-analyzer.js');
    expect(typeof mod.analyzeWallet).toBe('function');
  });

  it('should export CopyExecutor class', async () => {
    const mod = await import('../../src/copy-trading/copy-executor.js');
    expect(mod.CopyExecutor).toBeDefined();
  });

  it('should export wallet-db functions', async () => {
    const mod = await import('../../src/copy-trading/wallet-db.js');
    expect(typeof mod.getAllWallets).toBe('function');
    expect(typeof mod.getWallet).toBe('function');
    expect(typeof mod.upsertWallet).toBe('function');
    expect(typeof mod.deleteWallet).toBe('function');
    expect(typeof mod.toggleWallet).toBe('function');
  });
});
