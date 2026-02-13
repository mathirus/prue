const { Connection } = require('@solana/web3.js');

const endpoints = [
  { name: 'Helius Primary', url: 'https://mainnet.helius-rpc.com/?api-key=7a961a43-c3ac-4928-897a-c5d7c5d3fd67' },
  { name: 'Helius Backup', url: 'https://mainnet.helius-rpc.com/?api-key=5f0e6358-57fb-4077-a570-158e0acbf628' },
  { name: 'Helius Analysis', url: 'https://mainnet.helius-rpc.com/?api-key=665d0029-8917-4237-a47c-6c317a4b8c88' },
  { name: 'Alchemy', url: 'https://solana-mainnet.g.alchemy.com/v2/pNl-EuheAPvQ98tBgsGw1' },
  { name: 'ExtrNode', url: 'https://solana-mainnet.rpc.extrnode.com/cee1ff9d-c9e4-4227-84de-daf4cf536f80' },
  { name: 'Chainstack', url: 'https://solana-mainnet.core.chainstack.com/dbbd8c9624c41999b5c680eedbf892e9' },
];

async function testEndpoint(ep) {
  const conn = new Connection(ep.url, { commitment: 'confirmed' });
  const start = Date.now();
  try {
    const slot = await Promise.race([
      conn.getSlot(),
      new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT 3s')), 3000)),
    ]);
    console.log(`  ✅ ${ep.name}: slot=${slot} (${Date.now() - start}ms)`);
    return true;
  } catch (err) {
    console.log(`  ❌ ${ep.name}: ${err.message.slice(0, 60)} (${Date.now() - start}ms)`);
    return false;
  }
}

(async () => {
  console.log('Testing RPC endpoints...\n');
  let working = 0;
  for (const ep of endpoints) {
    if (await testEndpoint(ep)) working++;
  }
  console.log(`\n${working}/${endpoints.length} endpoints working`);
})();
