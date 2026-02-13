const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/RPC_URL=(.+)/);
const url = m ? m[1].trim() : null;
if (!url) { console.log('No HELIUS_RPC_URL'); process.exit(1); }
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
new Connection(url).getBalance(new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8'))
  .then(b => console.log((b / LAMPORTS_PER_SOL).toFixed(6), 'SOL'))
  .catch(e => console.log('ERR:', e.message));
