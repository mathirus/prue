const {PublicKey} = require('@solana/web3.js');
require('dotenv').config();

// Pool 6DkeboZA26BU3y9GDvPybVNNkMZwStbPgdmgWhBZjr31
// Expected PDA: 8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk
const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const expectedPDA = '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk';

// We need to find the creator key first - let's read the pool state
const {Connection} = require('@solana/web3.js');
const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');

async function main() {
  const poolAddress = new PublicKey('6DkeboZA26BU3y9GDvPybVNNkMZwStbPgdmgWhBZjr31');
  const poolInfo = await conn.getAccountInfo(poolAddress);
  if (!poolInfo) { console.log('Pool not found'); return; }

  // Pool layout: creator at offset 11 (32 bytes)
  const creator = new PublicKey(poolInfo.data.slice(11, 43));
  const baseMint = new PublicKey(poolInfo.data.slice(43, 75));
  const quoteMint = new PublicKey(poolInfo.data.slice(75, 107));

  console.log('Creator:', creator.toBase58());
  console.log('BaseMint:', baseMint.toBase58());
  console.log('QuoteMint:', quoteMint.toBase58());
  console.log('Expected PDA:', expectedPDA);

  // Try different seeds
  const seeds = [
    'creator_vault',
    'coin_creator_vault',
    'coin_creator',
    'creator',
    'creator_vault_authority',
    'coin_creator_vault_authority',
  ];

  for (const seed of seeds) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), creator.toBuffer()],
        PUMPSWAP_AMM,
      );
      const match = pda.toBase58() === expectedPDA;
      console.log(`seed="${seed}" + creator => ${pda.toBase58().slice(0,10)}... ${match ? '✅ MATCH!' : ''}`);
    } catch (e) {
      console.log(`seed="${seed}": error`);
    }
  }

  // Also try with quoteMint (TOKEN) as the key instead of creator
  for (const seed of seeds) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), quoteMint.toBuffer()],
        PUMPSWAP_AMM,
      );
      const match = pda.toBase58() === expectedPDA;
      if (match) console.log(`seed="${seed}" + quoteMint => ${pda.toBase58().slice(0,10)}... ✅ MATCH!`);
    } catch (e) {}
  }

  // Try with pool address as key
  for (const seed of seeds) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), poolAddress.toBuffer()],
        PUMPSWAP_AMM,
      );
      const match = pda.toBase58() === expectedPDA;
      if (match) console.log(`seed="${seed}" + poolAddress => ${pda.toBase58().slice(0,10)}... ✅ MATCH!`);
    } catch (e) {}
  }
}

main().catch(console.error);
