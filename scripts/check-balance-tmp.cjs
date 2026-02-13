const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://mainnet.helius-rpc.com/?api-key=5f0e6358-57fb-4077-a570-158e0acbf628');
const wallet = new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8');
const mint = new PublicKey(process.argv[2] || 'DhbRDq6uE1hS2kDthCbXB9bB7oUDp8eP8MgFkCMK3vJ6');
c.getParsedTokenAccountsByOwner(wallet, {mint}).then(r => {
  if (r.value.length === 0) console.log('NO token account found');
  else {
    const b = r.value[0].account.data.parsed.info.tokenAmount;
    console.log('Balance:', b.uiAmount, '(', b.amount, 'raw)');
  }
}).catch(e => console.error(e.message));
