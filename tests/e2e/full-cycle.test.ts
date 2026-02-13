import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { botEmitter } from '../../src/detection/event-emitter.js';
import type { DetectedPool, SecurityResult } from '../../src/types.js';

describe('Full Cycle E2E', () => {
  it('should emit newPool -> securityResult flow', async () => {
    const events: string[] = [];

    botEmitter.on('newPool', () => events.push('newPool'));
    botEmitter.on('securityResult', () => events.push('securityResult'));

    const mockPool: DetectedPool = {
      id: 'e2e-1',
      source: 'pumpswap',
      poolAddress: PublicKey.default,
      baseMint: PublicKey.default,
      quoteMint: PublicKey.default,
      baseDecimals: 6,
      quoteDecimals: 9,
      detectedAt: Date.now(),
      slot: 999,
      txSignature: 'e2e-sig',
    };

    const mockSecurity: SecurityResult = {
      mint: PublicKey.default,
      score: 75,
      passed: true,
      checks: {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        isHoneypot: false,
        liquidityUsd: 10000,
        liquiditySol: 50,
        topHolderPct: 10,
        lpBurned: true,
        lpLockedPct: 100,
      },
      timestamp: Date.now(),
    };

    botEmitter.emit('newPool', mockPool);
    botEmitter.emit('securityResult', mockSecurity);

    expect(events).toContain('newPool');
    expect(events).toContain('securityResult');

    botEmitter.removeAllListeners('newPool');
    botEmitter.removeAllListeners('securityResult');
  });

  it('should track position lifecycle events', () => {
    const events: string[] = [];

    botEmitter.on('positionOpened', () => events.push('opened'));
    botEmitter.on('positionUpdated', () => events.push('updated'));
    botEmitter.on('takeProfitHit', () => events.push('tp'));
    botEmitter.on('stopLossHit', () => events.push('sl'));
    botEmitter.on('positionClosed', () => events.push('closed'));

    // Simulate lifecycle
    botEmitter.emit('positionOpened', {} as any);
    botEmitter.emit('positionUpdated', {} as any);
    botEmitter.emit('takeProfitHit', {} as any, 0);
    botEmitter.emit('stopLossHit', {} as any);

    expect(events).toEqual(['opened', 'updated', 'tp', 'sl']);

    botEmitter.removeAllListeners('positionOpened');
    botEmitter.removeAllListeners('positionUpdated');
    botEmitter.removeAllListeners('takeProfitHit');
    botEmitter.removeAllListeners('stopLossHit');
    botEmitter.removeAllListeners('positionClosed');
  });
});
