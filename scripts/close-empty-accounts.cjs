/**
 * Close empty token accounts to recover rent SOL.
 * Each empty account has ~0.00203928 SOL in rent that can be recovered.
 */
const { Connection, PublicKey, Transaction, Keypair } = require('@solana/web3.js');
const { createCloseAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

function decodeBase58(str) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = BigInt(i);
  let result = 0n;
  for (const ch of str) result = result * 58n + ALPHABET_MAP[ch];
  const bytes = [];
  while (result > 0n) { bytes.unshift(Number(result & 0xffn)); result >>= 8n; }
  for (const ch of str) { if (ch === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

async function closeEmptyAccounts() {
  const conn = new Connection(process.env.RPC_URL);
  const wallet = Keypair.fromSecretKey(decodeBase58(process.env.PRIVATE_KEY));
  console.log('Wallet:', wallet.publicKey.toBase58());

  const balanceBefore = await conn.getBalance(wallet.publicKey);
  console.log('Balance before:', (balanceBefore / 1e9).toFixed(6), 'SOL');

  // Get all token accounts for both Token programs
  const [tokenAccounts, token2022Accounts] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const emptyAccounts = [];
  for (const acc of [...tokenAccounts.value, ...token2022Accounts.value]) {
    const info = acc.account.data.parsed && acc.account.data.parsed.info;
    if (info == null) continue;
    const amount = parseFloat((info.tokenAmount && info.tokenAmount.uiAmount) || '0');
    if (amount === 0) {
      const programId = acc.account.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
      emptyAccounts.push({ address: acc.pubkey, programId });
    }
  }

  console.log('Empty accounts to close:', emptyAccounts.length);
  if (emptyAccounts.length === 0) {
    console.log('No empty accounts to close.');
    return;
  }

  // Close in batches of 10 (max instructions per tx)
  const BATCH_SIZE = 10;
  let totalClosed = 0;

  for (let i = 0; i < emptyAccounts.length; i += BATCH_SIZE) {
    const batch = emptyAccounts.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    for (const acc of batch) {
      tx.add(
        createCloseAccountInstruction(
          acc.address,
          wallet.publicKey,
          wallet.publicKey,
          [],
          acc.programId,
        )
      );
    }

    tx.sign(wallet);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await conn.confirmTransaction(sig, 'confirmed');
      console.log('  Closed batch', Math.floor(i / BATCH_SIZE) + 1, '- TX:', sig);
      totalClosed += batch.length;
    } catch (e) {
      console.error('  Batch failed:', e.message);
      // Try one by one
      for (const acc of batch) {
        try {
          const singleTx = new Transaction();
          const { blockhash: bh } = await conn.getLatestBlockhash('confirmed');
          singleTx.recentBlockhash = bh;
          singleTx.feePayer = wallet.publicKey;
          singleTx.add(createCloseAccountInstruction(acc.address, wallet.publicKey, wallet.publicKey, [], acc.programId));
          singleTx.sign(wallet);
          const sig = await conn.sendRawTransaction(singleTx.serialize(), { skipPreflight: true });
          await conn.confirmTransaction(sig, 'confirmed');
          totalClosed++;
          console.log('    Closed individual:', acc.address.toBase58().slice(0, 12));
        } catch (e2) {
          console.error('    Failed:', acc.address.toBase58().slice(0, 12), e2.message.slice(0, 80));
        }
      }
    }
  }

  const balanceAfter = await conn.getBalance(wallet.publicKey);
  console.log('\nTotal closed:', totalClosed);
  console.log('Balance after:', (balanceAfter / 1e9).toFixed(6), 'SOL');
  console.log('SOL recovered:', ((balanceAfter - balanceBefore) / 1e9).toFixed(6), 'SOL');
}

closeEmptyAccounts().catch(e => console.error('Fatal:', e));
