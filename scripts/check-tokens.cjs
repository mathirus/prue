const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL);
const wallet = new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8');

async function checkTokens() {
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  });
  const token2022Accounts = await conn.getParsedTokenAccountsByOwner(wallet, {
    programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
  });

  const all = [...tokenAccounts.value, ...token2022Accounts.value];
  console.log('Total token accounts: ' + all.length);

  let recoverable = 0;
  let closeable = 0;

  for (const acc of all) {
    const info = acc.account.data.parsed && acc.account.data.parsed.info;
    if (info == null) continue;
    const amount = parseFloat((info.tokenAmount && info.tokenAmount.uiAmount) || '0');
    const mint = info.mint;
    if (amount > 0) {
      console.log('  Token: ' + mint.slice(0,12) + '...  Balance: ' + amount.toFixed(2) + '  Decimals: ' + info.tokenAmount.decimals);
      recoverable++;
    } else {
      closeable++;
    }
  }

  console.log('\nTokens with balance > 0: ' + recoverable);
  console.log('Empty accounts (closeable for rent): ' + closeable + ' (~' + (closeable * 0.00203928).toFixed(4) + ' SOL recoverable)');
}
checkTokens().catch(e => console.error(e));
