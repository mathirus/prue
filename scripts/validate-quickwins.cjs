const db = require('better-sqlite3')('data/bot.db', { readonly: true });

// Join detected_pools (dp) with positions (p) via token_mint/base_mint
// detected_pools has all the scoring details; positions has PnL

// === 1. FREEZE AUTH ===
console.log('=== FREEZE AUTH ANALYSIS ===');
const freezeData = db.prepare(`
  SELECT
    dp.dp_freeze_auth_revoked as freeze,
    COUNT(*) as total,
    SUM(CASE WHEN p.pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%drained%' THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl,
    ROUND(AVG(p.peak_multiplier), 2) as avg_peak
  FROM detected_pools dp
  JOIN positions p ON dp.base_mint = p.token_mint
  WHERE p.status IN ('closed', 'stopped') AND p.sol_invested > 0
  GROUP BY dp.dp_freeze_auth_revoked
`).all();
console.log('  freeze | total | wins | rugs | avg_pnl | avg_peak');
freezeData.forEach(r => {
  console.log(`  ${r.freeze === 1 ? 'YES' : r.freeze === 0 ? 'NO ' : 'UNK'} | ${String(r.total).padStart(5)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${r.avg_pnl} | ${r.avg_peak}`);
});

// === 2. HIDDEN WHALE ===
console.log('\n=== HIDDEN WHALE ANALYSIS ===');
const whaleData = db.prepare(`
  SELECT
    dp.dp_hidden_whale_count as whales,
    COUNT(*) as total,
    SUM(CASE WHEN p.pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%drained%' THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl,
    ROUND(AVG(p.peak_multiplier), 2) as avg_peak
  FROM detected_pools dp
  JOIN positions p ON dp.base_mint = p.token_mint
  WHERE p.status IN ('closed', 'stopped') AND p.sol_invested > 0
  GROUP BY dp.dp_hidden_whale_count
  ORDER BY dp.dp_hidden_whale_count
`).all();
console.log('  whales | total | wins | rugs | avg_pnl | avg_peak');
whaleData.forEach(r => {
  console.log(`  ${String(r.whales ?? 'null').padStart(6)} | ${String(r.total).padStart(5)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${r.avg_pnl} | ${r.avg_peak}`);
});

// === 3. TX VELOCITY ===
console.log('\n=== TX VELOCITY ANALYSIS ===');
const velData = db.prepare(`
  SELECT
    CASE
      WHEN dp.dp_tx_velocity IS NULL THEN 'null'
      WHEN dp.dp_tx_velocity = 0 THEN '0'
      WHEN dp.dp_tx_velocity < 5 THEN '1-4'
      WHEN dp.dp_tx_velocity < 15 THEN '5-14'
      WHEN dp.dp_tx_velocity < 50 THEN '15-49'
      WHEN dp.dp_tx_velocity < 100 THEN '50-99'
      ELSE '100+'
    END as vel_bucket,
    COUNT(*) as total,
    SUM(CASE WHEN p.pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%drained%' THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl,
    ROUND(AVG(p.peak_multiplier), 2) as avg_peak
  FROM detected_pools dp
  JOIN positions p ON dp.base_mint = p.token_mint
  WHERE p.status IN ('closed', 'stopped') AND p.sol_invested > 0
  GROUP BY vel_bucket
`).all();
console.log('  velocity | total | wins | rugs | avg_pnl | avg_peak');
velData.forEach(r => {
  console.log(`  ${String(r.vel_bucket).padEnd(8)} | ${String(r.total).padStart(5)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${r.avg_pnl} | ${r.avg_peak}`);
});

// Distribution of velocity values
const velDist = db.prepare(`
  SELECT dp.dp_tx_velocity as vel, COUNT(*) as cnt
  FROM detected_pools dp
  JOIN positions p ON dp.base_mint = p.token_mint
  WHERE p.status IN ('closed', 'stopped') AND p.sol_invested > 0 AND dp.dp_tx_velocity IS NOT NULL
  GROUP BY vel ORDER BY vel
`).all();
const totalVel = velDist.reduce((s, r) => s + r.cnt, 0);
if (totalVel > 0) {
  [5, 10, 15, 20, 50, 100].forEach(threshold => {
    const above = velDist.filter(r => r.vel >= threshold).reduce((s, r) => s + r.cnt, 0);
    console.log(`  >= ${threshold} tx/min: ${above}/${totalVel} (${(above/totalVel*100).toFixed(0)}%)`);
  });
}

// Also check ALL detected pools (not just traded) for txVelocity coverage
const velAllPools = db.prepare(`
  SELECT dp.dp_tx_velocity as vel, COUNT(*) as cnt
  FROM detected_pools dp
  WHERE dp.dp_tx_velocity IS NOT NULL AND dp.dp_tx_velocity > 0
  GROUP BY vel ORDER BY vel
`).all();
const totalVelAll = velAllPools.reduce((s, r) => s + r.cnt, 0);
if (totalVelAll > 0) {
  console.log('\n  TX Velocity across ALL detected pools (not just traded):');
  [5, 10, 15, 20, 50, 100].forEach(threshold => {
    const above = velAllPools.filter(r => r.vel >= threshold).reduce((s, r) => s + r.cnt, 0);
    console.log(`    >= ${threshold} tx/min: ${above}/${totalVelAll} (${(above/totalVelAll*100).toFixed(0)}%)`);
  });
}

// === 4. OBSERVATION WINDOW ===
console.log('\n=== OBSERVATION WINDOW (traded tokens) ===');
const obsTraded = db.prepare(`
  SELECT
    dp.dp_observation_stable as stable,
    COUNT(*) as total,
    SUM(CASE WHEN p.pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%drained%' THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl,
    ROUND(AVG(p.peak_multiplier), 2) as avg_peak
  FROM detected_pools dp
  JOIN positions p ON dp.base_mint = p.token_mint
  WHERE p.status IN ('closed', 'stopped') AND p.sol_invested > 0
  GROUP BY dp.dp_observation_stable
`).all();
console.log('  stable | total | wins | rugs | avg_pnl | avg_peak');
obsTraded.forEach(r => {
  console.log(`  ${r.stable === 1 ? 'YES' : r.stable === 0 ? 'NO ' : 'UNK'} | ${String(r.total).padStart(5)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${r.avg_pnl} | ${r.avg_peak}`);
});

// Obs across ALL detected pools (rejected ones show the signal)
const obsAll = db.prepare(`
  SELECT
    dp.dp_observation_stable as stable,
    COUNT(*) as total,
    SUM(CASE WHEN p.pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%drained%' THEN 1 ELSE 0 END) as rugs
  FROM detected_pools dp
  LEFT JOIN positions p ON dp.base_mint = p.token_mint AND p.status IN ('closed', 'stopped')
  WHERE dp.dp_observation_stable IS NOT NULL
  GROUP BY dp.dp_observation_stable
`).all();
console.log('\n  Obs across ALL detected pools:');
obsAll.forEach(r => {
  console.log(`  ${r.stable === 1 ? 'STABLE  ' : r.stable === 0 ? 'UNSTABLE' : 'NULL    '} : ${r.total} pools (${r.wins || 0} trades won, ${r.rugs || 0} rugs)`);
});

// === 5. LP BURNED ===
console.log('\n=== LP BURNED (always 0 for PumpSwap?) ===');
const lpData = db.prepare(`
  SELECT
    dp.source,
    dp.dp_lp_burned as lp,
    COUNT(*) as total
  FROM detected_pools dp
  WHERE dp.dp_lp_burned IS NOT NULL
  GROUP BY dp.source, dp.dp_lp_burned
`).all();
console.log('  source | lp_burned | count');
lpData.forEach(r => {
  console.log(`  ${String(r.source || 'unk').padEnd(9)} | ${r.lp === 1 ? 'YES' : 'NO '} | ${r.total}`);
});

// === 6. RECENT TRADES DETAILED ===
console.log('\n=== RECENT TRADES (v9o+) — full breakdown ===');
const recent = db.prepare(`
  SELECT
    dp.security_score as score,
    dp.dp_freeze_auth_revoked as freeze,
    dp.dp_mint_auth_revoked as mint,
    dp.dp_lp_burned as lp,
    dp.dp_holder_count as holders,
    dp.dp_liquidity_usd as liq,
    dp.dp_hidden_whale_count as whales,
    dp.dp_tx_velocity as vel,
    dp.dp_observation_stable as obs,
    dp.dp_observation_drop_pct as obs_drop,
    p.peak_multiplier as peak,
    p.pnl_pct,
    p.exit_reason,
    p.bot_version
  FROM detected_pools dp
  JOIN positions p ON dp.base_mint = p.token_mint
  WHERE p.status IN ('closed', 'stopped') AND p.sol_invested > 0
    AND p.bot_version >= 'v9o'
  ORDER BY p.opened_at DESC
`).all();
console.log('  score|frz|mnt|lp|hold|  liq_$|wh|vel|obs|drop%| peak |pnl%|exit');
recent.forEach(r => {
  console.log(`  ${String(r.score||'?').padStart(5)}| ${r.freeze?'Y':'N'} | ${r.mint?'Y':'N'} |${r.lp?'Y':'N'}|${String(r.holders??'?').padStart(4)}|${String(Math.round(r.liq||0)).padStart(6)}|${String(r.whales??'?').padStart(2)}|${String(r.vel??'?').padStart(3)}| ${r.obs===1?'S':r.obs===0?'U':'?'} |${String((r.obs_drop||0).toFixed(0)).padStart(4)}%|${(r.peak||0).toFixed(2)}x|${String((r.pnl_pct||0).toFixed(0)).padStart(4)}%|${(r.exit_reason||'unk').slice(0,12)}`);
});

db.close();
