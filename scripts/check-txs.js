import {Connection, PublicKey, LAMPORTS_PER_SOL} from '@solana/web3.js';
const conn = new Connection(process.env.RPC_URL);
const WALLET = 'Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8';

async function main() {
  // Get more TXs - we need to go back to 5:40 AM for GWkQ7J
  const fullSigs = await conn.getSignaturesForAddress(new PublicKey(WALLET), {limit: 50});

  // Only show OUR transactions (fee_payer = us) to see actual costs
  console.log('=== OUR TRANSACTIONS (fee payer = our wallet) ===\n');

  let totalOurChange = 0;
  let ourTxCount = 0;

  for (const sig of fullSigs) {
    try {
      const tx = await conn.getParsedTransaction(sig.signature, {maxSupportedTransactionVersion: 0});
      if (!tx) continue;

      const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());

      // Only show transactions WE initiated
      if (accountKeys[0] !== WALLET) continue;

      ourTxCount++;
      const walletIndex = 0; // We're the fee payer
      const pre = tx.meta.preBalances[walletIndex];
      const post = tx.meta.postBalances[walletIndex];
      const walletChange = (post - pre) / LAMPORTS_PER_SOL;
      totalOurChange += walletChange;

      const time = new Date(sig.blockTime * 1000).toLocaleString('es-AR', {hour:'2-digit', minute:'2-digit'});
      const err = sig.err ? 'FAIL' : 'OK';
      const fee = tx.meta.fee / LAMPORTS_PER_SOL;

      const programs = tx.transaction.message.instructions.map(i => {
        const p = i.programId.toString();
        if (p.includes('pAMMBay')) return 'PumpSwap';
        if (p.includes('JUP6Lkb')) return 'Jupiter';
        if (p.includes('ATokenG')) return 'ATA';
        if (p.includes('TokenzQd')) return 'Token2022';
        if (p.includes('TokenkegQ')) return 'SPLToken';
        if (p.includes('ComputeBudget')) return 'Compute';
        if (p === '11111111111111111111111111111111') return 'System';
        return p.substring(0,8);
      });
      const type = [...new Set(programs)].join('+');

      console.log(time + ' | ' + err.padEnd(4) + ' | ' + walletChange.toFixed(6).padStart(11) + ' SOL | fee=' + fee.toFixed(6) + ' | pre=' + (pre/LAMPORTS_PER_SOL).toFixed(4) + ' → post=' + (post/LAMPORTS_PER_SOL).toFixed(4) + ' | ' + type);
    } catch(e) {
      // skip
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Our TXs:', ourTxCount);
  console.log('Total SOL change:', totalOurChange.toFixed(6), 'SOL');

  const bal = await conn.getBalance(new PublicKey(WALLET));
  console.log('Current balance:', (bal / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
}

main().catch(console.error);
