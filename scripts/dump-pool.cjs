const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();

const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const expectedPDA = '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk';

async function main() {
  const pool = new PublicKey('6DkeboZA26BU3y9GDvPybVNNkMZwStbPgdmgWhBZjr31');
  const info = await conn.getAccountInfo(pool);
  if (!info) { console.log('Pool not found'); return; }
  const d = info.data;
  console.log(`Pool data length: ${d.length} bytes`);

  // Dump all possible 32-byte pubkeys in the data
  console.log('\nAll possible pubkeys in pool data:');
  for (let offset = 0; offset <= d.length - 32; offset++) {
    const pk = new PublicKey(d.slice(offset, offset + 32));
    const str = pk.toBase58();
    // Only print non-trivial pubkeys
    if (!str.startsWith('1111') && str.length > 30) {
      // Try deriving creator_vault with this pubkey
      const seeds = ['creator_vault', 'coin_creator_vault', 'creator'];
      for (const seed of seeds) {
        try {
          const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(seed), pk.toBuffer()], PUMPSWAP_AMM
          );
          if (pda.toBase58() === expectedPDA) {
            console.log(`\n*** MATCH at offset ${offset}! ***`);
            console.log(`  seed="${seed}", pubkey=${str}`);
          }
        } catch (e) {}
      }
    }
  }

  // Print known offsets
  console.log('\n=== Known fields ===');
  console.log(`[8] poolBump: ${d[8]}`);
  console.log(`[9] index: ${d.readUInt16LE(9)}`);
  console.log(`[11] creator: ${new PublicKey(d.slice(11, 43)).toBase58()}`);
  console.log(`[43] baseMint: ${new PublicKey(d.slice(43, 75)).toBase58()}`);
  console.log(`[75] quoteMint: ${new PublicKey(d.slice(75, 107)).toBase58()}`);
  console.log(`[107] lpMint: ${new PublicKey(d.slice(107, 139)).toBase58()}`);
  console.log(`[139] poolBase: ${new PublicKey(d.slice(139, 171)).toBase58()}`);
  console.log(`[171] poolQuote: ${new PublicKey(d.slice(171, 203)).toBase58()}`);
  console.log(`[203] lpSupply: ${d.readBigUInt64LE(203)}`);

  // Check if there's more data after lpSupply
  if (d.length > 211) {
    console.log(`\n=== Extra data after offset 211 (${d.length - 211} bytes) ===`);
    for (let offset = 211; offset <= d.length - 32; offset += 1) {
      const pk = new PublicKey(d.slice(offset, offset + 32));
      const str = pk.toBase58();
      if (!str.startsWith('1111')) {
        console.log(`[${offset}] ${str}`);
      }
    }
  }
}

main().catch(console.error);
