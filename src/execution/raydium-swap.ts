import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { logger } from '../utils/logger.js';
import {
  RAYDIUM_AMM_V4,
  RAYDIUM_AMM_AUTHORITY,
  WSOL_MINT,
} from '../constants.js';
import type { Wallet } from '../core/wallet.js';
import type { TradeResult, DetectedPool } from '../types.js';

// Jito endpoints for multi-endpoint submission
const JITO_TX_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
];

// Raydium AMM V4 Liquidity State Layout offsets (from raydium-sdk)
// Total size: 752 bytes
const POOL_STATE_LAYOUT = {
  status: 0, // u64
  nonce: 8, // u64
  maxOrder: 16, // u64
  depth: 24, // u64
  baseDecimal: 32, // u64
  quoteDecimal: 40, // u64
  state: 48, // u64
  resetFlag: 56, // u64
  minSize: 64, // u64
  volMaxCutRatio: 72, // u64
  amountWaveRatio: 80, // u64
  baseLotSize: 88, // u64
  quoteLotSize: 96, // u64
  minPriceMultiplier: 104, // u64
  maxPriceMultiplier: 112, // u64
  systemDecimalValue: 120, // u64
  minSeparateNumerator: 128, // u64
  minSeparateDenominator: 136, // u64
  tradeFeeNumerator: 144, // u64
  tradeFeeDenominator: 152, // u64
  pnlNumerator: 160, // u64
  pnlDenominator: 168, // u64
  swapFeeNumerator: 176, // u64
  swapFeeDenominator: 184, // u64
  baseNeedTakePnl: 192, // u64
  quoteNeedTakePnl: 200, // u64
  quoteTotalPnl: 208, // u64
  baseTotalPnl: 216, // u64
  poolOpenTime: 224, // u64 (or i64)
  punishPcAmount: 232, // u64
  punishCoinAmount: 240, // u64
  orderbookToInitTime: 248, // u64
  // Pubkeys start at offset 256
  swapBaseInAmount: 256, // u128
  swapQuoteOutAmount: 272, // u128
  swapBase2QuoteFee: 288, // u64
  swapQuoteInAmount: 296, // u128
  swapBaseOutAmount: 312, // u128
  swapQuote2BaseFee: 328, // u64
  // Pubkeys
  baseVault: 336, // Pubkey (32 bytes)
  quoteVault: 368, // Pubkey
  baseMint: 400, // Pubkey
  quoteMint: 432, // Pubkey
  lpMint: 464, // Pubkey
  openOrders: 496, // Pubkey
  marketId: 528, // Pubkey
  marketProgramId: 560, // Pubkey
  targetOrders: 592, // Pubkey
  withdrawQueue: 624, // Pubkey
  lpVault: 656, // Pubkey
  owner: 688, // Pubkey
  lpReserve: 720, // u64
  padding: 728, // 3 x u64
};

// Serum Market Layout offsets (simplified, what we need)
const SERUM_MARKET_LAYOUT = {
  // Skip first 5 bytes (account discriminator)
  ownAddress: 13, // Pubkey
  vaultSignerNonce: 45, // u64
  baseMint: 53, // Pubkey
  quoteMint: 85, // Pubkey
  baseVault: 117, // Pubkey
  baseDepositsTotal: 149, // u64
  baseFeesAccrued: 157, // u64
  quoteVault: 165, // Pubkey
  quoteDepositsTotal: 197, // u64
  quoteFeesAccrued: 205, // u64
  quoteDustThreshold: 213, // u64
  requestQueue: 221, // Pubkey
  eventQueue: 253, // Pubkey
  bids: 285, // Pubkey
  asks: 317, // Pubkey
  baseLotSize: 349, // u64
  quoteLotSize: 357, // u64
  feeRateBps: 365, // u64
  referrerRebatesAccrued: 373, // u64
};

interface PoolState {
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  openOrders: PublicKey;
  marketId: PublicKey;
  marketProgramId: PublicKey;
  targetOrders: PublicKey;
  baseDecimal: number;
  quoteDecimal: number;
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
}

interface SerumMarketAccounts {
  bids: PublicKey;
  asks: PublicKey;
  eventQueue: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  vaultSigner: PublicKey;
}

interface SwapParams {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  amountInLamports: number;
  slippageBps: number;
}

// Cache for pool state and serum accounts (they don't change frequently)
const poolStateCache = new Map<string, { state: PoolState; timestamp: number }>();
const serumAccountsCache = new Map<string, { accounts: SerumMarketAccounts; timestamp: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

export class RaydiumSwap {
  constructor(
    private readonly connection: Connection,
    private readonly wallet: Wallet,
  ) {}

  /**
   * Buy tokens directly via Raydium AMM V4.
   * ~175ms latency vs ~2000ms for Jupiter.
   */
  async buy(params: SwapParams): Promise<TradeResult> {
    const startTime = Date.now();

    try {
      logger.info(`[raydium] Starting direct swap for pool ${params.poolAddress.toBase58().slice(0, 8)}...`);

      // Step 1: Parse pool state (~50ms)
      const poolState = await this.getPoolState(params.poolAddress);
      if (!poolState) {
        return this.failResult(params.amountInLamports, 'Failed to parse pool state');
      }

      // Derive ATAs (sync, no RPC needed)
      const userWsolAta = await getAssociatedTokenAddress(WSOL_MINT, this.wallet.publicKey);
      const userTokenAta = await getAssociatedTokenAddress(poolState.baseMint, this.wallet.publicKey);

      // Step 2: Fetch serum accounts + reserves + blockhash + ATA existence ALL IN PARALLEL
      const [serumAccounts, reserves, blockInfo, ataInfos] = await Promise.all([
        this.getSerumAccounts(poolState.marketId, poolState.marketProgramId),
        this.getReserves(poolState),
        this.connection.getLatestBlockhash('confirmed'),
        this.connection.getMultipleAccountsInfo([userWsolAta, userTokenAta]),
      ]);

      if (!serumAccounts) {
        return this.failResult(params.amountInLamports, 'Failed to get Serum accounts');
      }
      if (!reserves) {
        return this.failResult(params.amountInLamports, 'Failed to get reserves');
      }

      const { minAmountOut, expectedOut } = this.calculateAmountOut(
        params.amountInLamports,
        reserves.quoteReserve, // SOL (quote) in
        reserves.baseReserve, // Token (base) out
        poolState.tradeFeeNumerator,
        poolState.tradeFeeDenominator,
        params.slippageBps,
      );

      logger.info(
        `[raydium] Reserves: base=${reserves.baseReserve}, quote=${reserves.quoteReserve}. Expected out: ${expectedOut}, min: ${minAmountOut}`,
      );

      if (expectedOut <= 0) {
        return this.failResult(params.amountInLamports, 'Expected output is 0 (pool may be empty)');
      }

      // Step 3: Build transaction with swap instruction (no extra RPC calls now)
      const transaction = this.buildSwapTransactionSync(
        params.poolAddress,
        poolState,
        serumAccounts,
        userWsolAta,
        userTokenAta,
        ataInfos[0], // wsolAtaInfo
        ataInfos[1], // tokenAtaInfo
        params.amountInLamports,
        minAmountOut,
      );

      // Step 4: Sign and send
      transaction.recentBlockhash = blockInfo.blockhash;
      transaction.feePayer = this.wallet.publicKey;
      transaction.sign(this.wallet.keypair);

      const signature = await this.sendMultiEndpoint(transaction, blockInfo.lastValidBlockHeight, blockInfo.blockhash);

      const elapsed = Date.now() - startTime;
      logger.info(`[raydium] Swap sent in ${elapsed}ms: ${signature}`);

      const pricePerToken = (params.amountInLamports / 1e9) / expectedOut; // SOL per base unit

      return {
        success: true,
        txSignature: signature,
        inputAmount: params.amountInLamports,
        outputAmount: expectedOut,
        pricePerToken,
        fee: 5000,
        timestamp: Date.now(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[raydium] Swap failed: ${errorMsg}`);
      return this.failResult(params.amountInLamports, errorMsg);
    }
  }

  /**
   * Convenience method for DetectedPool
   */
  async buyFromPool(pool: DetectedPool, amountInLamports: number, slippageBps: number): Promise<TradeResult> {
    return this.buy({
      poolAddress: pool.poolAddress,
      baseMint: pool.baseMint,
      amountInLamports,
      slippageBps,
    });
  }

  private async getPoolState(poolAddress: PublicKey): Promise<PoolState | null> {
    const cacheKey = poolAddress.toBase58();
    const cached = poolStateCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.state;
    }

    try {
      const accountInfo = await this.connection.getAccountInfo(poolAddress);
      if (!accountInfo || !accountInfo.data) {
        logger.error('[raydium] Pool account not found');
        return null;
      }

      const data = accountInfo.data;
      if (data.length < 720) {
        logger.error(`[raydium] Pool data too short: ${data.length} bytes`);
        return null;
      }

      const state: PoolState = {
        baseVault: new PublicKey(data.slice(POOL_STATE_LAYOUT.baseVault, POOL_STATE_LAYOUT.baseVault + 32)),
        quoteVault: new PublicKey(data.slice(POOL_STATE_LAYOUT.quoteVault, POOL_STATE_LAYOUT.quoteVault + 32)),
        baseMint: new PublicKey(data.slice(POOL_STATE_LAYOUT.baseMint, POOL_STATE_LAYOUT.baseMint + 32)),
        quoteMint: new PublicKey(data.slice(POOL_STATE_LAYOUT.quoteMint, POOL_STATE_LAYOUT.quoteMint + 32)),
        lpMint: new PublicKey(data.slice(POOL_STATE_LAYOUT.lpMint, POOL_STATE_LAYOUT.lpMint + 32)),
        openOrders: new PublicKey(data.slice(POOL_STATE_LAYOUT.openOrders, POOL_STATE_LAYOUT.openOrders + 32)),
        marketId: new PublicKey(data.slice(POOL_STATE_LAYOUT.marketId, POOL_STATE_LAYOUT.marketId + 32)),
        marketProgramId: new PublicKey(data.slice(POOL_STATE_LAYOUT.marketProgramId, POOL_STATE_LAYOUT.marketProgramId + 32)),
        targetOrders: new PublicKey(data.slice(POOL_STATE_LAYOUT.targetOrders, POOL_STATE_LAYOUT.targetOrders + 32)),
        baseDecimal: Number(data.readBigUInt64LE(POOL_STATE_LAYOUT.baseDecimal)),
        quoteDecimal: Number(data.readBigUInt64LE(POOL_STATE_LAYOUT.quoteDecimal)),
        tradeFeeNumerator: data.readBigUInt64LE(POOL_STATE_LAYOUT.tradeFeeNumerator),
        tradeFeeDenominator: data.readBigUInt64LE(POOL_STATE_LAYOUT.tradeFeeDenominator),
      };

      poolStateCache.set(cacheKey, { state, timestamp: Date.now() });
      return state;
    } catch (err) {
      logger.error(`[raydium] Failed to parse pool state: ${err}`);
      return null;
    }
  }

  private async getSerumAccounts(
    marketId: PublicKey,
    marketProgramId: PublicKey,
  ): Promise<SerumMarketAccounts | null> {
    const cacheKey = marketId.toBase58();
    const cached = serumAccountsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS * 10) {
      // Serum accounts never change, longer cache
      return cached.accounts;
    }

    try {
      const marketInfo = await this.connection.getAccountInfo(marketId);
      if (!marketInfo || !marketInfo.data) {
        logger.error('[raydium] Serum market account not found');
        return null;
      }

      const data = marketInfo.data;

      const bids = new PublicKey(data.slice(SERUM_MARKET_LAYOUT.bids, SERUM_MARKET_LAYOUT.bids + 32));
      const asks = new PublicKey(data.slice(SERUM_MARKET_LAYOUT.asks, SERUM_MARKET_LAYOUT.asks + 32));
      const eventQueue = new PublicKey(data.slice(SERUM_MARKET_LAYOUT.eventQueue, SERUM_MARKET_LAYOUT.eventQueue + 32));
      const baseVault = new PublicKey(data.slice(SERUM_MARKET_LAYOUT.baseVault, SERUM_MARKET_LAYOUT.baseVault + 32));
      const quoteVault = new PublicKey(data.slice(SERUM_MARKET_LAYOUT.quoteVault, SERUM_MARKET_LAYOUT.quoteVault + 32));
      const vaultSignerNonce = data.readBigUInt64LE(SERUM_MARKET_LAYOUT.vaultSignerNonce);

      // Derive vault signer PDA
      const vaultSigner = this.deriveVaultSigner(marketId, marketProgramId, vaultSignerNonce);

      const accounts: SerumMarketAccounts = {
        bids,
        asks,
        eventQueue,
        baseVault,
        quoteVault,
        vaultSigner,
      };

      serumAccountsCache.set(cacheKey, { accounts, timestamp: Date.now() });
      return accounts;
    } catch (err) {
      logger.error(`[raydium] Failed to get Serum accounts: ${err}`);
      return null;
    }
  }

  private deriveVaultSigner(
    marketId: PublicKey,
    marketProgramId: PublicKey,
    nonce: bigint,
  ): PublicKey {
    // Serum vault signer is derived from market address + nonce as u64 LE bytes
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(nonce);
    return PublicKey.createProgramAddressSync([marketId.toBuffer(), nonceBuffer], marketProgramId);
  }

  private async getReserves(
    poolState: PoolState,
  ): Promise<{ baseReserve: number; quoteReserve: number } | null> {
    try {
      // Fetch both vault accounts in parallel
      const [baseVaultInfo, quoteVaultInfo] = await this.connection.getMultipleAccountsInfo([
        poolState.baseVault,
        poolState.quoteVault,
      ]);

      if (!baseVaultInfo || !quoteVaultInfo) {
        logger.error('[raydium] Vault accounts not found');
        return null;
      }

      // Token account balance is at offset 64 (amount field)
      const baseReserve = Number(baseVaultInfo.data.readBigUInt64LE(64));
      const quoteReserve = Number(quoteVaultInfo.data.readBigUInt64LE(64));

      return { baseReserve, quoteReserve };
    } catch (err) {
      logger.error(`[raydium] Failed to get reserves: ${err}`);
      return null;
    }
  }

  /**
   * Calculate output amount using constant product formula.
   * amountOut = (amountIn * (1 - fee) * reserveOut) / (reserveIn + amountIn * (1 - fee))
   */
  private calculateAmountOut(
    amountIn: number,
    reserveIn: number,
    reserveOut: number,
    feeNumerator: bigint,
    feeDenominator: bigint,
    slippageBps: number,
  ): { expectedOut: number; minAmountOut: number } {
    // Raydium fee is typically 0.25% (25/10000)
    const feeMultiplier = Number(feeDenominator - feeNumerator) / Number(feeDenominator);
    const amountInWithFee = amountIn * feeMultiplier;

    // Constant product formula: x * y = k
    const expectedOut = Math.floor((amountInWithFee * reserveOut) / (reserveIn + amountInWithFee));

    // Apply slippage
    const minAmountOut = Math.floor((expectedOut * (10000 - slippageBps)) / 10000);

    return { expectedOut, minAmountOut };
  }

  private buildSwapTransactionSync(
    poolAddress: PublicKey,
    poolState: PoolState,
    serumAccounts: SerumMarketAccounts,
    userWsolAta: PublicKey,
    userTokenAta: PublicKey,
    wsolAtaInfo: { data: Buffer } | null,
    tokenAtaInfo: { data: Buffer } | null,
    amountIn: number,
    minAmountOut: number,
  ): Transaction {
    const transaction = new Transaction();

    // Priority fees - CRITICAL for getting included in blocks
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
    );

    // Create WSOL ATA if needed and wrap SOL
    if (!wsolAtaInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          this.wallet.publicKey,
          userWsolAta,
          this.wallet.publicKey,
          WSOL_MINT,
        ),
      );
    }

    // Transfer SOL to WSOL ATA and sync
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: userWsolAta,
        lamports: amountIn,
      }),
      createSyncNativeInstruction(userWsolAta),
    );

    // Create token ATA if needed
    if (!tokenAtaInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          this.wallet.publicKey,
          userTokenAta,
          this.wallet.publicKey,
          poolState.baseMint,
        ),
      );
    }

    // Build swap instruction (opcode 9 = SwapBaseIn)
    const swapInstruction = this.buildSwapInstruction(
      poolAddress,
      poolState,
      serumAccounts,
      userWsolAta, // source (SOL in)
      userTokenAta, // destination (token out)
      amountIn,
      minAmountOut,
    );

    transaction.add(swapInstruction);

    // Close WSOL account to recover rent
    transaction.add(
      createCloseAccountInstruction(userWsolAta, this.wallet.publicKey, this.wallet.publicKey),
    );

    return transaction;
  }

  private buildSwapInstruction(
    poolAddress: PublicKey,
    poolState: PoolState,
    serumAccounts: SerumMarketAccounts,
    userSourceAta: PublicKey,
    userDestAta: PublicKey,
    amountIn: number,
    minAmountOut: number,
  ): TransactionInstruction {
    // Instruction data: [opcode(1), amountIn(8), minAmountOut(8)]
    const dataLayout = Buffer.alloc(17);
    dataLayout.writeUInt8(9, 0); // Opcode 9 = SwapBaseIn (swap fixed input)
    dataLayout.writeBigUInt64LE(BigInt(amountIn), 1);
    dataLayout.writeBigUInt64LE(BigInt(minAmountOut), 9);

    // 18 accounts required for Raydium swap
    const keys = [
      // Raydium accounts
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: poolAddress, isSigner: false, isWritable: true },
      { pubkey: RAYDIUM_AMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: poolState.openOrders, isSigner: false, isWritable: true },
      { pubkey: poolState.targetOrders, isSigner: false, isWritable: true },
      { pubkey: poolState.baseVault, isSigner: false, isWritable: true },
      { pubkey: poolState.quoteVault, isSigner: false, isWritable: true },
      // Serum accounts
      { pubkey: poolState.marketProgramId, isSigner: false, isWritable: false },
      { pubkey: poolState.marketId, isSigner: false, isWritable: true },
      { pubkey: serumAccounts.bids, isSigner: false, isWritable: true },
      { pubkey: serumAccounts.asks, isSigner: false, isWritable: true },
      { pubkey: serumAccounts.eventQueue, isSigner: false, isWritable: true },
      { pubkey: serumAccounts.baseVault, isSigner: false, isWritable: true },
      { pubkey: serumAccounts.quoteVault, isSigner: false, isWritable: true },
      { pubkey: serumAccounts.vaultSigner, isSigner: false, isWritable: false },
      // User accounts
      { pubkey: userSourceAta, isSigner: false, isWritable: true }, // SOL in
      { pubkey: userDestAta, isSigner: false, isWritable: true }, // Token out
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ];

    return new TransactionInstruction({
      programId: RAYDIUM_AMM_V4,
      keys,
      data: dataLayout,
    });
  }

  private async sendMultiEndpoint(
    transaction: Transaction,
    lastValidBlockHeight: number,
    blockhash: string,
  ): Promise<string> {
    const rawTransaction = transaction.serialize();
    const base58Tx = bs58.encode(rawTransaction);

    const sendPromises: Promise<string | null>[] = [];

    // 1. Send via primary RPC
    sendPromises.push(
      this.connection
        .sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 })
        .catch((e) => {
          logger.debug(`[raydium] Primary RPC failed: ${e.message}`);
          return null;
        }),
    );

    // 2. Send via Jito endpoints
    for (const jitoUrl of JITO_TX_ENDPOINTS) {
      sendPromises.push(
        fetch(jitoUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base58Tx, { encoding: 'base58' }],
          }),
          signal: AbortSignal.timeout(3000),
        })
          .then(async (res) => {
            const data = (await res.json()) as { error?: { message: string }; result?: string };
            if (data.error) throw new Error(data.error.message);
            return data.result as string;
          })
          .catch((e) => {
            logger.warn(`[raydium] Jito endpoint failed: ${e.message}`);
            return null;
          }),
      );
    }

    // Wait for all sends to complete
    const results = await Promise.all(sendPromises);
    const successfulSigs = results.filter((r): r is string => r !== null);

    if (successfulSigs.length === 0) {
      throw new Error('All send endpoints failed');
    }

    const signature = successfulSigs[0];
    logger.info(`[raydium] TX sent to ${successfulSigs.length} endpoints: ${signature}`);

    // Confirm transaction with 15s timeout (don't block Jupiter fallback too long)
    const confirmPromise = this.connection.confirmTransaction(
      { signature, lastValidBlockHeight, blockhash },
      'confirmed',
    );
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Confirmation timeout (15s)')), 15_000),
    );

    const confirmation = await Promise.race([confirmPromise, timeoutPromise]);

    if (confirmation.value.err) {
      throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    logger.info(`[raydium] TX confirmed: ${signature}`);
    return signature;
  }

  private failResult(inputAmount: number, error: string): TradeResult {
    logger.error(`[raydium] Swap failed: ${error}`);
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
