const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();

const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const expectedPDA = '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk';

async function main() {
  const pool = new PublicKey('6DkeboZA26BU3y9GDvPybVNNkMZwStbPgdmgWhBZjr31');
  const info = await conn.getAccountInfo(pool);
  const d = info.data;

  // Check extra bytes at end
  console.log('Extra bytes at offset 211:');
  console.log('  [211] byte:', d[211], 'hex:', d[211].toString(16));

  // Try pubkey at offset 212 (32 bytes)
  if (d.length >= 244) {
    const pk = new PublicKey(d.slice(212, 244));
    console.log('  [212-243] pubkey:', pk.toBase58());

    // Test with all seeds
    const seeds = ['creator_vault', 'coin_creator_vault', 'coin_creator', 'creator',
                   'pool_creator_vault', 'vault', 'authority', 'creator_authority'];
    for (const seed of seeds) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), pk.toBuffer()], PUMPSWAP_AMM
        );
        const match = pda.toBase58() === expectedPDA;
        console.log(`  "${seed}" + pk => ${pda.toBase58().slice(0, 15)}${match ? ' ✅ MATCH!' : ''}`);
      } catch (e) {}
    }
  }

  // Also try ALL offsets with longer byte range
  console.log('\nBrute force all offsets with all seeds:');
  const seeds = ['creator_vault', 'coin_creator_vault', 'coin_creator', 'creator'];
  for (let offset = 0; offset <= d.length - 32; offset++) {
    const pk = new PublicKey(d.slice(offset, offset + 32));
    for (const seed of seeds) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), pk.toBuffer()], PUMPSWAP_AMM
        );
        if (pda.toBase58() === expectedPDA) {
          console.log(`FOUND! offset=${offset} seed="${seed}" pk=${pk.toBase58()}`);
        }
      } catch (e) {}
    }
  }

  console.log('Done.');
}

main().catch(console.error);
