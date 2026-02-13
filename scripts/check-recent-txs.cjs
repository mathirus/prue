// Quick script to check recent wallet transactions
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config();

const decode = bs58.decode || bs58.default?.decode;

async function main() {
  const connection = new Connection(process.env.RPC_URL);
  const wallet = Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));

  console.log('Wallet:', wallet.publicKey.toBase58());

  // Get recent signatures
  const sigs = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 15 });

  console.log('\n=== LAST 15 TRANSACTIONS ===');
  for (const s of sigs) {
    const time = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '?';
    const err = s.err ? 'FAIL' : 'OK';
    const sigShort = s.signature.substring(0, 20);
    console.log(`${time} | ${err} | ${sigShort}...`);
  }

  // Check successful ones for SOL balance changes
  const successful = sigs.filter(s => !s.err);
  console.log('\n=== SUCCESSFUL TX DETAILS ===');
  for (const s of successful.slice(0, 5)) {
    try {
      await new Promise(r => setTimeout(r, 1000)); // Rate limit
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      const time = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '?';

      const preBalance = tx.meta.preBalances[0] || 0;
      const postBalance = tx.meta.postBalances[0] || 0;
      const solDelta = (postBalance - preBalance) / 1e9;

      const programs = tx.transaction.message.instructions
        .map(i => {
          const pid = i.programId ? i.programId.toBase58() : i.program;
          // Shorten known programs
          if (pid === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') return 'PumpSwap';
          if (pid === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') return 'Jupiter';
          if (pid === 'ComputeBudget111111111111111111111111111111') return 'CB';
          if (pid === '11111111111111111111111111111111') return 'System';
          if (pid === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return 'Token';
          if (pid === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') return 'ATA';
          return pid.substring(0, 8) + '...';
        })
        .join(', ');

      const sign = solDelta >= 0 ? '+' : '';
      console.log(`\n${time} | SOL: ${sign}${solDelta.toFixed(6)} | ${programs}`);
      console.log(`  Sig: ${s.signature}`);

      // Check token balance changes
      if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
        const pre = tx.meta.preTokenBalances;
        const post = tx.meta.postTokenBalances;
        for (const p of post) {
          if (p.owner === wallet.publicKey.toBase58()) {
            const preEntry = pre.find(x => x.mint === p.mint && x.owner === wallet.publicKey.toBase58());
            const preAmt = preEntry ? parseFloat(preEntry.uiTokenAmount.uiAmountString || '0') : 0;
            const postAmt = parseFloat(p.uiTokenAmount.uiAmountString || '0');
            if (preAmt !== postAmt) {
              const mint = p.mint.substring(0, 8);
              console.log(`  Token ${mint}...: ${preAmt} -> ${postAmt}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  // Final balance
  const bal = await connection.getBalance(wallet.publicKey);
  console.log('\nCurrent SOL balance:', bal / 1e9, 'SOL');
}

main().catch(e => console.error('Error:', e.message));
