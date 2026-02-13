// Manual sell v2 - with simulation and retry
const {Connection, PublicKey, VersionedTransaction, Keypair} = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config({path: '.env'});

const MINT = process.argv[2] || '2EsyLpp89dmu7XtbYNbxd4j9iZaKufEeNFEYxjzHY1X7';
const AMOUNT = process.argv[3] || '95249663827';

// Try multiple RPC endpoints
const RPCS = [
  process.env.RPC_URL,
  'https://mainnet.helius-rpc.com/?api-key=665d0029-8917-4237-a47c-6c317a4b8c88',
  'https://solana-mainnet.g.alchemy.com/v2/pNl-EuheAPvQ98tBgsGw1',
];

async function sellNow() {
  const decode = bs58.default ? bs58.default.decode : bs58.decode;
  const wallet = Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));
  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Selling:', MINT.slice(0,8), 'amount:', AMOUNT);

  // Step 1: Get Jupiter quote
  const quoteUrl = `https://public.jupiterapi.com/quote?inputMint=${MINT}&outputMint=So11111111111111111111111111111111111111112&amount=${AMOUNT}&slippageBps=5000`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json();
  if (!quote.outAmount) {
    console.log('No quote:', JSON.stringify(quote).slice(0,300));
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
      prioritizationFeeLamports: 100000,
    }),
  });
  const swapData = await swapRes.json();
  if (swapData.error) {
    console.log('Swap error:', swapData.error);
    return;
  }

  // Step 3: Deserialize and sign
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([wallet]);
  const rawTx = vtx.serialize();

  // Step 4: Simulate first
  for (const rpcUrl of RPCS) {
    if (!rpcUrl) continue;
    try {
      const conn = new Connection(rpcUrl, 'confirmed');
      const simResult = await conn.simulateTransaction(vtx, {replaceRecentBlockhash: true});
      if (simResult.value.err) {
        console.log('Sim FAILED on', rpcUrl.split('/')[2], ':', JSON.stringify(simResult.value.err));
        continue;
      }
      console.log('Sim OK on', rpcUrl.split('/')[2], '- sending...');

      // Step 5: Send to ALL endpoints simultaneously
      const sendPromises = RPCS.filter(Boolean).map(async url => {
        try {
          const c = new Connection(url, 'confirmed');
          const sig = await c.sendRawTransaction(rawTx, {skipPreflight: true, maxRetries: 5});
          return sig;
        } catch(e) {
          return null;
        }
      });

      const sigs = await Promise.all(sendPromises);
      const sig = sigs.find(s => s);
      if (!sig) {
        console.log('All sends failed');
        return;
      }

      console.log('TX sent:', sig);
      console.log('https://solscan.io/tx/' + sig);

      // Step 6: Confirm with longer timeout
      const latest = await conn.getLatestBlockhash();
      try {
        const conf = await Promise.race([
          conn.confirmTransaction({signature: sig, ...latest}, 'confirmed'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
        ]);
        if (conf.value && conf.value.err) {
          console.log('TX FAILED:', JSON.stringify(conf.value.err));
        } else {
          console.log('SELL SUCCESS! Recovered ~', (parseInt(quote.outAmount)/1e9).toFixed(6), 'SOL');
        }
      } catch(e) {
        console.log('Confirm timeout - check solscan');
      }
      return;
    } catch(e) {
      console.log('Error on', rpcUrl.split('/')[2], ':', e.message.slice(0,100));
    }
  }
  console.log('All RPCs failed');
}

sellNow().catch(e => console.log('Fatal:', e.message));
