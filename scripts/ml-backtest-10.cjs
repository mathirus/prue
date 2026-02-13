const Database = require("better-sqlite3");
const db = new Database("data/bot.db");

const rows = db.prepare(`
  SELECT
    p.id, substr(p.token_mint, 1, 8) as mint, p.token_mint,
    p.pnl_sol, p.pnl_pct, p.exit_reason, p.security_score,
    p.sol_invested, p.peak_multiplier, p.bot_version,
    dp.dp_liquidity_usd, dp.dp_top_holder_pct, dp.dp_holder_count,
    dp.dp_rugcheck_score, dp.dp_lp_burned, dp.source,
    dp.dp_observation_initial_sol,
    tc.wallet_age_seconds, tc.tx_count, tc.reputation_score,
    p.opened_at
  FROM positions p
  LEFT JOIN detected_pools dp ON p.token_mint = dp.base_mint
  LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
  ORDER BY p.opened_at DESC
  LIMIT 10
`).all();

function classifyToken(f) {
  const lph = f.liquidityUsd / Math.max(f.holderCount, 1);
  const hli = f.holderCount * f.liquidityUsd;
  const res = f.entrySolReserve || 0;
  if (res > 0) {
    if (res <= 154.08) {
      const lph2 = f.liquidityUsd / Math.max(f.holderCount, 1);
      if (lph2 <= 6273.95) {
        if (lph <= 3615.73) {
          if ((f.topHolderPct || 100) <= 56.09) {
            if (lph <= 1188.45) return {p:"safe",c:0.52,n:"low_res_lowtp_lowlph"};
            return {p:"safe",c:0.82,n:"low_res_lowtp_midlph"};
          }
          if (f.liquidityUsd <= 2055.46) return {p:"safe",c:0.75,n:"low_res_vlowliq"};
          return {p:"safe",c:0.91,n:"low_res_normal"};
        }
        return {p:"rug",c:0.62,n:"low_res_concentrated"};
      }
      if (hli <= -7020.81) return {p:"safe",c:0.85,n:"low_res_anomaly"};
      if (res <= 87.01) {
        if (res <= 84.99) return {p:"safe",c:0.89,n:"low_reserve_high_lph"};
        return {p:"safe",c:0.99,n:"low_reserve_peak_safe"};
      }
      if (f.liquidityUsd <= 7179.39) return {p:"safe",c:0.82,n:"mid_reserve_lowliq"};
      return {p:"safe",c:0.94,n:"mid_reserve_highliq"};
    }
    if (res <= 166.62) {
      if (f.holderCount <= 5) {
        if (res <= 158.74) {
          if (lph <= 5385.71) return {p:"rug",c:0.97,n:"rug_zone_main"};
          return {p:"rug",c:0.85,n:"rug_zone_highlph"};
        }
        return {p:"rug",c:0.66,n:"rug_zone_upper"};
      }
      return {p:"safe",c:0.67,n:"rug_zone_many_holders"};
    }
    if (res <= 181.29) return {p:"safe",c:0.68,n:"high_reserve_low"};
    if (f.liquidityUsd <= 31521.48) return {p:"safe",c:0.90,n:"high_reserve_midliq"};
    return {p:"safe",c:0.72,n:"high_reserve_highliq"};
  }
  // Fallback (no reserve)
  if (f.liquidityUsd <= 26743) {
    if (lph <= 809) return {p:"safe",c:0.80,n:"fb_many_holders"};
    if (f.liquidityUsd <= 7338) return {p:"safe",c:0.70,n:"fb_very_low_liq"};
    if (f.liquidityUsd <= 22061) return {p:"rug",c:0.68,n:"fb_mid_liq_concentrated"};
    return {p:"safe",c:0.56,n:"fb_high_mid_liq"};
  }
  if (lph <= 28057) return {p:"safe",c:0.75,n:"fb_high_liq_distributed"};
  if (lph <= 37196) return {p:"rug",c:0.58,n:"fb_whale_trap"};
  return {p:"safe",c:0.64,n:"fb_ultra_high_lph"};
}

console.log("=".repeat(110));
console.log("ULTIMOS 10 TRADES vs ML CLASSIFIER v6 (minConf 70%)");
console.log("=".repeat(110));

let saved=0, missed=0, fneg=0, pnlWith=0, pnlWithout=0;

rows.forEach((r, i) => {
  const f = {
    liquidityUsd: r.dp_liquidity_usd || 0,
    topHolderPct: r.dp_top_holder_pct || 0,
    holderCount: r.dp_holder_count || 0,
    entrySolReserve: r.dp_observation_initial_sol || 0,
  };
  const ml = classifyToken(f);
  const blocked = ml.p === "rug" && ml.c >= 0.70;
  const isRug = r.exit_reason && (r.exit_reason.includes("rug") || r.exit_reason.includes("honeypot") || r.exit_reason.includes("emergency") || r.exit_reason.includes("authority"));
  const isWin = r.pnl_sol !== null && r.pnl_sol > 0;
  const isLoss = r.pnl_sol !== null && r.pnl_sol < -0.0005;

  let verdict = "";
  if (blocked && (isRug || isLoss)) { verdict = "SAVED (blocked bad trade)"; saved++; }
  else if (blocked && isWin) { verdict = "FALSE POS (missed winner!)"; missed++; }
  else if (blocked && !isWin && !isLoss) { verdict = "BLOCKED (neutral)"; }
  else if (!blocked && isRug) { verdict = "FALSE NEG (missed rug)"; fneg++; }
  else if (!blocked && isWin) { verdict = "OK (winner passed)"; }
  else if (!blocked && isLoss) { verdict = "OK (loser passed)"; }
  else { verdict = "OK"; }

  if (r.pnl_sol !== null) {
    pnlWithout += r.pnl_sol;
    if (!blocked) pnlWith += r.pnl_sol;
  }

  const pnl = r.pnl_sol !== null ? (r.pnl_sol >= 0 ? "+" : "") + r.pnl_sol.toFixed(6) : "OPEN";
  const pct = r.pnl_pct !== null ? r.pnl_pct.toFixed(1) + "%" : "";
  const time = new Date(r.opened_at).toLocaleString("es-AR");

  console.log("");
  console.log("#" + (i+1) + " " + r.mint + " | " + time + " | score:" + r.security_score + " | " + r.bot_version);
  console.log("   PnL: " + pnl + " SOL (" + pct + ") | Exit: " + (r.exit_reason||"OPEN") + " | Peak: " + (r.peak_multiplier ? r.peak_multiplier.toFixed(2) : "?") + "x");
  console.log("   Features: reserve=" + f.entrySolReserve.toFixed(1) + " SOL, liq=$" + f.liquidityUsd.toFixed(0) + ", holders=" + f.holderCount + ", topH=" + f.topHolderPct.toFixed(1) + "%");
  console.log("   ML: " + ml.p.toUpperCase() + " @" + ml.n + " (" + (ml.c*100).toFixed(0) + "%) -> " + (blocked ? "BLOCK" : "PASS"));
  console.log("   >>> " + verdict);
});

const diff = pnlWith - pnlWithout;
console.log("\n" + "=".repeat(110));
console.log("RESUMEN:");
console.log("  Trades bloqueados por ML: " + (saved + missed));
console.log("  Rugs/losers salvados:     " + saved);
console.log("  Winners perdidos:         " + missed);
console.log("  Rugs no detectados:       " + fneg);
console.log("  PnL real (sin ML block):  " + (pnlWithout >= 0 ? "+" : "") + pnlWithout.toFixed(6) + " SOL");
console.log("  PnL hipotetico (con ML):  " + (pnlWith >= 0 ? "+" : "") + pnlWith.toFixed(6) + " SOL");
console.log("  Diferencia:               " + (diff >= 0 ? "+" : "") + diff.toFixed(6) + " SOL");

db.close();
