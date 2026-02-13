#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });
const now = Date.now();

// 1. Shadow positions by period
console.log('=== SHADOW POSITIONS POR PERIODO ===');
const periods = [
  { name: 'ultima hora', ms: 3600000 },
  { name: 'ultimas 2h', ms: 7200000 },
  { name: 'ultimas 3h', ms: 10800000 },
  { name: 'todo hoy', ms: now - new Date('2026-02-10T00:00:00Z').getTime() },
];
for (const p of periods) {
  const start = now - p.ms;
  const r = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN rug_detected=1 THEN 1 ELSE 0 END) as rugs,
      SUM(CASE WHEN tp1_hit=1 THEN 1 ELSE 0 END) as tp1,
      SUM(CASE WHEN tp2_hit=1 THEN 1 ELSE 0 END) as tp2
    FROM shadow_positions WHERE status='closed' AND opened_at >= ?
  `).get(start);
  console.log(`${p.name}: total=${r.total} rugs=${r.rugs} tp1=${r.tp1} tp2=${r.tp2}`);
}

// 2. Active shadows
const active = db.prepare("SELECT COUNT(*) as cnt FROM shadow_positions WHERE status='tracking'").get();
console.log('\nShadow activas:', active.cnt);

// 3. Last hour detail
console.log('\n=== SHADOW CERRADAS ULTIMA HORA ===');
const oneHourAgo = now - 3600000;
const recent = db.prepare(`
  SELECT sp.security_score, sp.peak_multiplier, sp.tp1_hit, sp.tp2_hit, sp.tp3_hit,
         sp.exit_reason, sp.rug_detected, sp.entry_sol_reserve,
         dp.dp_liquidity_usd,
         ROUND((sp.closed_at - sp.opened_at)/1000.0, 0) as duration_s
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON (sp.token_mint = dp.base_mint OR sp.token_mint = dp.quote_mint)
    AND dp.base_mint != 'So11111111111111111111111111111111111111112'
  WHERE sp.status = 'closed' AND sp.opened_at >= ?
  ORDER BY sp.opened_at DESC
`).all(oneHourAgo);

console.log('Total:', recent.length);
if (recent.length > 0) {
  const rugs = recent.filter(r => r.rug_detected);
  const safe = recent.filter(r => !r.rug_detected);
  console.log('Rugs:', rugs.length, '| Safe:', safe.length);
  console.log('TP1:', recent.filter(r => r.tp1_hit).length, '| TP2:', recent.filter(r => r.tp2_hit).length);
  if (safe.length > 0) console.log('Avg peak (safe):', (safe.reduce((a,b) => a+b.peak_multiplier, 0)/safe.length).toFixed(2) + 'x');
  if (rugs.length > 0) console.log('Avg peak (rugs):', (rugs.reduce((a,b) => a+b.peak_multiplier, 0)/rugs.length).toFixed(2) + 'x');
}

// 4. Breakdown by filter for LAST HOUR
console.log('\n=== ULTIMA HORA POR FILTRO ===');
const filters = [
  { name: 'ALL', fn: () => true },
  { name: 'score>=50', fn: p => (p.security_score||0) >= 50 },
  { name: 'score>=60', fn: p => (p.security_score||0) >= 60 },
  { name: 'score>=75', fn: p => (p.security_score||0) >= 75 },
  { name: 'liq>=10K', fn: p => (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=60 liq>=10K', fn: p => (p.security_score||0) >= 60 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=75 liq>=10K', fn: p => (p.security_score||0) >= 75 && (p.dp_liquidity_usd||0) >= 10000 },
];

for (const f of filters) {
  const s = recent.filter(f.fn);
  if (s.length === 0) { console.log(`${f.name}: 0 datos`); continue; }
  const rugs = s.filter(p => p.rug_detected).length;
  const tp1 = s.filter(p => p.tp1_hit).length;
  const tp2 = s.filter(p => p.tp2_hit).length;
  const safe = s.filter(p => !p.rug_detected);
  const avgPeak = safe.length > 0 ? (safe.reduce((a,b)=>a+b.peak_multiplier,0)/safe.length).toFixed(2) : 'N/A';
  console.log(`${f.name}: N=${s.length} rugs=${rugs}(${(rugs/s.length*100).toFixed(0)}%) TP1=${tp1}(${(tp1/s.length*100).toFixed(0)}%) TP2=${tp2}(${(tp2/s.length*100).toFixed(0)}%) safe_avg_peak=${avgPeak}x`);
}

// 5. Price log availability
console.log('\n=== PRICE LOGS ===');
const totalLogs = db.prepare('SELECT COUNT(*) as cnt FROM shadow_price_log').get();
console.log('Total entries:', totalLogs.cnt);

const withLogs = db.prepare(`
  SELECT COUNT(DISTINCT sp.id) as cnt
  FROM shadow_positions sp
  JOIN shadow_price_log spl ON spl.shadow_id = sp.id
  WHERE sp.status = 'closed'
`).get();
console.log('Shadow con price logs:', withLogs.cnt);

// 6. ALL 104 shadow positions - full breakdown for backtest planning
console.log('\n=== ALL SHADOW (104) — PnL SIMULATION DETALLADA ===');
const allShadow = db.prepare(`
  SELECT sp.security_score, sp.peak_multiplier, sp.tp1_hit, sp.tp2_hit, sp.tp3_hit,
         sp.exit_reason, sp.rug_detected, sp.entry_sol_reserve,
         sp.final_multiplier, dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON (sp.token_mint = dp.base_mint OR sp.token_mint = dp.quote_mint)
    AND dp.base_mint != 'So11111111111111111111111111111111111111112'
  WHERE sp.status = 'closed' AND sp.peak_multiplier > 0
`).all();

// Simulate EXACT PnL for each shadow position with v9d exit strategy
// TP1: 50% @ 1.2x, TP2: 30% @ 1.5x, TP3: 20% @ 3.0x
// Trailing: 10% base, 8% post-TP1, 5% post-TP2
// SL: -30%, Timeout: 12min
const sizes = [0.02, 0.05, 0.10];
const overhead = 0.0028;
const slippage = 0.04; // 2% buy + 2% sell

for (const f of [
  { name: 'ALL', fn: () => true },
  { name: 'score>=50', fn: p => (p.security_score||0) >= 50 },
  { name: 'score>=60', fn: p => (p.security_score||0) >= 60 },
  { name: 'score>=60 liq>=10K', fn: p => (p.security_score||0) >= 60 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=75 liq>=10K [v9d]', fn: p => (p.security_score||0) >= 75 && (p.dp_liquidity_usd||0) >= 10000 },
]) {
  const positions = allShadow.filter(f.fn);
  if (positions.length < 3) { console.log(`\n${f.name}: N=${positions.length} (insuficiente)`); continue; }

  console.log(`\n${f.name} (N=${positions.length}):`);

  for (const size of sizes) {
    let totalPnl = 0;
    let wins = 0, losses = 0;

    for (const p of positions) {
      let pnl = -overhead; // always pay overhead

      if (p.rug_detected) {
        // Rug: lose ~50-80% depending on how fast we exit
        // Conservative: lose 60% of position
        const rugLoss = size * 0.60;
        pnl -= rugLoss;
      } else {
        // Simulate exit based on peak multiplier with slippage
        const effectivePeak = p.peak_multiplier * (1 - slippage);
        const effectiveFinal = (p.final_multiplier || 1) * (1 - slippage);

        let exitValue = 0;
        let remaining = 1.0; // fraction of position

        if (p.tp1_hit && effectivePeak >= 1.2) {
          // Sell 50% at ~1.15x (1.2x - slippage)
          exitValue += 0.50 * size * Math.min(1.15, effectivePeak);
          remaining -= 0.50;
        }
        if (p.tp2_hit && effectivePeak >= 1.5) {
          // Sell 30% at ~1.44x (1.5x - slippage)
          exitValue += 0.30 * size * Math.min(1.44, effectivePeak);
          remaining -= 0.30;
        }
        if (p.tp3_hit && effectivePeak >= 3.0) {
          // Sell 20% at ~2.88x
          exitValue += 0.20 * size * Math.min(2.88, effectivePeak);
          remaining -= 0.20;
        }

        // Remaining sells at trailing stop or timeout
        // Conservative: remaining exits at final_multiplier * 0.9 (trailing)
        if (remaining > 0) {
          const trailingExit = Math.max(effectiveFinal * 0.92, 0.70); // trailing or SL floor
          exitValue += remaining * size * trailingExit;
        }

        pnl += exitValue - size; // profit = exit value - initial investment
      }

      totalPnl += pnl;
      if (pnl > 0) wins++;
      else losses++;
    }

    const avgPnl = totalPnl / positions.length;
    const wr = (wins / positions.length * 100).toFixed(0);
    console.log(`  @${size} SOL: total=${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} avg=${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(5)} WR=${wr}% (${wins}W/${losses}L)`);
  }
}

db.close();
