import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS } from '../../src/constants.js';

describe('Transaction Builder', () => {
  it('should export TransactionBuilder class', async () => {
    const mod = await import('../../src/execution/transaction-builder.js');
    expect(mod.TransactionBuilder).toBeDefined();
  });

  it('should have valid Jito tip accounts', () => {
    expect(JITO_TIP_ACCOUNTS.length).toBeGreaterThan(0);
    for (const account of JITO_TIP_ACCOUNTS) {
      expect(account).toBeInstanceOf(PublicKey);
    }
  });
});

describe('JitoBundler', () => {
  it('should export JitoBundler class', async () => {
    const mod = await import('../../src/execution/jito-bundler.js');
    expect(mod.JitoBundler).toBeDefined();
  });
});

describe('MultiSender', () => {
  it('should export MultiSender class', async () => {
    const mod = await import('../../src/execution/multi-sender.js');
    expect(mod.MultiSender).toBeDefined();
  });
});
