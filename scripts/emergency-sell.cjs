const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();
const bs58 = require('bs58').default || require('bs58');

async function main() {
  const mint = new PublicKey(process.argv[2] || 'CraPQ4thPxS62tDimmTwnMFFRbLfaHbJeBebvrHQv4HE');
  const conn = new Connection(process.env.CHAINSTACK_RPC_URL || process.env.RPC_URL);
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

  const bal = await conn.getTokenAccountBalance(ata);
  console.log('Balance:', bal.value.uiAmount, 'tokens (', bal.value.amount, 'raw)');
  if (bal.value.uiAmount === 0) { console.log('No tokens to sell'); return; }

  const amount = bal.value.amount;
  const url = `https://public.jupiterapi.com/quote?inputMint=${mint.toBase58()}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=5000`;
  console.log('Getting Jupiter quote...');
  const resp = await fetch(url);
  if (!resp.ok) { console.log('Quote failed:', resp.status, await resp.text()); return; }
  const quote = await resp.json();
  console.log('Quote: out=', quote.outAmount, 'lamports (', Number(quote.outAmount) / 1e9, 'SOL)');

  const swapResp = await fetch('https://public.jupiterapi.com/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: { autoMultiplier: 2 }
    })
  });
  if (!swapResp.ok) { console.log('Swap failed:', swapResp.status, await swapResp.text()); return; }
  const swapData = await swapResp.json();

  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  console.log('Sending TX...');
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  console.log('TX sent:', sig);

  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) {
    console.log('TX FAILED:', JSON.stringify(conf.value.err));
  } else {
    console.log('SUCCESS! Sold', bal.value.uiAmount, 'tokens');
    console.log('https://solscan.io/tx/' + sig);
  }
}
main().catch(e => console.error('Error:', e.message));
