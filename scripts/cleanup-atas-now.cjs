const fs = require('fs');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { createBurnInstruction, createCloseAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');

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
const wallet = Keypair.fromSecretKey(bs58.default.decode(vars.PRIVATE_KEY));

async function cleanup() {
  const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  });

  console.log('Token accounts found:', accounts.value.length);

  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    const mint = new PublicKey(info.mint);
    const ata = acc.pubkey;
    const amount = BigInt(info.tokenAmount.amount);

    console.log(`\nProcessing: ${info.mint.substring(0, 8)} | amount: ${info.tokenAmount.uiAmountString}`);

    const tx = new Transaction();
    if (amount > 0n) {
      tx.add(createBurnInstruction(ata, mint, wallet.publicKey, amount));
    }
    tx.add(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey));

    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      console.log('  Simulation failed:', JSON.stringify(sim.value.err));
      continue;
    }

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log('  TX sent:', sig.substring(0, 30));
    const conf = await conn.confirmTransaction(sig, 'confirmed');
    if (conf.value.err) {
      console.log('  TX failed:', JSON.stringify(conf.value.err));
    } else {
      console.log('  SUCCESS - rent recovered (~0.002 SOL)');
    }
  }

  const bal = await conn.getBalance(wallet.publicKey);
  console.log('\nFinal balance:', bal / 1e9, 'SOL');
}

cleanup().catch(e => console.error('Error:', e.message));
