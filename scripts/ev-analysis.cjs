#!/usr/bin/env node
// EV Analysis Script for Sniper Bot
// Calculates Expected Value, sensitivity analysis, and distribution metrics

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// ============================================================
// SECTION 1: CURRENT EV
// ============================================================
console.log("===============================================================");
console.log("  FASE 1A: EXPECTED VALUE (EV) ANALYSIS");
console.log("  Database: data/bot.db (v11o-v11x)");
console.log("===============================================================\n");

// Basic stats
const basic = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN pnl_sol > 0 THEN 1 END) as wins,
    COUNT(CASE WHEN pnl_sol <= 0 THEN 1 END) as losers,
    ROUND(AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END), 6) as avg_win,
    ROUND(SUM(pnl_sol), 6) as total_pnl
  FROM positions WHERE status IN ('closed', 'stopped')
`).get();

// Categorize losses
const categories = db.prepare(`
  SELECT
    CASE
      WHEN pnl_sol > 0 THEN 'WIN'
      WHEN exit_reason IN ('rug_pull')
        OR (exit_reason = 'max_retries' AND sol_returned < 0.0001)
        OR (exit_reason = 'stranded_timeout_max_retries') THEN 'RUG_OR_SELL_FAIL'
      ELSE 'OTHER_LOSS'
    END as category,
    COUNT(*) as n,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(SUM(pnl_sol), 6) as sum_pnl,
    ROUND(AVG(ABS(pnl_sol)), 6) as avg_abs_pnl
  FROM positions WHERE status IN ('closed', 'stopped')
  GROUP BY 1 ORDER BY 1
`).all();

const catMap = {};
categories.forEach(c => { catMap[c.category] = c; });

const N = basic.total;
const wins = catMap['WIN'].n;
const rugs = catMap['RUG_OR_SELL_FAIL'].n;
const otherLoss = catMap['OTHER_LOSS'].n;

const P_win = wins / N;
const P_rug = rugs / N;
const P_other = otherLoss / N;

const avg_win = catMap['WIN'].avg_abs_pnl;
const avg_rug_loss = catMap['RUG_OR_SELL_FAIL'].avg_abs_pnl;
const avg_other_loss = catMap['OTHER_LOSS'].avg_abs_pnl;

const OVERHEAD = 0.00205; // ATA rent + TX fees, NOT in pnl_sol

console.log("=== SECTION 1: CURRENT EV (N=" + N + ", v11o-v11x) ===\n");
console.log("Probabilities:");
console.log("  P(win)        = " + wins + "/" + N + " = " + (P_win * 100).toFixed(1) + "%");
console.log("  P(rug/fail)   = " + rugs + "/" + N + " = " + (P_rug * 100).toFixed(1) + "%");
console.log("  P(other_loss) = " + otherLoss + "/" + N + " = " + (P_other * 100).toFixed(1) + "%");
console.log("");
console.log("Average outcomes (SOL):");
console.log("  avg_win        = +" + avg_win.toFixed(6) + " SOL");
console.log("  avg_rug_loss   = -" + avg_rug_loss.toFixed(6) + " SOL");
console.log("  avg_other_loss = -" + avg_other_loss.toFixed(6) + " SOL");
console.log("");

const EV_reported = (P_win * avg_win) - (P_rug * avg_rug_loss) - (P_other * avg_other_loss);
const EV_real = EV_reported - OVERHEAD;

console.log("EV Formula: EV = P_win * avg_win - P_rug * avg_rug - P_other * avg_other - overhead");
console.log("");
console.log("  EV(reported pnl)  = (" + P_win.toFixed(3) + " * " + avg_win.toFixed(6) + ") - (" + P_rug.toFixed(3) + " * " + avg_rug_loss.toFixed(6) + ") - (" + P_other.toFixed(3) + " * " + avg_other_loss.toFixed(6) + ")");
console.log("                    = " + (P_win * avg_win).toFixed(6) + " - " + (P_rug * avg_rug_loss).toFixed(6) + " - " + (P_other * avg_other_loss).toFixed(6));
console.log("                    = " + EV_reported.toFixed(6) + " SOL/trade");
console.log("");
console.log("  Overhead/trade    = -" + OVERHEAD.toFixed(5) + " SOL (ATA rent, NOT in pnl_sol)");
console.log("  EV(real)          = " + EV_real.toFixed(6) + " SOL/trade");
console.log("");
console.log("  Total " + N + " trades:");
console.log("    Reported PnL   = " + basic.total_pnl.toFixed(4) + " SOL");
console.log("    Hidden overhead = -" + (N * OVERHEAD).toFixed(4) + " SOL (est.)");
console.log("    TRUE total     = " + (basic.total_pnl - N * OVERHEAD).toFixed(4) + " SOL");
console.log("");

// Win:Loss asymmetry
const winsPerRug = Math.ceil(avg_rug_loss / avg_win);
console.log("  Win:Loss Asymmetry:");
console.log("    1 rug (-" + avg_rug_loss.toFixed(4) + ") needs " + winsPerRug + " mean-wins (+" + avg_win.toFixed(4) + " each) to recover");
console.log("    Current ratio: " + (wins / rugs).toFixed(1) + ":1 wins per rug");
console.log("    Required ratio: " + winsPerRug + ":1 minimum");
console.log("    STATUS: " + ((wins / rugs) >= winsPerRug ? "SUFFICIENT" : "INSUFFICIENT (deficit " + (winsPerRug - wins / rugs).toFixed(1) + ")"));

// ============================================================
// SECTION 2: EV BY VERSION
// ============================================================
console.log("\n\n=== SECTION 2: EV BY VERSION ===\n");

const byVersion = db.prepare(`
  SELECT
    bot_version,
    COUNT(*) as n,
    COUNT(CASE WHEN pnl_sol > 0 THEN 1 END) as wins,
    COUNT(CASE WHEN exit_reason IN ('rug_pull') OR (exit_reason = 'max_retries' AND sol_returned < 0.0001) OR exit_reason = 'stranded_timeout_max_retries' THEN 1 END) as rugs,
    ROUND(AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END), 6) as avg_win,
    ROUND(AVG(CASE WHEN exit_reason IN ('rug_pull') OR (exit_reason = 'max_retries' AND sol_returned < 0.0001) OR exit_reason = 'stranded_timeout_max_retries' THEN ABS(pnl_sol) END), 6) as avg_rug,
    ROUND(SUM(pnl_sol), 6) as total_pnl,
    ROUND(AVG(sol_invested), 4) as avg_size,
    MIN(datetime(opened_at/1000, 'unixepoch')) as first_trade
  FROM positions WHERE status IN ('closed', 'stopped')
  GROUP BY bot_version
  ORDER BY MIN(opened_at)
`).all();

console.log("Version | N   | Wins | Rugs | Win%  | Rug%  | avg_win   | avg_rug   | PnL Total  | EV/trade   | Size");
console.log("--------|-----|------|------|-------|-------|-----------|-----------|------------|------------|------");

byVersion.forEach(v => {
  const wr = (v.wins / v.n * 100).toFixed(1);
  const rr = (v.rugs / v.n * 100).toFixed(1);
  const evPerTrade = (v.total_pnl / v.n);
  const evMinusOverhead = evPerTrade - OVERHEAD;
  console.log(
    v.bot_version.padEnd(8) + "| " +
    String(v.n).padStart(3) + " | " +
    String(v.wins).padStart(4) + " | " +
    String(v.rugs).padStart(4) + " | " +
    wr.padStart(5) + " | " +
    rr.padStart(5) + " | " +
    (v.avg_win ? ("+" + v.avg_win.toFixed(6)) : "   N/A  ") + " | " +
    (v.avg_rug ? ("-" + v.avg_rug.toFixed(6)) : "   N/A  ") + " | " +
    (v.total_pnl >= 0 ? "+" : "") + v.total_pnl.toFixed(6) + " | " +
    (evMinusOverhead >= 0 ? "+" : "") + evMinusOverhead.toFixed(6) + " | " +
    v.avg_size
  );
});

// ============================================================
// SECTION 3: EV EXCLUDING SELL FAILURES
// ============================================================
console.log("\n\n=== SECTION 3: EV EXCLUDING SELL FAILURES ===\n");

const sellFails = db.prepare(`
  SELECT
    COUNT(*) as n,
    SUM(ABS(pnl_sol)) as total_lost,
    GROUP_CONCAT(substr(token_mint, 1, 8) || '(' || exit_reason || ',' || sell_attempts || '/' || sell_successes || ')') as details
  FROM positions
  WHERE status IN ('closed', 'stopped')
    AND pnl_sol < -0.001
    AND sell_successes = 0
`).get();

const partialSells = db.prepare(`
  SELECT
    COUNT(*) as n,
    SUM(ABS(pnl_sol)) as total_lost
  FROM positions
  WHERE status IN ('closed', 'stopped')
    AND pnl_sol < -0.001
    AND sell_successes > 0
`).get();

const totalPnL = basic.total_pnl;

console.log("Zero-sell trades (total loss, sell never worked):");
console.log("  Count: " + sellFails.n + " trades");
console.log("  Total lost: -" + sellFails.total_lost.toFixed(4) + " SOL");
console.log("");
console.log("Partial sells (sell worked but huge loss):");
console.log("  Count: " + partialSells.n + " trades");
console.log("  Total lost: -" + partialSells.total_lost.toFixed(4) + " SOL");
console.log("");

const recoverable = sellFails.total_lost;

console.log("Recovery scenarios (if sells had worked):");
console.log("  Current PnL (reported):     " + totalPnL.toFixed(4) + " SOL");
console.log("  If 50% recovery on 0-sells: " + (totalPnL + recoverable * 0.5).toFixed(4) + " SOL (EV/trade = " + ((totalPnL + recoverable * 0.5) / N).toFixed(6) + ")");
console.log("  If 80% recovery on 0-sells: " + (totalPnL + recoverable * 0.8).toFixed(4) + " SOL (EV/trade = " + ((totalPnL + recoverable * 0.8) / N).toFixed(6) + ")");
console.log("  If 100% recovery (no rugs): " + (totalPnL + recoverable).toFixed(4) + " SOL (EV/trade = " + ((totalPnL + recoverable) / N).toFixed(6) + ")");
console.log("");
console.log("  With overhead subtracted:");
console.log("  If 100% recovery - overhead: " + (totalPnL + recoverable - N * OVERHEAD).toFixed(4) + " SOL");
console.log("");
console.log("  INTERPRETATION: Even if EVERY sell failure had recovered 100%,");
console.log("  total PnL would be " + (totalPnL + recoverable).toFixed(4) + " SOL,");
console.log("  minus ~" + (N * OVERHEAD).toFixed(3) + " SOL overhead = " + (totalPnL + recoverable - N * OVERHEAD).toFixed(4) + " SOL.");

// ============================================================
// SECTION 4: SENSITIVITY ANALYSIS
// ============================================================
console.log("\n\n=== SECTION 4: SENSITIVITY ANALYSIS ===\n");

// A: Breakeven win rate
const rugFrac = rugs / (rugs + otherLoss);
const otherFrac = otherLoss / (rugs + otherLoss);
const lossComp = rugFrac * avg_rug_loss + otherFrac * avg_other_loss;
const be_wr = (OVERHEAD + lossComp) / (avg_win + lossComp);
console.log("A) Breakeven WIN RATE (at current avg_win=" + avg_win.toFixed(6) + ", avg_rug=" + avg_rug_loss.toFixed(6) + "):");
console.log("   Required: " + (be_wr * 100).toFixed(1) + "%");
console.log("   Current:  " + (P_win * 100).toFixed(1) + "%");
console.log("   Gap:      " + ((be_wr - P_win) * 100).toFixed(1) + " percentage points " + (be_wr > P_win ? "BELOW breakeven" : "ABOVE breakeven"));
console.log("");

// B: Breakeven avg_win
const be_aw = (P_rug * avg_rug_loss + P_other * avg_other_loss + OVERHEAD) / P_win;
console.log("B) Breakeven AVG_WIN (at current win rate=" + (P_win * 100).toFixed(1) + "%, rug rate=" + (P_rug * 100).toFixed(1) + "%):");
console.log("   Required: " + be_aw.toFixed(6) + " SOL (" + (be_aw / avg_win).toFixed(1) + "x current)");
console.log("   Current:  " + avg_win.toFixed(6) + " SOL");
console.log("   At 0.015 size: need " + ((be_aw / 0.015) * 100).toFixed(1) + "% gain per win (TP at 1." + ((be_aw / 0.015) * 100).toFixed(0) + "x)");
console.log("");

// C: Max rug rate
let maxRug = 0;
for (let pr = 0; pr <= 0.50; pr += 0.001) {
  const pw = 1 - pr - P_other;
  if (pw < 0) break;
  const ev = pw * avg_win - pr * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
  if (ev > 0) maxRug = pr;
}
console.log("C) Max RUG RATE for EV > 0 (at current avg_win & win fills the rest):");
console.log("   Max:     " + (maxRug * 100).toFixed(1) + "%");
console.log("   Current: " + (P_rug * 100).toFixed(1) + "%");
console.log("   Need to reduce by: " + ((P_rug - maxRug) * 100).toFixed(1) + " pp");
console.log("");

// D: Sensitivity tables
console.log("D) Sensitivity Tables: EV per trade in mSOL\n");
console.log("   Table 1: At current avg_win = " + avg_win.toFixed(6) + " SOL (~" + ((avg_win / 0.015) * 100).toFixed(1) + "% on 0.015 size)");
console.log("");

const winRates = [0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
const rugRates = [0.02, 0.05, 0.10, 0.144, 0.20];

function printTable(aw, label) {
  let hdr = "  WinRate\\RugRate |";
  rugRates.forEach(rr => { hdr += "  " + (rr * 100).toFixed(1) + "%  |"; });
  console.log(hdr);
  console.log("  " + "-".repeat(hdr.length - 2));

  winRates.forEach(wr => {
    let row = "    " + (wr * 100).toFixed(0) + "%           |";
    rugRates.forEach(rr => {
      const po = Math.max(0, 1 - wr - rr);
      const ev = wr * aw - rr * avg_rug_loss - po * avg_other_loss - OVERHEAD;
      const m = ev * 1000;
      const str = (m >= 0 ? "+" : "") + m.toFixed(2);
      row += str.padStart(7) + " |";
    });
    console.log(row);
  });
}

printTable(avg_win, "current");

console.log("\n   Table 2: At 2x avg_win = " + (avg_win * 2).toFixed(6) + " SOL (~" + ((avg_win * 2 / 0.015) * 100).toFixed(1) + "% on 0.015 = TP ~1.11x)");
console.log("");
printTable(avg_win * 2, "2x");

console.log("\n   Table 3: At 3x avg_win = " + (avg_win * 3).toFixed(6) + " SOL (~" + ((avg_win * 3 / 0.015) * 100).toFixed(1) + "% on 0.015 = TP ~1.16x)");
console.log("");
printTable(avg_win * 3, "3x");

console.log("\n   Table 4: At 5x avg_win = " + (avg_win * 5).toFixed(6) + " SOL (~" + ((avg_win * 5 / 0.015) * 100).toFixed(1) + "% on 0.015 = TP ~1.27x)");
console.log("");
printTable(avg_win * 5, "5x");

// ============================================================
// SECTION 5: DISTRIBUTION ANALYSIS
// ============================================================
console.log("\n\n=== SECTION 5: DISTRIBUTION ANALYSIS ===\n");

// Percentiles for winners
const winPnls = db.prepare(`
  SELECT pnl_sol FROM positions
  WHERE status IN ('closed', 'stopped') AND pnl_sol > 0
  ORDER BY pnl_sol
`).all().map(r => r.pnl_sol);

const p10 = winPnls[Math.floor(winPnls.length * 0.10)];
const p25 = winPnls[Math.floor(winPnls.length * 0.25)];
const p50 = winPnls[Math.floor(winPnls.length * 0.50)];
const p75 = winPnls[Math.floor(winPnls.length * 0.75)];
const p90 = winPnls[Math.floor(winPnls.length * 0.90)];
const meanWin = winPnls.reduce((a, b) => a + b, 0) / winPnls.length;

console.log("Winner PnL Distribution (N=" + winPnls.length + "):");
console.log("  P10 (bottom):  +" + p10.toFixed(6) + " SOL");
console.log("  P25:           +" + p25.toFixed(6) + " SOL");
console.log("  P50 (median):  +" + p50.toFixed(6) + " SOL");
console.log("  P75:           +" + p75.toFixed(6) + " SOL");
console.log("  P90 (top):     +" + p90.toFixed(6) + " SOL");
console.log("  Mean:          +" + meanWin.toFixed(6) + " SOL");
console.log("  Max:           +" + winPnls[winPnls.length - 1].toFixed(6) + " SOL");
console.log("");
console.log("  Skewness: mean (" + meanWin.toFixed(6) + ") > median (" + p50.toFixed(6) + ") = positive skew (few large wins)");
console.log("  " + winPnls.filter(w => w > avg_rug_loss).length + "/" + winPnls.length + " winners cover 1 rug (" + avg_rug_loss.toFixed(4) + " SOL)");
console.log("  " + winPnls.filter(w => w > avg_rug_loss * 2).length + "/" + winPnls.length + " winners cover 2 rugs");
console.log("");

// Histogram
const histogram = db.prepare(`
  SELECT
    CASE
      WHEN pnl_sol <= -0.014 THEN '  -15.0 mSOL (total loss)'
      WHEN pnl_sol <= -0.009 THEN ' -10 to -14 mSOL         '
      WHEN pnl_sol <= -0.004 THEN '  -5 to -9 mSOL          '
      WHEN pnl_sol <= -0.001 THEN '  -1 to -4 mSOL          '
      WHEN pnl_sol <= 0      THEN '   0 to -1 mSOL          '
      WHEN pnl_sol <= 0.0005 THEN '  +0 to +0.5 mSOL        '
      WHEN pnl_sol <= 0.001  THEN '  +0.5 to +1 mSOL        '
      WHEN pnl_sol <= 0.002  THEN '  +1 to +2 mSOL          '
      WHEN pnl_sol <= 0.005  THEN '  +2 to +5 mSOL          '
      ELSE                        '  +5+ mSOL               '
    END as bucket,
    COUNT(*) as n,
    ROUND(SUM(pnl_sol) * 1000, 2) as bucket_pnl_msol,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM positions WHERE status IN ('closed','stopped')), 1) as pct
  FROM positions WHERE status IN ('closed', 'stopped')
  GROUP BY 1
  ORDER BY MIN(pnl_sol)
`).all();

console.log("PnL Histogram:");
console.log("  Bucket                    |  N   |   %   | PnL (mSOL) | Bar");
console.log("  " + "-".repeat(80));

histogram.forEach(h => {
  const barLen = Math.max(0, Math.round(h.n / 2));
  const bar = h.bucket_pnl_msol >= 0 ? "+".repeat(barLen) : "-".repeat(barLen);
  console.log(
    "  " + h.bucket + "| " +
    String(h.n).padStart(4) + " | " +
    String(h.pct).padStart(5) + "% | " +
    (h.bucket_pnl_msol >= 0 ? "+" : "") + String(h.bucket_pnl_msol).padStart(7) + " | " +
    bar
  );
});

// ============================================================
// SECTION 6: CUMULATIVE PnL TRAJECTORY
// ============================================================
console.log("\n\n=== SECTION 6: CUMULATIVE PnL TRAJECTORY ===\n");

const trajectory = db.prepare(`
  SELECT
    ROW_NUMBER() OVER (ORDER BY closed_at) as trade_num,
    bot_version,
    exit_reason,
    ROUND(pnl_sol, 6) as pnl,
    ROUND(SUM(pnl_sol) OVER (ORDER BY closed_at), 6) as cum_pnl,
    ROUND(sol_invested, 4) as size,
    datetime(closed_at/1000, 'unixepoch') as closed
  FROM positions WHERE status IN ('closed', 'stopped')
  ORDER BY closed_at
`).all();

// Find peak, trough, and sustained profitable periods
let peak = -Infinity, peakIdx = 0;
let trough = Infinity, troughIdx = 0;
let profitableStreak = 0, maxProfitableStreak = 0;
let profitableStartIdx = -1, bestProfitableStart = -1, bestProfitableEnd = -1;

trajectory.forEach((t, i) => {
  if (t.cum_pnl > peak) { peak = t.cum_pnl; peakIdx = i; }
  if (t.cum_pnl < trough) { trough = t.cum_pnl; troughIdx = i; }

  if (t.cum_pnl > 0) {
    if (profitableStreak === 0) profitableStartIdx = i;
    profitableStreak++;
    if (profitableStreak > maxProfitableStreak) {
      maxProfitableStreak = profitableStreak;
      bestProfitableStart = profitableStartIdx;
      bestProfitableEnd = i;
    }
  } else {
    profitableStreak = 0;
  }
});

console.log("Trajectory Summary:");
console.log("  Peak:   +" + peak.toFixed(4) + " SOL at trade #" + (peakIdx + 1) + " (" + trajectory[peakIdx].closed + ", " + trajectory[peakIdx].bot_version + ")");
console.log("  Trough: " + trough.toFixed(4) + " SOL at trade #" + (troughIdx + 1) + " (" + trajectory[troughIdx].closed + ", " + trajectory[troughIdx].bot_version + ")");
console.log("  Final:  " + trajectory[trajectory.length - 1].cum_pnl.toFixed(4) + " SOL at trade #" + trajectory.length);
console.log("");

if (maxProfitableStreak > 0) {
  console.log("  Longest sustained profitable period: " + maxProfitableStreak + " consecutive trades (#" + (bestProfitableStart + 1) + " to #" + (bestProfitableEnd + 1) + ")");
  console.log("    From: " + trajectory[bestProfitableStart].closed);
  console.log("    To:   " + trajectory[bestProfitableEnd].closed);
} else {
  console.log("  Never sustained profitable period (cum PnL was never positive after a loss)");
}

// Show trajectory at milestones
console.log("\n  Trajectory at key points:");
const milestones = [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 125];
milestones.forEach(m => {
  if (m <= trajectory.length) {
    const t = trajectory[m - 1];
    const bar = t.cum_pnl >= 0
      ? "+".repeat(Math.min(30, Math.round(t.cum_pnl * 5000)))
      : "-".repeat(Math.min(30, Math.round(Math.abs(t.cum_pnl) * 5000)));
    console.log("  Trade #" + String(m).padStart(3) + " (" + t.bot_version + "): " +
      (t.cum_pnl >= 0 ? "+" : "") + t.cum_pnl.toFixed(4) + " SOL  " +
      (t.cum_pnl >= 0 ? "|" + bar : bar + "|"));
  }
});

// ============================================================
// SECTION 7: HONEST ASSESSMENT
// ============================================================
console.log("\n\n=== SECTION 7: HONEST ASSESSMENT ===\n");

console.log("Is EV positive under ANY realistic scenario?\n");

console.log("SCENARIO 1: Current state (as-is)");
console.log("  EV = " + EV_real.toFixed(6) + " SOL/trade = " + (EV_real * 1000).toFixed(3) + " mSOL/trade");
console.log("  VERDICT: NEGATIVE. Losing ~" + (Math.abs(EV_real) * 1000).toFixed(1) + " mSOL per trade.\n");

console.log("SCENARIO 2: Fix sell failures (100% recovery on 13 zero-sells)");
const evNoFails = ((totalPnL + recoverable) / N);
console.log("  EV = " + evNoFails.toFixed(6) + " SOL/trade (before overhead)");
console.log("  EV = " + (evNoFails - OVERHEAD).toFixed(6) + " SOL/trade (after overhead)");
console.log("  VERDICT: " + ((evNoFails - OVERHEAD) > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

console.log("SCENARIO 3: Double avg_win (TP at ~1.11x instead of current ~1.05x)");
const ev2x = P_win * avg_win * 2 - P_rug * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
console.log("  EV = " + ev2x.toFixed(6) + " SOL/trade");
console.log("  VERDICT: " + (ev2x > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

console.log("SCENARIO 4: Halve rug rate (7.2% instead of 14.4%)");
const evHalfRug = (P_win + P_rug / 2) * avg_win - (P_rug / 2) * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
console.log("  EV = " + evHalfRug.toFixed(6) + " SOL/trade");
console.log("  VERDICT: " + (evHalfRug > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

console.log("SCENARIO 5: Double avg_win AND halve rug rate");
const evCombo = (P_win + P_rug / 2) * avg_win * 2 - (P_rug / 2) * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
console.log("  EV = " + evCombo.toFixed(6) + " SOL/trade");
console.log("  VERDICT: " + (evCombo > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

console.log("SCENARIO 6: Triple avg_win (TP at ~1.16x)");
const ev3x = P_win * avg_win * 3 - P_rug * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
console.log("  EV = " + ev3x.toFixed(6) + " SOL/trade");
console.log("  VERDICT: " + (ev3x > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

console.log("SCENARIO 7: 5x avg_win (TP at ~1.27x) + current rug rate");
const ev5x = P_win * avg_win * 5 - P_rug * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
console.log("  EV = " + ev5x.toFixed(6) + " SOL/trade");
console.log("  VERDICT: " + (ev5x > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

console.log("SCENARIO 8: 5x avg_win + halve rug rate");
const ev5xHalfRug = (P_win + P_rug / 2) * avg_win * 5 - (P_rug / 2) * avg_rug_loss - P_other * avg_other_loss - OVERHEAD;
console.log("  EV = " + ev5xHalfRug.toFixed(6) + " SOL/trade");
console.log("  VERDICT: " + (ev5xHalfRug > 0 ? "POSITIVE" : "STILL NEGATIVE") + "\n");

// What multiplier of avg_win is needed for different rug rates?
console.log("BREAKEVEN TABLE: Required avg_win multiplier at different rug rates:");
console.log("  Rug Rate | Needed avg_win | Multiplier | TP Level (on 0.015)");
console.log("  " + "-".repeat(65));
[0.02, 0.05, 0.07, 0.10, 0.144, 0.20].forEach(rr => {
  const pw = 1 - rr - P_other;
  const needed = (rr * avg_rug_loss + P_other * avg_other_loss + OVERHEAD) / pw;
  const mult = needed / avg_win;
  const tpLevel = 1 + (needed / 0.015);
  console.log("  " + (rr * 100).toFixed(1).padStart(5) + "%   | " +
    needed.toFixed(6) + " SOL | " +
    mult.toFixed(1) + "x         | 1." + ((needed / 0.015) * 100).toFixed(0) + "x");
});

console.log("\n\n=== CONCLUSION ===\n");
console.log("The bot has STRUCTURALLY NEGATIVE EV. The fundamental problem is:");
console.log("");
console.log("  1. ASYMMETRY: avg_win (" + (avg_win * 1000).toFixed(2) + " mSOL) is 13x smaller than avg_rug_loss (" + (avg_rug_loss * 1000).toFixed(2) + " mSOL)");
console.log("     Each rug erases " + winsPerRug + " wins. Need " + winsPerRug + ":1 win/rug ratio, have " + (wins / rugs).toFixed(1) + ":1.");
console.log("");
console.log("  2. OVERHEAD: " + (OVERHEAD * 1000).toFixed(1) + " mSOL/trade ATA cost further erodes tiny wins.");
console.log("     Overhead alone consumes " + ((OVERHEAD / avg_win) * 100).toFixed(0) + "% of avg_win.");
console.log("");
console.log("  3. PATH TO PROFITABILITY requires BOTH:");
console.log("     a) Higher avg_win: TP at 1.20x+ (currently ~1.05x effective)");
console.log("     b) Lower rug rate: below ~" + (maxRug * 100).toFixed(0) + "% (currently " + (P_rug * 100).toFixed(1) + "%)");
console.log("     c) OR fix sell reliability (recovers " + (recoverable * 1000).toFixed(0) + " mSOL of " + (Math.abs(totalPnL) * 1000).toFixed(0) + " mSOL lost)");

db.close();
