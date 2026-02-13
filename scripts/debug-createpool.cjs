const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL);

const sig = process.argv[2] || '3ocG4nWCgKNghHkJvomJQhgiD8Xz2eZxQruJBAjaCxzJaZpBb1t6uSzBxjAWGhXyUDNWwQFrvGX5HXRM5LC6nZM3';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';

async function main() {
  const tx = await conn.getParsedTransaction(sig, {maxSupportedTransactionVersion: 0, commitment: 'confirmed'});
  if (!tx) { console.log('TX not found'); return; }

  console.log('=== Top-level instructions ===');
  const ixs = tx.transaction.message.instructions;
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const prog = ix.programId.toBase58();
    const isPumpswap = prog === PUMPSWAP;
    console.log(`\n  IX[${i}] program=${prog.slice(0, 8)}... ${isPumpswap ? '<<< PUMPSWAP' : ''}`);
    if ('accounts' in ix && ix.accounts) {
      console.log(`    accounts (${ix.accounts.length}):`);
      ix.accounts.forEach((a, j) => {
        const addr = a.toBase58();
        const label = addr === WSOL ? ' (WSOL)' : '';
        console.log(`      [${j}] ${addr}${label}`);
      });
    }
    if ('parsed' in ix) {
      console.log('    parsed:', JSON.stringify(ix.parsed).slice(0, 200));
    }
    if ('data' in ix) {
      console.log('    data (first 16 chars):', String(ix.data).slice(0, 16));
    }
  }

  console.log('\n=== Inner instructions ===');
  if (tx.meta && tx.meta.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      console.log(`\n  Inner group (index=${inner.index}):`);
      for (let i = 0; i < inner.instructions.length; i++) {
        const ix = inner.instructions[i];
        const prog = ix.programId.toBase58();
        const isPumpswap = prog === PUMPSWAP;
        if (isPumpswap) {
          console.log(`    IX[${i}] program=${prog.slice(0, 8)}... <<< PUMPSWAP`);
          if ('accounts' in ix && ix.accounts) {
            console.log(`      accounts (${ix.accounts.length}):`);
            ix.accounts.forEach((a, j) => {
              const addr = a.toBase58();
              const label = addr === WSOL ? ' (WSOL)' : '';
              console.log(`        [${j}] ${addr}${label}`);
            });
          }
        }
      }
    }
  }

  // Also check postTokenBalances
  console.log('\n=== Post Token Balances ===');
  if (tx.meta && tx.meta.postTokenBalances) {
    for (const bal of tx.meta.postTokenBalances) {
      console.log(`  idx=${bal.accountIndex} mint=${bal.mint} amount=${bal.uiTokenAmount?.uiAmountString || 'N/A'}`);
    }
  }

  // Logs mentioning CreatePool
  console.log('\n=== Logs ===');
  if (tx.meta && tx.meta.logMessages) {
    tx.meta.logMessages.forEach((l, i) => {
      if (l.includes('CreatePool') || l.includes('create_pool') || l.includes('Instruction:')) {
        console.log(`  [${i}] ${l}`);
      }
    });
  }
}

main().catch(e => console.error(e));
