// Check specific TX details for BRhV position investigation
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config();

const decode = bs58.decode || bs58.default?.decode;

async function main() {
  const connection = new Connection(process.env.RPC_URL);
  const wallet = Keypair.fromSecretKey(decode(process.env.PRIVATE_KEY));
  const walletAddr = wallet.publicKey.toBase58();
  const TOKEN_MINT = 'BRhVZMhtXdrZ9eZ9RUzKm8jRtzdnQ1KG4976TZLk7KcM';

  // Get last 20 sigs
  const sigs = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 20 });

  for (const s of sigs) {
    await new Promise(r => setTimeout(r, 500));

    try {
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;

      const time = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '?';
      const err = s.err ? 'FAIL' : 'OK';

      // Check if this TX involves BRhV token
      const involvesBRhV =
        (tx.meta.preTokenBalances || []).some(b => b.mint === TOKEN_MINT) ||
        (tx.meta.postTokenBalances || []).some(b => b.mint === TOKEN_MINT);

      // SOL delta
      const preSOL = tx.meta.preBalances[0] / 1e9;
      const postSOL = tx.meta.postBalances[0] / 1e9;
      const solDelta = postSOL - preSOL;

      // Programs
      const programs = tx.transaction.message.instructions
        .map(i => {
          const pid = i.programId ? i.programId.toBase58() : '';
          if (pid === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') return 'PumpSwap';
          if (pid.startsWith('JUP')) return 'Jupiter';
          if (pid === 'ComputeBudget111111111111111111111111111111') return 'CB';
          if (pid === '11111111111111111111111111111111') return 'System';
          if (pid === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return 'Token';
          if (pid === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') return 'ATA';
          return pid.substring(0, 10);
        })
        .join(', ');

      const marker = involvesBRhV ? ' ★ BRhV' : '';
      const sign = solDelta >= 0 ? '+' : '';
      console.log(`${time} | ${err} | SOL:${sign}${solDelta.toFixed(6)} | ${programs}${marker}`);

      // Show token balance changes for BRhV
      if (involvesBRhV) {
        const pre = (tx.meta.preTokenBalances || []).filter(b => b.mint === TOKEN_MINT);
        const post = (tx.meta.postTokenBalances || []).filter(b => b.mint === TOKEN_MINT);
        console.log('  BRhV pre balances:', pre.map(b => `${b.owner?.substring(0,8)}...=${b.uiTokenAmount.uiAmountString}`));
        console.log('  BRhV post balances:', post.map(b => `${b.owner?.substring(0,8)}...=${b.uiTokenAmount.uiAmountString}`));
        console.log('  Sig:', s.signature);

        // Show parsed instructions for BRhV-related TXs
        for (const inst of tx.transaction.message.instructions) {
          if (inst.parsed) {
            console.log('  Instruction:', inst.parsed.type, JSON.stringify(inst.parsed.info || {}).substring(0, 200));
          }
        }
      }
    } catch (e) {
      const time = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '?';
      console.log(`${time} | Error: ${e.message.substring(0, 60)}`);
    }
  }
}

main().catch(e => console.error('Error:', e.message));
