#!/usr/bin/env node
/**
 * Analyzes WHAT creator wallets do during bursts
 * Goal: Find if the TYPE of transactions differs between rugs and winners
 * (burst COUNT is the same, but maybe the CONTENT differs)
 */
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const Database = require('better-sqlite3');
const path = require('path');

const conn = new Connection(process.env.RPC_URL);
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

async function analyzeCreatorTxTypes(tokenMint, creatorWallet, detectedAt, closedAt, category) {
  try {
    const creatorPk = new PublicKey(creatorWallet);
    const sigs = await conn.getSignaturesForAddress(creatorPk, { limit: 50 });
    if (sigs.length === 0) return null;

    const detectedSec = detectedAt / 1000;
    const closedSec = closedAt / 1000;
    const holdStart = detectedSec;
    const holdEnd = closedSec;

    // Get the 5 most interesting TXs: around hold period
    const relevantSigs = sigs
      .filter(s => !s.err)
      .filter(s => {
        const rel = s.blockTime - holdStart;
        return rel >= -30 && rel <= (holdEnd - holdStart) + 30; // +-30s of our hold
      })
      .slice(0, 5); // max 5 to save RPC calls

    const txAnalysis = {
      category,
      tokenMint: tokenMint.substring(0, 10),
      totalSigs: sigs.length,
      failedSigs: sigs.filter(s => s.err).length,
      relevantCount: relevantSigs.length,
      programs: {},
      instructions: [],
      solFlows: [],
      hasTokenTransfer: false,
      hasCloseAccount: false,
      hasSwap: false,
      hasCreateAccount: false,
      creatorSolChange: 0,
      largestSolOutflow: 0,
    };

    for (const sig of relevantSigs) {
      try {
        const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) continue;

        const ixs = tx.transaction.message.instructions;
        for (const ix of ixs) {
          const prog = ix.programId?.toBase58() || '?';
          const progName =
            prog === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' ? 'PumpSwap' :
            prog === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? 'SPLToken' :
            prog === '11111111111111111111111111111111' ? 'System' :
            prog === 'ComputeBudget111111111111111111111111111111' ? 'ComputeBudget' :
            prog === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' ? 'AssocToken' :
            prog === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' ? 'PumpFun' :
            prog === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' ? 'Jupiter' :
            prog.substring(0, 8);

          const ixType = ix.parsed?.type || (ix.data ? 'raw' : '?');
          txAnalysis.programs[progName] = (txAnalysis.programs[progName] || 0) + 1;
          txAnalysis.instructions.push(`${progName}:${ixType}`);

          if (ixType === 'transfer' && progName === 'SPLToken') txAnalysis.hasTokenTransfer = true;
          if (ixType === 'closeAccount') txAnalysis.hasCloseAccount = true;
          if (progName === 'PumpSwap' || progName === 'Jupiter') txAnalysis.hasSwap = true;
          if (ixType === 'createAccount') txAnalysis.hasCreateAccount = true;
        }

        // SOL balance changes for creator
        if (tx.meta) {
          const accounts = tx.transaction.message.accountKeys;
          for (let i = 0; i < accounts.length; i++) {
            const addr = accounts[i].pubkey ? accounts[i].pubkey.toBase58() : accounts[i].toBase58();
            if (addr === creatorWallet) {
              const change = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
              txAnalysis.creatorSolChange += change;
              if (change > 0) txAnalysis.solFlows.push(`+${change.toFixed(4)}`);
              if (change < txAnalysis.largestSolOutflow) txAnalysis.largestSolOutflow = change;
            }
          }
        }
      } catch (e) {
        // skip individual TX errors
      }
      await new Promise(r => setTimeout(r, 300));
    }

    return txAnalysis;
  } catch (e) {
    return { error: e.message.substring(0, 60) };
  }
}

async function main() {
  // Get rugs with creators
  const rugs = db.prepare(`
    SELECT p.token_mint, p.exit_reason, p.pnl_pct, p.opened_at, p.closed_at,
      tc.creator_wallet, d.detected_at
    FROM positions p
    LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
    LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
    WHERE (p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%')
    AND p.closed_at IS NOT NULL AND tc.creator_wallet IS NOT NULL
    ORDER BY p.opened_at DESC LIMIT 10
  `).all();

  // Get winners with creators
  const winners = db.prepare(`
    SELECT p.token_mint, p.exit_reason, p.pnl_pct, p.opened_at, p.closed_at,
      tc.creator_wallet, d.detected_at
    FROM positions p
    LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
    LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
    WHERE p.pnl_sol > 0
    AND p.closed_at IS NOT NULL AND tc.creator_wallet IS NOT NULL
    ORDER BY p.opened_at DESC LIMIT 10
  `).all();

  console.log('CREATOR TX TYPE ANALYSIS');
  console.log('Goal: Find if creator TX CONTENT (not count) differs between rugs vs winners\n');
  console.log(`Analyzing ${rugs.length} rugs and ${winners.length} winners...\n`);

  // Analyze rugs
  const rugResults = [];
  console.log('='.repeat(100));
  console.log('  RUG PULL CREATORS — What do they do?');
  console.log('='.repeat(100));

  for (const rug of rugs) {
    const result = await analyzeCreatorTxTypes(
      rug.token_mint, rug.creator_wallet, rug.detected_at, rug.closed_at, 'RUG'
    );
    if (result && !result.error) {
      rugResults.push(result);
      console.log(`\n${result.tokenMint}.. [${rug.exit_reason}] pnl=${(rug.pnl_pct||0).toFixed(0)}%`);
      console.log(`  TXs: ${result.totalSigs} total, ${result.failedSigs} failed, ${result.relevantCount} analyzed`);
      console.log(`  Programs: ${JSON.stringify(result.programs)}`);
      console.log(`  Has: tokenTransfer=${result.hasTokenTransfer}, closeAccount=${result.hasCloseAccount}, swap=${result.hasSwap}, createAccount=${result.hasCreateAccount}`);
      console.log(`  Creator SOL change: ${result.creatorSolChange.toFixed(4)} SOL`);
      if (result.solFlows.length > 0) console.log(`  SOL inflows: ${result.solFlows.join(', ')}`);
      // Show unique instruction patterns
      const uniqueIx = [...new Set(result.instructions)];
      console.log(`  Instruction patterns: ${uniqueIx.join(', ')}`);
    } else {
      console.log(`\n${rug.token_mint.substring(0,10)}.. ERROR: ${result ? result.error : 'null'}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Analyze winners
  const winResults = [];
  console.log('\n' + '='.repeat(100));
  console.log('  WINNER CREATORS — What do they do?');
  console.log('='.repeat(100));

  for (const win of winners) {
    const result = await analyzeCreatorTxTypes(
      win.token_mint, win.creator_wallet, win.detected_at, win.closed_at, 'WIN'
    );
    if (result && !result.error) {
      winResults.push(result);
      console.log(`\n${result.tokenMint}.. [${win.exit_reason}] pnl=${(win.pnl_pct||0).toFixed(0)}%`);
      console.log(`  TXs: ${result.totalSigs} total, ${result.failedSigs} failed, ${result.relevantCount} analyzed`);
      console.log(`  Programs: ${JSON.stringify(result.programs)}`);
      console.log(`  Has: tokenTransfer=${result.hasTokenTransfer}, closeAccount=${result.hasCloseAccount}, swap=${result.hasSwap}, createAccount=${result.hasCreateAccount}`);
      console.log(`  Creator SOL change: ${result.creatorSolChange.toFixed(4)} SOL`);
      if (result.solFlows.length > 0) console.log(`  SOL inflows: ${result.solFlows.join(', ')}`);
      const uniqueIx = [...new Set(result.instructions)];
      console.log(`  Instruction patterns: ${uniqueIx.join(', ')}`);
    } else {
      console.log(`\n${win.token_mint.substring(0,10)}.. ERROR: ${result ? result.error : 'null'}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // COMPARISON
  console.log('\n' + '='.repeat(100));
  console.log('  COMPARISON: RUG vs WINNER CREATORS');
  console.log('='.repeat(100));

  const compare = (label, arr) => {
    const n = arr.length;
    if (n === 0) return;
    const withTokenTransfer = arr.filter(r => r.hasTokenTransfer).length;
    const withCloseAccount = arr.filter(r => r.hasCloseAccount).length;
    const withSwap = arr.filter(r => r.hasSwap).length;
    const withCreateAccount = arr.filter(r => r.hasCreateAccount).length;
    const avgSolChange = arr.reduce((s, r) => s + r.creatorSolChange, 0) / n;
    const avgFailed = arr.reduce((s, r) => s + r.failedSigs, 0) / n;

    // Program frequency
    const progFreq = {};
    for (const r of arr) {
      for (const [prog, count] of Object.entries(r.programs)) {
        progFreq[prog] = (progFreq[prog] || 0) + count;
      }
    }

    console.log(`\n${label} (N=${n}):`);
    console.log(`  Token Transfer: ${withTokenTransfer}/${n} (${(withTokenTransfer/n*100).toFixed(0)}%)`);
    console.log(`  Close Account:  ${withCloseAccount}/${n} (${(withCloseAccount/n*100).toFixed(0)}%)`);
    console.log(`  Swap (AMM):     ${withSwap}/${n} (${(withSwap/n*100).toFixed(0)}%)`);
    console.log(`  Create Account: ${withCreateAccount}/${n} (${(withCreateAccount/n*100).toFixed(0)}%)`);
    console.log(`  Avg SOL change: ${avgSolChange.toFixed(4)} SOL`);
    console.log(`  Avg failed TXs: ${avgFailed.toFixed(1)}`);
    console.log(`  Programs used: ${JSON.stringify(progFreq)}`);

    // Instruction pattern frequency
    const ixFreq = {};
    for (const r of arr) {
      for (const ix of [...new Set(r.instructions)]) {
        ixFreq[ix] = (ixFreq[ix] || 0) + 1;
      }
    }
    const sortedIx = Object.entries(ixFreq).sort((a, b) => b[1] - a[1]);
    console.log(`  Top instruction patterns:`);
    for (const [ix, count] of sortedIx.slice(0, 10)) {
      console.log(`    ${ix}: ${count}/${n} (${(count/n*100).toFixed(0)}%)`);
    }
  };

  compare('RUG CREATORS', rugResults);
  compare('WINNER CREATORS', winResults);

  // KEY DIFFERENCES
  console.log('\n' + '='.repeat(100));
  console.log('  KEY DIFFERENCES (if any)');
  console.log('='.repeat(100));

  if (rugResults.length > 0 && winResults.length > 0) {
    const rugTokenXfer = rugResults.filter(r => r.hasTokenTransfer).length / rugResults.length;
    const winTokenXfer = winResults.filter(r => r.hasTokenTransfer).length / winResults.length;
    const rugClose = rugResults.filter(r => r.hasCloseAccount).length / rugResults.length;
    const winClose = winResults.filter(r => r.hasCloseAccount).length / winResults.length;
    const rugSwap = rugResults.filter(r => r.hasSwap).length / rugResults.length;
    const winSwap = winResults.filter(r => r.hasSwap).length / winResults.length;
    const rugSol = rugResults.reduce((s, r) => s + r.creatorSolChange, 0) / rugResults.length;
    const winSol = winResults.reduce((s, r) => s + r.creatorSolChange, 0) / winResults.length;

    console.log(`\n  Feature              | Rugs    | Winners | Diff`);
    console.log(`  --------------------|---------|---------|-------`);
    console.log(`  Token Transfer      | ${(rugTokenXfer*100).toFixed(0)}%     | ${(winTokenXfer*100).toFixed(0)}%     | ${((rugTokenXfer-winTokenXfer)*100).toFixed(0)}pp`);
    console.log(`  Close Account       | ${(rugClose*100).toFixed(0)}%     | ${(winClose*100).toFixed(0)}%     | ${((rugClose-winClose)*100).toFixed(0)}pp`);
    console.log(`  Swap (AMM)          | ${(rugSwap*100).toFixed(0)}%     | ${(winSwap*100).toFixed(0)}%     | ${((rugSwap-winSwap)*100).toFixed(0)}pp`);
    console.log(`  Avg SOL change      | ${rugSol.toFixed(3)} | ${winSol.toFixed(3)} | ${(rugSol-winSol).toFixed(3)}`);

    console.log(`\n  INTERPRETATION:`);
    if (rugTokenXfer > winTokenXfer + 0.2) {
      console.log(`  ✓ RUG creators do more Token Transfers (moving tokens out = drain signal)`);
    }
    if (rugClose > winClose + 0.2) {
      console.log(`  ✓ RUG creators do more Close Account (cleanup after drain)`);
    }
    if (rugSol > winSol + 1) {
      console.log(`  ✓ RUG creators receive more SOL (draining pool)`);
    }
    if (Math.abs(rugTokenXfer - winTokenXfer) < 0.2 && Math.abs(rugClose - winClose) < 0.2) {
      console.log(`  ✗ NO significant difference found in TX types between rugs and winners`);
      console.log(`  → Creator TX monitoring is NOT viable for rug detection`);
    }
  }

  db.close();
  console.log('\nAnalysis complete.');
}

main().catch(console.error);
