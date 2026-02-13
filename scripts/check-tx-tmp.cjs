const {Connection}=require('@solana/web3.js');
const c=new Connection('https://mainnet.helius-rpc.com/?api-key=7a961a43-c3ac-4928-897a-c5d7c5d3fd67');
c.getTransaction('4NyYZS2HkofpwKzmsLLCtfDqtvy4tcVMHdf2deeuGSjeALEahpDoDZpQxWWJmQ24qbofgBBBHvhB9kiA7CD1xXm7',{maxSupportedTransactionVersion:0}).then(r=>{
  if(r===null){console.log('TX not found');return;}
  console.log('Status:', r.meta.err ? 'FAILED' : 'SUCCESS');
  var post=r.meta.postTokenBalances||[];
  for(var b of post){
    console.log('mint='+b.mint.slice(0,8)+' owner='+b.owner.slice(0,8)+' amount='+b.uiTokenAmount.uiAmount);
  }
}).catch(e=>console.error(e.message));
