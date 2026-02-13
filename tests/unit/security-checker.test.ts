import { describe, it, expect } from 'vitest';

describe('Security Checker', () => {
  it('should export checkAuthorities function', async () => {
    const mod = await import('../../src/analysis/security-checker.js');
    expect(typeof mod.checkAuthorities).toBe('function');
  });
});

describe('Honeypot Detector', () => {
  it('should export checkHoneypot function', async () => {
    const mod = await import('../../src/analysis/honeypot-detector.js');
    expect(typeof mod.checkHoneypot).toBe('function');
  });
});

describe('Holder Analyzer', () => {
  it('should export analyzeHolders function', async () => {
    const mod = await import('../../src/analysis/holder-analyzer.js');
    expect(typeof mod.analyzeHolders).toBe('function');
  });
});

describe('LP Checker', () => {
  it('should export checkLpStatus function', async () => {
    const mod = await import('../../src/analysis/lp-checker.js');
    expect(typeof mod.checkLpStatus).toBe('function');
  });
});

describe('RugCheck API', () => {
  it('should export fetchRugCheck function', async () => {
    const mod = await import('../../src/analysis/rugcheck-api.js');
    expect(typeof mod.fetchRugCheck).toBe('function');
  });
});
