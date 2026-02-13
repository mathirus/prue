const {Connection} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com');
const txId = process.argv[2] || '4CfW8W1bXUkFg3uhztJTTKcoB3tcc8TkbmXvQKxy9RHRLimQEiGv43LuksWvkkiFd9z1zDmG2FhgZinRGHL8sgbz';
conn.getTransaction(txId, {maxSupportedTransactionVersion: 0}).then(tx => {
  if (!tx) { console.log('TX not found'); return; }
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  console.log('=== STATIC ACCOUNTS ===');
  keys.forEach((k, i) => console.log(i + ': ' + k.toBase58()));
  if (tx.transaction.message.addressTableLookups) {
    console.log('=== ADDRESS TABLE LOOKUPS ===');
    console.log(JSON.stringify(tx.transaction.message.addressTableLookups));
  }
  console.log('=== LOG MESSAGES ===');
  (tx.meta.logMessages || []).forEach(l => console.log(l));
  console.log('=== ERROR ===');
  console.log(JSON.stringify(tx.meta.err));
  console.log('=== INNER INSTRUCTIONS ===');
  console.log(JSON.stringify(tx.meta.innerInstructions, null, 2));
}).catch(e => console.error(e.message));
