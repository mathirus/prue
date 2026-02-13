const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');

const env = fs.readFileSync('.env', 'utf8');
const vars = {};
for (const l of env.split('\n')) {
  const t = l.trim();
  if (t && !t.startsWith('#')) {
    const eq = t.indexOf('=');
    if (eq > 0) vars[t.substring(0, eq)] = t.substring(eq + 1);
  }
}

const conn = new Connection(vars.RPC_URL);
const wallet = new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8');

async function main() {
  const sigs = await conn.getSignaturesForAddress(wallet, { limit: 10 });

  for (const s of sigs) {
    const date = new Date(s.blockTime * 1000);
    console.log(`\n=== ${date.toLocaleTimeString()} ${s.err ? 'FAIL' : 'OK'} ${s.signature.substring(0, 30)}... ===`);

    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) { console.log('TX not found'); continue; }

    const pre = tx.meta.preBalances[0];
    const post = tx.meta.postBalances[0];
    console.log('SOL change:', ((post - pre) / 1e9).toFixed(6));

    const preTok = tx.meta.preTokenBalances || [];
    const postTok = tx.meta.postTokenBalances || [];

    for (const t of preTok) {
      if (t.owner === wallet.toBase58()) {
        console.log(`  pre-token: ${t.mint.substring(0, 8)}... = ${t.uiTokenAmount.uiAmountString}`);
      }
    }
    for (const t of postTok) {
      if (t.owner === wallet.toBase58()) {
        console.log(`  post-token: ${t.mint.substring(0, 8)}... = ${t.uiTokenAmount.uiAmountString}`);
      }
    }

    // Show programs used
    const programs = tx.transaction.message.accountKeys
      .filter(k => !k.signer && !k.writable)
      .map(k => k.pubkey.toBase58().substring(0, 8));
    if (programs.length) console.log('  programs:', programs.join(', '));
  }
}

main().catch(e => console.error('Error:', e.message));
