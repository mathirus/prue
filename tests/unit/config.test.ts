import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock environment before importing config
beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('should load default config values', async () => {
    vi.stubEnv('RPC_URL', 'https://test-rpc.example.com');
    vi.stubEnv('PRIVATE_KEY', 'test-key');

    // Dynamic import to get fresh module
    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.rpc.url).toBe('https://test-rpc.example.com');
    expect(config.risk.dryRun).toBe(true);
    expect(config.analysis.minScore).toBeGreaterThan(0);
    expect(config.position.takeProfit).toBeInstanceOf(Array);
  });

  it('should respect DRY_RUN env override', async () => {
    vi.stubEnv('RPC_URL', 'https://test-rpc.example.com');
    vi.stubEnv('PRIVATE_KEY', 'test-key');
    vi.stubEnv('DRY_RUN', 'false');

    const { loadConfig } = await import('../../src/config.js');
    const config = loadConfig();

    expect(config.risk.dryRun).toBe(false);
  });
});

describe('validateConfig', () => {
  it('should return errors for missing required fields', async () => {
    vi.stubEnv('RPC_URL', '');
    vi.stubEnv('PRIVATE_KEY', '');

    const { loadConfig, validateConfig } = await import('../../src/config.js');
    const config = loadConfig();
    const errors = validateConfig(config);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('RPC_URL'))).toBe(true);
  });
});
