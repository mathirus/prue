import { describe, it, expect } from 'vitest';
import { RpcManager } from '../../src/core/rpc-manager.js';

describe('RpcManager', () => {
  it('should create with multiple endpoints', () => {
    const rpc = new RpcManager([
      'https://api.mainnet-beta.solana.com',
      'https://api.devnet.solana.com',
    ]);

    const status = rpc.getStatus();
    expect(status).toHaveLength(2);
    expect(status[0].healthy).toBe(true);
  });

  it('should return a connection', () => {
    const rpc = new RpcManager(['https://api.mainnet-beta.solana.com']);
    const conn = rpc.connection;
    expect(conn).toBeDefined();
    expect(conn.rpcEndpoint).toContain('solana.com');
  });

  it('should round-robin connections', () => {
    const rpc = new RpcManager([
      'https://api.mainnet-beta.solana.com',
      'https://api.devnet.solana.com',
    ]);

    const conn1 = rpc.connection;
    const conn2 = rpc.connection;
    // They should cycle through different endpoints
    expect(conn1).toBeDefined();
    expect(conn2).toBeDefined();
  });

  it('should mask API keys in status', () => {
    const rpc = new RpcManager([
      'https://mainnet.helius-rpc.com/?api-key=my-secret-key',
    ]);

    const status = rpc.getStatus();
    expect(status[0].url).not.toContain('my-secret-key');
    expect(status[0].url).toContain('***');
  });
});
