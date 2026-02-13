/**
 * Convert USDC and BONK to SOL via Jupiter API
 */
const { Connection, PublicKey, VersionedTransaction, Keypair } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');
require('dotenv').config();

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://public.jupiterapi.com';

const conn = new Connection(process.env.RPC_URL);
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const wallet = keypair.publicKey;

async function getBalance(mint) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet);
    const info = await conn.getTokenAccountBalance(ata);
    return { amount: info.value.amount, uiAmount: info.value.uiAmount, decimals: info.value.decimals };
  } catch {
    return { amount: '0', uiAmount: 0, decimals: 0 };
  }
}

async function swapToSol(inputMint, amount, label) {
  if (amount === '0' || amount === 0) {
    console.log(`[${label}] No balance to swap`);
    return;
  }

  console.log(`\n[${label}] Getting quote for ${amount} -> SOL...`);

  // Get quote
  const quoteUrl = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=500`;
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
  if (!quoteRes.ok) {
    console.error(`[${label}] Quote failed: HTTP ${quoteRes.status} ${await quoteRes.text()}`);
    return;
  }
  const quote = await quoteRes.json();
  const outSol = parseInt(quote.outAmount) / 1e9;
  console.log(`[${label}] Quote: ${quote.inAmount} -> ${quote.outAmount} (${outSol.toFixed(6)} SOL)`);

  // Get swap transaction - use fixed low priority fee (we have very little SOL)
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 10000,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!swapRes.ok) {
    console.error(`[${label}] Swap API failed: ${await swapRes.text()}`);
    return;
  }

  const swapData = await swapRes.json();

  // Sign and send with retries
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const rawTx = tx.serialize();
  console.log(`[${label}] Sending transaction (with retries)...`);

  // Send with maxRetries and preflight to catch errors early
  let sig;
  try {
    sig = await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 5 });
  } catch (e) {
    console.error(`[${label}] Send failed: ${e.message}`);
    return;
  }
  console.log(`[${label}] TX: ${sig}`);

  // Confirm with 60s timeout
  const blockhash = tx.message.recentBlockhash;
  try {
    const confirmation = await conn.confirmTransaction(
      { signature: sig, lastValidBlockHeight: swapData.lastValidBlockHeight, blockhash },
      'confirmed',
    );
    if (confirmation.value?.err) {
      console.error(`[${label}] TX failed:`, JSON.stringify(confirmation.value.err));
    } else {
      console.log(`[${label}] SUCCESS! Received ~${outSol.toFixed(6)} SOL`);
    }
  } catch (e) {
    console.error(`[${label}] Confirm error: ${e.message}`);
    // Final check
    await new Promise(r => setTimeout(r, 3000));
    const status = await conn.getSignatureStatus(sig);
    if (status.value?.confirmationStatus) {
      console.log(`[${label}] TX actually confirmed: ${status.value.confirmationStatus}`);
    } else {
      console.error(`[${label}] TX did not land`);
    }
  }
}

async function main() {
  const solBal = await conn.getBalance(wallet);
  console.log(`Wallet: ${wallet.toBase58()}`);
  console.log(`SOL balance: ${(solBal / 1e9).toFixed(6)} SOL`);

  const usdc = await getBalance(USDC_MINT);
  const bonk = await getBalance(BONK_MINT);
  console.log(`USDC: ${usdc.uiAmount} (${usdc.amount} raw)`);
  console.log(`BONK: ${bonk.uiAmount} (${bonk.amount} raw)`);

  // Swap USDC -> SOL first (bigger amount)
  if (parseInt(usdc.amount) > 0) {
    await swapToSol(USDC_MINT, usdc.amount, 'USDC→SOL');
  }

  // Small delay between swaps
  await new Promise(r => setTimeout(r, 2000));

  // Swap BONK -> SOL
  if (parseInt(bonk.amount) > 0) {
    await swapToSol(BONK_MINT, bonk.amount, 'BONK→SOL');
  }

  // Final balance
  await new Promise(r => setTimeout(r, 3000));
  const finalBal = await conn.getBalance(wallet);
  console.log(`\nFinal SOL balance: ${(finalBal / 1e9).toFixed(6)} SOL`);
  console.log(`Gained: ${((finalBal - solBal) / 1e9).toFixed(6)} SOL`);
}

main().catch(console.error);
