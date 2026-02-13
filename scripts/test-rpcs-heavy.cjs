const { Connection } = require('@solana/web3.js');

// Use a recent TX from the bot logs
const TEST_TX = 'mdSePrDQaoFTP4Dm7CzWVby2QBSAGa5Mj34g6DUQ5xnWWo5DHDhp9MqtiqbJ7mXVAJYkLwC6E2qpt85cJbXKyLn';

const endpoints = [
  { name: 'Helius Primary', url: 'https://mainnet.helius-rpc.com/?api-key=7a961a43-c3ac-4928-897a-c5d7c5d3fd67' },
  { name: 'Helius Analysis', url: 'https://mainnet.helius-rpc.com/?api-key=665d0029-8917-4237-a47c-6c317a4b8c88' },
  { name: 'Alchemy', url: 'https://solana-mainnet.g.alchemy.com/v2/pNl-EuheAPvQ98tBgsGw1' },
  { name: 'ExtrNode', url: 'https://solana-mainnet.rpc.extrnode.com/cee1ff9d-c9e4-4227-84de-daf4cf536f80' },
  { name: 'Chainstack', url: 'https://solana-mainnet.core.chainstack.com/dbbd8c9624c41999b5c680eedbf892e9' },
];

async function testEndpoint(ep) {
  const conn = new Connection(ep.url, { commitment: 'confirmed' });
  const start = Date.now();
  try {
    const tx = await Promise.race([
      conn.getParsedTransaction(TEST_TX, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
      new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT 5s')), 5000)),
    ]);
    const ms = Date.now() - start;
    if (tx) {
      console.log(`  ✅ ${ep.name}: TX found (${ms}ms)`);
    } else {
      console.log(`  ⚠️  ${ep.name}: TX null/not found (${ms}ms)`);
    }
    return true;
  } catch (err) {
    console.log(`  ❌ ${ep.name}: ${err.message.slice(0, 60)} (${Date.now() - start}ms)`);
    return false;
  }
}

(async () => {
  console.log(`Testing getParsedTransaction on ${TEST_TX.slice(0,16)}...\n`);
  for (const ep of endpoints) {
    await testEndpoint(ep);
  }
})();
