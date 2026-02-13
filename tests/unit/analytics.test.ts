import { describe, it, expect } from 'vitest';

describe('Analytics', () => {
  it('should export getAnalytics function', async () => {
    const mod = await import('../../src/data/analytics.js');
    expect(typeof mod.getAnalytics).toBe('function');
    expect(typeof mod.getDailyPnl).toBe('function');
  });
});
