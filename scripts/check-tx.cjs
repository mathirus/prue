const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL);

const sig = process.argv[2] || '64Q1x1KdxLuTJ2Zgf1r88UQ2pfnLN5kUkrv4fhFcBRFoNNVFRrt31fYRGm2ERfjcUL6r6srBTqXfBr9zw5wGL1Fs';

async function main() {
  const tx = await conn.getParsedTransaction(sig, {maxSupportedTransactionVersion: 0, commitment: 'confirmed'});
  if (!tx) { console.log('TX not found'); return; }

  const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const ixs = tx.transaction.message.instructions;
  for (const ix of ixs) {
    if (ix.programId.toBase58() === PUMPSWAP && ix.accounts) {
      console.log('PumpSwap instruction accounts (' + ix.accounts.length + '):');
      ix.accounts.forEach((a, i) => console.log('  [' + i + ']', a.toBase58()));
    }
  }

  if (tx.meta && tx.meta.logMessages) {
    const logs = tx.meta.logMessages.filter(l =>
      l.includes('Constraint') || l.includes('Error') || l.includes('AnchorError') ||
      l.includes('failed') || l.includes('creator') || l.includes('Program log:')
    );
    console.log('\nRelevant logs:');
    logs.forEach(l => console.log(' ', l));
  }
}

main().catch(e => console.error(e.message));
