import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

/**
 * Checks if a POOL was created recently (not the token itself).
 *
 * IMPORTANT: We check the POOL age, not the token age, because:
 * - Tokens on pump.fun can have 100s of txs during bonding curve
 * - A token might be "old" but the Raydium pool is NEW (just graduated)
 * - We want to buy RIGHT when it migrates to Raydium
 *
 * This function should be called with the POOL address, not the token mint.
 */
export async function checkPoolAge(
  connection: Connection,
  poolAddress: PublicKey,
  maxAgeMinutes: number = 5, // Pools should be very fresh (< 5 min)
): Promise<{ isNew: boolean; ageMinutes: number | null; createdAt: number | null; txCount: number }> {
  const poolStr = poolAddress.toBase58();
  const shortPool = poolStr.slice(0, 8);

  try {
    // Get signatures for the POOL (not the token)
    const signatures = await connection.getSignaturesForAddress(poolAddress, {
      limit: 20, // Pools won't have many txs if they're new
    });

    if (signatures.length === 0) {
      // No transactions - pool might not exist or be invalid
      logger.info(`[edad-pool] ${shortPool}... sin transacciones, pool inválido`);
      return { isNew: false, ageMinutes: null, createdAt: null, txCount: 0 };
    }

    // The OLDEST signature is the pool creation
    const oldestSig = signatures[signatures.length - 1];
    const createdAt = oldestSig.blockTime;

    if (!createdAt) {
      logger.info(`[edad-pool] ${shortPool}... sin timestamp`);
      return { isNew: false, ageMinutes: null, createdAt: null, txCount: signatures.length };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - createdAt;
    const ageMinutes = ageSeconds / 60;

    const isNew = ageMinutes <= maxAgeMinutes;

    logger.info(
      `[edad-pool] ${shortPool}... pool creado hace ${ageMinutes.toFixed(1)} min, ${signatures.length} txs => ${isNew ? 'NUEVO ✓' : 'VIEJO ✗'}`,
    );

    return {
      isNew,
      ageMinutes,
      createdAt: createdAt * 1000,
      txCount: signatures.length,
    };
  } catch (err) {
    logger.error(`[edad-pool] Error verificando ${shortPool}...`, { error: String(err) });
    return { isNew: false, ageMinutes: null, createdAt: null, txCount: -1 };
  }
}

/**
 * Legacy function - checks token age (kept for backwards compatibility)
 * Use checkPoolAge() instead for migration sniping.
 */
export async function checkTokenAge(
  connection: Connection,
  tokenMint: PublicKey,
  maxAgeMinutes: number = 10,
): Promise<{ isNew: boolean; ageMinutes: number | null; firstTxTime: number | null; txCount: number }> {
  const mintStr = tokenMint.toBase58();
  const shortMint = mintStr.slice(0, 8);

  try {
    // For tokens, we just check if they have a reasonable amount of recent activity
    // The POOL age check is more important for sniping
    const signatures = await connection.getSignaturesForAddress(tokenMint, {
      limit: 50,
    });

    if (signatures.length === 0) {
      logger.info(`[edad] ${shortMint}... sin transacciones`);
      return { isNew: false, ageMinutes: null, firstTxTime: null, txCount: 0 };
    }

    // Check the most recent transaction time
    const newestSig = signatures[0];
    const newestTxTime = newestSig.blockTime;

    if (!newestTxTime) {
      return { isNew: false, ageMinutes: null, firstTxTime: null, txCount: signatures.length };
    }

    // Check age of most recent activity (not first transaction)
    const nowSeconds = Math.floor(Date.now() / 1000);
    const recentActivityAge = (nowSeconds - newestTxTime) / 60;

    // If there's been no activity in the last X minutes, it's probably dead
    if (recentActivityAge > maxAgeMinutes) {
      logger.info(`[edad] ${shortMint}... sin actividad reciente (${recentActivityAge.toFixed(1)} min) => INACTIVO`);
      return { isNew: false, ageMinutes: recentActivityAge, firstTxTime: null, txCount: signatures.length };
    }

    // Token has recent activity
    logger.info(`[edad] ${shortMint}... actividad hace ${recentActivityAge.toFixed(1)} min, ${signatures.length} txs => ACTIVO ✓`);

    return {
      isNew: true, // Has recent activity
      ageMinutes: recentActivityAge,
      firstTxTime: newestTxTime * 1000,
      txCount: signatures.length,
    };
  } catch (err) {
    logger.error(`[edad] Error verificando ${shortMint}...`, { error: String(err) });
    return { isNew: false, ageMinutes: null, firstTxTime: null, txCount: -1 };
  }
}
