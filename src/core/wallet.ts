import {
  Keypair,
  PublicKey,
  type Connection,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import { logger } from '../utils/logger.js';
import { lamportsToSol } from '../utils/helpers.js';

export class Wallet {
  public readonly keypair: Keypair;
  public readonly publicKey: PublicKey;

  constructor(privateKeyBase58: string) {
    try {
      const secretKey = bs58.decode(privateKeyBase58);
      this.keypair = Keypair.fromSecretKey(secretKey);
      this.publicKey = this.keypair.publicKey;
    } catch (err) {
      throw new Error(`Invalid private key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getBalance(connection: Connection): Promise<number> {
    const lamports = await connection.getBalance(this.publicKey);
    return lamportsToSol(lamports);
  }

  async getTokenBalance(
    connection: Connection,
    mint: PublicKey,
  ): Promise<{ amount: bigint; decimals: number; uiAmount: number }> {
    try {
      const ata = await getAssociatedTokenAddress(mint, this.publicKey);
      const account = await getAccount(connection, ata);
      const decimals = 9; // will be overridden by caller if needed
      const uiAmount = Number(account.amount) / Math.pow(10, decimals);
      return {
        amount: account.amount,
        decimals,
        uiAmount,
      };
    } catch {
      return { amount: 0n, decimals: 0, uiAmount: 0 };
    }
  }

  async getTokenAccounts(connection: Connection): Promise<
    Array<{
      mint: PublicKey;
      amount: bigint;
      address: PublicKey;
    }>
  > {
    const response = await connection.getParsedTokenAccountsByOwner(
      this.publicKey,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
    );

    return response.value
      .filter((acc) => {
        const parsed = acc.account.data.parsed;
        return parsed.info.tokenAmount.uiAmount > 0;
      })
      .map((acc) => {
        const parsed = acc.account.data.parsed;
        return {
          mint: new PublicKey(parsed.info.mint),
          amount: BigInt(parsed.info.tokenAmount.amount),
          address: acc.pubkey,
        };
      });
  }

  logInfo(): void {
    logger.info(`[wallet] Address: ${this.publicKey.toBase58()}`);
  }
}
