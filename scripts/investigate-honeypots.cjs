#!/usr/bin/env node
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('RPC_URL not set'); process.exit(1); }

const conn = new Connection(RPC_URL);

async function investigateToken(mint, label) {
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  ${label}`);
  console.log(`  Mint: ${mint}`);
  console.log('='.repeat(90));

  try {
    const mintPk = new PublicKey(mint);
    const info = await conn.getParsedAccountInfo(mintPk);

    if (!info.value) {
      console.log('  TOKEN NOT FOUND ON-CHAIN (closed/burned)');
    } else {
      const data = info.value.data;
      const owner = info.value.owner.toBase58();
      const isToken2022 = owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      const isStandardSPL = owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

      if (data.parsed) {
        const ti = data.parsed.info;
        console.log(`  Program: ${isToken2022 ? 'TOKEN-2022' : isStandardSPL ? 'SPL Token (standard)' : owner}`);
        console.log(`  Freeze Auth: ${ti.freezeAuthority || 'REVOKED'}`);
        console.log(`  Mint Auth: ${ti.mintAuthority || 'REVOKED'}`);
        console.log(`  Supply: ${ti.supply}`);
        if (isToken2022 && ti.extensions) {
          console.log(`  EXTENSIONS:`);
          for (const ext of ti.extensions) {
            console.log(`    - ${ext.extension}: ${JSON.stringify(ext.state || {})}`);
          }
        }
      }
    }
  } catch (e) {
    console.log(`  On-chain error: ${e.message.substring(0, 100)}`);
  }

  // DexScreener
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d.pairs && d.pairs.length > 0) {
      const p = d.pairs[0];
      console.log(`  DexScreener: ALIVE | liq=$${(p.liquidity?.usd||0).toFixed(0)} | fdv=$${(p.fdv||0).toFixed(0)} | dex=${p.dexId}`);
    } else {
      console.log(`  DexScreener: DEAD (no pairs)`);
    }
  } catch (e) {
    console.log(`  DexScreener error: ${e.message}`);
  }

  // Recent transactions - look for failed ones
  try {
    const mintPk = new PublicKey(mint);
    const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 30 });
    const failed = sigs.filter(s => s.err !== null);
    const success = sigs.filter(s => s.err === null);
    console.log(`  Recent TXs: ${sigs.length} total | ${success.length} ok | ${failed.length} FAILED`);

    if (failed.length > 0) {
      console.log(`  FAILED TX ERRORS:`);
      const errorTypes = {};
      for (const f of failed) {
        const errStr = JSON.stringify(f.err);
        errorTypes[errStr] = (errorTypes[errStr] || 0) + 1;
      }
      for (const [err, count] of Object.entries(errorTypes)) {
        console.log(`    ${count}x: ${err}`);
      }

      // Inspect first failed TX logs
      const firstFailed = failed[0];
      try {
        const tx = await conn.getParsedTransaction(firstFailed.signature, { maxSupportedTransactionVersion: 0 });
        if (tx && tx.meta && tx.meta.logMessages) {
          const interestingLogs = tx.meta.logMessages.filter(l =>
            l.includes('Error') || l.includes('failed') || l.includes('Custom') ||
            l.includes('Program log') || l.includes('invoke')
          ).slice(0, 10);
          if (interestingLogs.length > 0) {
            console.log(`  FAILED TX LOGS (first):`);
            interestingLogs.forEach(l => console.log(`    ${l}`));
          }
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) {
    console.log(`  TX history error: ${e.message.substring(0, 80)}`);
  }

  await new Promise(r => setTimeout(r, 500));
}

async function main() {
  console.log('HONEYPOT ON-CHAIN INVESTIGATION\n');

  // HONEYPOT PARTIAL (one-sell pattern) - MOST INTERESTING
  await investigateToken('DbUiTbB28ZTNr3XxhUgDbTXa6AA73RvKPFqrFbnCpump',
    'HONEYPOT_PARTIAL | peak=3.6x | sold 1/3 attempts | pnl=-37%');

  await investigateToken('8yDY9BtE12M9Dm9BKYo47vTrYWHMGxSP4mjFCRP7gaNR',
    'HONEYPOT_PARTIAL | peak=1.8x | sold 1/3 attempts | pnl=-39%');

  await investigateToken('46xQhoWcKjwK7efx1NAeME7inYzQ8bLGNQosTT6ZDNXA',
    'HONEYPOT_PARTIAL | peak=1.65x | sold 1/3 attempts | pnl=-36%');

  await investigateToken('6RgX3U8zThojebVrEpZLdWXiRHRAW7ptT7pfrjFzEgDE',
    'HONEYPOT_PARTIAL | peak=1.58x | sold 1/3 attempts | pnl=-40%');

  // RUG PULLS (pool drained, 0 sells)
  await investigateToken('8Uqt91KxiU5N6dtGTHgU16vWz2uyZdo8nBFArrhfvn3x',
    'RUG_PULL | peak=1.2x | 0/1 sells | score=77 | RECENT v11c');

  await investigateToken('BvaRpn6iVT6EW5JguoXmd42n3Jr1AY3ciDkBhZGTEZdi',
    'RUG_PULL | peak=1.86x | 0/4 sells | score=85');

  console.log('\n' + '='.repeat(90));
  console.log('  INVESTIGATION COMPLETE');
  console.log('='.repeat(90));
}

main().catch(console.error);
