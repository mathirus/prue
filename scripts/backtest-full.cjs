#!/usr/bin/env node
/**
 * FULL Shadow Backtest: Evalúa TODAS las 64+ shadow positions
 * Sin límite de concurrencia — evalúa calidad pura de cada filtro+exit combo
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const OVERHEAD = 0.0028; // ATA + TX fees
const SLIP = 0.02; // 2% slippage each way

// Load all closed shadow positions
const positions = db.prepare(`
  SELECT sp.*, dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON (sp.token_mint = dp.base_mint OR sp.token_mint = dp.quote_mint)
    AND dp.base_mint != 'So11111111111111111111111111111111111111112'
  WHERE sp.status = 'closed' AND sp.peak_multiplier > 0 AND sp.entry_price > 0
  ORDER BY sp.opened_at ASC
`).all();

const logStmt = db.prepare(`
  SELECT spl.multiplier, spl.created_at as ts
  FROM shadow_price_log spl
  JOIN shadow_positions sp ON sp.id = spl.shadow_id
  WHERE sp.token_mint = ?
  ORDER BY spl.created_at ASC
`);

// Cache price logs
const logsCache = {};
for (const p of positions) {
  logsCache[p.token_mint] = logStmt.all(p.token_mint);
}

console.log(`BACKTEST COMPLETO — ${positions.length} shadow positions, sin limite concurrencia`);
console.log(`Periodo: ${new Date(positions[0].opened_at).toLocaleString()} — ${new Date(positions[positions.length-1].opened_at).toLocaleString()}`);
console.log(`Slippage: ${SLIP*100}% | Overhead: ${OVERHEAD} SOL/trade`);
console.log('='.repeat(110));

// Simulate one trade
function simTrade(pos, cfg) {
  const logs = logsCache[pos.token_mint];
  if (!logs || logs.length < 3) return null;

  const isRug = pos.exit_reason === 'rug_pull_detected';
  const sz = cfg.size;
  let rem = 100; // % remaining
  let tp = 0;    // TP levels hit
  let peak = 1.0;
  let pnl = 0;
  const t0 = logs[0].ts;

  for (let i = 0; i < logs.length; i++) {
    const m = logs[i].multiplier / (1 + SLIP); // adjust for buy slippage
    const min = (logs[i].ts - t0) / 60000;
    if (m > peak) peak = m;

    // TPs
    if (tp === 0 && m >= cfg.tp1m && rem > 0) {
      const s = Math.min(cfg.tp1p, rem);
      pnl += sz * s/100 * (m*(1-SLIP) - 1);
      rem -= s; tp = 1;
    }
    if (tp === 1 && m >= cfg.tp2m && rem > 0) {
      const s = Math.min(cfg.tp2p, rem);
      pnl += sz * s/100 * (m*(1-SLIP) - 1);
      rem -= s; tp = 2;
    }
    if (tp === 2 && m >= cfg.tp3m && rem > 0) {
      const s = Math.min(cfg.tp3p, rem);
      pnl += sz * s/100 * (m*(1-SLIP) - 1);
      rem -= s; tp = 3;
    }

    // Hard stop (pre-TP only)
    if (m <= (1 + cfg.sl/100) && tp === 0 && rem > 0) {
      pnl += sz * rem/100 * (m*(1-SLIP) - 1);
      rem = 0; break;
    }

    // Trailing stop
    const tr = tp >= 2 ? cfg.tr2 : tp >= 1 ? cfg.tr1 : cfg.tr0;
    if (peak >= 1.12 && rem > 0) {
      const drop = (peak - m) / peak * 100;
      if (drop >= tr) {
        const keep = tp >= 1 ? Math.min(cfg.moon, rem) : 0;
        const sell = rem - keep;
        if (sell > 0) {
          pnl += sz * sell/100 * (m*(1-SLIP) - 1);
          rem -= sell;
        }
      }
    }

    // Post-TP floor
    if (tp >= 1 && m < cfg.floor && rem > 0) {
      pnl += sz * rem/100 * (m*(1-SLIP) - 1);
      rem = 0; break;
    }

    // Early exit: 3min, no TP, below entry
    if (min >= 3 && tp === 0 && m < 1.0 && rem > 0) {
      pnl += sz * rem/100 * (m*(1-SLIP) - 1);
      rem = 0; break;
    }

    // Slow grind: 5min, no TP, below 1.1x
    if (min >= 5 && tp === 0 && m < 1.1 && rem > 0) {
      pnl += sz * rem/100 * (m*(1-SLIP) - 1);
      rem = 0; break;
    }

    // Rug detection near end
    if (isRug && i >= logs.length - 3 && rem > 0) {
      pnl -= sz * rem/100;
      rem = 0; break;
    }

    // Timeout
    if (min >= cfg.timeout && rem > 0) {
      pnl += sz * rem/100 * (m*(1-SLIP) - 1);
      rem = 0; break;
    }
  }

  // Still holding at end
  if (rem > 0) {
    if (isRug) {
      pnl -= sz * rem/100;
    } else {
      const last = logs[logs.length - 1];
      const m = last.multiplier / (1 + SLIP);
      pnl += sz * rem/100 * (m*(1-SLIP) - 1);
    }
  }

  pnl -= OVERHEAD;
  return { pnl, tp, peak, isRug };
}

// Exit strategy configs
const exitConfigs = {
  'v9d': { tp1m:1.2, tp1p:50, tp2m:1.5, tp2p:30, tp3m:3.0, tp3p:20, tr0:10, tr1:8, tr2:5, sl:-30, timeout:12, moon:25, floor:1.15, size:0.02 },
  'v8t': { tp1m:1.2, tp1p:50, tp2m:2.0, tp2p:25, tp3m:4.0, tp3p:25, tr0:25, tr1:20, tr2:15, sl:-30, timeout:12, moon:25, floor:1.15, size:0.02 },
  'scalp': { tp1m:1.15, tp1p:100, tp2m:99, tp2p:0, tp3m:99, tp3p:0, tr0:8, tr1:5, tr2:5, sl:-15, timeout:5, moon:0, floor:1.05, size:0.02 },
  'allTP1': { tp1m:1.2, tp1p:100, tp2m:99, tp2p:0, tp3m:99, tp3p:0, tr0:10, tr1:5, tr2:5, sl:-30, timeout:12, moon:0, floor:1.0, size:0.02 },
  'v9d_5c': { tp1m:1.2, tp1p:50, tp2m:1.5, tp2p:30, tp3m:3.0, tp3p:20, tr0:10, tr1:8, tr2:5, sl:-30, timeout:12, moon:25, floor:1.15, size:0.05 },
};

// Filter configs
const filterConfigs = [
  { name: 'ALL (no filter)', minS: 0, minL: 0 },
  { name: 'liq>=5K', minS: 0, minL: 5000 },
  { name: 'liq>=7K', minS: 0, minL: 7000 },
  { name: 'liq>=10K', minS: 0, minL: 10000 },
  { name: 'liq>=15K', minS: 0, minL: 15000 },
  { name: 'score>=40', minS: 40, minL: 0 },
  { name: 'score>=50', minS: 50, minL: 0 },
  { name: 'score>=55', minS: 55, minL: 0 },
  { name: 'score>=60', minS: 60, minL: 0 },
  { name: 'score>=65', minS: 65, minL: 0 },
  { name: 'score>=70', minS: 70, minL: 0 },
  { name: 'score>=75', minS: 75, minL: 0 },
  { name: 'score>=40 liq>=7K', minS: 40, minL: 7000 },
  { name: 'score>=50 liq>=5K', minS: 50, minL: 5000 },
  { name: 'score>=50 liq>=7K', minS: 50, minL: 7000 },
  { name: 'score>=50 liq>=10K', minS: 50, minL: 10000 },
  { name: 'score>=55 liq>=7K', minS: 55, minL: 7000 },
  { name: 'score>=55 liq>=10K', minS: 55, minL: 10000 },
  { name: 'score>=60 liq>=5K', minS: 60, minL: 5000 },
  { name: 'score>=60 liq>=7K', minS: 60, minL: 7000 },
  { name: 'score>=60 liq>=10K', minS: 60, minL: 10000 },
  { name: 'score>=65 liq>=7K', minS: 65, minL: 7000 },
  { name: 'score>=65 liq>=10K', minS: 65, minL: 10000 },
  { name: 'score>=70 liq>=10K', minS: 70, minL: 10000 },
  { name: 'score>=75 liq>=8K', minS: 75, minL: 8000 },
  { name: 'score>=75 liq>=10K [v9d]', minS: 75, minL: 10000 },
];

// Run ALL combos
const results = [];
for (const f of filterConfigs) {
  for (const [eName, eCfg] of Object.entries(exitConfigs)) {
    const eligible = positions.filter(p =>
      (p.security_score || 0) >= f.minS &&
      (p.dp_liquidity_usd || 0) >= f.minL
    );

    let totalPnl = 0, wins = 0, losses = 0, rugs = 0, totalTrades = 0;
    for (const pos of eligible) {
      const r = simTrade(pos, eCfg);
      if (!r) continue;
      totalTrades++;
      totalPnl += r.pnl;
      if (r.pnl > 0) wins++; else losses++;
      if (r.isRug) rugs++;
    }

    results.push({
      filter: f.name,
      exit: eName,
      trades: totalTrades,
      wins, losses, rugs,
      wr: totalTrades > 0 ? wins/totalTrades*100 : 0,
      pnl: totalPnl,
      ev: totalTrades > 0 ? totalPnl/totalTrades : 0,
      eligible: eligible.length,
    });
  }
}

// Sort by PnL
results.sort((a, b) => b.pnl - a.pnl);

// Print TOP 30
console.log('\nTOP 30 COMBINACIONES POR PnL TOTAL:');
console.log('');
const hdr =
  '#'.padStart(3) + ' | ' +
  'Filter'.padEnd(26) + '| ' +
  'Exit'.padEnd(7) + '| ' +
  'N'.padStart(3) + ' | ' +
  'Win%'.padStart(6) + ' | ' +
  'Rug'.padStart(3) + ' | ' +
  'PnL'.padStart(10) + ' | ' +
  'EV/trade'.padStart(10) + ' | ' +
  'W'.padStart(3) + ' | ' +
  'L'.padStart(3);
console.log(hdr);
console.log('-'.repeat(hdr.length));

for (let i = 0; i < Math.min(30, results.length); i++) {
  const r = results[i];
  const pnlStr = (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(4);
  const evStr = (r.ev >= 0 ? '+' : '') + r.ev.toFixed(5);
  console.log(
    String(i+1).padStart(3) + ' | ' +
    r.filter.padEnd(26) + '| ' +
    r.exit.padEnd(7) + '| ' +
    String(r.trades).padStart(3) + ' | ' +
    r.wr.toFixed(1).padStart(5) + '% | ' +
    String(r.rugs).padStart(3) + ' | ' +
    pnlStr.padStart(10) + ' | ' +
    evStr.padStart(10) + ' | ' +
    String(r.wins).padStart(3) + ' | ' +
    String(r.losses).padStart(3)
  );
}

// Print WORST 10
console.log('\nPEORES 10:');
console.log('-'.repeat(hdr.length));
for (let i = Math.max(0, results.length - 10); i < results.length; i++) {
  const r = results[i];
  const pnlStr = (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(4);
  const evStr = (r.ev >= 0 ? '+' : '') + r.ev.toFixed(5);
  console.log(
    String(i+1).padStart(3) + ' | ' +
    r.filter.padEnd(26) + '| ' +
    r.exit.padEnd(7) + '| ' +
    String(r.trades).padStart(3) + ' | ' +
    r.wr.toFixed(1).padStart(5) + '% | ' +
    String(r.rugs).padStart(3) + ' | ' +
    pnlStr.padStart(10) + ' | ' +
    evStr.padStart(10) + ' | ' +
    String(r.wins).padStart(3) + ' | ' +
    String(r.losses).padStart(3)
  );
}

// Highlight v9d current
console.log('\n--- v9d ACTUAL ---');
const v9d = results.find(r => r.filter.includes('[v9d]') && r.exit === 'v9d');
if (v9d) {
  console.log(`Rank: ${results.indexOf(v9d)+1} de ${results.length}`);
  console.log(`Trades: ${v9d.trades} | Win: ${v9d.wr.toFixed(1)}% | Rugs: ${v9d.rugs} | PnL: ${v9d.pnl.toFixed(4)} SOL | EV: ${v9d.ev.toFixed(5)}`);
}

// Best by EV (min 5 trades)
console.log('\n--- MEJOR EV (min 5 trades) ---');
const byEV = results.filter(r => r.trades >= 5).sort((a,b) => b.ev - a.ev);
for (let i = 0; i < Math.min(10, byEV.length); i++) {
  const r = byEV[i];
  console.log(
    `${i+1}. EV=${(r.ev>=0?'+':'')+r.ev.toFixed(5)} | ${r.filter} + ${r.exit} | N=${r.trades} Win=${r.wr.toFixed(0)}% Rugs=${r.rugs} PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(4)}`
  );
}

// Best by win rate (min 5 trades)
console.log('\n--- MEJOR WIN RATE (min 5 trades) ---');
const byWR = results.filter(r => r.trades >= 5).sort((a,b) => b.wr - a.wr);
for (let i = 0; i < Math.min(10, byWR.length); i++) {
  const r = byWR[i];
  console.log(
    `${i+1}. WR=${r.wr.toFixed(1)}% | ${r.filter} + ${r.exit} | N=${r.trades} Rugs=${r.rugs} PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(4)}`
  );
}

// Lowest rug count with decent volume
console.log('\n--- MENOS RUGS (min 5 trades) ---');
const byRuG = results.filter(r => r.trades >= 5).sort((a,b) => (a.rugs/a.trades) - (b.rugs/b.trades));
for (let i = 0; i < Math.min(10, byRuG.length); i++) {
  const r = byRuG[i];
  console.log(
    `${i+1}. Rug%=${(r.rugs/r.trades*100).toFixed(1)}% (${r.rugs}/${r.trades}) | ${r.filter} + ${r.exit} | WR=${r.wr.toFixed(0)}% PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(4)}`
  );
}

console.log('\n' + '='.repeat(80));
console.log('NOTA: N=' + positions.length + ' positions en ~' + ((positions[positions.length-1].opened_at - positions[0].opened_at)/3600000).toFixed(1) + 'h.');
console.log('Resultados son INDICATIVOS. Shadow sobreestima ~30-50% vs real.');
console.log('Cualquier resultado con <10 trades es ANECDOTICO.');

db.close();
