import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { PublicKey } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { RpcManager } from '../src/core/rpc-manager.js';
import { TokenScorer } from '../src/analysis/token-scorer.js';
import type { DetectedPool } from '../src/types.js';
import { WSOL_MINT } from '../src/constants.js';

async function main() {
  const mint = process.argv[2];
  if (!mint) {
    console.error('Usage: npx tsx scripts/test-analysis.ts <TOKEN_MINT_ADDRESS>');
    process.exit(1);
  }

  console.log(`=== Analyzing Token: ${mint} ===\n`);

  const config = loadConfig();
  const rpc = new RpcManager([config.rpc.url]);
  const scorer = new TokenScorer(rpc.connection, config);

  const mockPool: DetectedPool = {
    id: 'manual-test',
    source: 'raydium_amm_v4',
    poolAddress: new PublicKey(mint), // Will use mint as pool for testing
    baseMint: new PublicKey(mint),
    quoteMint: WSOL_MINT,
    baseDecimals: 6,
    quoteDecimals: 9,
    detectedAt: Date.now(),
    slot: 0,
    txSignature: '',
  };

  const result = await scorer.score(mockPool);

  console.log('\n=== RESULT ===');
  console.log(`Score: ${result.score}/100`);
  console.log(`Passed: ${result.passed}`);
  console.log('\nChecks:');
  console.log(`  Mint Authority Revoked: ${result.checks.mintAuthorityRevoked}`);
  console.log(`  Freeze Authority Revoked: ${result.checks.freezeAuthorityRevoked}`);
  console.log(`  Is Honeypot: ${result.checks.isHoneypot}`);
  console.log(`  Liquidity: $${result.checks.liquidityUsd.toFixed(2)} (${result.checks.liquiditySol.toFixed(4)} SOL)`);
  console.log(`  Top Holder: ${result.checks.topHolderPct.toFixed(2)}%`);
  console.log(`  LP Burned: ${result.checks.lpBurned} (${result.checks.lpLockedPct.toFixed(1)}%)`);
  if (result.checks.rugcheckScore !== undefined) {
    console.log(`  RugCheck Score: ${result.checks.rugcheckScore}`);
  }
  if (result.checks.rugcheckRisks?.length) {
    console.log(`  RugCheck Risks: ${result.checks.rugcheckRisks.join(', ')}`);
  }
}

main().catch(console.error);
