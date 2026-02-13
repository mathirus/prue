import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

async function testBuy() {
    console.log('=== TEST DE COMPRA ===');

    const connection = new Connection(process.env.RPC_URL!);
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

    console.log('Wallet:', keypair.publicKey.toBase58());
    const balance = await connection.getBalance(keypair.publicKey);
    console.log('Balance:', balance / 1e9, 'SOL');

    const params = new URLSearchParams({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '10000000', // 0.01 SOL
        slippageBps: '500'
    });

    console.log('\nObteniendo quote de Jupiter...');
    const quoteRes = await fetch('https://public.jupiterapi.com/quote?' + params);
    const quote = await quoteRes.json();

    if (quote.error) {
        console.log('Error en quote:', quote.error);
        return;
    }

    console.log('Quote OK:', Number(quote.inAmount)/1e9, 'SOL ->', Number(quote.outAmount)/1e6, 'USDC');

    console.log('\nObteniendo TX de swap...');
    const swapRes = await fetch('https://public.jupiterapi.com/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: keypair.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto'
        })
    });

    if (!swapRes.ok) {
        console.log('Swap API error:', await swapRes.text());
        return;
    }

    const swapData = await swapRes.json();
    console.log('Swap TX recibida');

    console.log('\nFirmando y enviando...');
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2
    });

    console.log('TX enviada:', sig);
    console.log('https://solscan.io/tx/' + sig);

    console.log('\nEsperando confirmacion...');
    const latestBlock = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlock.blockhash,
        lastValidBlockHeight: latestBlock.lastValidBlockHeight
    }, 'confirmed');

    if (confirmation.value.err) {
        console.log('TX fallo:', JSON.stringify(confirmation.value.err));
    } else {
        console.log('COMPRA EXITOSA!');
        const newBalance = await connection.getBalance(keypair.publicKey);
        console.log('Nuevo balance:', newBalance / 1e9, 'SOL');
    }
}

testBuy().catch(e => console.error('Error:', e.message));
