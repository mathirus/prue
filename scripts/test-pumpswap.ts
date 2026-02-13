/**
 * Test script: buy a pump.fun token via PumpSwap direct swap.
 * Usage: npx tsx scripts/test-pumpswap.ts <TOKEN_MINT> [AMOUNT_SOL]
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

// Import PumpSwap swap class
import { PumpSwapSwap } from '../src/execution/pumpswap-swap.js';

class SimpleWallet {
  public readonly keypair: Keypair;
  public readonly publicKey: PublicKey;

  constructor(privateKeyBase58: string) {
    this.keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.publicKey = this.keypair.publicKey;
  }
}

async function main() {
  const tokenMint = process.argv[2];
  const amountSol = parseFloat(process.argv[3] || '0.005');

  if (!tokenMint) {
    console.error('Usage: npx tsx scripts/test-pumpswap.ts <TOKEN_MINT> [AMOUNT_SOL]');
    process.exit(1);
  }

  const amountLamports = Math.floor(amountSol * 1e9);
  console.log(`\n=== PumpSwap Direct Swap Test ===`);
  console.log(`Token: ${tokenMint}`);
  console.log(`Amount: ${amountSol} SOL (${amountLamports} lamports)`);

  // Load wallet
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  const wallet = new SimpleWallet(privateKey);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Connection
  const rpcUrl = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < amountLamports + 10_000_000) {
    console.error('Insufficient balance');
    process.exit(1);
  }

  // Derive pool address
  const mint = new PublicKey(tokenMint);
  const poolAddress = PumpSwapSwap.derivePoolAddress(mint);
  console.log(`\nDerived pool: ${poolAddress.toBase58()}`);

  // Check if pool exists
  const poolAccount = await connection.getAccountInfo(poolAddress);
  if (!poolAccount) {
    console.error('Pool account does NOT exist! Token may not have migrated to PumpSwap.');
    process.exit(1);
  }
  console.log(`Pool exists! Size: ${poolAccount.data.length} bytes, Owner: ${poolAccount.owner.toBase58()}`);

  // Create PumpSwap instance
  const pumpSwap = new PumpSwapSwap(connection, wallet as any);

  // Execute buy
  console.log(`\n--- Executing PumpSwap buy (${amountSol} SOL, 95% slippage) ---`);
  const startTime = Date.now();
  const result = await pumpSwap.buy(mint, amountLamports, 9500);
  const elapsed = Date.now() - startTime;

  console.log(`\n--- Result (${elapsed}ms) ---`);
  if (result.success) {
    console.log(`✅ SUCCESS!`);
    console.log(`TX: https://solscan.io/tx/${result.txSignature}`);
    console.log(`Input: ${result.inputAmount} lamports (${result.inputAmount / 1e9} SOL)`);
    console.log(`Output: ${result.outputAmount} token lamports`);
    console.log(`Price: ${result.pricePerToken} SOL per token lamport`);
  } else {
    console.log(`❌ FAILED: ${result.error}`);
  }

  const newBalance = await connection.getBalance(wallet.publicKey);
  console.log(`\nNew balance: ${(newBalance / 1e9).toFixed(4)} SOL`);
}

main().catch(console.error);
