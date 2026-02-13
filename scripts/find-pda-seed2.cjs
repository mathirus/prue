const {PublicKey} = require('@solana/web3.js');
require('dotenv').config();

const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMPSWAP_FEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const expectedPDA = '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk';

const creator = new PublicKey('3PERaDiGXnWT8qWuxcoECkHfeTwgsQD23JfUfu4eTYUY');
const pool = new PublicKey('6DkeboZA26BU3y9GDvPybVNNkMZwStbPgdmgWhBZjr31');
const quoteMint = new PublicKey('2r1jb1txV7pGfNi7p6SaPiUHFbJ1sh5VJgPDpxDQoQeD');

const seeds = ['creator_vault', 'coin_creator_vault', 'coin_creator', 'creator'];
const programs = [
  ['PUMPSWAP_AMM', PUMPSWAP_AMM],
  ['PUMPFUN_PROGRAM', PUMPFUN_PROGRAM],
  ['PUMPSWAP_FEE', PUMPSWAP_FEE],
];
const keys = [
  ['creator', creator],
  ['pool', pool],
  ['quoteMint', quoteMint],
];

// Try seed + key combinations with all programs
for (const [progName, prog] of programs) {
  for (const seed of seeds) {
    for (const [keyName, key] of keys) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), key.toBuffer()],
          prog,
        );
        if (pda.toBase58() === expectedPDA) {
          console.log(`MATCH: seed="${seed}" + ${keyName}, program=${progName}`);
        }
      } catch (e) {}
    }
  }
}

// Try seed + pool + creator combos
for (const seed of seeds) {
  for (const [progName, prog] of programs) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), pool.toBuffer(), creator.toBuffer()],
        prog,
      );
      if (pda.toBase58() === expectedPDA) {
        console.log(`MATCH: seed="${seed}" + pool + creator, program=${progName}`);
      }
    } catch (e) {}
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), creator.toBuffer(), pool.toBuffer()],
        prog,
      );
      if (pda.toBase58() === expectedPDA) {
        console.log(`MATCH: seed="${seed}" + creator + pool, program=${progName}`);
      }
    } catch (e) {}
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), creator.toBuffer(), quoteMint.toBuffer()],
        prog,
      );
      if (pda.toBase58() === expectedPDA) {
        console.log(`MATCH: seed="${seed}" + creator + quoteMint, program=${progName}`);
      }
    } catch (e) {}
  }
}

// Try without any prefix seed, just key
for (const [progName, prog] of programs) {
  for (const [keyName, key] of keys) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [key.toBuffer()],
        prog,
      );
      if (pda.toBase58() === expectedPDA) {
        console.log(`MATCH: just ${keyName}, program=${progName}`);
      }
    } catch (e) {}
  }
}

// Try "pool_creator_vault" variations
const extraSeeds = ['pool_creator_vault', 'vault', 'pool_vault', 'pool_creator'];
for (const seed of extraSeeds) {
  for (const [progName, prog] of programs) {
    for (const [keyName, key] of keys) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), key.toBuffer()],
          prog,
        );
        if (pda.toBase58() === expectedPDA) {
          console.log(`MATCH: seed="${seed}" + ${keyName}, program=${progName}`);
        }
      } catch (e) {}
    }
  }
}

console.log('Search complete.');
