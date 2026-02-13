#!/usr/bin/env node
/**
 * v11a: Verify Helius paid tier is working correctly after migration.
 * Reads recent bot logs and checks for:
 * - Zero 429 errors (CRITICAL)
 * - Analysis latency improvements
 * - Pool detection and analysis counts
 * - Any JS crashes
 *
 * Usage: node scripts/verify-paid-tier.cjs [--logs=N]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const LOG_LINES = parseInt(process.argv.find(a => a.startsWith('--logs='))?.split('=')[1] || '500');

// Find most recent log file
function findLatestLog() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
    .sort()
    .reverse();
  return files[0] ? path.join(DATA_DIR, files[0]) : null;
}

function analyze(logPath) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n').slice(-LOG_LINES);

  const results = {
    totalLines: lines.length,
    errors429: 0,
    errors503: 0,
    rateLimitErrors: 0,
    jsErrors: 0,
    analysisCount: 0,
    analysisLatencies: [],
    poolsDetected: 0,
    shadowPositions: 0,
    livePositions: 0,
    sellsAttempted: 0,
    sellsSucceeded: 0,
    timeoutErrors: 0,
  };

  for (const line of lines) {
    // 429 errors
    if (line.includes('429') || line.includes('Too Many') || line.includes('rate limit')) {
      results.errors429++;
      results.rateLimitErrors++;
    }
    // 503 errors
    if (line.includes('503')) {
      results.errors503++;
    }
    // JS crashes/errors
    if (line.includes('UnhandledPromiseRejection') || line.includes('TypeError') ||
        line.includes('ReferenceError') || line.includes('FATAL')) {
      results.jsErrors++;
    }
    // Analysis completed
    if (line.includes('[scorer]') && line.includes('score=')) {
      results.analysisCount++;
    }
    // Analysis latency (parse from tier2 logs)
    const latencyMatch = line.match(/Analysis completed in (\d+)ms/);
    if (latencyMatch) {
      results.analysisLatencies.push(parseInt(latencyMatch[1]));
    }
    // Pool detection
    if (line.includes('[pumpswap-monitor]') && line.includes('New pool')) {
      results.poolsDetected++;
    }
    // Shadow positions
    if (line.includes('[shadow]') && line.includes('tracking')) {
      results.shadowPositions++;
    }
    // Live positions
    if (line.includes('[position]') && line.includes('opened')) {
      results.livePositions++;
    }
    // Sells
    if (line.includes('[pumpswap-sell]') && line.includes('Selling')) {
      results.sellsAttempted++;
    }
    if (line.includes('[pumpswap-sell]') && line.includes('Sell completed')) {
      results.sellsSucceeded++;
    }
    // Timeouts
    if (line.includes('timeout after') || line.includes('Polling timeout')) {
      results.timeoutErrors++;
    }
  }

  return results;
}

function printReport(results, logPath) {
  const avgLatency = results.analysisLatencies.length > 0
    ? Math.round(results.analysisLatencies.reduce((a, b) => a + b, 0) / results.analysisLatencies.length)
    : 'N/A';
  const maxLatency = results.analysisLatencies.length > 0
    ? Math.max(...results.analysisLatencies)
    : 'N/A';

  console.log('');
  console.log('=== v11a Paid Tier Verification ===');
  console.log(`Log: ${path.basename(logPath)} (last ${results.totalLines} lines)`);
  console.log('');

  // CRITICAL checks
  const pass429 = results.errors429 === 0;
  const passJS = results.jsErrors === 0;
  const passActivity = results.analysisCount > 0 || results.poolsDetected > 0;
  const passLatency = avgLatency === 'N/A' || avgLatency < 5000;

  console.log('--- CRITICAL CHECKS ---');
  console.log(`  429 errors:       ${results.errors429} ${pass429 ? 'PASS' : 'FAIL <<<'}`);
  console.log(`  JS crashes:       ${results.jsErrors} ${passJS ? 'PASS' : 'FAIL <<<'}`);
  console.log(`  Bot active:       ${passActivity ? 'PASS' : 'FAIL (no activity detected) <<<'}`);
  console.log(`  Avg latency:      ${avgLatency}ms ${passLatency ? 'PASS' : 'FAIL (>5s) <<<'}`);
  console.log('');

  console.log('--- METRICS ---');
  console.log(`  Pools detected:     ${results.poolsDetected}`);
  console.log(`  Analyses completed: ${results.analysisCount}`);
  console.log(`  Avg analysis ms:    ${avgLatency}`);
  console.log(`  Max analysis ms:    ${maxLatency}`);
  console.log(`  Shadow positions:   ${results.shadowPositions}`);
  console.log(`  Live positions:     ${results.livePositions}`);
  console.log(`  Sells attempted:    ${results.sellsAttempted}`);
  console.log(`  Sells succeeded:    ${results.sellsSucceeded}`);
  console.log(`  Timeout errors:     ${results.timeoutErrors}`);
  console.log(`  503 errors:         ${results.errors503}`);
  console.log(`  Rate limit errors:  ${results.rateLimitErrors}`);
  console.log('');

  const allPass = pass429 && passJS && passActivity;
  console.log(`=== OVERALL: ${allPass ? 'PASS - Paid tier working correctly' : 'FAIL - Issues detected, check above'} ===`);
  console.log('');
}

// Main
const logPath = findLatestLog();
if (!logPath) {
  console.error('No log files found in data/');
  process.exit(1);
}

const results = analyze(logPath);
printReport(results, logPath);
