// Find a successful PumpSwap sell transaction to see the correct account layout
const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();

const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

async function main() {
  // Get recent transactions for PumpSwap
  const sigs = await conn.getSignaturesForAddress(PUMPSWAP_AMM, {limit: 30});
  console.log(`Found ${sigs.length} recent PumpSwap transactions`);

  for (const sig of sigs) {
    if (sig.err) continue; // Skip failed txs

    const tx = await conn.getTransaction(sig.signature, {maxSupportedTransactionVersion: 0});
    if (!tx || !tx.meta || !tx.meta.logMessages) continue;

    // Look for "Sell" instruction logs
    const logs = tx.meta.logMessages;
    const hasSell = logs.some(l => l.includes('Instruction: Sell'));
    if (!hasSell) continue;

    console.log('\n=== SUCCESSFUL SELL TX ===');
    console.log('Sig:', sig.signature);
    const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
    console.log('Accounts:');
    keys.forEach((k, i) => console.log(`  ${i}: ${k.toBase58()}`));
    console.log('Logs:');
    logs.forEach(l => console.log('  ' + l));
    return; // Just need one
  }
  console.log('No successful sell TX found');
}

main().catch(console.error);
