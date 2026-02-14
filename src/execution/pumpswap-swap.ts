import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { logger } from '../utils/logger.js';
import {
  PUMPSWAP_AMM,
  PUMPSWAP_FEE_PROGRAM,
  PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
  PUMPFUN_PROGRAM,
  WSOL_MINT,
  HELIUS_SENDER_TIP_ACCOUNTS,
  SENDER_TIP_LAMPORTS,
  MIN_PRIORITY_FEE_LAMPORTS,
} from '../constants.js';
import type { Wallet } from '../core/wallet.js';
import type { TradeResult, DetectedPool } from '../types.js';
import { getCachedBlockhash } from '../utils/blockhash-cache.js';
import { pollConfirmation } from '../utils/confirm-tx.js';

// Dynamic priority fee cache (TTL 10s — fees don't change drastically between blocks)
let cachedPriorityFee: { fee: number; timestamp: number } | null = null;
const PRIORITY_FEE_CACHE_TTL_MS = 10_000;

async function getDynamicPriorityFee(
  connection: Connection,
  defaultFee: number,
): Promise<number> {
  // Return cached value if fresh
  if (cachedPriorityFee && (Date.now() - cachedPriorityFee.timestamp) < PRIORITY_FEE_CACHE_TTL_MS) {
    return cachedPriorityFee.fee;
  }

  try {
    // Helius getPriorityFeeEstimate (free RPC method)
    const response = await (connection as any)._rpcRequest('getPriorityFeeEstimate', [{
      accountKeys: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'], // PumpSwap program
      options: { priorityLevel: 'High' },
    }]);
    const estimate = response?.result?.priorityFeeEstimate;
    if (typeof estimate === 'number' && estimate > 0) {
      // Clamp between 50K and 500K microLamports (reasonable range)
      const clampedFee = Math.max(50_000, Math.min(500_000, Math.round(estimate)));
      cachedPriorityFee = { fee: clampedFee, timestamp: Date.now() };
      logger.info(`[pumpswap] Dynamic priority fee: ${clampedFee} µLamports (estimate: ${Math.round(estimate)})`);
      return clampedFee;
    }
  } catch {
    // Fallback silently — not all RPC providers support this method
  }

  cachedPriorityFee = { fee: defaultFee, timestamp: Date.now() };
  return defaultFee;
}

// Jito endpoints for multi-endpoint submission
const JITO_TX_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
];

// v11k: Backup RPCs for sell-path redundancy (independent infrastructure from Helius)
// Only used for sell path (~5 sells/hour max = no rate limit issues on free tier)
// Reads ALCHEMY_RPC_URL and QUICKNODE_RPC_URL from env for paid-tier backup (faster, more reliable)
const SELL_BACKUP_RPCS: string[] = [];
if (process.env.ALCHEMY_RPC_URL) SELL_BACKUP_RPCS.push(process.env.ALCHEMY_RPC_URL);
if (process.env.QUICKNODE_RPC_URL) SELL_BACKUP_RPCS.push(process.env.QUICKNODE_RPC_URL);
// Always include free-tier public RPCs as last resort
SELL_BACKUP_RPCS.push(
  'https://api.mainnet-beta.solana.com',    // Solana Foundation
  'https://solana-rpc.publicnode.com',       // PublicNode (independent infra)
);
const sellBackupConnections = SELL_BACKUP_RPCS.map(url => new Connection(url, 'confirmed'));
logger.info(`[pumpswap] Sell backup RPCs: ${SELL_BACKUP_RPCS.length} endpoints (${SELL_BACKUP_RPCS.length - 2} paid + 2 public)`);

// v11g: Helius Sender URL (staked connections, SWQOS-only)
let _senderUrl: string | null | undefined;
function getSenderUrl(): string | null {
  if (_senderUrl === undefined) {
    // Try HELIUS_API_KEY first, then extract from RPC_URL
    let key = process.env.HELIUS_API_KEY;
    if (!key) {
      const rpcUrl = process.env.RPC_URL || '';
      const match = rpcUrl.match(/api-key=([a-f0-9-]+)/i);
      if (match) key = match[1];
    }
    _senderUrl = key ? `https://sender.helius-rpc.com/fast?api-key=${key}&swqos_only=true` : null;
    if (_senderUrl) logger.info(`[pumpswap] Helius Sender endpoint configured`);
    else logger.warn(`[pumpswap] Helius Sender endpoint NOT configured (no API key found)`);
  }
  return _senderUrl;
}

// v11g: Enforce minimum total priority fee for staked routing (Helius recommends >= 10K lamports)
function enforcePriorityFeeFloor(
  cuPriceMicroLamports: number,
  computeUnits: number,
): { cuPrice: number; floorApplied: boolean } {
  const totalFeeLamports = Math.floor(cuPriceMicroLamports * computeUnits / 1_000_000);
  if (totalFeeLamports >= MIN_PRIORITY_FEE_LAMPORTS) {
    return { cuPrice: cuPriceMicroLamports, floorApplied: false };
  }
  const newCuPrice = Math.ceil(MIN_PRIORITY_FEE_LAMPORTS * 1_000_000 / computeUnits);
  logger.info(`[pumpswap] Priority fee floor: ${totalFeeLamports} < ${MIN_PRIORITY_FEE_LAMPORTS} lamports → ${cuPriceMicroLamports} → ${newCuPrice} µLamports (${computeUnits} CU)`);
  return { cuPrice: newCuPrice, floorApplied: true };
}

// buy_exact_quote_in discriminator: SHA256("global:buy_exact_quote_in") first 8 bytes
const BUY_EXACT_QUOTE_IN_DISCRIMINATOR = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

// sell discriminator: SHA256("global:sell") first 8 bytes
// Used when baseMint=WSOL (ALL PumpSwap pools): sell WSOL (base) to get TOKEN (quote) = BUY token
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// Fee config magic seed for PDA derivation
const FEE_CONFIG_MAGIC = Buffer.from([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
  244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

// Pool account layout offsets (Anchor: 8-byte discriminator + fields)
const POOL_LAYOUT = {
  discriminator: 0,   // 8 bytes
  poolBump: 8,        // u8
  index: 9,           // u16
  creator: 11,        // pubkey (32 bytes) - pool/LP creator
  baseMint: 43,       // pubkey
  quoteMint: 75,      // pubkey
  lpMint: 107,        // pubkey
  poolBaseTokenAccount: 139,  // pubkey
  poolQuoteTokenAccount: 171, // pubkey
  lpSupply: 203,      // u64 (8 bytes, ends at 210)
  coinCreator: 211,   // pubkey (32 bytes) - original token creator (used for fee PDA)
};

interface PumpSwapPoolState {
  creator: PublicKey;
  coinCreator: PublicKey; // Original token creator at offset 211 (used for creator_vault PDA)
  baseMint: PublicKey;  // Pool's baseMint (TOKEN for standard pump.fun pools)
  quoteMint: PublicKey; // Pool's quoteMint (WSOL for standard pump.fun pools)
  poolBaseTokenAccount: PublicKey;  // Pool's base vault
  poolQuoteTokenAccount: PublicKey; // Pool's quote vault
  baseMintIsWsol: boolean; // True if baseMint is WSOL (reversed pool)
}

export class PumpSwapSwap {
  // B1: Cache prefetched pool states to avoid re-reading during buy
  private poolStateCache = new Map<string, { state: PumpSwapPoolState; timestamp: number }>();
  private static readonly CACHE_TTL_MS = 30_000; // 30s TTL (must survive observation window + buy)

  // v10a: Track last sent TX signature for recovery when confirmation times out
  private lastSentSignature: string | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Wallet,
  ) {}

  /**
   * B1: Pre-read pool state during analysis (runs in parallel with scorer).
   * Saves ~566-1000ms by avoiding a sequential RPC read at buy time.
   * Returns the coinCreator pubkey for creator tracking (zero extra cost).
   */
  async prefetchPoolState(pool: DetectedPool): Promise<string | null> {
    try {
      const poolAddress = !pool.poolAddress.equals(pool.baseMint)
        ? pool.poolAddress
        : PumpSwapSwap.derivePoolAddress(pool.baseMint);
      const state = await this.getPoolState(poolAddress);
      if (state) {
        this.poolStateCache.set(poolAddress.toBase58(), { state, timestamp: Date.now() });
        logger.debug(`[pumpswap] Prefetched pool state for ${poolAddress.toBase58().slice(0, 8)}...`);
        const creatorStr = state.coinCreator.toBase58();
        // Skip system program (all zeros) - means coinCreator not populated (reversed pool)
        if (creatorStr !== '11111111111111111111111111111111') {
          return creatorStr;
        }
        // Fallback 1: try BondingCurve PDA (may be closed after migration)
        const tokenMint = state.baseMintIsWsol ? state.quoteMint : state.baseMint;
        const bcCreator = await this.getCreatorFromBondingCurve(tokenMint);
        if (bcCreator) return bcCreator;

        // Fallback 2: extract fee payer from pool creation TX (works even post-migration)
        if (pool.txSignature) {
          const txCreator = await this.getCreatorFromPoolTx(pool.txSignature);
          if (txCreator) return txCreator;
        }

        logger.debug(`[pumpswap] coinCreator unavailable: all 3 methods failed (coinCreator=System, BondingCurve closed, TX fallback failed)`);
        return null;
      }
      return null;
    } catch (err) {
      logger.debug(`[pumpswap] Prefetch failed (non-fatal): ${err}`);
      return null;
    }
  }

  /**
   * Fallback: Get token creator from pump.fun BondingCurve PDA.
   * BondingCurve account stores creator pubkey at offset 49 (32 bytes).
   * PDA: ["bonding-curve", tokenMint] under pump.fun program.
   */
  private async getCreatorFromBondingCurve(tokenMint: PublicKey): Promise<string | null> {
    try {
      const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
        PUMPFUN_PROGRAM,
      );
      // v9k: Route through analysis RPC pool
      const accountInfo = await withAnalysisRetry(
        (conn) => conn.getAccountInfo(bondingCurvePDA),
        this.connection,
      );
      if (!accountInfo || accountInfo.data.length < 81) {
        logger.debug(`[pumpswap] BondingCurve PDA not found for ${tokenMint.toBase58().slice(0, 8)}...`);
        return null;
      }
      // Creator is at offset 49, 32 bytes
      const creatorBytes = accountInfo.data.slice(49, 81);
      const creator = new PublicKey(creatorBytes);
      const creatorStr = creator.toBase58();
      // Sanity check: skip if system program
      if (creatorStr === '11111111111111111111111111111111') return null;
      logger.info(`[pumpswap] coinCreator from BondingCurve PDA: ${creatorStr.slice(0, 8)}...`);
      return creatorStr;
    } catch (err) {
      logger.debug(`[pumpswap] BondingCurve creator lookup failed (non-fatal): ${err}`);
      return null;
    }
  }

  /**
   * Fallback 2: Get creator candidate from pool creation TX fee payer.
   * The fee payer (accountKeys[0]) of the pool creation TX is typically the creator.
   * Works even when BondingCurve PDA is closed post-migration.
   * Cost: 1 RPC call, only called when both coinCreator and BondingCurve fail.
   */
  private async getCreatorFromPoolTx(txSignature: string): Promise<string | null> {
    try {
      // v9k: Route through analysis RPC pool
      const tx = await withAnalysisRetry(
        (conn) => conn.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 }),
        this.connection,
      );
      if (!tx?.transaction?.message?.accountKeys?.length) return null;

      const feePayer = tx.transaction.message.accountKeys[0];
      const feePayerStr = feePayer.pubkey.toBase58();

      // Skip if system program or known program IDs
      if (feePayerStr === '11111111111111111111111111111111') return null;
      if (feePayerStr === PUMPSWAP_AMM.toBase58()) return null;
      if (feePayerStr === PUMPFUN_PROGRAM.toBase58()) return null;

      logger.info(`[pumpswap] coinCreator from pool TX fee payer: ${feePayerStr.slice(0, 8)}...`);
      return feePayerStr;
    } catch (err) {
      logger.debug(`[pumpswap] Pool TX creator lookup failed (non-fatal): ${err}`);
      return null;
    }
  }

  private getCachedPoolState(poolAddress: PublicKey): PumpSwapPoolState | null {
    const key = poolAddress.toBase58();
    const cached = this.poolStateCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < PumpSwapSwap.CACHE_TTL_MS) {
      // Don't delete yet - observation window may have used it and buy still needs it
      // Cache auto-expires after CACHE_TTL_MS (30s)
      logger.info(`[pumpswap] Using prefetched pool state (saved ~600ms)`);
      return cached.state;
    }
    this.poolStateCache.delete(key); // Expired
    return null;
  }

  /**
   * Derive the PumpSwap pool PDA from a token mint.
   */
  static derivePoolAddress(tokenMint: PublicKey, quoteMint: PublicKey = WSOL_MINT, index = 0): PublicKey {
    // Step 1: Derive pool-authority PDA from PumpFun program
    const [poolAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool-authority'), tokenMint.toBuffer()],
      PUMPFUN_PROGRAM,
    );

    // Step 2: Encode index as u16 LE
    const indexBuf = Buffer.alloc(2);
    indexBuf.writeUInt16LE(index, 0);

    // Step 3: Derive pool PDA from PumpSwap AMM program
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('pool'),
        indexBuf,
        poolAuthority.toBuffer(),
        tokenMint.toBuffer(),
        quoteMint.toBuffer(),
      ],
      PUMPSWAP_AMM,
    );

    return poolPDA;
  }

  /**
   * Buy tokens directly via PumpSwap AMM.
   * Uses buy_exact_quote_in: specify SOL amount, get tokens.
   * @param poolAddressOverride - Use this pool address instead of deriving from mint
   */
  async buy(tokenMint: PublicKey, amountInLamports: number, slippageBps: number, poolAddressOverride?: PublicKey): Promise<TradeResult> {
    const startTime = Date.now();

    try {
      // Step 1: Use provided pool address or derive from token mint
      const poolAddress = poolAddressOverride || PumpSwapSwap.derivePoolAddress(tokenMint);
      logger.info(`[pumpswap] Starting swap for ${tokenMint.toBase58().slice(0, 8)}... pool=${poolAddress.toBase58().slice(0, 8)}... (${poolAddressOverride ? 'detected' : 'derived'})`);

      // Step 2: Read pool state (check cache from prefetch first)
      const poolState = this.getCachedPoolState(poolAddress) ?? await this.getPoolState(poolAddress);
      if (!poolState) {
        return this.failResult(amountInLamports, 'Failed to read pool state');
      }

      // Verify the pool contains our token
      const poolHasToken = poolState.baseMint.equals(tokenMint) || poolState.quoteMint.equals(tokenMint);
      if (!poolHasToken) {
        return this.failResult(amountInLamports, `Pool doesn't contain token: expected ${tokenMint.toBase58().slice(0, 8)}, found base=${poolState.baseMint.toBase58().slice(0, 8)} quote=${poolState.quoteMint.toBase58().slice(0, 8)}`);
      }

      // Pool orientation: baseMint=WSOL (reversed) or baseMint=TOKEN (standard)
      // Both are supported - instruction type changes based on orientation
      const isReversed = poolState.baseMintIsWsol;

      // Step 3: Derive all accounts (initially with standard Token Program, may be re-derived later)
      let userBaseAta = await getAssociatedTokenAddress(poolState.baseMint, this.wallet.publicKey);
      let userQuoteAta = await getAssociatedTokenAddress(poolState.quoteMint, this.wallet.publicKey);

      // Semantic aliases: which ATA is WSOL and which is TOKEN
      const userWsolAta = isReversed ? userBaseAta : userQuoteAta;
      let userTokenAta = isReversed ? userQuoteAta : userBaseAta;

      // Derive PDAs
      const [globalConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('global_config')],
        PUMPSWAP_AMM,
      );
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        PUMPSWAP_AMM,
      );
      const [creatorVaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), poolState.coinCreator.toBuffer()],
        PUMPSWAP_AMM,
      );
      // creatorVaultAta will be re-derived after we know the token program (below)
      let creatorVaultAta: PublicKey; // placeholder
      const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from('global_volume_accumulator')],
        PUMPSWAP_AMM,
      );
      const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), this.wallet.publicKey.toBuffer()],
        PUMPSWAP_AMM,
      );
      const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee_config'), FEE_CONFIG_MAGIC],
        PUMPSWAP_FEE_PROGRAM,
      );

      // Step 4: Pre-derive fee ATAs assuming standard TOKEN_PROGRAM_ID (99% of tokens)
      // This lets us batch ALL account fetches into ONE RPC call (saves ~600ms)
      const feeMint = poolState.quoteMint;
      const [protocolFeeAtaPreDerived, creatorVaultAtaPreDerived] = await Promise.all([
        getAssociatedTokenAddress(feeMint, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, true, TOKEN_PROGRAM_ID),
        getAssociatedTokenAddress(feeMint, creatorVaultAuthority, true, TOKEN_PROGRAM_ID),
      ]);

      // ONE big parallel fetch: vaults (for reserves + Token Program) + ATAs + blockhash
      // Merges what was 2 separate RPC rounds into 1
      // v8s: blockhash from pre-cache (0ms vs 100-300ms RPC call)
      // v9h: Use analysis RPCs for batch fetch to avoid 429 on Helius primary
      const [batchAccountInfos, blockInfo] = await Promise.all([
        withAnalysisRetry(
          (conn) => conn.getMultipleAccountsInfo([
            poolState.poolBaseTokenAccount,   // [0] baseVault → reserves + Token Program
            poolState.poolQuoteTokenAccount,  // [1] quoteVault → reserves + Token Program
            userWsolAta,                       // [2] user WSOL ATA existence
            userTokenAta,                      // [3] user Token ATA existence (may need re-derive for Token-2022)
            creatorVaultAtaPreDerived,         // [4] creator vault ATA existence
            protocolFeeAtaPreDerived,          // [5] protocol fee ATA existence
          ]),
          this.connection,
        ),
        getCachedBlockhash(this.connection),
      ]);

      // Parse reserves from vault accounts
      const baseVaultInfo = batchAccountInfos[0];
      const quoteVaultInfo = batchAccountInfos[1];
      if (!baseVaultInfo || !quoteVaultInfo) {
        return this.failResult(amountInLamports, 'Vault accounts not found');
      }

      const reserves = {
        baseReserve: Number(baseVaultInfo.data.readBigUInt64LE(64)),
        quoteReserve: Number(quoteVaultInfo.data.readBigUInt64LE(64)),
        baseTokenProgram: baseVaultInfo.owner,
        quoteTokenProgram: quoteVaultInfo.owner,
      };

      // Determine the correct Token Program for each side
      const baseTokenProgramId = reserves.baseTokenProgram;
      const quoteTokenProgramId = reserves.quoteTokenProgram;
      const tokenProgramId = isReversed ? quoteTokenProgramId : baseTokenProgramId;
      const feeTokenProgram = quoteTokenProgramId;

      // ATA existence from batch fetch
      let ataInfos = [batchAccountInfos[2], batchAccountInfos[3], batchAccountInfos[4], batchAccountInfos[5]];

      // Handle Token-2022: re-derive affected ATAs (rare, <1% of tokens)
      let userWsolAtaFinal = userWsolAta;
      let userTokenAtaFinal = userTokenAta;
      if (!tokenProgramId.equals(TOKEN_PROGRAM_ID) || !feeTokenProgram.equals(TOKEN_PROGRAM_ID)) {
        logger.info(`[pumpswap] Token uses Token-2022 program - re-deriving ATAs`);
        // Re-derive token ATA with correct program
        if (!tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
          userTokenAtaFinal = await getAssociatedTokenAddress(
            isReversed ? poolState.quoteMint : poolState.baseMint,
            this.wallet.publicKey, false, tokenProgramId,
          );
          if (isReversed) userQuoteAta = userTokenAtaFinal;
          else userBaseAta = userTokenAtaFinal;
        }
        // Re-derive fee ATAs if needed
        const [protocolFeeAtaNew, creatorVaultAtaNew] = await Promise.all([
          getAssociatedTokenAddress(feeMint, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, true, feeTokenProgram),
          getAssociatedTokenAddress(feeMint, creatorVaultAuthority, true, feeTokenProgram),
        ]);
        creatorVaultAta = creatorVaultAtaNew;
        // Re-check all 4 ATAs (extra RPC call only for Token-2022)
        ataInfos = await this.connection.getMultipleAccountsInfo([
          userWsolAtaFinal, userTokenAtaFinal, creatorVaultAta, protocolFeeAtaNew,
        ]) as any;
      } else {
        creatorVaultAta = creatorVaultAtaPreDerived;
      }
      const protocolFeeAta = !feeTokenProgram.equals(TOKEN_PROGRAM_ID)
        ? await getAssociatedTokenAddress(feeMint, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, true, feeTokenProgram)
        : protocolFeeAtaPreDerived;

      // Pre-flight balance check: count ATAs that need creation and verify we have enough SOL
      // Each ATA creation costs ~0.00204 SOL in rent. Without this, we get cryptic Custom(1) errors.
      // v8t: Track ATA overhead separately — creator_vault_ata rent is IRRECOVERABLE (~0.002 SOL/trade)
      const atasToCreate = ataInfos.filter(a => !a).length;
      const irrecoverableAtas = (!ataInfos[2] ? 1 : 0) + (!ataInfos[3] ? 1 : 0); // creator vault + protocol fee
      if (atasToCreate > 0) {
        const ATA_RENT = 2_039_280; // lamports per ATA
        const totalAtaCost = atasToCreate * ATA_RENT;
        const irrecoverableCost = irrecoverableAtas * ATA_RENT;
        const totalNeeded = amountInLamports + 500_000 + totalAtaCost + 300_000; // trade + wrap buffer + ATAs + fees
        const userBalance = await this.connection.getBalance(this.wallet.publicKey);
        if (userBalance < totalNeeded) {
          const needed = (totalNeeded / 1e9).toFixed(4);
          const have = (userBalance / 1e9).toFixed(4);
          return this.failResult(amountInLamports, `Insufficient SOL: need ${needed} (trade+${atasToCreate}ATAs+fees) but have ${have}`);
        }
        // v8t: Log irrecoverable ATA cost as hidden overhead
        if (irrecoverableAtas > 0) {
          const overheadPct = ((irrecoverableCost / amountInLamports) * 100).toFixed(1);
          logger.warn(`[pumpswap] ATA overhead: ${irrecoverableAtas} irrecoverable ATAs = ${(irrecoverableCost / 1e9).toFixed(4)} SOL (${overheadPct}% of trade)`);
        }
        logger.debug(`[pumpswap] Need ${atasToCreate} ATA creations, total cost: ${(totalAtaCost / 1e9).toFixed(4)} SOL`);
      }

      // Step 5: Calculate expected output
      // For reversed pools (baseMint=WSOL): baseReserve = SOL, quoteReserve = TOKEN
      // For standard pools (baseMint=TOKEN): baseReserve = TOKEN, quoteReserve = SOL
      const solReserve = isReversed ? reserves.baseReserve : reserves.quoteReserve;
      const tokenReserve = isReversed ? reserves.quoteReserve : reserves.baseReserve;

      // Use BigInt for AMM math to avoid overflow (tokenReserve * amount > MAX_SAFE_INTEGER)
      const feeBps = 30n; // 0.3% total fee
      const bSolReserve = BigInt(solReserve);
      const bTokenReserve = BigInt(tokenReserve);
      const bAmountIn = BigInt(amountInLamports);
      const bSlippage = BigInt(slippageBps);

      let expectedTokens: number;
      if (isReversed) {
        // sell instruction: fee deducted from base input (WSOL)
        const netIn = bAmountIn * (10000n - feeBps) / 10000n;
        expectedTokens = Number(netIn * bTokenReserve / (bSolReserve + netIn));
      } else {
        // buy_exact_quote_in: fee deducted from base output
        const rawTokens = bAmountIn * bTokenReserve / (bSolReserve + bAmountIn);
        expectedTokens = Number(rawTokens * (10000n - feeBps) / 10000n);
      }
      const minTokensOut = Number(BigInt(expectedTokens) * (10000n - bSlippage) / 10000n);

      logger.info(
        `[pumpswap] Reserves: token=${tokenReserve}, sol=${solReserve}. ` +
        `Expected: ${expectedTokens} tokens, min: ${minTokensOut} (${(slippageBps / 100).toFixed(0)}% slippage)`,
      );

      if (expectedTokens <= 0) {
        return this.failResult(amountInLamports, 'Expected output is 0 (pool may be empty)');
      }

      // Step 6: Build transaction
      const transaction = new Transaction();

      // Dynamic priority fees (v8l): adapts to network congestion
      // Fallback: 200K µLamports if RPC doesn't support getPriorityFeeEstimate
      const buyPriorityFee = await getDynamicPriorityFee(this.connection, 200_000);
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: buyPriorityFee }),
      );

      // Create WSOL ATA if needed
      if (!ataInfos[0]) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            this.wallet.publicKey,
            userWsolAta,
            this.wallet.publicKey,
            WSOL_MINT,
          ),
        );
      }

      // Wrap SOL → WSOL (add extra buffer for fees/rent)
      const wrapAmount = amountInLamports + 500_000; // 0.0005 SOL buffer
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: userWsolAta,
          lamports: wrapAmount,
        }),
        createSyncNativeInstruction(userWsolAta),
      );

      // Create token ATA if needed (use correct Token Program for the mint)
      if (!ataInfos[1]) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            this.wallet.publicKey,
            userTokenAtaFinal,
            this.wallet.publicKey,
            tokenMint,
            tokenProgramId,
          ),
        );
      }

      // v8t: Create creator vault ATA if it doesn't exist (feeMint = quoteMint)
      // Uses idempotent instruction: safe against race conditions (another bot creating ATA between our check and TX)
      if (!ataInfos[2]) {
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            this.wallet.publicKey,
            creatorVaultAta,
            creatorVaultAuthority,
            feeMint,
            feeTokenProgram,
          ),
        );
      }

      // v8t: Create protocol fee ATA if it doesn't exist (feeMint = quoteMint)
      if (!ataInfos[3]) {
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            this.wallet.publicKey,
            protocolFeeAta,
            PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
            feeMint,
            feeTokenProgram,
          ),
        );
      }

      // Build swap instruction data (24 bytes: 8 discriminator + 8 amount_in + 8 min_out)
      const data = Buffer.alloc(24);
      if (isReversed) {
        // sell: sell base (WSOL) → get quote (TOKEN) = BUY token
        SELL_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(BigInt(amountInLamports), 8); // base_amount_in (WSOL to sell)
        data.writeBigUInt64LE(BigInt(minTokensOut), 16);     // min_quote_amount_out (min TOKEN)
      } else {
        // buy_exact_quote_in: spend quote (WSOL) → get base (TOKEN) = BUY token
        BUY_EXACT_QUOTE_IN_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(BigInt(amountInLamports), 8); // spendable_quote_in (WSOL to pay)
        data.writeBigUInt64LE(BigInt(minTokensOut), 16);     // min_base_amount_out (min TOKEN)
      }

      // Build account keys - sell and buy have different layouts
      const baseAccounts = [
        { pubkey: poolAddress, isSigner: false, isWritable: true },                       // 0: pool
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },              // 1: user
        { pubkey: globalConfig, isSigner: false, isWritable: false },                     // 2: global_config
        { pubkey: poolState.baseMint, isSigner: false, isWritable: false },               // 3: base_mint
        { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },              // 4: quote_mint
        { pubkey: userBaseAta, isSigner: false, isWritable: true },                       // 5: user_base_token_account
        { pubkey: userQuoteAta, isSigner: false, isWritable: true },                      // 6: user_quote_token_account
        { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },    // 7: pool_base_token_account
        { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },   // 8: pool_quote_token_account
        { pubkey: PUMPSWAP_PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },  // 9: protocol_fee_recipient
        { pubkey: protocolFeeAta, isSigner: false, isWritable: true },                    // 10: protocol_fee_recipient_ata
        { pubkey: baseTokenProgramId, isSigner: false, isWritable: false },                 // 11: base_token_program
        { pubkey: quoteTokenProgramId, isSigner: false, isWritable: false },              // 12: quote_token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },          // 13: system_program
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 14: associated_token_program
        { pubkey: eventAuthority, isSigner: false, isWritable: false },                   // 15: event_authority
        { pubkey: PUMPSWAP_AMM, isSigner: false, isWritable: false },                     // 16: program
        { pubkey: creatorVaultAta, isSigner: false, isWritable: true },                   // 17: creator_vault_token_account
        { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },            // 18: creator_vault_authority
      ];

      let keys;
      if (isReversed) {
        // sell instruction: 21 accounts (NO volume accumulators)
        keys = [
          ...baseAccounts,
          { pubkey: feeConfig, isSigner: false, isWritable: false },                      // 19: fee_config
          { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },           // 20: fee_program
        ];
      } else {
        // buy_exact_quote_in: 23 accounts (includes volume accumulators)
        keys = [
          ...baseAccounts,
          { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },         // 19: global_volume_accumulator
          { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },           // 20: user_volume_accumulator
          { pubkey: feeConfig, isSigner: false, isWritable: false },                      // 21: fee_config
          { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },           // 22: fee_program
        ];
      }

      const buyIx = new TransactionInstruction({
        programId: PUMPSWAP_AMM,
        keys,
        data,
      });

      transaction.add(buyIx);

      // Close WSOL account to recover rent
      transaction.add(
        createCloseAccountInstruction(userWsolAta, this.wallet.publicKey, this.wallet.publicKey),
      );

      // v11g: Sender tip for staked connection routing (after close WSOL to ensure SOL available)
      const tipAccount = HELIUS_SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_SENDER_TIP_ACCOUNTS.length)];
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: tipAccount,
          lamports: SENDER_TIP_LAMPORTS,
        }),
      );

      // Step 7: Sign, simulate, optimize CU, and send
      transaction.recentBlockhash = blockInfo.blockhash;
      transaction.feePayer = this.wallet.publicKey;
      transaction.sign(this.wallet.keypair);

      // PROTECTION: Simulate before sending (FREE RPC call - catches errors without burning fees)
      const simResult = await this.connection.simulateTransaction(transaction);
      if (simResult.value.err) {
        const simError = JSON.stringify(simResult.value.err);
        logger.warn(`[pumpswap] Simulation FAILED (saved ~0.0003 SOL in fees): ${simError}`);
        return this.failResult(amountInLamports, `Simulation failed: ${simError}`);
      }

      // v8s: CU optimization — use actual CU from simulation + 15% margin instead of 300K hardcoded
      let txToSend = transaction;
      const unitsConsumed = simResult.value.unitsConsumed;
      if (unitsConsumed && unitsConsumed > 0) {
        const optimizedCU = Math.ceil(unitsConsumed * 1.15);
        transaction.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: optimizedCU });
        // v11g: Enforce priority fee floor (10K lamports min for staked routing)
        const { cuPrice: finalBuyCuPrice, floorApplied: buyFloorApplied } = enforcePriorityFeeFloor(buyPriorityFee, optimizedCU);
        if (buyFloorApplied) {
          transaction.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: finalBuyCuPrice });
        }
        // Re-sign with updated instructions (single re-sign for both CU + fee floor)
        transaction.signatures = [];
        transaction.sign(this.wallet.keypair);
        txToSend = transaction;
        logger.info(`[pumpswap] CU optimized: 300000 → ${optimizedCU} (sim: ${unitsConsumed})${buyFloorApplied ? ` [fee floor: ${finalBuyCuPrice} µL]` : ''}`);
      } else {
        logger.debug('[pumpswap] Simulation passed (no CU data), sending with 300K CU...');
      }

      const signature = await this.sendMultiEndpoint(
        txToSend,
        blockInfo.lastValidBlockHeight,
        blockInfo.blockhash,
      );

      const elapsed = Date.now() - startTime;
      logger.info(`[pumpswap] Swap sent in ${elapsed}ms: ${signature}`);

      const pricePerToken = (amountInLamports / 1e9) / expectedTokens; // SOL per base unit

      // v8t: Track irrecoverable ATA overhead (creator vault + protocol fee ATAs we paid for)
      const ATA_RENT_LAMPORTS = 2_039_280;
      const ataOverhead = irrecoverableAtas * ATA_RENT_LAMPORTS;

      return {
        success: true,
        txSignature: signature,
        inputAmount: amountInLamports,
        outputAmount: expectedTokens,
        pricePerToken,
        fee: 5000,
        timestamp: Date.now(),
        poolReserves: { solLamports: solReserve },
        ataOverheadLamports: ataOverhead,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
      logger.error(`[pumpswap] Swap failed: ${errorMsg}`);
      // v10a: If TX was broadcast but confirmation failed, include signature for recovery
      const result = this.failResult(amountInLamports, errorMsg);
      if (this.lastSentSignature && errorMsg.includes('TX confirmation error')) {
        result.txSignature = this.lastSentSignature;
        this.lastSentSignature = null;
      }
      return result;
    }
  }

  /**
   * Convenience method for DetectedPool.
   * Uses the detected pool address if available, otherwise derives it.
   */
  async buyFromPool(pool: DetectedPool, amountInLamports: number, slippageBps: number): Promise<TradeResult> {
    // Use detected pool address if it's different from the token mint (which is the fallback)
    const hasDetectedPool = !pool.poolAddress.equals(pool.baseMint);
    return this.buy(
      pool.baseMint,
      amountInLamports,
      slippageBps,
      hasDetectedPool ? pool.poolAddress : undefined,
    );
  }

  /**
   * v11g: Simulate a sell TX to detect honeypots BEFORE committing to position management.
   * Called immediately after buy success. Uses cached pool state from buy.
   * Returns { sellable: true } if simulation passes, or { sellable: false, error } if honeypot.
   * On any error (RPC fail, timeout), returns sellable=true to avoid blocking legitimate trades.
   * Cost: 0 SOL (simulation is free). Latency: ~200-500ms (1 RPC call).
   */
  async simulateSellCheck(
    tokenMint: PublicKey,
    tokenAmount: number,
    poolAddressOverride?: PublicKey,
  ): Promise<{ sellable: boolean; error?: string }> {
    const start = Date.now();
    try {
      const poolAddress = poolAddressOverride || PumpSwapSwap.derivePoolAddress(tokenMint);
      const poolState = this.getCachedPoolState(poolAddress) || await this.getPoolState(poolAddress);
      if (!poolState) return { sellable: true }; // Can't check, assume OK

      const isReversed = poolState.baseMintIsWsol;

      // Derive user ATAs (same as sell)
      const userBaseAta = await getAssociatedTokenAddress(poolState.baseMint, this.wallet.publicKey);
      const userQuoteAta = await getAssociatedTokenAddress(poolState.quoteMint, this.wallet.publicKey);
      const userWsolAta = isReversed ? userBaseAta : userQuoteAta;
      const userTokenAta = isReversed ? userQuoteAta : userBaseAta;

      // Get reserves + blockhash in parallel
      const [reserves, blockInfo] = await Promise.all([
        this.getReservesFromConn(poolState.poolBaseTokenAccount, poolState.poolQuoteTokenAccount, this.connection),
        getCachedBlockhash(this.connection),
      ]);

      // Token programs
      const baseTokenProgramId = reserves.baseTokenProgram;
      const quoteTokenProgramId = reserves.quoteTokenProgram;

      // Fee ATAs
      const feeMint = poolState.quoteMint;
      const feeTokenProgram = quoteTokenProgramId;
      const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMPSWAP_AMM);
      const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMPSWAP_AMM);
      const [creatorVaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), poolState.coinCreator.toBuffer()], PUMPSWAP_AMM,
      );
      const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMPSWAP_AMM);
      const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), this.wallet.publicKey.toBuffer()], PUMPSWAP_AMM,
      );
      const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from('fee_config'), FEE_CONFIG_MAGIC], PUMPSWAP_FEE_PROGRAM);
      const protocolFeeAta = await getAssociatedTokenAddress(feeMint, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, true, feeTokenProgram);
      const creatorVaultAta = await getAssociatedTokenAddress(feeMint, creatorVaultAuthority, true, feeTokenProgram);

      // Use small test amount (min 1 token, max 1% of holdings)
      const testAmount = Math.max(1, Math.min(Math.floor(tokenAmount * 0.01), 10000));

      // Build instruction data
      const data = Buffer.alloc(24);
      if (isReversed) {
        BUY_EXACT_QUOTE_IN_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(BigInt(testAmount), 8);
        data.writeBigUInt64LE(0n, 16); // min_out = 0 (just testing sellability)
      } else {
        SELL_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(BigInt(testAmount), 8);
        data.writeBigUInt64LE(0n, 16);
      }

      // Build account keys (same layout as sell)
      const baseAccounts = [
        { pubkey: poolAddress, isSigner: false, isWritable: true },
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        { pubkey: poolState.baseMint, isSigner: false, isWritable: false },
        { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },
        { pubkey: userBaseAta, isSigner: false, isWritable: true },
        { pubkey: userQuoteAta, isSigner: false, isWritable: true },
        { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: PUMPSWAP_PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
        { pubkey: protocolFeeAta, isSigner: false, isWritable: true },
        { pubkey: baseTokenProgramId, isSigner: false, isWritable: false },
        { pubkey: quoteTokenProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: PUMPSWAP_AMM, isSigner: false, isWritable: false },
        { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
        { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },
      ];

      let keys;
      if (isReversed) {
        keys = [
          ...baseAccounts,
          { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
          { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
          { pubkey: feeConfig, isSigner: false, isWritable: false },
          { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },
        ];
      } else {
        keys = [
          ...baseAccounts,
          { pubkey: feeConfig, isSigner: false, isWritable: false },
          { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },
        ];
      }

      // Build minimal TX (no ATA creates — they already exist post-buy)
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

      // WSOL ATA might be closed after buy — create it for simulation
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        this.wallet.publicKey, userWsolAta, this.wallet.publicKey, WSOL_MINT,
      ));

      tx.add(new TransactionInstruction({ programId: PUMPSWAP_AMM, keys, data }));
      tx.recentBlockhash = blockInfo.blockhash;
      tx.feePayer = this.wallet.publicKey;
      tx.sign(this.wallet.keypair);

      const simResult = await Promise.race([
        this.connection.simulateTransaction(tx),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);

      const elapsed = Date.now() - start;

      if (!simResult) {
        logger.warn(`[honeypot-sim] Simulation timeout (5s) — assuming sellable (${elapsed}ms)`);
        return { sellable: true };
      }

      if (simResult.value.err) {
        const errStr = JSON.stringify(simResult.value.err);
        // Custom:6024 = PumpSwap sell blocked, Custom:6001 = insufficient output (pool drain),
        // Custom:6025 = another PumpSwap error variant
        const isHoneypotError = errStr.includes('6024') || errStr.includes('6025');
        if (isHoneypotError) {
          logger.warn(`[honeypot-sim] 🚨 HONEYPOT DETECTED in ${elapsed}ms: ${errStr}`);
          return { sellable: false, error: `Honeypot: ${errStr}` };
        }
        // Other errors (insufficient balance edge case, etc.) — not honeypot
        logger.info(`[honeypot-sim] Sim error (not honeypot) in ${elapsed}ms: ${errStr}`);
        return { sellable: true, error: `Sim error: ${errStr}` };
      }

      logger.info(`[honeypot-sim] ✅ Sell simulation passed in ${elapsed}ms — token is sellable`);
      return { sellable: true };
    } catch (err) {
      logger.warn(`[honeypot-sim] Check failed (assuming sellable): ${String(err)}`);
      return { sellable: true }; // Don't block trades on RPC errors
    }
  }

  /**
   * Sell tokens back to SOL via PumpSwap AMM.
   * Supports both pool orientations:
   * - Reversed (baseMint=WSOL): buy_exact_quote_in (spend TOKEN quote → get WSOL base)
   * - Standard (baseMint=TOKEN): sell (sell TOKEN base → get WSOL quote)
   */
  async sell(tokenMint: PublicKey, tokenAmount: number, slippageBps: number, poolAddressOverride?: PublicKey, force = false, skipSimulation = false, cancelFlag?: { cancelled: boolean }): Promise<TradeResult> {
    const startTime = Date.now();

    try {
      const poolAddress = poolAddressOverride || PumpSwapSwap.derivePoolAddress(tokenMint);
      logger.info(`[pumpswap-sell] Selling ${tokenMint.toBase58().slice(0, 8)}... pool=${poolAddress.toBase58().slice(0, 8)}...`);

      // v11k: Use cached pool state first (pool structure doesn't change, saves RPC on retries)
      // Parallel backup: fire Helius + backup RPCs simultaneously if cache miss
      let poolState = this.getCachedPoolState(poolAddress);
      if (!poolState) {
        try {
          const accountInfo = await this.withSellBackup(
            (conn) => conn.getAccountInfo(poolAddress),
          );
          if (accountInfo?.data) {
            poolState = this.parsePoolData(accountInfo.data);
          }
        } catch (err) {
          logger.warn(`[pumpswap-sell] All RPCs failed for pool state: ${err}`);
        }
        // v11k: Cache the pool state for subsequent sell retries (saves RPC on retry)
        if (poolState) {
          this.poolStateCache.set(poolAddress.toBase58(), { state: poolState, timestamp: Date.now() });
        }
      }
      if (!poolState) {
        return this.failResult(tokenAmount, 'Failed to read pool state');
      }

      const isReversed = poolState.baseMintIsWsol;
      // For sell, output is always WSOL regardless of orientation
      // - Reversed: buy_exact_quote_in output = base (WSOL)
      // - Standard: sell output = quote (WSOL)

      // Derive accounts
      let userBaseAta = await getAssociatedTokenAddress(poolState.baseMint, this.wallet.publicKey);
      let userQuoteAta = await getAssociatedTokenAddress(poolState.quoteMint, this.wallet.publicKey);

      // Semantic aliases
      const userWsolAta = isReversed ? userBaseAta : userQuoteAta;
      let userTokenAta = isReversed ? userQuoteAta : userBaseAta;

      // Derive PDAs
      const [globalConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('global_config')], PUMPSWAP_AMM,
      );
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')], PUMPSWAP_AMM,
      );
      const [creatorVaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), poolState.coinCreator.toBuffer()], PUMPSWAP_AMM,
      );
      const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from('global_volume_accumulator')], PUMPSWAP_AMM,
      );
      const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), this.wallet.publicKey.toBuffer()], PUMPSWAP_AMM,
      );
      const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee_config'), FEE_CONFIG_MAGIC], PUMPSWAP_FEE_PROGRAM,
      );

      // v11k: Batch ALL sell-path account reads into ONE RPC call (saves 1-2 round trips)
      // Reserves (vaults) + ATAs + blockhash all in parallel
      const feeMint = poolState.quoteMint;
      // Pre-derive fee ATAs assuming TOKEN_PROGRAM_ID (99% of pools)
      const [creatorVaultAtaPreDerived, protocolFeeAtaPreDerived] = await Promise.all([
        getAssociatedTokenAddress(feeMint, creatorVaultAuthority, true, TOKEN_PROGRAM_ID),
        getAssociatedTokenAddress(feeMint, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, true, TOKEN_PROGRAM_ID),
      ]);

      // v10d: Check cancel flag before expensive RPC calls
      if (cancelFlag?.cancelled) {
        return this.failResult(tokenAmount, 'Cancelled: parallel sell already succeeded');
      }

      // ONE batch fetch: vaults (reserves + token program) + all 4 ATAs + blockhash
      const [batchInfos, blockInfo] = await Promise.all([
        this.withSellBackup((conn) => conn.getMultipleAccountsInfo([
          poolState!.poolBaseTokenAccount,   // [0] base vault → reserves + token program
          poolState!.poolQuoteTokenAccount,  // [1] quote vault → reserves + token program
          userWsolAta,                        // [2] user WSOL ATA
          userTokenAta,                       // [3] user Token ATA
          creatorVaultAtaPreDerived,          // [4] creator vault ATA
          protocolFeeAtaPreDerived,           // [5] protocol fee ATA
        ])),
        getCachedBlockhash(this.connection),
      ]);

      const baseVaultInfo = batchInfos[0];
      const quoteVaultInfo = batchInfos[1];
      if (!baseVaultInfo || !quoteVaultInfo) {
        return this.failResult(tokenAmount, 'Failed to get pool reserves');
      }

      const reserves = {
        baseReserve: Number(baseVaultInfo.data.readBigUInt64LE(64)),
        quoteReserve: Number(quoteVaultInfo.data.readBigUInt64LE(64)),
        baseTokenProgram: baseVaultInfo.owner,
        quoteTokenProgram: quoteVaultInfo.owner,
      };

      // Token program detection
      const baseTokenProgramId = reserves.baseTokenProgram;
      const quoteTokenProgramId = reserves.quoteTokenProgram;
      const tokenProgramId = isReversed ? quoteTokenProgramId : baseTokenProgramId;
      const feeTokenProgram = quoteTokenProgramId;

      let creatorVaultAta = creatorVaultAtaPreDerived;
      let protocolFeeAta = protocolFeeAtaPreDerived;
      let ataInfos = [batchInfos[2], batchInfos[3], batchInfos[4], batchInfos[5]];

      // Re-derive ATAs if Token-2022 (rare, <1% of tokens)
      if (!tokenProgramId.equals(TOKEN_PROGRAM_ID) || !feeTokenProgram.equals(TOKEN_PROGRAM_ID)) {
        logger.info(`[pumpswap-sell] Token uses Token-2022 — re-deriving ATAs`);
        if (!tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
          userTokenAta = await getAssociatedTokenAddress(
            isReversed ? poolState.quoteMint : poolState.baseMint,
            this.wallet.publicKey, false, tokenProgramId,
          );
          if (isReversed) userQuoteAta = userTokenAta;
          else userBaseAta = userTokenAta;
        }
        if (!feeTokenProgram.equals(TOKEN_PROGRAM_ID)) {
          [creatorVaultAta, protocolFeeAta] = await Promise.all([
            getAssociatedTokenAddress(feeMint, creatorVaultAuthority, true, feeTokenProgram),
            getAssociatedTokenAddress(feeMint, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, true, feeTokenProgram),
          ]);
        }
        // Re-fetch ATAs with correct addresses (only for Token-2022)
        ataInfos = await this.withSellBackup(
          (conn) => conn.getMultipleAccountsInfo([userWsolAta, userTokenAta, creatorVaultAta, protocolFeeAta]),
        ) as any;
      }

      // Query actual token balance from ATA (handles Token-2022 transfer fees)
      let actualTokenAmount = tokenAmount;
      let actualAtaBalance = 0;
      if (ataInfos[1] && ataInfos[1].data.length >= 72) {
        actualAtaBalance = Number(ataInfos[1].data.readBigUInt64LE(64));
        if (actualAtaBalance < Math.floor(tokenAmount)) {
          logger.warn(`[pumpswap-sell] Actual balance ${actualAtaBalance} < requested ${Math.floor(tokenAmount)}, using actual`);
          actualTokenAmount = actualAtaBalance;
        }
      }

      if (actualTokenAmount <= 0) {
        return this.failResult(tokenAmount, 'Token balance is 0 (already sold or transferred)');
      }

      // Calculate expected SOL output using BigInt
      const solReserve = isReversed ? reserves.baseReserve : reserves.quoteReserve;
      const tokenReserve = isReversed ? reserves.quoteReserve : reserves.baseReserve;
      const bSolReserve = BigInt(solReserve);
      const bTokenReserve = BigInt(tokenReserve);
      const bTokenAmount = BigInt(Math.floor(actualTokenAmount));
      const feeBps = 30n; // 0.3%

      let expectedSolOut: number;
      if (isReversed) {
        // buy_exact_quote_in: fee from output (WSOL base)
        const rawSolOut = bTokenAmount * bSolReserve / (bTokenReserve + bTokenAmount);
        expectedSolOut = Number(rawSolOut * (10000n - feeBps) / 10000n);
      } else {
        // sell: fee from input (TOKEN base)
        const netIn = bTokenAmount * (10000n - feeBps) / 10000n;
        expectedSolOut = Number(netIn * bSolReserve / (bTokenReserve + netIn));
      }
      let minSolOut = Number(BigInt(expectedSolOut) * (10000n - BigInt(slippageBps)) / 10000n);

      // In force mode, set minSolOut to 0 to accept any amount
      if (force) {
        minSolOut = 0;
      }

      logger.info(
        `[pumpswap-sell] Expected: ${expectedSolOut} lamports SOL (min: ${minSolOut}), selling ${actualTokenAmount} tokens (reversed=${isReversed})${force ? ' [FORCE MODE]' : ''}`,
      );

      if (expectedSolOut <= 0 && !force) {
        return this.failResult(tokenAmount, 'Expected SOL output is 0');
      }

      // In force mode, check if pool has any SOL at all
      if (expectedSolOut <= 0 && force && solReserve <= 0) {
        return this.failResult(tokenAmount, 'Pool has 0 SOL reserves (completely drained)');
      }

      // Build transaction
      const transaction = new Transaction();

      // Dynamic priority fees for sell (v8l): adapts to network congestion
      // Fallback: 150K µLamports if RPC doesn't support getPriorityFeeEstimate
      const sellPriorityFee = await getDynamicPriorityFee(this.connection, 150_000);
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: sellPriorityFee }),
      );

      // Create WSOL ATA if needed (to receive SOL)
      if (!ataInfos[0]) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            this.wallet.publicKey, userWsolAta, this.wallet.publicKey, WSOL_MINT,
          ),
        );
      }

      // v8t: Create creator vault ATA if needed (feeMint = quoteMint) - idempotent for race safety
      if (!ataInfos[2]) {
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            this.wallet.publicKey, creatorVaultAta, creatorVaultAuthority, feeMint, feeTokenProgram,
          ),
        );
      }

      // v8t: Create protocol fee ATA if needed - fixes Custom:3012 sell failures
      if (!ataInfos[3]) {
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            this.wallet.publicKey, protocolFeeAta, PUMPSWAP_PROTOCOL_FEE_RECIPIENT, feeMint, feeTokenProgram,
          ),
        );
        logger.info('[pumpswap-sell] Creating protocol fee ATA (idempotent)');
      }

      // Build instruction data (24 bytes)
      const sellTokenAmount = Math.floor(actualTokenAmount);
      const data = Buffer.alloc(24);
      if (isReversed) {
        // buy_exact_quote_in: spend TOKEN (quote) → get WSOL (base)
        BUY_EXACT_QUOTE_IN_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(BigInt(sellTokenAmount), 8);  // spendable_quote_in (TOKEN)
        data.writeBigUInt64LE(BigInt(minSolOut), 16);    // min_base_amount_out (WSOL)
      } else {
        // sell: sell TOKEN (base) → get WSOL (quote)
        SELL_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(BigInt(sellTokenAmount), 8);   // base_amount_in (TOKEN)
        data.writeBigUInt64LE(BigInt(minSolOut), 16);     // min_quote_amount_out (WSOL)
      }

      // Build account keys
      const baseAccounts = [
        { pubkey: poolAddress, isSigner: false, isWritable: true },                       // 0: pool
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },              // 1: user
        { pubkey: globalConfig, isSigner: false, isWritable: false },                     // 2: global_config
        { pubkey: poolState.baseMint, isSigner: false, isWritable: false },               // 3: base_mint
        { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },              // 4: quote_mint
        { pubkey: userBaseAta, isSigner: false, isWritable: true },                       // 5: user_base_ata
        { pubkey: userQuoteAta, isSigner: false, isWritable: true },                      // 6: user_quote_ata
        { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },    // 7: pool base vault
        { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },   // 8: pool quote vault
        { pubkey: PUMPSWAP_PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },  // 9: protocol_fee_recipient
        { pubkey: protocolFeeAta, isSigner: false, isWritable: true },                    // 10: protocol_fee_ata (quoteMint)
        { pubkey: baseTokenProgramId, isSigner: false, isWritable: false },               // 11: base_token_program
        { pubkey: quoteTokenProgramId, isSigner: false, isWritable: false },              // 12: quote_token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },          // 13: system_program
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 14: associated_token_program
        { pubkey: eventAuthority, isSigner: false, isWritable: false },                   // 15: event_authority
        { pubkey: PUMPSWAP_AMM, isSigner: false, isWritable: false },                     // 16: program
        { pubkey: creatorVaultAta, isSigner: false, isWritable: true },                   // 17: creator_vault_ata
        { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },            // 18: creator_vault_authority
      ];

      let keys;
      if (isReversed) {
        // buy_exact_quote_in: 23 accounts (with volume accumulators)
        keys = [
          ...baseAccounts,
          { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },         // 19
          { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },           // 20
          { pubkey: feeConfig, isSigner: false, isWritable: false },                      // 21
          { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },           // 22
        ];
      } else {
        // sell: 21 accounts (no volume accumulators)
        keys = [
          ...baseAccounts,
          { pubkey: feeConfig, isSigner: false, isWritable: false },                      // 19
          { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },           // 20
        ];
      }

      transaction.add(new TransactionInstruction({
        programId: PUMPSWAP_AMM,
        keys,
        data,
      }));

      // Close WSOL account to unwrap received SOL
      transaction.add(
        createCloseAccountInstruction(userWsolAta, this.wallet.publicKey, this.wallet.publicKey),
      );

      // Close token ATA after full sell to recover rent (~0.002 SOL)
      // Only if selling ALL tokens in the ATA (remaining balance will be ~0)
      const remainingAfterSell = actualAtaBalance - sellTokenAmount;
      if (actualAtaBalance > 0 && remainingAfterSell < 10) {
        transaction.add(
          createCloseAccountInstruction(userTokenAta, this.wallet.publicKey, this.wallet.publicKey, [], tokenProgramId),
        );
        logger.info('[pumpswap-sell] Will close token ATA to recover rent');
      }

      // v11g: Sender tip for staked connection routing (after close to ensure SOL available)
      const sellTipAccount = HELIUS_SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_SENDER_TIP_ACCOUNTS.length)];
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: sellTipAccount,
          lamports: SENDER_TIP_LAMPORTS,
        }),
      );

      // Sign, simulate, optimize CU, and send
      transaction.recentBlockhash = blockInfo.blockhash;
      transaction.feePayer = this.wallet.publicKey;
      transaction.sign(this.wallet.keypair);

      // v8w: Skip simulation for emergency sells (speed > safety when rug detected)
      let txToSend = transaction;
      if (skipSimulation) {
        logger.info(`[pumpswap-sell] EMERGENCY: skipping simulation for speed`);
      } else {
        // v11a: Simulate with backup fallback. If ALL RPCs fail, send unsimulated (sell > safety).
        let simResult: Awaited<ReturnType<Connection['simulateTransaction']>> | null = null;
        try {
          simResult = await this.withSellBackup(
            (conn) => conn.simulateTransaction(transaction),
          );
        } catch {
          logger.warn('[pumpswap-sell] All RPCs failed for simulation — sending unsimulated');
        }

        if (simResult) {
          if (simResult.value.err) {
            const simError = JSON.stringify(simResult.value.err);
            logger.warn(`[pumpswap-sell] Simulation FAILED (saved fees): ${simError}`);
            return this.failResult(Math.floor(tokenAmount), `Simulation failed: ${simError}`);
          }

          // v8s: CU optimization — use actual CU from simulation + 15% margin instead of 300K hardcoded
          const unitsConsumed = simResult.value.unitsConsumed;
          if (unitsConsumed && unitsConsumed > 0) {
            const optimizedCU = Math.ceil(unitsConsumed * 1.15);
            transaction.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: optimizedCU });
            // v11g: Enforce priority fee floor (10K lamports min for staked routing)
            const { cuPrice: finalSellCuPrice, floorApplied: sellFloorApplied } = enforcePriorityFeeFloor(sellPriorityFee, optimizedCU);
            if (sellFloorApplied) {
              transaction.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: finalSellCuPrice });
            }
            transaction.signatures = [];
            transaction.sign(this.wallet.keypair);
            txToSend = transaction;
            logger.info(`[pumpswap-sell] CU optimized: 300000 → ${optimizedCU} (sim: ${unitsConsumed})${sellFloorApplied ? ` [fee floor: ${finalSellCuPrice} µL]` : ''}`);
          }
        }
      }

      // v10d: Final cancel check right before sending TX — catches cases where parallel sell
      // succeeded during our TX build/simulation time (typically 7-15s gap)
      if (cancelFlag?.cancelled) {
        logger.info(`[pumpswap-sell] Aborting before TX send: parallel sell already succeeded`);
        return this.failResult(tokenAmount, 'Cancelled before send: parallel sell succeeded');
      }

      const signature = await this.sendMultiEndpoint(
        txToSend,
        blockInfo.lastValidBlockHeight,
        blockInfo.blockhash,
      );

      const elapsed = Date.now() - startTime;
      logger.info(`[pumpswap-sell] Sell completed in ${elapsed}ms: ${signature}`);

      return {
        success: true,
        txSignature: signature,
        inputAmount: sellTokenAmount,
        outputAmount: expectedSolOut,
        pricePerToken: sellTokenAmount > 0 ? (expectedSolOut / 1e9) / sellTokenAmount : 0,
        fee: 5000,
        timestamp: Date.now(),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
      logger.error(`[pumpswap-sell] Sell failed: ${errorMsg}`);
      // v10a: Preserve TX signature for sell recovery (same pattern as buy)
      const result = this.failResult(Math.floor(tokenAmount), errorMsg);
      if (this.lastSentSignature && errorMsg.includes('TX confirmation error')) {
        result.txSignature = this.lastSentSignature;
        this.lastSentSignature = null;
      }
      return result;
    }
  }

  /** v9a: Public wrapper for shadow mode pool state reads */
  async getPoolStatePublic(poolAddress: PublicKey): Promise<PumpSwapPoolState | null> {
    return this.getCachedPoolState(poolAddress) ?? this.getPoolState(poolAddress);
  }

  /**
   * v9s: Quick reserves check for Tier 1 pre-filter.
   * Returns SOL reserves in lamports (just 1 RPC call for pool state).
   * Returns null on error (caller should skip liq filter, not block).
   */
  async getPoolReservesQuick(poolAddress: PublicKey): Promise<number | null> {
    try {
      const state = await this.getPoolState(poolAddress);
      if (!state) return null;

      // Read vault balances (1 more call)
      const reserves = await this.getReserves(state.poolBaseTokenAccount, state.poolQuoteTokenAccount);
      if (!reserves) return null;

      // SOL reserves = the WSOL side
      const solReserve = state.baseMintIsWsol ? reserves.baseReserve : reserves.quoteReserve;
      return solReserve;
    } catch {
      return null;
    }
  }

  private async getPoolState(poolAddress: PublicKey, isSellPath = false): Promise<PumpSwapPoolState | null> {
    try {
      // v9h: Use analysis RPCs to avoid saturating Helius primary (pool state parse is non-critical)
      // v9y: isSellPath bypasses concurrency limiter for priority sell execution
      const accountInfo = await withAnalysisRetry(
        (conn) => conn.getAccountInfo(poolAddress),
        this.connection,
        8_000,
        isSellPath,
      );
      if (!accountInfo || !accountInfo.data) {
        logger.error(`[pumpswap] Pool account not found: ${poolAddress.toBase58().slice(0, 8)}...`);
        return null;
      }

      const data = accountInfo.data;
      if (data.length < 243) {
        logger.error(`[pumpswap] Pool data too short: ${data.length} bytes (need 243)`);
        return null;
      }

      const baseMint = new PublicKey(data.slice(POOL_LAYOUT.baseMint, POOL_LAYOUT.baseMint + 32));
      const quoteMint = new PublicKey(data.slice(POOL_LAYOUT.quoteMint, POOL_LAYOUT.quoteMint + 32));
      const poolBaseTokenAccount = new PublicKey(data.slice(POOL_LAYOUT.poolBaseTokenAccount, POOL_LAYOUT.poolBaseTokenAccount + 32));
      const poolQuoteTokenAccount = new PublicKey(data.slice(POOL_LAYOUT.poolQuoteTokenAccount, POOL_LAYOUT.poolQuoteTokenAccount + 32));
      const coinCreator = new PublicKey(data.slice(POOL_LAYOUT.coinCreator, POOL_LAYOUT.coinCreator + 32));
      const baseMintIsWsol = baseMint.equals(WSOL_MINT);

      logger.info(`[pumpswap] Pool state: base=${baseMint.toBase58().slice(0, 8)} quote=${quoteMint.toBase58().slice(0, 8)} reversed=${baseMintIsWsol} coinCreator=${coinCreator.toBase58().slice(0, 8)}`);

      return {
        creator: new PublicKey(data.slice(POOL_LAYOUT.creator, POOL_LAYOUT.creator + 32)),
        coinCreator,
        baseMint,
        quoteMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        baseMintIsWsol,
      };
    } catch (err) {
      logger.error(`[pumpswap] Failed to parse pool state: ${err}`);
      return null;
    }
  }

  private async getReserves(
    baseVault: PublicKey,
    quoteVault: PublicKey,
    isSellPath = false,
  ): Promise<{ baseReserve: number; quoteReserve: number; baseTokenProgram: PublicKey; quoteTokenProgram: PublicKey } | null> {
    try {
      // v9h: Use analysis RPCs to avoid 429 on Helius (critical for emergency sells)
      // v9y: isSellPath bypasses concurrency limiter for priority sell execution
      const [baseInfo, quoteInfo] = await withAnalysisRetry(
        (conn) => conn.getMultipleAccountsInfo([baseVault, quoteVault]),
        this.connection,
        8_000,
        isSellPath,
      );
      if (!baseInfo || !quoteInfo) {
        logger.error('[pumpswap] Vault accounts not found');
        return null;
      }

      // Token account amount is at offset 64
      const baseReserve = Number(baseInfo.data.readBigUInt64LE(64));
      const quoteReserve = Number(quoteInfo.data.readBigUInt64LE(64));
      // Detect which Token Program each vault uses (standard SPL Token or Token-2022)
      const baseTokenProgram = baseInfo.owner;
      const quoteTokenProgram = quoteInfo.owner;

      return { baseReserve, quoteReserve, baseTokenProgram, quoteTokenProgram };
    } catch (err) {
      logger.error(`[pumpswap] Failed to get reserves: ${err}`);
      return null;
    }
  }

  /**
   * v11a: Read reserves directly from a specific connection (for backup RPC path).
   * Throws on failure so withSellBackup can retry with backup.
   */
  private async getReservesFromConn(
    baseVault: PublicKey,
    quoteVault: PublicKey,
    conn: Connection,
  ): Promise<{ baseReserve: number; quoteReserve: number; baseTokenProgram: PublicKey; quoteTokenProgram: PublicKey }> {
    const [baseInfo, quoteInfo] = await conn.getMultipleAccountsInfo([baseVault, quoteVault]);
    if (!baseInfo || !quoteInfo) throw new Error('Vault accounts not found');
    return {
      baseReserve: Number(baseInfo.data.readBigUInt64LE(64)),
      quoteReserve: Number(quoteInfo.data.readBigUInt64LE(64)),
      baseTokenProgram: baseInfo.owner,
      quoteTokenProgram: quoteInfo.owner,
    };
  }

  /**
   * v11a: Parse pool account data into PumpSwapPoolState.
   * Extracted for reuse in backup RPC paths.
   */
  private parsePoolData(data: Buffer): PumpSwapPoolState | null {
    if (data.length < 243) return null;
    const baseMint = new PublicKey(data.slice(POOL_LAYOUT.baseMint, POOL_LAYOUT.baseMint + 32));
    const quoteMint = new PublicKey(data.slice(POOL_LAYOUT.quoteMint, POOL_LAYOUT.quoteMint + 32));
    return {
      creator: new PublicKey(data.slice(POOL_LAYOUT.creator, POOL_LAYOUT.creator + 32)),
      coinCreator: new PublicKey(data.slice(POOL_LAYOUT.coinCreator, POOL_LAYOUT.coinCreator + 32)),
      baseMint,
      quoteMint,
      poolBaseTokenAccount: new PublicKey(data.slice(POOL_LAYOUT.poolBaseTokenAccount, POOL_LAYOUT.poolBaseTokenAccount + 32)),
      poolQuoteTokenAccount: new PublicKey(data.slice(POOL_LAYOUT.poolQuoteTokenAccount, POOL_LAYOUT.poolQuoteTokenAccount + 32)),
      baseMintIsWsol: baseMint.equals(WSOL_MINT),
    };
  }

  /**
   * v11a: Read RPC call with backup fallback for sell-critical paths.
   * Tries primary first (via withAnalysisRetry), falls back to backup RPCs.
   */
  // v11k: Parallel sell backup — fire primary + all backups simultaneously (first-success wins)
  // Reduces worst-case from 24s (sequential) to 12s (parallel, single timeout window)
  private async withSellBackup<T>(
    fn: (conn: Connection) => Promise<T>,
    timeoutMs: number = 12_000,
  ): Promise<T> {
    const connections = [this.connection, ...sellBackupConnections];
    return new Promise<T>((resolve, reject) => {
      let resolved = false;
      let completedCount = 0;
      const errors: Error[] = [];

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`All ${connections.length} RPCs timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      for (let i = 0; i < connections.length; i++) {
        const conn = connections[i];
        fn(conn)
          .then((result) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              if (i > 0) logger.info(`[pumpswap-sell] Backup RPC #${i} succeeded (primary was slower)`);
              resolve(result);
            }
          })
          .catch((err) => {
            completedCount++;
            errors.push(err instanceof Error ? err : new Error(String(err)));
            if (completedCount === connections.length && !resolved) {
              resolved = true;
              clearTimeout(timer);
              reject(errors[0]); // Throw primary error
            }
          });
      }
    });
  }

  private async sendMultiEndpoint(
    transaction: Transaction,
    lastValidBlockHeight: number,
    blockhash: string,
  ): Promise<string> {
    const rawTransaction = transaction.serialize();
    const base58Tx = bs58.encode(rawTransaction);
    const base64Tx = Buffer.from(rawTransaction).toString('base64'); // v11g: For Sender endpoint

    // v11g: Helius Sender URL (staked connections)
    const senderUrl = getSenderUrl();

    // v11a: Helius + Jito + backup RPCs + Sender in parallel (4 independent paths)
    // First-success strategy: resolve as soon as ANY endpoint returns a signature
    const signature = await new Promise<string>((resolve, reject) => {
      let resolved = false;
      let completedCount = 0;
      const totalEndpoints = 1 + JITO_TX_ENDPOINTS.length + sellBackupConnections.length + (senderUrl ? 1 : 0);

      const onResult = (sig: string | null) => {
        completedCount++;
        if (sig && !resolved) {
          resolved = true;
          resolve(sig);
        }
        if (completedCount >= totalEndpoints && !resolved) {
          reject(new Error('All send endpoints failed'));
        }
      };

      // Primary RPC (Helius paid)
      this.connection
        .sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 })
        .then((sig) => onResult(sig))
        .catch((e) => {
          logger.debug(`[pumpswap] Primary RPC send failed: ${e.message}`);
          onResult(null);
        });

      // v11a: Backup RPCs for sell redundancy (independent infrastructure)
      for (const backupConn of sellBackupConnections) {
        backupConn
          .sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 })
          .then((sig) => onResult(sig))
          .catch((e) => {
            logger.debug(`[pumpswap] Backup RPC send failed: ${e.message}`);
            onResult(null);
          });
      }

      // v11g: Helius Sender endpoint (staked connections, SWQOS-only)
      if (senderUrl) {
        fetch(senderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
          }),
          signal: AbortSignal.timeout(3000),
        })
          .then(async (res) => {
            const data = (await res.json()) as { error?: { message: string }; result?: string };
            if (data.error) throw new Error(data.error.message);
            logger.info(`[pumpswap] Sender endpoint success`);
            onResult(data.result as string);
          })
          .catch((e) => {
            logger.debug(`[pumpswap] Sender endpoint failed: ${e.message}`);
            onResult(null);
          });
      }

      // Jito endpoints (fire in parallel, don't wait)
      for (const jitoUrl of JITO_TX_ENDPOINTS) {
        fetch(jitoUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base58Tx, { encoding: 'base58' }],
          }),
          signal: AbortSignal.timeout(1500),
        })
          .then(async (res) => {
            const data = (await res.json()) as { error?: { message: string }; result?: string };
            if (data.error) throw new Error(data.error.message);
            onResult(data.result as string);
          })
          .catch((e) => {
            logger.debug(`[pumpswap] Jito endpoint failed: ${e.message}`);
            onResult(null);
          });
      }
    });

    logger.info(`[pumpswap] TX sent (first-success): ${signature}`);
    this.lastSentSignature = signature; // v10a: Save for recovery if confirmation times out

    // v11k: 25s timeout (was 15s). During Solana congestion, TXs land in 15-25s.
    // 15s caused POST-SELL RECOVERY loops where TX landed but bot didn't see it.
    // FtnW: TP1 sell took 51s total because 15s timeout → retry → eventually confirmed.
    const pollResult = await pollConfirmation(
      signature, this.connection, 25_000, 1_000, sellBackupConnections,
      { rawTransaction },
    );
    if (!pollResult.confirmed) {
      throw new Error(`TX confirmation error: ${pollResult.error ?? 'Polling timeout (25s)'}`);
    }

    logger.info(`[pumpswap] TX confirmed: ${signature}`);
    return signature;
  }

  // ─── Observation Window: watch pool reserves before buying ────────────

  /**
   * Observe pool SOL reserves for a period of time before buying.
   * Catches fast rug pulls (10-30s) that drain SOL reserves.
   * Early exits if reserves drop beyond threshold.
   */
  async observePool(
    pool: DetectedPool,
    opts: { durationMs: number; pollIntervalMs: number; maxDropPct: number },
  ): Promise<{ stable: boolean; dropPct: number; elapsedMs: number; initialSolReserve: number; finalSolReserve: number }> {
    const startTime = Date.now();

    // Resolve pool address
    const poolAddress = !pool.poolAddress.equals(pool.baseMint)
      ? pool.poolAddress
      : PumpSwapSwap.derivePoolAddress(pool.baseMint);

    // Try to get SOL vault from prefetch cache (0 RPC calls) or read pool state (2 RPC calls)
    // Subsequent polls reuse the vault address (1 RPC call each)
    let solVault: PublicKey | null = null;
    let initialSolReserve: number | null = null;
    const cached = this.poolStateCache.get(poolAddress.toBase58());
    if (cached && (Date.now() - cached.timestamp) < PumpSwapSwap.CACHE_TTL_MS) {
      const state = cached.state;
      solVault = state.baseMintIsWsol ? state.poolBaseTokenAccount : state.poolQuoteTokenAccount;
      // v9k: Use analysis RPC pool (was readVaultBalance → Helius direct)
      initialSolReserve = await this.readVaultBalanceRetry(solVault);
      logger.debug(`[observation] Using prefetched vault address (saved 1 RPC call)`);
    } else {
      const full = await this.readSolReservesFull(poolAddress);
      solVault = full.solVault;
      initialSolReserve = full.reserve;
    }

    // v9g: If initial reserve read fails (429 rate limit), RETRY once after 2s.
    // If still fails, PASS THROUGH — buy simulation will catch real pool issues.
    // Before v9g this returned stable=false, which blocked ALL pools during 429 storms.
    if (!solVault || initialSolReserve === null || initialSolReserve <= 0) {
      logger.warn(`[observation] Initial reserve read failed (429?), retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));

      // Retry with fresh pool state read
      const retry = await this.readSolReservesFull(poolAddress);
      solVault = retry.solVault;
      initialSolReserve = retry.reserve;

      if (!solVault || initialSolReserve === null || initialSolReserve <= 0) {
        logger.warn(`[observation] Reserve read still failed after retry — passing through (buy sim will validate)`);
        return { stable: true, dropPct: 0, elapsedMs: Date.now() - startTime, initialSolReserve: 0, finalSolReserve: 0 };
      }
      logger.info(`[observation] Retry succeeded: ${(initialSolReserve / 1e9).toFixed(2)} SOL`);
    }

    let latestSolReserve = initialSolReserve;
    const polls = Math.floor(opts.durationMs / opts.pollIntervalMs);

    for (let i = 0; i < polls; i++) {
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));

      // v9g: Use analysis RPC rotation for observation polls too
      const currentReserve = await this.readVaultBalanceRetry(solVault);
      if (currentReserve === null) continue; // RPC fail, skip this poll

      latestSolReserve = currentReserve;
      const dropPct = ((initialSolReserve - currentReserve) / initialSolReserve) * 100;

      logger.debug(`[observation] Poll ${i + 1}/${polls}: SOL reserves ${(currentReserve / 1e9).toFixed(4)} (${dropPct > 0 ? '-' : '+'}${Math.abs(dropPct).toFixed(1)}%)`);

      // Early exit on big drop
      if (dropPct >= opts.maxDropPct) {
        return {
          stable: false,
          dropPct,
          elapsedMs: Date.now() - startTime,
          initialSolReserve,
          finalSolReserve: currentReserve,
        };
      }
    }

    const finalDrop = ((initialSolReserve - latestSolReserve) / initialSolReserve) * 100;
    return {
      stable: finalDrop < opts.maxDropPct,
      dropPct: finalDrop,
      elapsedMs: Date.now() - startTime,
      initialSolReserve,
      finalSolReserve: latestSolReserve,
    };
  }

  /**
   * Read pool account to find SOL vault address and its balance (2 RPC calls).
   * Used for the first poll in observation window.
   */
  private async readSolReservesFull(poolAddress: PublicKey): Promise<{ solVault: PublicKey | null; reserve: number | null }> {
    try {
      // v9g: Use analysis RPC rotation to avoid 429s on primary Helius
      const poolInfo = await withAnalysisRetry(
        (conn) => conn.getAccountInfo(poolAddress),
        this.connection,
      );
      if (!poolInfo || !poolInfo.data || poolInfo.data.length < 203) return { solVault: null, reserve: null };

      const baseMint = new PublicKey(poolInfo.data.slice(POOL_LAYOUT.baseMint, POOL_LAYOUT.baseMint + 32));
      const isReversed = baseMint.equals(WSOL_MINT);

      const solVaultOffset = isReversed
        ? POOL_LAYOUT.poolBaseTokenAccount
        : POOL_LAYOUT.poolQuoteTokenAccount;
      const solVault = new PublicKey(poolInfo.data.slice(solVaultOffset, solVaultOffset + 32));

      const reserve = await this.readVaultBalanceRetry(solVault);
      return { solVault, reserve };
    } catch (err) {
      logger.debug(`[observation] Failed to read SOL reserves: ${err}`);
      return { solVault: null, reserve: null };
    }
  }

  /**
   * Read token account balance from a vault (1 RPC call).
   * Used for subsequent polls after vault address is known.
   */
  private async readVaultBalance(vault: PublicKey): Promise<number | null> {
    try {
      const vaultInfo = await this.connection.getAccountInfo(vault);
      if (!vaultInfo || vaultInfo.data.length < 72) return null;
      return Number(vaultInfo.data.readBigUInt64LE(64));
    } catch (err) {
      logger.debug(`[observation] Failed to read vault balance: ${err}`);
      return null;
    }
  }

  /**
   * v9g: Read vault balance with analysis RPC rotation (avoids 429s).
   * Used in observation window initial read and retry.
   */
  private async readVaultBalanceRetry(vault: PublicKey): Promise<number | null> {
    try {
      const vaultInfo = await withAnalysisRetry(
        (conn) => conn.getAccountInfo(vault),
        this.connection,
      );
      if (!vaultInfo || vaultInfo.data.length < 72) return null;
      return Number(vaultInfo.data.readBigUInt64LE(64));
    } catch (err) {
      logger.debug(`[observation] Failed to read vault balance (retry): ${err}`);
      return null;
    }
  }

  private failResult(inputAmount: number, error: string): TradeResult {
    return {
      success: false,
      inputAmount,
      outputAmount: 0,
      pricePerToken: 0,
      fee: 0,
      timestamp: Date.now(),
      error,
    };
  }
}
