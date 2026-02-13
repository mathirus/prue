const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL);

const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const poolAddress = new PublicKey('8aqFZNK12NMDSXbjeKoKVuSUcVABmNqxWHczZDpnqqJh');
const expectedPDA = '49eYp2bRgmwmXXXYxpCLmxSC71SkeXeWurk3j9U4HdXE';

async function main() {
  const accountInfo = await conn.getAccountInfo(poolAddress);
  if (!accountInfo) { console.log('Pool not found'); return; }

  const data = accountInfo.data;
  console.log('Pool data length:', data.length);

  // Read various offsets to find coinCreator
  const creator = new PublicKey(data.subarray(11, 43));
  const baseMint = new PublicKey(data.subarray(43, 75));
  const quoteMint = new PublicKey(data.subarray(75, 107));
  const coinCreator212 = new PublicKey(data.subarray(212, 244));

  console.log('creator@11:', creator.toBase58());
  console.log('baseMint@43:', baseMint.toBase58());
  console.log('quoteMint@75:', quoteMint.toBase58());
  console.log('coinCreator@212:', coinCreator212.toBase58());

  // Try PDA derivation with coinCreator@212
  const [pda1] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator212.toBuffer()],
    PUMPSWAP_AMM
  );
  console.log('\nPDA with coinCreator@212:', pda1.toBase58());
  console.log('Match expected?', pda1.toBase58() === expectedPDA);

  // Try PDA with creator@11
  const [pda2] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creator.toBuffer()],
    PUMPSWAP_AMM
  );
  console.log('\nPDA with creator@11:', pda2.toBase58());
  console.log('Match expected?', pda2.toBase58() === expectedPDA);

  // Try different seed prefixes
  const seedVariants = [
    'creator_vault',
    'coin_creator_vault',
    'coin_creator_vault_authority',
    'creator_authority',
    'creator',
  ];

  for (const seed of seedVariants) {
    for (const [label, key] of [['coinCreator@212', coinCreator212], ['creator@11', creator]]) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), key.toBuffer()],
          PUMPSWAP_AMM
        );
        if (pda.toBase58() === expectedPDA) {
          console.log(`\n*** MATCH FOUND! seed="${seed}" with ${label} ***`);
          console.log('PDA:', pda.toBase58());
        }
      } catch {}
    }
  }

  // Also try with just the key as sole seed
  for (const [label, key] of [['coinCreator@212', coinCreator212], ['creator@11', creator]]) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [key.toBuffer()],
        PUMPSWAP_AMM
      );
      if (pda.toBase58() === expectedPDA) {
        console.log(`\n*** MATCH with single seed ${label} ***`);
      }
    } catch {}
  }

  // Let me also check what's at other offsets - maybe coinCreator is elsewhere
  // Dump bytes around 200-244 as hex
  console.log('\nPool data hex (offset 200-244):');
  for (let off = 200; off < 244; off += 32) {
    const pk = new PublicKey(data.subarray(off, off + 32));
    console.log(`  @${off}: ${pk.toBase58()}`);
  }

  // Check all 32-byte aligned offsets as potential pubkeys
  console.log('\nSearching all offsets for a key that produces the expected PDA...');
  for (let off = 0; off + 32 <= data.length; off++) {
    try {
      const key = new PublicKey(data.subarray(off, off + 32));
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), key.toBuffer()],
        PUMPSWAP_AMM
      );
      if (pda.toBase58() === expectedPDA) {
        console.log(`  *** FOUND at offset ${off}: ${key.toBase58()} ***`);
      }
    } catch {}
  }
}

main().catch(e => console.error(e));
