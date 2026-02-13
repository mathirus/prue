import { describe, it, expect } from 'vitest';

describe('Telegram Formatters', () => {
  it('should export format functions', async () => {
    const mod = await import('../../src/telegram/formatters.js');
    expect(typeof mod.formatDetection).toBe('function');
    expect(typeof mod.formatBuy).toBe('function');
    expect(typeof mod.formatSell).toBe('function');
    expect(typeof mod.formatPosition).toBe('function');
    expect(typeof mod.formatPositionsList).toBe('function');
    expect(typeof mod.formatStats).toBe('function');
    expect(typeof mod.formatBalance).toBe('function');
    expect(typeof mod.formatError).toBe('function');
  });

  it('should format balance correctly', async () => {
    const { formatBalance } = await import('../../src/telegram/formatters.js');
    const result = formatBalance(1.2345, '9xYz...abcd');
    expect(result).toContain('1.2345');
    expect(result).toContain('Wallet');
  });

  it('should format error correctly', async () => {
    const { formatError } = await import('../../src/telegram/formatters.js');
    const result = formatError('Something went wrong', 'test-context');
    expect(result).toContain('Error');
    expect(result).toContain('test-context');
    expect(result).toContain('Something went wrong');
  });

  it('should format empty positions list', async () => {
    const { formatPositionsList } = await import('../../src/telegram/formatters.js');
    const result = formatPositionsList([]);
    expect(result).toContain('No open positions');
  });
});
