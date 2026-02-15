import { PublicKey } from '@solana/web3.js';

// Raydium AMM V4
export const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Raydium AMM Authority (PDA seed = "amm authority")
export const RAYDIUM_AMM_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

// Serum/OpenBook DEX V3
export const SERUM_PROGRAM_ID = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');

// Raydium CLMM (Concentrated Liquidity)
export const RAYDIUM_CLMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

// Raydium CPMM (Constant Product)
export const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

// Pump.fun Program
export const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// PumpSwap (old routing program, kept for backward compat)
export const PUMPSWAP_PROGRAM = new PublicKey('PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP');

// PumpSwap AMM (actual constant-product AMM program for swaps)
export const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// PumpSwap Fee Program
export const PUMPSWAP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// PumpSwap Protocol Fee Recipient
export const PUMPSWAP_PROTOCOL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

// Pump.fun Fee Account (used to detect migrations)
export const PUMPFUN_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ2qKnLKYYWw');

// Pump.fun Migration Authority
export const PUMPFUN_MIGRATION_AUTHORITY = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

// Jupiter V6 Aggregator
export const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

// Jito Tip Accounts (rotate between these)
export const JITO_TIP_ACCOUNTS = [
  new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
  new PublicKey('HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiY294pay'),
  new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY'),
  new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSLgCPEdbbg6MHzAe6f'),
  new PublicKey('DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh'),
  new PublicKey('ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt'),
  new PublicKey('DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL'),
  new PublicKey('3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'),
];

// v11g: Helius Sender Tip Accounts (for staked connection routing via sender.helius-rpc.com)
export const HELIUS_SENDER_TIP_ACCOUNTS = [
  new PublicKey('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE'),
  new PublicKey('D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ'),
  new PublicKey('9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta'),
  new PublicKey('5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn'),
  new PublicKey('2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD'),
  new PublicKey('2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ'),
  new PublicKey('wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF'),
  new PublicKey('3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT'),
  new PublicKey('4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey'),
  new PublicKey('4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or'),
];

// v11g: Sender tip amount (10K lamports = 0.00001 SOL per TX)
export const SENDER_TIP_LAMPORTS = 10_000;

// v11g: Minimum total priority fee for staked routing (Helius docs recommend >= 10K lamports)
export const MIN_PRIORITY_FEE_LAMPORTS = 10_000;

// WSOL Mint
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// USDC Mint
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// USDT Mint
export const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

// Known stablecoins and major tokens to exclude from pump.fun detection
export const EXCLUDED_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112',  // WSOL
  '11111111111111111111111111111111',             // System Program
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
];

// System Program
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

// Sysvar Rent (to filter out invalid pool addresses)
export const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

// Token Program
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Associated Token Program
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Raydium AMM initialize2 instruction discriminator (first 8 bytes)
export const RAYDIUM_INIT2_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

// Jito Block Engine URLs
export const JITO_BLOCK_ENGINE_URLS = {
  mainnet: 'https://mainnet.block-engine.jito.wtf',
  amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
  frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
  ny: 'https://ny.mainnet.block-engine.jito.wtf',
  tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
};

// Jupiter API (public endpoint - has 0.2% platform fee on swaps)
export const JUPITER_API_BASE = 'https://public.jupiterapi.com';

// RugCheck API
export const RUGCHECK_API_BASE = 'https://api.rugcheck.xyz/v1';

// Bot version — updated on each meaningful code change for trade/rejection tracking
export const BOT_VERSION = 'v11m';

// Solscan base URL
export const SOLSCAN_BASE = 'https://solscan.io';
