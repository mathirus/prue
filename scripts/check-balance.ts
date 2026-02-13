import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { loadConfig } from '../src/config.js';
import { RpcManager } from '../src/core/rpc-manager.js';
import { Wallet } from '../src/core/wallet.js';

async function main() {
  const config = loadConfig();

  if (!config.wallet.privateKey) {
    console.error('PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const rpc = new RpcManager([config.rpc.url]);
  const wallet = new Wallet(config.wallet.privateKey);

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const balance = await wallet.getBalance(rpc.connection);
  console.log(`Balance: ${balance.toFixed(6)} SOL`);

  const tokens = await wallet.getTokenAccounts(rpc.connection);
  if (tokens.length > 0) {
    console.log(`\nToken Accounts (${tokens.length}):`);
    for (const token of tokens) {
      console.log(`  ${token.mint.toBase58()} => ${token.amount.toString()}`);
    }
  } else {
    console.log('\nNo token accounts found.');
  }
}

main().catch(console.error);
