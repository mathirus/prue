import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig } from '../src/config.js';
import { RpcManager } from '../src/core/rpc-manager.js';
import { WebSocketManager } from '../src/core/websocket-manager.js';
import { PoolDetector } from '../src/detection/pool-detector.js';
import { PumpFunMonitor } from '../src/detection/pumpfun-monitor.js';
import { PumpSwapMonitor } from '../src/detection/pumpswap-monitor.js';
import { botEmitter } from '../src/detection/event-emitter.js';
import { shortenAddress, solscanTx } from '../src/utils/helpers.js';
import type { DetectedPool } from '../src/types.js';

async function main() {
  console.log('=== Detection Test ===');
  console.log('Listening for new pools and migrations...');
  console.log('Press Ctrl+C to stop\n');

  const config = loadConfig();
  const rpc = new RpcManager([config.rpc.url], config.rpc.wsUrl);
  const ws = new WebSocketManager(rpc.primaryConnection, config.rpc.wsUrl);

  let count = 0;

  botEmitter.on('newPool', (pool: DetectedPool) => {
    count++;
    console.log(`\n[#${count}] NEW POOL`);
    console.log(`  Source: ${pool.source}`);
    console.log(`  Token:  ${pool.baseMint.toBase58()}`);
    console.log(`  Pool:   ${shortenAddress(pool.poolAddress)}`);
    console.log(`  TX:     ${solscanTx(pool.txSignature)}`);
    console.log(`  Time:   ${new Date(pool.detectedAt).toISOString()}`);
  });

  const detector = new PoolDetector(rpc.primaryConnection, ws);
  const pumpfun = new PumpFunMonitor(rpc.primaryConnection, ws);
  const pumpswap = new PumpSwapMonitor(rpc.primaryConnection, ws);

  await detector.start();
  await pumpfun.start();
  await pumpswap.start();

  ws.startHeartbeat();

  process.on('SIGINT', async () => {
    console.log(`\nDetected ${count} pools. Shutting down...`);
    await detector.stop();
    await pumpfun.stop();
    await pumpswap.stop();
    await ws.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
