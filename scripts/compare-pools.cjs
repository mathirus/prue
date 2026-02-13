const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();

const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const MIGRATION_AUTH = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
const expectedPDA = '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk';

async function readPool(label, address) {
  const info = await conn.getAccountInfo(new PublicKey(address));
  if (!info) { console.log(`${label}: not found`); return; }
  const d = info.data;
  const creator = new PublicKey(d.slice(11, 43));
  const baseMint = new PublicKey(d.slice(43, 75));
  const quoteMint = new PublicKey(d.slice(75, 107));
  console.log(`\n${label}:`);
  console.log(`  creator: ${creator.toBase58()}`);
  console.log(`  baseMint: ${baseMint.toBase58()}`);
  console.log(`  quoteMint: ${quoteMint.toBase58()}`);
  return creator;
}

async function main() {
  const creator1 = await readPool('Our failing pool', '6DkeboZA26BU3y9GDvPybVNNkMZwStbPgdmgWhBZjr31');
  const creator2 = await readPool('Successful TX pool', 'GNAPp7pAYQXyGVqobE66xM5riWCgZkWrnC6GQSZVDywN');

  console.log('\n=== Testing PDA derivations ===');
  console.log('Expected:', expectedPDA);

  // Try with creators
  const creators = [creator1, creator2, MIGRATION_AUTH];
  const creatorNames = ['our_creator', 'success_creator', 'migration_auth'];
  const seeds = ['creator_vault', 'coin_creator_vault', 'coin_creator', 'creator',
                 'pool_creator_vault', 'vault_authority', 'creator_authority'];
  const programs = [['AMM', PUMPSWAP_AMM], ['PUMPFUN', PUMPFUN_PROGRAM]];

  for (let ci = 0; ci < creators.length; ci++) {
    const c = creators[ci];
    if (!c) continue;
    for (const seed of seeds) {
      for (const [pn, prog] of programs) {
        try {
          const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(seed), c.toBuffer()], prog
          );
          if (pda.toBase58() === expectedPDA) {
            console.log(`MATCH: "${seed}" + ${creatorNames[ci]}, ${pn}`);
          }
        } catch (e) {}
      }
    }
  }

  // Also try: just the creator bytes with PumpFun
  if (creator2) {
    const seeds2 = ['creator_vault', 'coin_creator_vault'];
    for (const seed of seeds2) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), creator2.toBuffer()], PUMPSWAP_AMM
        );
        console.log(`"${seed}" + success_creator => ${pda.toBase58().slice(0, 20)}`);
      } catch (e) {}
    }
  }
}

main().catch(console.error);
