#!/usr/bin/env node
/**
 * Validates creator burst pattern across ALL rug pulls in DB
 * Measures: burst detection, time window, consistency
 */
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const Database = require('better-sqlite3');
const path = require('path');

const conn = new Connection(process.env.RPC_URL);
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

async function analyzeCreatorActivity(tokenMint, creatorWallet, detectedAt, closedAt) {
  try {
    const creatorPk = new PublicKey(creatorWallet);
    const sigs = await conn.getSignaturesForAddress(creatorPk, { limit: 50 });

    if (sigs.length === 0) return null;

    const detectedSec = detectedAt / 1000;
    const closedSec = closedAt / 1000;

    // Classify transactions by time window
    const beforePool = []; // before detection
    const duringHold = []; // while we held
    const afterClose = []; // after our position closed
    const aroundDrain = []; // within 30s of close

    for (const sig of sigs) {
      const rel = sig.blockTime - detectedSec;
      const relClose = sig.blockTime - closedSec;

      if (rel < 0) beforePool.push({ rel, sig });
      else if (rel < (closedSec - detectedSec)) duringHold.push({ rel, sig });
      else afterClose.push({ rel, sig });

      if (Math.abs(relClose) < 30) aroundDrain.push({ rel, relClose, sig });
    }

    // Detect bursts: >5 TXs within 5 seconds
    const allByTime = sigs
      .filter(s => !s.err)
      .map(s => s.blockTime)
      .sort((a, b) => a - b);

    let maxBurstCount = 0;
    let burstStartTime = 0;
    let burstRelToClose = 0;

    for (let i = 0; i < allByTime.length; i++) {
      let count = 1;
      for (let j = i + 1; j < allByTime.length; j++) {
        if (allByTime[j] - allByTime[i] <= 5) count++;
        else break;
      }
      if (count > maxBurstCount) {
        maxBurstCount = count;
        burstStartTime = allByTime[i];
        burstRelToClose = allByTime[i] - closedSec;
      }
    }

    // Find first creator activity after pool detection
    const firstActivityAfterPool = duringHold.length > 0 ? duringHold[0].rel : null;

    // Find creator activity closest to drain
    const closestToDrain = aroundDrain.length > 0 ?
      aroundDrain.reduce((best, cur) => Math.abs(cur.relClose) < Math.abs(best.relClose) ? cur : best) : null;

    return {
      totalTxs: sigs.length,
      beforePool: beforePool.length,
      duringHold: duringHold.length,
      afterClose: afterClose.length,
      maxBurstCount,
      burstRelToClose: burstRelToClose.toFixed(0),
      firstActivityAfterPool: firstActivityAfterPool ? firstActivityAfterPool.toFixed(0) : null,
      closestToDrainSec: closestToDrain ? closestToDrain.relClose.toFixed(0) : null,
      holdTimeSec: ((closedSec - detectedSec)).toFixed(0),
    };
  } catch (e) {
    return { error: e.message.substring(0, 60) };
  }
}

async function main() {
  // Get ALL rug pulls with creator data
  const rugs = db.prepare(`
    SELECT
      p.token_mint,
      p.exit_reason,
      p.pnl_pct,
      p.peak_multiplier,
      p.sell_attempts,
      p.sell_successes,
      p.opened_at,
      p.closed_at,
      p.security_score,
      p.bot_version,
      tc.creator_wallet,
      tc.wallet_age_seconds,
      tc.tx_count as creator_tx_count,
      d.detected_at
    FROM positions p
    LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
    LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
    WHERE (p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%')
    AND p.closed_at IS NOT NULL
    AND tc.creator_wallet IS NOT NULL
    ORDER BY p.opened_at DESC
  `).all();

  console.log(`CREATOR BURST PATTERN VALIDATION`);
  console.log(`Analyzing ${rugs.length} rug pulls with known creators\n`);

  // Also get WINNERS for comparison (false positive check)
  const winners = db.prepare(`
    SELECT
      p.token_mint,
      p.exit_reason,
      p.pnl_pct,
      p.peak_multiplier,
      p.opened_at,
      p.closed_at,
      p.security_score,
      tc.creator_wallet,
      d.detected_at
    FROM positions p
    LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
    LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
    WHERE p.pnl_sol > 0
    AND p.closed_at IS NOT NULL
    AND tc.creator_wallet IS NOT NULL
    ORDER BY p.opened_at DESC
  `).all();

  console.log(`Also checking ${winners.length} WINNERS for false positives\n`);

  // Analyze rugs
  console.log('='.repeat(130));
  console.log('  RUG PULLS — Creator Activity Pattern');
  console.log('='.repeat(130));
  console.log(
    'Token'.padEnd(12) + '| ' +
    'Exit'.padEnd(18) + '| ' +
    'Hold'.padStart(5) + 's | ' +
    'PnL'.padStart(6) + ' | ' +
    'Burst'.padStart(6) + ' | ' +
    'BurstVsDrain'.padStart(13) + ' | ' +
    '1stActivity'.padStart(12) + ' | ' +
    'CreatorAge'.padStart(10) + ' | ' +
    'Version'
  );
  console.log('-'.repeat(130));

  const rugResults = [];
  for (const rug of rugs) {
    const result = await analyzeCreatorActivity(
      rug.token_mint, rug.creator_wallet, rug.detected_at, rug.closed_at
    );
    if (result && !result.error) {
      rugResults.push({ ...rug, ...result });
      console.log(
        rug.token_mint.substring(0, 10).padEnd(12) + '| ' +
        (rug.exit_reason || '?').padEnd(18) + '| ' +
        result.holdTimeSec.padStart(5) + 's | ' +
        ((rug.pnl_pct || 0).toFixed(0) + '%').padStart(6) + ' | ' +
        String(result.maxBurstCount).padStart(6) + ' | ' +
        (result.burstRelToClose + 's').padStart(13) + ' | ' +
        (result.firstActivityAfterPool ? result.firstActivityAfterPool + 's' : 'none').padStart(12) + ' | ' +
        (rug.wallet_age_seconds + 's').padStart(10) + ' | ' +
        (rug.bot_version || '?')
      );
    } else {
      console.log(
        rug.token_mint.substring(0, 10).padEnd(12) + '| ' +
        (rug.exit_reason || '?').padEnd(18) + '| ' +
        'ERROR: ' + (result ? result.error : 'null')
      );
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // Analyze winners
  console.log('\n' + '='.repeat(130));
  console.log('  WINNERS — False Positive Check (do creators also burst on winners?)');
  console.log('='.repeat(130));
  console.log(
    'Token'.padEnd(12) + '| ' +
    'Exit'.padEnd(18) + '| ' +
    'Hold'.padStart(5) + 's | ' +
    'PnL'.padStart(6) + ' | ' +
    'Burst'.padStart(6) + ' | ' +
    'BurstVsDrain'.padStart(13) + ' | ' +
    '1stActivity'.padStart(12)
  );
  console.log('-'.repeat(130));

  const winResults = [];
  for (const win of winners) {
    const result = await analyzeCreatorActivity(
      win.token_mint, win.creator_wallet, win.detected_at, win.closed_at
    );
    if (result && !result.error) {
      winResults.push({ ...win, ...result });
      console.log(
        win.token_mint.substring(0, 10).padEnd(12) + '| ' +
        (win.exit_reason || '?').padEnd(18) + '| ' +
        result.holdTimeSec.padStart(5) + 's | ' +
        ((win.pnl_pct || 0).toFixed(0) + '%').padStart(6) + ' | ' +
        String(result.maxBurstCount).padStart(6) + ' | ' +
        (result.burstRelToClose + 's').padStart(13) + ' | ' +
        (result.firstActivityAfterPool ? result.firstActivityAfterPool + 's' : 'none').padStart(12)
      );
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // SUMMARY STATISTICS
  console.log('\n' + '='.repeat(100));
  console.log('  STATISTICAL SUMMARY');
  console.log('='.repeat(100));

  const validRugs = rugResults.filter(r => r.maxBurstCount !== undefined);
  const validWins = winResults.filter(r => r.maxBurstCount !== undefined);

  if (validRugs.length > 0) {
    const avgBurstRugs = validRugs.reduce((s, r) => s + r.maxBurstCount, 0) / validRugs.length;
    const rugsWithBurst5 = validRugs.filter(r => r.maxBurstCount >= 5).length;
    const rugsWithBurst10 = validRugs.filter(r => r.maxBurstCount >= 10).length;
    const rugsWithBurst20 = validRugs.filter(r => r.maxBurstCount >= 20).length;

    console.log(`\nRUG PULLS (N=${validRugs.length}):`);
    console.log(`  Avg burst size: ${avgBurstRugs.toFixed(1)} TXs`);
    console.log(`  With burst >= 5 TXs/5s: ${rugsWithBurst5} (${(rugsWithBurst5/validRugs.length*100).toFixed(0)}%)`);
    console.log(`  With burst >= 10 TXs/5s: ${rugsWithBurst10} (${(rugsWithBurst10/validRugs.length*100).toFixed(0)}%)`);
    console.log(`  With burst >= 20 TXs/5s: ${rugsWithBurst20} (${(rugsWithBurst20/validRugs.length*100).toFixed(0)}%)`);

    // Time window analysis
    const burstTimings = validRugs
      .filter(r => r.maxBurstCount >= 5)
      .map(r => parseInt(r.burstRelToClose));
    if (burstTimings.length > 0) {
      const beforeDrain = burstTimings.filter(t => t < 0);
      const afterDrain = burstTimings.filter(t => t >= 0);
      console.log(`\n  Burst timing vs drain:`);
      console.log(`    Burst BEFORE drain: ${beforeDrain.length} (${(beforeDrain.length/burstTimings.length*100).toFixed(0)}%)`);
      console.log(`    Burst AFTER drain: ${afterDrain.length} (${(afterDrain.length/burstTimings.length*100).toFixed(0)}%)`);
      if (beforeDrain.length > 0) {
        const avgWindow = beforeDrain.reduce((s, t) => s + Math.abs(t), 0) / beforeDrain.length;
        console.log(`    Avg time BEFORE drain: ${avgWindow.toFixed(0)}s (this is our detection window)`);
        console.log(`    Individual windows: ${beforeDrain.map(t => t + 's').join(', ')}`);
      }
    }
  }

  if (validWins.length > 0) {
    const avgBurstWins = validWins.reduce((s, r) => s + r.maxBurstCount, 0) / validWins.length;
    const winsWithBurst5 = validWins.filter(r => r.maxBurstCount >= 5).length;
    const winsWithBurst10 = validWins.filter(r => r.maxBurstCount >= 10).length;

    console.log(`\nWINNERS (N=${validWins.length}) — FALSE POSITIVE CHECK:`);
    console.log(`  Avg burst size: ${avgBurstWins.toFixed(1)} TXs`);
    console.log(`  With burst >= 5 TXs/5s: ${winsWithBurst5} (${(winsWithBurst5/validWins.length*100).toFixed(0)}%)`);
    console.log(`  With burst >= 10 TXs/5s: ${winsWithBurst10} (${(winsWithBurst10/validWins.length*100).toFixed(0)}%)`);
  }

  // DETECTION VIABILITY
  console.log('\n' + '='.repeat(100));
  console.log('  DETECTION VIABILITY ASSESSMENT');
  console.log('='.repeat(100));

  if (validRugs.length > 0 && validWins.length > 0) {
    const threshold = 10;
    const rugDetected = validRugs.filter(r => r.maxBurstCount >= threshold).length;
    const winFalsePos = validWins.filter(r => r.maxBurstCount >= threshold).length;

    console.log(`\nWith burst threshold >= ${threshold} TXs in 5s:`);
    console.log(`  Rugs detected: ${rugDetected}/${validRugs.length} (${(rugDetected/validRugs.length*100).toFixed(0)}%)`);
    console.log(`  False positives (winners killed): ${winFalsePos}/${validWins.length} (${(winFalsePos/validWins.length*100).toFixed(0)}%)`);
    console.log(`  Net: Would save ${rugDetected} rugs, kill ${winFalsePos} winners`);
  }

  db.close();
  console.log('\nValidation complete.');
}

main().catch(console.error);
