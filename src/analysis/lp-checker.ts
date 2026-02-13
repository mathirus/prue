import { type Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { logger } from '../utils/logger.js';

export interface LpCheckResult {
  lpBurned: boolean;
  lpLockedPct: number;
  lpTotalSupply: bigint;
  lpBurnedAmount: bigint;
}

// Common burn addresses
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '1111111111111111111111111111111111111111111',
  'deaddeaddeaddeaddeaddeaddeaddeaddeaddead',
]);

/**
 * Checks if LP tokens are burned or locked.
 * Burned LP = liquidity cannot be removed = safer.
 */
export async function checkLpStatus(
  connection: Connection,
  lpMint: PublicKey,
): Promise<LpCheckResult> {
  try {
    const mintInfo = await getMint(connection, lpMint);
    const totalSupply = mintInfo.supply;

    if (totalSupply === 0n) {
      return {
        lpBurned: false,
        lpLockedPct: 0,
        lpTotalSupply: 0n,
        lpBurnedAmount: 0n,
      };
    }

    // Get all LP token holders
    const largestAccounts = await connection.getTokenLargestAccounts(lpMint);

    let burnedAmount = 0n;

    for (const account of largestAccounts.value) {
      const address = account.address.toBase58();

      // Check if held by known burn address
      if (BURN_ADDRESSES.has(address)) {
        burnedAmount += BigInt(account.amount);
        continue;
      }

      // Check if the owner of this token account is a burn address
      try {
        const accountInfo = await connection.getParsedAccountInfo(account.address);
        if (accountInfo.value?.data && 'parsed' in accountInfo.value.data) {
          const owner = accountInfo.value.data.parsed?.info?.owner;
          if (owner && BURN_ADDRESSES.has(owner)) {
            burnedAmount += BigInt(account.amount);
          }
        }
      } catch {
        // Skip if can't fetch
      }
    }

    const lpLockedPct = Number((burnedAmount * 10000n) / totalSupply) / 100;
    const lpBurned = lpLockedPct > 95; // Consider burned if >95% is in burn addresses

    return {
      lpBurned,
      lpLockedPct,
      lpTotalSupply: totalSupply,
      lpBurnedAmount: burnedAmount,
    };
  } catch (err) {
    logger.error(`[lp-check] Failed for ${lpMint.toBase58()}`, {
      error: String(err),
    });
    return {
      lpBurned: false,
      lpLockedPct: 0,
      lpTotalSupply: 0n,
      lpBurnedAmount: 0n,
    };
  }
}
