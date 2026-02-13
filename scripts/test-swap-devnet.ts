import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { Wallet } from '../src/core/wallet.js';
import { JupiterSwap } from '../src/execution/jupiter-swap.js';
import { WSOL_MINT, USDC_MINT } from '../src/constants.js';
import type { TradeOrder } from '../src/types.js';

async function main() {
  console.log('=== Swap Test (Devnet) ===\n');
  console.log('NOTE: Jupiter API works on mainnet only.');
  console.log('This test gets a quote but does NOT execute.\n');

  const config = loadConfig();

  if (!config.wallet.privateKey) {
    console.error('PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const connection = new Connection(config.rpc.url, 'confirmed');
  const wallet = new Wallet(config.wallet.privateKey);
  const jupiter = new JupiterSwap(connection, wallet);

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  const balance = await wallet.getBalance(connection);
  console.log(`Balance: ${balance.toFixed(6)} SOL\n`);

  // Test quote: 0.01 SOL -> USDC
  const testAmount = 0.01 * LAMPORTS_PER_SOL;

  console.log('Getting quote: 0.01 SOL -> USDC...');
  const quote = await jupiter.getQuote(WSOL_MINT, USDC_MINT, testAmount, 300);

  if (quote) {
    console.log(`  Input:  ${quote.inAmount} lamports`);
    console.log(`  Output: ${quote.outAmount} (USDC atomic units)`);
    console.log(`  Impact: ${quote.priceImpactPct}%`);
    console.log(`  Routes: ${(quote.routePlan as unknown[]).length}`);
    console.log('\nQuote OK! Jupiter API is working.');
  } else {
    console.log('  No quote available. Check RPC URL.');
  }

  console.log('\n(Swap NOT executed - test only)');
}

main().catch(console.error);
