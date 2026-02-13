const db = require('better-sqlite3')('data/bot.db');

// 1. Scammer blacklist - how many entries, has it ever blocked anything?
console.log('=== SCAMMER BLACKLIST ===');
const blacklist = db.prepare('SELECT COUNT(*) as n FROM scammer_blacklist').get();
console.log('Wallets en blacklist:', blacklist.n);
const blEntries = db.prepare('SELECT wallet, reason, linked_rug_count FROM scammer_blacklist LIMIT 10').all();
blEntries.forEach(b => console.log('  ', b.wallet.slice(0,8), '|', b.reason, '| rugs:', b.linked_rug_count));

// 2. Creator deep checker - has it ever blocked or penalized anything?
console.log('\n=== CREATOR DEEP CHECK RESULTS ===');
const creatorResults = db.prepare(`
  SELECT dp_creator_reputation as rep, dp_creator_funding as funding, COUNT(*) as n
  FROM detected_pools
  WHERE dp_creator_reputation IS NOT NULL
  GROUP BY rep, funding
  ORDER BY n DESC
`).all();
creatorResults.forEach(r => console.log('  rep=' + r.rep, '| funding=' + (r.funding || 'null'), '| count=' + r.n));

// 3. Token creators table - any data?
console.log('\n=== TOKEN CREATORS TABLE ===');
const creators = db.prepare('SELECT COUNT(*) as n FROM token_creators').get();
console.log('Total entries:', creators.n);
const creatorOutcomes = db.prepare(`
  SELECT outcome, COUNT(*) as n, ROUND(AVG(pnl_pct),1) as avg_pnl
  FROM token_creators
  WHERE outcome != 'unknown'
  GROUP BY outcome
`).all();
creatorOutcomes.forEach(r => console.log('  ', r.outcome, ':', r.n, '| avg_pnl:', r.avg_pnl));

// 4. Has creator reputation ever actually changed a score?
console.log('\n=== CREATOR REPUTATION IMPACT ===');
const repImpact = db.prepare(`
  SELECT dp_creator_reputation as rep, COUNT(*) as n,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN security_passed = 0 THEN 1 ELSE 0 END) as rejected
  FROM detected_pools
  WHERE dp_creator_reputation IS NOT NULL
  GROUP BY rep
  ORDER BY rep
`).all();
repImpact.forEach(r => console.log('  rep=' + r.rep, '| total=' + r.n, '| passed=' + r.passed, '| rejected=' + r.rejected));

// 5. Check the logs - how often does creator check even run?
console.log('\n=== CREATOR DATA EN POSITIONS (bought tokens) ===');
const posCreator = db.prepare(`
  SELECT p.token_mint, p.bot_version, p.pnl_pct, dp.dp_creator_reputation, dp.dp_creator_funding
  FROM positions p
  LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
  WHERE p.bot_version IN ('v8o', 'v8p')
`).all();
posCreator.forEach(t => {
  console.log('  ', t.token_mint.slice(0,8), '| ver=' + t.bot_version, '| pnl=' + (t.pnl_pct?.toFixed(1)||'?') + '%', '| creator_rep=' + t.dp_creator_reputation, '| funding=' + t.dp_creator_funding);
});

// 6. For old rugs - did we have creator data?
console.log('\n=== CREATOR DATA EN RUGS ===');
const rugCreator = db.prepare(`
  SELECT p.token_mint, dp.dp_creator_reputation, dp.dp_creator_funding,
    tc.creator_wallet, tc.funding_source, tc.wallet_age_seconds, tc.tx_count, tc.reputation_score
  FROM positions p
  LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
  LEFT JOIN token_creators tc ON tc.token_mint = p.token_mint
  WHERE p.exit_reason = 'rug_pull'
`).all();
rugCreator.forEach(t => {
  console.log('  ', t.token_mint.slice(0,8),
    '| dp_rep=' + t.dp_creator_reputation,
    '| dp_fund=' + t.dp_creator_funding,
    '| tc_wallet=' + (t.creator_wallet ? t.creator_wallet.slice(0,8) : 'null'),
    '| tc_fund=' + t.funding_source,
    '| tc_age=' + t.wallet_age_seconds + 's',
    '| tc_txs=' + t.tx_count,
    '| tc_rep=' + t.reputation_score
  );
});

// 7. How many tokens does creator check even fire on? (check if coinCreator is System Program)
console.log('\n=== coinCreator = System Program (reversed pools) ===');
// Count positions where creator data is null
const noCreator = db.prepare(`
  SELECT COUNT(*) as n FROM detected_pools WHERE dp_creator_reputation IS NULL AND bot_version IN ('v8o','v8p')
`).get();
const hasCreator = db.prepare(`
  SELECT COUNT(*) as n FROM detected_pools WHERE dp_creator_reputation IS NOT NULL AND bot_version IN ('v8o','v8p')
`).get();
console.log('v8o+v8p: con creator data:', hasCreator.n, '| sin creator data:', noCreator.n);

db.close();
