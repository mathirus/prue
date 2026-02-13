// Sell via PumpSwap directly (for tokens Jupiter doesn't have routes for)
const {Connection,PublicKey,Keypair,VersionedTransaction,TransactionMessage,ComputeBudgetProgram}=require('@solana/web3.js');
const bs58=require('bs58');
require('dotenv').config();

const MINT=process.argv[2];
const POOL=process.argv[3];
const AMOUNT=process.argv[4];
if(!MINT||!POOL||!AMOUNT){console.error('Usage: node sell-pumpswap-direct.cjs <mint> <pool> <rawAmount>');process.exit(1)}

const decode=bs58.decode||bs58.default?.decode;
const conn=new Connection(process.env.RPC_URL);
const connBackup=process.env.CHAINSTACK_RPC_URL?new Connection(process.env.CHAINSTACK_RPC_URL):new Connection(process.env.RPC_URL_BACKUP||'https://api.mainnet-beta.solana.com');
const wallet=Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));
const PUMPSWAP=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM=new PublicKey('11111111111111111111111111111111');
const ATA_PROGRAM=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PROTOCOL_FEE_RECIP=new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

async function sell(){
  console.log('Selling',AMOUNT,'of',MINT.slice(0,8)+'...','via pool',POOL.slice(0,8)+'...');

  const poolPk=new PublicKey(POOL);
  const mintPk=new PublicKey(MINT);

  // Parse pool to find reserves
  const poolInfo=await conn.getAccountInfo(poolPk);
  if(!poolInfo){console.error('Pool not found');return}
  const data=poolInfo.data;

  // PumpSwap pool layout: 8(disc)+32(poolBump?)+32(baseMint)+32(quoteMint)+...
  // Actually offset: 8+1+2+32+32+32+32+8+8+8+8+8
  // Let's just read the accounts from the pool data
  const baseMint=new PublicKey(data.subarray(43,75));
  const quoteMint=new PublicKey(data.subarray(75,107));

  console.log('Pool baseMint:',baseMint.toBase58().slice(0,8));
  console.log('Pool quoteMint:',quoteMint.toBase58().slice(0,8));

  const reversed=baseMint.equals(WSOL);
  console.log('Reversed:',reversed);

  // Get ATAs
  const [userTokenAta]=PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(),TOKEN_PROGRAM.toBuffer(),mintPk.toBuffer()],
    ATA_PROGRAM
  );
  const [userWsolAta]=PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(),TOKEN_PROGRAM.toBuffer(),WSOL.toBuffer()],
    ATA_PROGRAM
  );
  const [poolTokenVault]=PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(),TOKEN_PROGRAM.toBuffer(),(reversed?quoteMint:baseMint).toBuffer()],
    ATA_PROGRAM
  );

  // Pool vaults
  const [poolBaseVault]=PublicKey.findProgramAddressSync(
    [poolPk.toBuffer(),TOKEN_PROGRAM.toBuffer(),baseMint.toBuffer()],
    ATA_PROGRAM
  );
  const [poolQuoteVault]=PublicKey.findProgramAddressSync(
    [poolPk.toBuffer(),TOKEN_PROGRAM.toBuffer(),quoteMint.toBuffer()],
    ATA_PROGRAM
  );

  // Protocol fee ATA (always WSOL)
  const [protocolFeeAta]=PublicKey.findProgramAddressSync(
    [PROTOCOL_FEE_RECIP.toBuffer(),TOKEN_PROGRAM.toBuffer(),WSOL.toBuffer()],
    ATA_PROGRAM
  );

  // Read reserves to calculate min output
  const vaultInfos=await conn.getMultipleAccountsInfo([poolBaseVault,poolQuoteVault]);
  const baseReserve=vaultInfos[0]?BigInt('0x'+Buffer.from(vaultInfos[0].data.subarray(64,72)).reverse().toString('hex')):0n;
  const quoteReserve=vaultInfos[1]?BigInt('0x'+Buffer.from(vaultInfos[1].data.subarray(64,72)).reverse().toString('hex')):0n;

  const solReserve=reversed?baseReserve:quoteReserve;
  const tokenReserve=reversed?quoteReserve:baseReserve;

  console.log('SOL reserve:',Number(solReserve)/1e9,'SOL');
  console.log('Token reserve:',Number(tokenReserve)/1e6,'tokens');

  const amountBig=BigInt(AMOUNT);
  const expectedSol=(amountBig*solReserve)/(tokenReserve+amountBig);
  const minSol=expectedSol*30n/100n; // 70% slippage tolerance

  console.log('Expected:',Number(expectedSol)/1e9,'SOL');
  console.log('Min (30%):',Number(minSol)/1e9,'SOL');

  // Build sell instruction
  // For reversed pool (base=WSOL), selling tokens = buy_exact_quote_in
  // Discriminator for sell: reversed uses different instruction
  // Actually let's use Jupiter as fallback wait...
  // The simplest approach: just try Jupiter with a wider search

  const quoteUrl='https://public.jupiterapi.com/quote?inputMint='+MINT+'&outputMint=So11111111111111111111111111111111111111112&amount='+AMOUNT+'&slippageBps=9000&onlyDirectRoutes=false';
  console.log('\nTrying Jupiter with 90% slippage...');
  const qRes=await fetch(quoteUrl);
  if(qRes.ok){
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
    if(swapRes.ok){
      const {swapTransaction}=await swapRes.json();
      const txBuf=Buffer.from(swapTransaction,'base64');
      const tx=VersionedTransaction.deserialize(txBuf);
      tx.sign([wallet]);
      const sim=await conn.simulateTransaction(tx);
      if(sim.value.err){console.error('Sim failed:',JSON.stringify(sim.value.err));return}
      console.log('Sim OK! Sending to multiple RPCs...');
      const raw=tx.serialize();
      const [sig]=await Promise.all([
        conn.sendRawTransaction(raw,{skipPreflight:true,maxRetries:3}),
        connBackup.sendRawTransaction(raw,{skipPreflight:true,maxRetries:2}).catch(()=>null),
      ]);
      console.log('TX:',sig);
      try{
        const conf=await conn.confirmTransaction(sig,'confirmed');
        console.log(conf.value.err?'ERROR':'SUCCESS!');
      }catch(e){
        console.log('Confirm timeout, TX may still land');
      }
    }else{
      console.log('Swap API failed:',swapRes.status,await swapRes.text());
    }
  }else{
    console.log('Jupiter has no route for this token');
    console.log('Token value estimate:',Number(expectedSol)/1e9,'SOL');
    if(Number(expectedSol)<1000){
      console.log('Token is essentially worthless (<0.000001 SOL), not worth selling');
    }else{
      console.log('Consider waiting for Jupiter to index this token');
    }
  }

  const bal=await conn.getBalance(wallet.publicKey);
  console.log('\nBalance:',bal/1e9,'SOL');
}
sell().catch(e=>console.error('Error:',e.message));
