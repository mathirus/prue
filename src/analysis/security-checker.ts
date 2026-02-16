import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';

export interface AuthorityCheckResult {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  dangerousExtensions: string[];
  isToken2022: boolean; // v9r: Token-2022 program tokens — Jupiter can't sell them (Custom:6024)
}

// Token-2022 extension type IDs that are dangerous for trading
// These allow the creator to steal/freeze/block tokens
const DANGEROUS_EXTENSION_TYPES: Record<number, string> = {
  1: 'TransferFeeConfig',     // Charges fee on every transfer
  9: 'NonTransferable',       // Tokens can't be transferred (can't sell!)
  12: 'PermanentDelegate',    // Creator can burn/transfer from ANY account
  14: 'TransferHook',         // Arbitrary code on each transfer (can block sells)
  26: 'Pausable',             // Creator can pause all transfers
};

/**
 * Parse Token-2022 TLV extension entries from raw mint account data.
 * Returns list of dangerous extension names found.
 * TLV format: after byte 82 (mint data) + byte 82 (account type) = offset 83
 * Each entry: u16 type (LE) + u16 length (LE) + data[length]
 */
function parseToken2022Extensions(data: Buffer): string[] {
  const dangerous: string[] = [];
  if (data.length <= 83) return dangerous; // No extensions

  // Byte 82 = AccountType (1=Mint, 2=Account)
  const accountType = data[82];
  if (accountType !== 1) return dangerous; // Not a mint

  let offset = 83;
  while (offset + 4 <= data.length) {
    const extType = data.readUInt16LE(offset);
    const extLen = data.readUInt16LE(offset + 2);

    if (extType === 0 && extLen === 0) break; // Padding/end

    const name = DANGEROUS_EXTENSION_TYPES[extType];
    if (name) {
      dangerous.push(name);
    }

    offset += 4 + extLen;
    if (extLen === 0 && extType === 0) break; // Safety: avoid infinite loop
  }

  return dangerous;
}

/**
 * Checks on-chain token authorities (mint & freeze).
 * Revoked authorities = safer token.
 *
 * Parses raw mint account data directly instead of using getMint()
 * to avoid TokenInvalidAccountOwnerError with Token-2022 tokens.
 * The mint layout (first 82 bytes) is identical for both Token and Token-2022:
 *   [0..4]   mintAuthorityOption (u32 LE): 0=None, 1=Some
 *   [4..36]  mintAuthority (Pubkey, only valid if option=1)
 *   [36..44] supply (u64 LE)
 *   [44]     decimals (u8)
 *   [45]     isInitialized (bool)
 *   [46..50] freezeAuthorityOption (u32 LE): 0=None, 1=Some
 *   [50..82] freezeAuthority (Pubkey, only valid if option=1)
 */
export async function checkAuthorities(
  connection: Connection,
  mintAddress: PublicKey,
  source?: string,
): Promise<AuthorityCheckResult> {
  try {
    // v9k: Route through analysis RPC pool to avoid saturating Helius primary
    const accountInfo = await withAnalysisRetry(
      (conn) => conn.getAccountInfo(mintAddress, 'confirmed'),
      connection,
    );
    if (!accountInfo || !accountInfo.data || accountInfo.data.length < 82) {
      throw new Error('Mint account not found or data too small');
    }

    const data = accountInfo.data;

    // v9r: Detect Token-2022 program by account owner
    const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const isToken2022 = accountInfo.owner.toBase58() === TOKEN_2022_PROGRAM;

    // Parse mint authority (offset 0-36)
    const mintAuthorityOption = data.readUInt32LE(0);
    const mintAuthority = mintAuthorityOption === 1
      ? new PublicKey(data.subarray(4, 36))
      : null;

    // Parse supply (offset 36-44)
    const supply = data.readBigUInt64LE(36);

    // Parse decimals (offset 44)
    const decimals = data[44];

    // Parse freeze authority (offset 46-82)
    const freezeAuthorityOption = data.readUInt32LE(46);
    const freezeAuthority = freezeAuthorityOption === 1
      ? new PublicKey(data.subarray(50, 82))
      : null;

    // Parse Token-2022 extensions (if present)
    const dangerousExtensions = parseToken2022Extensions(data);
    if (dangerousExtensions.length > 0) {
      logger.warn(`[security] ⚠️ Token-2022 DANGEROUS extensions detected: ${dangerousExtensions.join(', ')}`);
    }

    if (isToken2022) {
      // v11u: Demoted to debug (tier1 block line already logs this at warn level)
      logger.debug(`[security] Token-2022 program detected for ${mintAddress.toBase58().slice(0, 8)}...`);
    }

    return {
      mintAuthorityRevoked: mintAuthority === null,
      freezeAuthorityRevoked: freezeAuthority === null,
      mintAuthority: mintAuthority?.toBase58() ?? null,
      freezeAuthority: freezeAuthority?.toBase58() ?? null,
      supply,
      decimals,
      dangerousExtensions,
      isToken2022,
    };
  } catch (err) {
    // For pumpswap tokens, authorities are always revoked (graduated pump.fun tokens)
    if (source === 'pumpswap') {
      logger.debug(`[security] PumpSwap token ${mintAddress.toBase58().slice(0, 8)}... - assuming revoked authorities`);
      return {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        mintAuthority: null,
        freezeAuthority: null,
        supply: 0n,
        decimals: 6,
        dangerousExtensions: [],
        isToken2022: false,
      };
    }

    // For pump.fun vanity addresses
    const mintStr = mintAddress.toBase58();
    if (mintStr.endsWith('pump')) {
      logger.debug(`[security] Assuming pump.fun token ${mintStr.slice(0, 8)}... has revoked authorities`);
      return {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        mintAuthority: null,
        freezeAuthority: null,
        supply: 0n,
        decimals: 6,
        dangerousExtensions: [],
        isToken2022: false,
      };
    }

    logger.error(`[security] Failed to check authorities for ${mintStr}`, {
      error: String(err),
    });
    return {
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      mintAuthority: 'unknown',
      freezeAuthority: 'unknown',
      supply: 0n,
      decimals: 0,
      dangerousExtensions: [],
      isToken2022: false,
    };
  }
}
