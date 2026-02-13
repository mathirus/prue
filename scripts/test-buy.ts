/**
 * Test script: buy a token with Jupiter to verify the execution pipeline works.
 * Usage: npx tsx scripts/test-buy.ts <TOKEN_MINT> [AMOUNT_SOL]
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

const JUPITER_API = 'https://public.jupiterapi.com';
const WSOL = 'So11111111111111111111111111111111111111112';
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
];

async function main() {
  const tokenMint = process.argv[2];
  const amountSol = parseFloat(process.argv[3] || '0.01');

  if (!tokenMint) {
    console.error('Usage: npx tsx scripts/test-buy.ts <TOKEN_MINT> [AMOUNT_SOL]');
    process.exit(1);
  }

  const amountLamports = Math.floor(amountSol * 1e9);
  console.log(`Buying ${amountSol} SOL worth of ${tokenMint.slice(0, 8)}...`);

  // Load wallet
  const privateKey = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Connection
  const rpcUrl = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < amountLamports + 10_000_000) {
    console.error('Insufficient balance');
    process.exit(1);
  }

  // Step 1: Get Jupiter quote
  console.log('\n--- Step 1: Getting Jupiter quote ---');
  const quoteUrl = `${JUPITER_API}/quote?inputMint=${WSOL}&outputMint=${tokenMint}&amount=${amountLamports}&slippageBps=9500`;
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });

  if (!quoteRes.ok) {
    console.error(`Quote failed: HTTP ${quoteRes.status}`);
    const body = await quoteRes.text();
    console.error(body.slice(0, 300));
    process.exit(1);
  }

  const quote = await quoteRes.json() as any;
  console.log(`Quote: ${quote.inAmount} -> ${quote.outAmount}`);
  console.log(`Route: ${quote.routePlan?.map((r: any) => r.swapInfo?.label).join(' -> ')}`);
  console.log(`Price impact: ${quote.priceImpactPct}%`);

  // Step 2: Get swap transaction
  console.log('\n--- Step 2: Getting swap transaction ---');
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!swapRes.ok) {
    console.error(`Swap API failed: HTTP ${swapRes.status}`);
    const body = await swapRes.text();
    console.error(body.slice(0, 300));
    process.exit(1);
  }

  const swapData = await swapRes.json() as any;
  console.log('Got swap transaction!');

  // Step 3: Sign and send
  console.log('\n--- Step 3: Signing and sending ---');
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const rawTx = tx.serialize();
  const base58Tx = bs58.encode(rawTx);

  // Send to RPC + Jito in parallel
  const sendPromises: Promise<string | null>[] = [];

  // Primary RPC
  sendPromises.push(
    connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 2 })
      .catch(e => { console.log(`RPC send failed: ${e.message}`); return null; })
  );

  // Jito endpoints
  for (const url of JITO_ENDPOINTS) {
    sendPromises.push(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sendTransaction',
          params: [base58Tx, { encoding: 'base58' }],
        }),
        signal: AbortSignal.timeout(5000),
      })
        .then(async res => {
          const data = await res.json() as any;
          if (data.error) throw new Error(data.error.message);
          return data.result as string;
        })
        .catch(e => { console.log(`Jito failed: ${e.message}`); return null; })
    );
  }

  const results = await Promise.all(sendPromises);
  const sigs = results.filter((r): r is string => r !== null);

  if (sigs.length === 0) {
    console.error('ALL endpoints failed to accept TX');
    process.exit(1);
  }

  const sig = sigs[0];
  console.log(`TX sent to ${sigs.length} endpoints!`);
  console.log(`Signature: ${sig}`);
  console.log(`Solscan: https://solscan.io/tx/${sig}`);

  // Step 4: Wait for confirmation
  console.log('\n--- Step 4: Waiting for confirmation (30s timeout) ---');
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const confirmation = await Promise.race([
      connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Timeout 30s')), 30000)),
    ]);

    if (confirmation.value.err) {
      console.error(`TX FAILED on-chain: ${JSON.stringify(confirmation.value.err)}`);
    } else {
      console.log('\n✅ TX CONFIRMED! Token bought successfully!');
      const newBalance = await connection.getBalance(keypair.publicKey);
      console.log(`New balance: ${(newBalance / 1e9).toFixed(4)} SOL`);
    }
  } catch (e: any) {
    console.log(`Confirmation: ${e.message}`);
    console.log('Check the TX on Solscan to see if it succeeded.');
  }
}

main().catch(console.error);
