const db = require('better-sqlite3')('data/bot.db');

// 1. Check if bot_version columns exist and have data
console.log('=== BOT VERSION TRACKING CHECK ===');

try {
  const dpVersions = db.prepare(`
    SELECT bot_version, COUNT(*) as n FROM detected_pools GROUP BY bot_version ORDER BY n DESC LIMIT 10
  `).all();
  console.log('\ndetected_pools by version:');
  dpVersions.forEach(r => console.log(`  ${r.bot_version || 'NULL'}: ${r.n} pools`));
} catch(e) { console.log('detected_pools bot_version: column missing -', e.message); }

try {
  const posVersions = db.prepare(`
    SELECT bot_version, COUNT(*) as n FROM positions GROUP BY bot_version ORDER BY n DESC LIMIT 10
  `).all();
  console.log('\npositions by version:');
  posVersions.forEach(r => console.log(`  ${r.bot_version || 'NULL'}: ${r.n} positions`));
} catch(e) { console.log('positions bot_version: column missing -', e.message); }

try {
  const taVersions = db.prepare(`
    SELECT bot_version, COUNT(*) as n FROM token_analysis GROUP BY bot_version ORDER BY n DESC LIMIT 10
  `).all();
  console.log('\ntoken_analysis by version:');
  taVersions.forEach(r => console.log(`  ${r.bot_version || 'NULL'}: ${r.n} records`));
} catch(e) { console.log('token_analysis bot_version: column missing -', e.message); }

// 2. Full performance analysis - all time by date
console.log('\n=== DAILY PERFORMANCE (ALL TIME) ===');
const daily = db.prepare(`
  SELECT date(opened_at/1000, 'unixepoch', 'localtime') as day,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(100.0 * SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct
  FROM positions
  WHERE status IN ('closed','stopped')
  GROUP BY day ORDER BY day DESC
`).all();
console.log('Date       | Trades | Wins | Rugs | Win%  | PnL        | Avg PnL');
daily.forEach(r => {
  console.log(`${r.day} |   ${String(r.n).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.win_pct).padStart(5)}% | ${String(r.pnl).padStart(10)} | ${r.avg_pnl}`);
});

// 3. Today's trades - detailed
console.log('\n=== TODAY TRADES (DETAILED) ===');
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
const todayMs = todayStart.getTime();

const today = db.prepare(`
  SELECT substr(p.token_mint,1,8) as tok,
    ROUND(p.pnl_sol, 6) as pnl, ROUND(p.pnl_pct, 1) as pct,
    p.exit_reason, p.security_score as score,
    ROUND(p.liquidity_usd, 0) as liq,
    p.holder_count as holders,
    ROUND(p.peak_multiplier, 3) as peak,
    ROUND((p.closed_at - p.opened_at)/1000.0, 0) as hold_sec,
    p.sell_attempts, p.sell_successes,
    p.bot_version as ver,
    datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened,
    dp.dp_graduation_time_s as grad_time
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.opened_at > ?
  ORDER BY p.opened_at DESC
`).all(todayMs);
console.log(`Total: ${today.length} trades today`);
today.forEach(r => {
  const gradStr = r.grad_time != null && r.grad_time >= 0 ? `${Math.round(r.grad_time/60)}min` : 'N/A';
  console.log(`  ${r.opened} | ${r.tok} | v=${r.ver || '?'} | score=${r.score} | liq=$${r.liq} | h=${r.holders} | grad=${gradStr} | peak=${r.peak}x | hold=${r.hold_sec}s | ${r.exit_reason} | ${r.pnl} SOL (${r.pct}%)`);
});

// 4. Liquidity bracket analysis (last 24h)
console.log('\n=== LIQUIDITY BRACKETS (last 24h) ===');
const liq24 = db.prepare(`
  SELECT
    CASE WHEN liquidity_usd < 15000 THEN '<$15K'
         WHEN liquidity_usd < 20000 THEN '$15-20K'
         WHEN liquidity_usd < 25000 THEN '$20-25K'
         WHEN liquidity_usd < 30000 THEN '$25-30K'
         WHEN liquidity_usd < 50000 THEN '$30-50K'
         WHEN liquidity_usd < 75000 THEN '$50-75K'
         ELSE '>$75K' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(100.0 * SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct,
    ROUND(100.0 * SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) / COUNT(*), 1) as rug_pct
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd > 0 AND opened_at > ?
  GROUP BY bracket ORDER BY MIN(liquidity_usd)
`).all(Date.now() - 24 * 3600000);
console.log('Bracket   | N   | Wins | Rugs | Win%  | Rug%  | PnL        | Avg PnL');
liq24.forEach(r => console.log(`${r.bracket.padEnd(10)}| ${String(r.n).padStart(3)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.win_pct).padStart(5)}% | ${String(r.rug_pct).padStart(5)}% | ${String(r.pnl).padStart(10)} | ${r.avg_pnl}`));

// 5. Exit reason breakdown (last 24h)
console.log('\n=== EXIT REASONS (last 24h) ===');
const exits = db.prepare(`
  SELECT exit_reason, COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_sol),6) as pnl, ROUND(AVG(pnl_sol),6) as avg,
    ROUND(AVG(peak_multiplier),3) as avg_peak,
    ROUND(AVG((closed_at - opened_at)/1000.0), 0) as avg_hold
  FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY exit_reason ORDER BY n DESC
`).all(Date.now() - 24 * 3600000);
exits.forEach(r => console.log(`  ${(r.exit_reason || 'null').padEnd(20)} | ${r.n} trades | ${r.wins} wins | ${r.pnl} SOL (avg ${r.avg}) | peak=${r.avg_peak}x | hold=${r.avg_hold}s`));

// 6. Graduation timing analysis (last 24h, where we have data)
console.log('\n=== GRADUATION TIMING vs OUTCOME (last 24h) ===');
const gradAnalysis = db.prepare(`
  SELECT
    CASE WHEN dp.dp_graduation_time_s IS NULL OR dp.dp_graduation_time_s < 0 THEN 'N/A'
         WHEN dp.dp_graduation_time_s < 300 THEN '<5min'
         WHEN dp.dp_graduation_time_s < 2700 THEN '5-45min'
         ELSE '>45min' END as grad_bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(p.pnl_sol), 6) as pnl,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.opened_at > ?
  GROUP BY grad_bracket
`).all(Date.now() - 24 * 3600000);
gradAnalysis.forEach(r => console.log(`  ${r.grad_bracket.padEnd(8)}: ${r.n} trades, ${r.wins} wins, ${r.rugs} rugs, ${r.pnl} SOL (avg ${r.avg_pnl})`));

// 7. Current balance
console.log('\n=== SUMMARY ===');
const allTime = db.prepare(`
  SELECT COUNT(*) as n, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions WHERE status IN ('closed','stopped')
`).get();
const last24h = db.prepare(`
  SELECT COUNT(*) as n, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?
`).get(Date.now() - 24 * 3600000);
console.log(`All-time: ${allTime.n} trades, ${allTime.wins} wins (${allTime.n>0?Math.round(100*allTime.wins/allTime.n):0}%), ${allTime.pnl} SOL`);
console.log(`Last 24h: ${last24h.n} trades, ${last24h.wins} wins (${last24h.n>0?Math.round(100*last24h.wins/last24h.n):0}%), ${last24h.pnl} SOL`);

// Open positions
const open = db.prepare(`SELECT COUNT(*) as n FROM positions WHERE status IN ('open','partial_close')`).get();
console.log(`Open positions: ${open.n}`);

db.close();
