const {Connection,PublicKey,Keypair,VersionedTransaction}=require('@solana/web3.js');
const bs58=require('bs58');
require('dotenv').config();
const decode=bs58.decode||bs58.default?.decode;
const conn=new Connection(process.env.RPC_URL);
const wallet=Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));

async function sell(){
  const mint=process.argv[2];
  const amount=process.argv[3];
  if(!mint||!amount){console.error('Usage: node sell-quick.cjs <mint> <rawAmount>');process.exit(1);}
  const wsol='So11111111111111111111111111111111111111112';

  console.log('Selling',amount,'of',mint.slice(0,8)+'...');

  const quoteUrl='https://public.jupiterapi.com/quote?inputMint='+mint+'&outputMint='+wsol+'&amount='+amount+'&slippageBps=5000';
  const qRes=await fetch(quoteUrl);
  if(!qRes.ok){console.error('Quote failed:',qRes.status);return;}
  const quote=await qRes.json();
  console.log('Quote:',Number(quote.outAmount)/1e9,'SOL');

  const swapRes=await fetch('https://public.jupiterapi.com/swap',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      quoteResponse:quote,
      userPublicKey:wallet.publicKey.toBase58(),
      wrapAndUnwrapSol:true,
      dynamicComputeUnitLimit:true,
      prioritizationFeeLamports:'auto'
    })
  });
  if(!swapRes.ok){console.error('Swap failed:',swapRes.status,await swapRes.text());return;}
  const {swapTransaction}=await swapRes.json();

  const txBuf=Buffer.from(swapTransaction,'base64');
  const tx=VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sim=await conn.simulateTransaction(tx);
  if(sim.value.err){console.error('Sim failed:',JSON.stringify(sim.value.err));return;}
  console.log('Sim OK! Sending...');

  const sig=await conn.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});
  console.log('TX:',sig);

  try{
    const conf=await conn.confirmTransaction(sig,'confirmed');
    console.log(conf.value.err?'ERROR':'SUCCESS!');
  }catch(e){
    console.log('Confirm timeout, checking TX status...');
    const status=await conn.getSignatureStatus(sig);
    console.log('Status:',JSON.stringify(status.value));
  }

  const bal=await conn.getBalance(wallet.publicKey);
  console.log('Balance:',bal/1e9,'SOL');
}
sell().catch(e=>console.error('Error:',e.message));
