// Manual sell script for tokens stuck in wallet after failed sells
const {Connection, PublicKey, Transaction, Keypair, VersionedTransaction} = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config({path: '.env'});

const MINT = process.argv[2] || '2EsyLpp89dmu7XtbYNbxd4j9iZaKufEeNFEYxjzHY1X7';
const AMOUNT = process.argv[3] || '95249663827';

async function sellNow() {
  const decode = bs58.default ? bs58.default.decode : bs58.decode;
  const conn = new Connection(process.env.RPC_URL, 'confirmed');
  const wallet = Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));
  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Selling:', MINT.slice(0,8), 'amount:', AMOUNT);

  // Step 1: Get Jupiter quote
  const quoteUrl = `https://public.jupiterapi.com/quote?inputMint=${MINT}&outputMint=So11111111111111111111111111111111111111112&amount=${AMOUNT}&slippageBps=5000`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json();
  if (!quote.outAmount) {
    console.log('No quote:', JSON.stringify(quote).slice(0,200));
    return;
  }
  console.log('Quote:', (parseInt(quote.outAmount)/1e9).toFixed(6), 'SOL');

  // Step 2: Get swap TX
  const swapRes = await fetch('https://public.jupiterapi.com/swap', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 50000,
    }),
  });
  const swapData = await swapRes.json();
  if (swapData.error) {
    console.log('Swap error:', swapData.error);
    return;
  }

  // Step 3: Deserialize and sign
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  let sig;
  try {
    const vtx = VersionedTransaction.deserialize(txBuf);
    vtx.sign([wallet]);
    sig = await conn.sendRawTransaction(vtx.serialize(), {skipPreflight: true, maxRetries: 3});
  } catch(e) {
    console.log('Trying legacy TX format...');
    const tx = Transaction.from(txBuf);
    tx.sign(wallet);
    sig = await conn.sendRawTransaction(tx.serialize(), {skipPreflight: true, maxRetries: 3});
  }

  console.log('TX sent:', sig);
  console.log('https://solscan.io/tx/' + sig);

  // Step 4: Confirm
  const latest = await conn.getLatestBlockhash();
  try {
    const conf = await Promise.race([
      conn.confirmTransaction({signature: sig, ...latest}, 'confirmed'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
    ]);
    if (conf.value && conf.value.err) {
      console.log('TX FAILED:', JSON.stringify(conf.value.err));
    } else {
      console.log('SELL SUCCESS! Recovered ~', (parseInt(quote.outAmount)/1e9).toFixed(6), 'SOL');
    }
  } catch(e) {
    console.log('Confirm timeout, check solscan for:', sig);
  }
}

sellNow().catch(e => console.log('Fatal:', e.message));
