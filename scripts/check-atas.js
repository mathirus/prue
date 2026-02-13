import {Connection, PublicKey, LAMPORTS_PER_SOL} from '@solana/web3.js';
const conn = new Connection(process.env.RPC_URL);
const WALLET = new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

async function main() {
  console.log('Fetching SPL Token accounts...');
  const splAccounts = await conn.getParsedTokenAccountsByOwner(WALLET, { programId: TOKEN_PROGRAM });
  console.log('Fetching Token-2022 accounts...');
  const t22Accounts = await conn.getParsedTokenAccountsByOwner(WALLET, { programId: TOKEN_2022 });

  const allAccounts = [
    ...splAccounts.value.map(a => ({...a, program: 'SPL Token'})),
    ...t22Accounts.value.map(a => ({...a, program: 'Token-2022'})),
  ];

  console.log(`\nTotal token accounts: ${allAccounts.length} (SPL: ${splAccounts.value.length}, T22: ${t22Accounts.value.length})\n`);

  let emptyCount = 0;
  let emptyRentTotal = 0;
  let frozenCount = 0;
  let nonEmptyCount = 0;

  for (const acc of allAccounts) {
    const info = acc.account.data.parsed.info;
    const balance = parseInt(info.tokenAmount.amount);
    const mint = info.mint;
    const frozen = info.state === 'frozen';
    const rent = acc.account.lamports;

    if (balance === 0 && !frozen) {
      emptyCount++;
      emptyRentTotal += rent;
      console.log(`CLOSABLE | ${acc.program.padEnd(10)} | ${mint.substring(0,12)}... | rent=${(rent/LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    } else if (frozen) {
      frozenCount++;
      console.log(`FROZEN   | ${acc.program.padEnd(10)} | ${mint.substring(0,12)}... | balance=${info.tokenAmount.uiAmountString} | rent=${(rent/LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    } else {
      nonEmptyCount++;
      console.log(`HAS BAL  | ${acc.program.padEnd(10)} | ${mint.substring(0,12)}... | balance=${info.tokenAmount.uiAmountString} | rent=${(rent/LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Empty (closable): ${emptyCount} → recoverable: ${(emptyRentTotal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Frozen (NOT closable): ${frozenCount}`);
  console.log(`Has balance: ${nonEmptyCount}`);

  const bal = await conn.getBalance(WALLET);
  console.log(`\nWallet SOL balance: ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch(console.error);
