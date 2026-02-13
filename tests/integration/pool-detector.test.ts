import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { botEmitter } from '../../src/detection/event-emitter.js';
import type { DetectedPool } from '../../src/types.js';

describe('Pool Detection Events', () => {
  it('should emit newPool events correctly', () => {
    const received: DetectedPool[] = [];

    botEmitter.on('newPool', (pool) => {
      received.push(pool);
    });

    const mockPool: DetectedPool = {
      id: 'test-1',
      source: 'raydium_amm_v4',
      poolAddress: PublicKey.default,
      baseMint: PublicKey.default,
      quoteMint: PublicKey.default,
      baseDecimals: 6,
      quoteDecimals: 9,
      detectedAt: Date.now(),
      slot: 123456,
      txSignature: 'test-signature',
    };

    botEmitter.emit('newPool', mockPool);

    expect(received).toHaveLength(1);
    expect(received[0].source).toBe('raydium_amm_v4');
    expect(received[0].id).toBe('test-1');

    botEmitter.removeAllListeners('newPool');
  });

  it('should emit migration events', () => {
    const migrations: DetectedPool[] = [];

    botEmitter.on('migration', (pool) => {
      migrations.push(pool);
    });

    const mockPool: DetectedPool = {
      id: 'test-2',
      source: 'pumpswap',
      poolAddress: PublicKey.default,
      baseMint: PublicKey.default,
      quoteMint: PublicKey.default,
      baseDecimals: 6,
      quoteDecimals: 9,
      detectedAt: Date.now(),
      slot: 123457,
      txSignature: 'test-signature-2',
    };

    botEmitter.emit('migration', mockPool);

    expect(migrations).toHaveLength(1);
    expect(migrations[0].source).toBe('pumpswap');

    botEmitter.removeAllListeners('migration');
  });

  it('should emit error events', () => {
    const errors: Array<{ error: Error; context: string }> = [];

    botEmitter.on('error', (error, context) => {
      errors.push({ error, context });
    });

    botEmitter.emit('error', new Error('test error'), 'test-context');

    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe('test error');
    expect(errors[0].context).toBe('test-context');

    botEmitter.removeAllListeners('error');
  });
});
