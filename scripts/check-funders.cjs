#!/usr/bin/env node
// Check funder wallets on-chain via Helius API
// Analyzes fan-out patterns (sending SOL to many wallets)

const API_KEY = '7a961a43-c3ac-4928-897a-c5d7c5d3fd67';

const RUG_FUNDERS = [
  '2nZKq2ZZ4JSXhhVCmQSwZ1LhhcBs1c9vMQ19BAGtEL3k',
  '2ugdchEANnnqbg8mdfajvsNB8Enw1ozp7VKC5zovznMi',
  '39FQiBN8s4hK5YLCsUDyA5QT4WmdamPy7B33srvbSGKE',
  '5CzKXtWQMPV9yVvzpn6B3aKVFL8kvcTWbgScP7iGeATR',
  '7JnLF7wG5YcLoQa8HVUKMtFVLoHLPFsCwWSkEAB3QW7t',
  '7yRd3dojv8a4gX7tgUdP5HQEiJNkxd7oGphj83G46LGk',
  '9A19Qow7JmLWxayCd1ZGpgrCxHVc6uX4AGeBLoeS2jL2',
  'AajesrahRP6YQ7NiQpkK71jSnmQY1Wmf3AguoZeHtVCK',
  'DhgcpAqr2TQ6q5VseAimte5Nu7cFMWDvhva7yfXce77p',
  'Dx1F5VZcGcVz1JAxCuGDwpAVJX6AL5rXZE4DzHXco9X4',
  'GsLo38xvHPaMBetkC2JmnLtaiU9cRSmT1DKRGG8fikiU',
  'GuJsA6cnYw4wjcKGDdqscaK5vSQLL56iM6ccBSrXVZsB',
];

const WINNER_FUNDERS = [
  '3e2yEAe5PEqjszgGCeL1zFVhQrpTnF4jWy7Zdivu6fLW',  // funded Den9xfis (winner)
  '5E2DK1GpYJJRKakp95FoELnoBv9p7NpW6cRbXRM4vzL6',  // funded CXUKkyZG (winner)
  '9ThqpTG2grHUgqLUmy6KhqLXZn1xuNFVfFtFP2kFaXRN',  // funded 9VEEtZah (winner)
  'Hqghw63wTtQuUP2FoYjES8xjX35JEDBBE8dbJg4yaNS1',  // funded 2aNtrpEi (winner) - also a CREATOR of 5qmmPy6p
  'G3oQKQoS2epqZrZjszVxT7PWkzENWPXnWFAFRBXjgMsf',  // funded A1Nz8sBD (winner)
];

async function fetchTransactions(wallet, label) {
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${API_KEY}&limit=20`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`  ERROR: ${resp.status} ${resp.statusText}`);
      return null;
    }
    const txs = await resp.json();
    return txs;
  } catch (e) {
    console.log(`  FETCH ERROR: ${e.message}`);
    return null;
  }
}

function analyzeFanOut(txs, wallet) {
  if (!txs || txs.length === 0) return { totalTxs: 0, outgoing: 0, uniqueRecipients: 0, fanOut: false };

  const outgoingTransfers = [];
  const uniqueRecipients = new Set();
  let solSentTotal = 0;
  const amounts = [];

  for (const tx of txs) {
    // Check native transfers
    if (tx.nativeTransfers) {
      for (const nt of tx.nativeTransfers) {
        if (nt.fromUserAccount === wallet && nt.toUserAccount !== wallet) {
          outgoingTransfers.push({
            to: nt.toUserAccount,
            amount: nt.amount / 1e9,
            timestamp: tx.timestamp,
            signature: tx.signature,
            type: tx.type || 'UNKNOWN',
          });
          uniqueRecipients.add(nt.toUserAccount);
          solSentTotal += nt.amount / 1e9;
          amounts.push(nt.amount / 1e9);
        }
      }
    }
  }

  // Check for similar amounts (fan-out pattern)
  const amountBuckets = {};
  for (const amt of amounts) {
    const bucket = Math.round(amt * 100) / 100; // round to 0.01
    amountBuckets[bucket] = (amountBuckets[bucket] || 0) + 1;
  }

  const maxSameAmount = Math.max(...Object.values(amountBuckets), 0);
  const fanOut = uniqueRecipients.size >= 3 && maxSameAmount >= 3;

  return {
    totalTxs: txs.length,
    outgoing: outgoingTransfers.length,
    uniqueRecipients: uniqueRecipients.size,
    solSentTotal: solSentTotal.toFixed(4),
    fanOut,
    maxSameAmountCount: maxSameAmount,
    amountBuckets,
    topRecipients: [...uniqueRecipients].slice(0, 10),
    recentTypes: [...new Set(txs.map(t => t.type))],
    transfers: outgoingTransfers.slice(0, 15),
    timeRange: txs.length > 0 ? {
      oldest: new Date(txs[txs.length - 1].timestamp * 1000).toISOString(),
      newest: new Date(txs[0].timestamp * 1000).toISOString(),
    } : null,
  };
}

async function main() {
  console.log('='.repeat(100));
  console.log('FUNDER WALLET ON-CHAIN ANALYSIS');
  console.log('='.repeat(100));

  console.log('\n' + '='.repeat(100));
  console.log('SECTION 1: RUG FUNDERS (12 wallets)');
  console.log('='.repeat(100));

  const rugResults = [];

  for (const wallet of RUG_FUNDERS) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`RUG FUNDER: ${wallet}`);
    console.log(`${'─'.repeat(80)}`);

    const txs = await fetchTransactions(wallet, 'rug');
    if (!txs) continue;

    const analysis = analyzeFanOut(txs, wallet);
    rugResults.push({ wallet, ...analysis });

    console.log(`  Total TXs fetched: ${analysis.totalTxs}`);
    console.log(`  Outgoing SOL transfers: ${analysis.outgoing}`);
    console.log(`  Unique recipients: ${analysis.uniqueRecipients}`);
    console.log(`  Total SOL sent: ${analysis.solSentTotal}`);
    console.log(`  FAN-OUT detected: ${analysis.fanOut ? 'YES <<<' : 'no'}`);
    console.log(`  Max same-amount transfers: ${analysis.maxSameAmountCount}`);
    console.log(`  TX types: ${analysis.recentTypes.join(', ')}`);
    if (analysis.timeRange) {
      console.log(`  Time range: ${analysis.timeRange.oldest} to ${analysis.timeRange.newest}`);
    }

    // Show amount distribution
    if (Object.keys(analysis.amountBuckets).length > 0) {
      console.log('  Amount distribution (SOL):');
      const sorted = Object.entries(analysis.amountBuckets).sort((a, b) => b[1] - a[1]);
      for (const [amt, count] of sorted.slice(0, 10)) {
        console.log(`    ${amt} SOL: ${count}x${count >= 3 ? ' <<< CLUSTER' : ''}`);
      }
    }

    // Show individual transfers
    if (analysis.transfers.length > 0) {
      console.log('  Recent outgoing transfers:');
      for (const t of analysis.transfers.slice(0, 8)) {
        const date = new Date(t.timestamp * 1000).toISOString().slice(0, 19);
        console.log(`    ${date} | ${t.amount.toFixed(4)} SOL -> ${t.to.slice(0, 12)}... | type: ${t.type}`);
      }
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n' + '='.repeat(100));
  console.log('SECTION 2: WINNER FUNDERS (5 wallets - CONTROL GROUP)');
  console.log('='.repeat(100));

  const winnerResults = [];

  for (const wallet of WINNER_FUNDERS) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`WINNER FUNDER: ${wallet}`);
    console.log(`${'─'.repeat(80)}`);

    const txs = await fetchTransactions(wallet, 'winner');
    if (!txs) continue;

    const analysis = analyzeFanOut(txs, wallet);
    winnerResults.push({ wallet, ...analysis });

    console.log(`  Total TXs fetched: ${analysis.totalTxs}`);
    console.log(`  Outgoing SOL transfers: ${analysis.outgoing}`);
    console.log(`  Unique recipients: ${analysis.uniqueRecipients}`);
    console.log(`  Total SOL sent: ${analysis.solSentTotal}`);
    console.log(`  FAN-OUT detected: ${analysis.fanOut ? 'YES <<<' : 'no'}`);
    console.log(`  Max same-amount transfers: ${analysis.maxSameAmountCount}`);
    console.log(`  TX types: ${analysis.recentTypes.join(', ')}`);
    if (analysis.timeRange) {
      console.log(`  Time range: ${analysis.timeRange.oldest} to ${analysis.timeRange.newest}`);
    }

    if (Object.keys(analysis.amountBuckets).length > 0) {
      console.log('  Amount distribution (SOL):');
      const sorted = Object.entries(analysis.amountBuckets).sort((a, b) => b[1] - a[1]);
      for (const [amt, count] of sorted.slice(0, 10)) {
        console.log(`    ${amt} SOL: ${count}x${count >= 3 ? ' <<< CLUSTER' : ''}`);
      }
    }

    if (analysis.transfers.length > 0) {
      console.log('  Recent outgoing transfers:');
      for (const t of analysis.transfers.slice(0, 8)) {
        const date = new Date(t.timestamp * 1000).toISOString().slice(0, 19);
        console.log(`    ${date} | ${t.amount.toFixed(4)} SOL -> ${t.to.slice(0, 12)}... | type: ${t.type}`);
      }
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // SUMMARY
  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY COMPARISON');
  console.log('='.repeat(100));

  console.log('\nRUG FUNDERS:');
  console.log('Wallet (first 12)       | TXs | Outgoing | Recipients | SOL Sent | Fan-Out | Max Same-Amt');
  console.log('─'.repeat(95));
  for (const r of rugResults) {
    console.log(`${r.wallet.slice(0, 20)}... | ${String(r.totalTxs).padStart(3)} | ${String(r.outgoing).padStart(8)} | ${String(r.uniqueRecipients).padStart(10)} | ${String(r.solSentTotal).padStart(8)} | ${r.fanOut ? 'YES' : ' no'} | ${r.maxSameAmountCount}`);
  }

  console.log('\nWINNER FUNDERS:');
  console.log('Wallet (first 12)       | TXs | Outgoing | Recipients | SOL Sent | Fan-Out | Max Same-Amt');
  console.log('─'.repeat(95));
  for (const r of winnerResults) {
    console.log(`${r.wallet.slice(0, 20)}... | ${String(r.totalTxs).padStart(3)} | ${String(r.outgoing).padStart(8)} | ${String(r.uniqueRecipients).padStart(10)} | ${String(r.solSentTotal).padStart(8)} | ${r.fanOut ? 'YES' : ' no'} | ${r.maxSameAmountCount}`);
  }

  // Statistical comparison
  const rugFanOutRate = rugResults.filter(r => r.fanOut).length / rugResults.length;
  const winFanOutRate = winnerResults.filter(r => r.fanOut).length / winnerResults.length;
  const rugAvgRecipients = rugResults.reduce((s, r) => s + r.uniqueRecipients, 0) / rugResults.length;
  const winAvgRecipients = winnerResults.reduce((s, r) => s + r.uniqueRecipients, 0) / winnerResults.length;

  console.log('\nSTATISTICAL COMPARISON:');
  console.log(`  Rug funders fan-out rate:    ${(rugFanOutRate * 100).toFixed(1)}% (${rugResults.filter(r => r.fanOut).length}/${rugResults.length})`);
  console.log(`  Winner funders fan-out rate:  ${(winFanOutRate * 100).toFixed(1)}% (${winnerResults.filter(r => r.fanOut).length}/${winnerResults.length})`);
  console.log(`  Rug funders avg recipients:  ${rugAvgRecipients.toFixed(1)}`);
  console.log(`  Winner funders avg recipients: ${winAvgRecipients.toFixed(1)}`);
}

main().catch(console.error);
