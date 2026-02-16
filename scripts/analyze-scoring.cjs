#!/usr/bin/env node
/**
 * analyze-scoring.cjs — Scoring component analysis & ML readiness assessment
 *
 * Analyzes which scoring penalties/bonuses best discriminate rugs from survivors,
 * identifies penalty combos that let rugs through, and assesses ML training readiness.
 *
 * Usage:
 *   node scripts/analyze-scoring.cjs                        # Full report
 *   node scripts/analyze-scoring.cjs --section penalty_vs_outcome  # Single section
 *   node scripts/analyze-scoring.cjs --version v11s          # Filter version
 *   node scripts/analyze-scoring.cjs --since 2h              # Last 2 hours
 *
 * Sections: data_audit, penalty_vs_outcome, penalty_combos, position_correlation,
 *           broad_features, rejection_analysis, ml_readiness
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');

// ── Arg parsing (same pattern as analyze-v11o.cjs) ──────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] || true;
}

const filterVersion = getArg('version');
const sinceArg = getArg('since');
const sectionFilter = getArg('section');

function parseSince(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+)(h|m|d)$/);
  if (!m) return 0;
  const n = parseInt(m[1]);
  if (m[2] === 'h') return Date.now() - n * 3600_000;
  if (m[2] === 'm') return Date.now() - n * 60_000;
  if (m[2] === 'd') return Date.now() - n * 86400_000;
  return 0;
}

const sinceTs = parseSince(sinceArg);

const db = new Database(DB_PATH, { readonly: true });

// ── Helpers ─────────────────────────────────────────────────────────────

function versionWhereDP(col = 'bot_version') {
  const parts = [];
  if (filterVersion) {
    parts.push(`${col} = '${filterVersion}'`);
  } else {
    parts.push(`${col} >= 'v11o'`);
  }
  if (sinceTs > 0) {
    parts.push(`detected_at > ${sinceTs}`);
  }
  return parts.join(' AND ');
}

function versionWherePos(col = 'bot_version') {
  const parts = [];
  if (filterVersion) {
    parts.push(`${col} = '${filterVersion}'`);
  } else {
    parts.push(`${col} >= 'v11o'`);
  }
  if (sinceTs > 0) {
    parts.push(`opened_at > ${sinceTs}`);
  }
  return parts.join(' AND ');
}

function header(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function subheader(title) {
  console.log(`\n--- ${title} ---`);
}

function shouldShow(section) {
  return !sectionFilter || sectionFilter === section;
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

// Cohen's d effect size: (mean1 - mean2) / pooled_std
function cohensD(vals1, vals2) {
  if (vals1.length < 2 || vals2.length < 2) return null;
  const mean1 = vals1.reduce((s, v) => s + v, 0) / vals1.length;
  const mean2 = vals2.reduce((s, v) => s + v, 0) / vals2.length;
  const var1 = vals1.reduce((s, v) => s + (v - mean1) ** 2, 0) / (vals1.length - 1);
  const var2 = vals2.reduce((s, v) => s + (v - mean2) ** 2, 0) / (vals2.length - 1);
  const pooledStd = Math.sqrt(((vals1.length - 1) * var1 + (vals2.length - 1) * var2) / (vals1.length + vals2.length - 2));
  if (pooledStd === 0) return null;
  return (mean1 - mean2) / pooledStd;
}

// Pearson correlation
function pearsonR(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? null : num / den;
}

// ── Penalty column definitions ──────────────────────────────────────────
const PENALTY_COLS = [
  { col: 'dp_holder_penalty', label: 'Holder', dir: 'penalty' },
  { col: 'dp_rugcheck_penalty', label: 'RugCheck', dir: 'penalty' },
  { col: 'dp_creator_age_penalty', label: 'Creator Age', dir: 'penalty' },
  { col: 'dp_velocity_penalty', label: 'Velocity', dir: 'penalty' },
  { col: 'dp_insider_penalty', label: 'Insider', dir: 'penalty' },
  { col: 'dp_whale_penalty', label: 'Whale', dir: 'penalty' },
  { col: 'dp_timing_cv_penalty', label: 'Timing CV', dir: 'penalty' },
  { col: 'dp_hhi_penalty', label: 'HHI', dir: 'penalty' },
  { col: 'dp_concentrated_penalty', label: 'Concentrated', dir: 'penalty' },
  { col: 'dp_wash_penalty', label: 'Wash', dir: 'penalty' },
  { col: 'dp_graduation_bonus', label: 'Graduation', dir: 'bonus' },
  { col: 'dp_obs_bonus', label: 'Observation', dir: 'bonus' },
  { col: 'dp_organic_bonus', label: 'Organic', dir: 'bonus' },
  { col: 'dp_smart_wallet_bonus', label: 'Smart Wallet', dir: 'bonus' },
  { col: 'dp_creator_reputation', label: 'Creator Rep', dir: 'mixed' },
];

// ═══════════════════════════════════════════════════════════════════════
// SECTION: Data Audit
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('data_audit')) {
  header('DATA AUDIT');

  // Pools with breakdowns by version
  subheader('Pools with penalty breakdowns (dp_final_score NOT NULL)');
  const byVersion = db.prepare(`
    SELECT bot_version, COUNT(*) as n,
      SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
      SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
      SUM(CASE WHEN pool_outcome IS NULL OR pool_outcome = '' THEN 1 ELSE 0 END) as no_outcome
    FROM detected_pools
    WHERE dp_final_score IS NOT NULL AND ${versionWhereDP()}
    GROUP BY bot_version ORDER BY bot_version
  `).all();

  console.log(`  ${'Version'.padEnd(8)} ${'Total'.padStart(6)} ${'Rugs'.padStart(6)} ${'Surv'.padStart(6)} ${'NoOut'.padStart(6)}`);
  console.log(`  ${'-'.repeat(36)}`);
  let totalBD = 0, totalBDRug = 0, totalBDSurv = 0;
  for (const v of byVersion) {
    console.log(`  ${v.bot_version.padEnd(8)} ${String(v.n).padStart(6)} ${String(v.rugs).padStart(6)} ${String(v.survivors).padStart(6)} ${String(v.no_outcome).padStart(6)}`);
    totalBD += v.n; totalBDRug += v.rugs; totalBDSurv += v.survivors;
  }
  console.log(`  ${'TOTAL'.padEnd(8)} ${String(totalBD).padStart(6)} ${String(totalBDRug).padStart(6)} ${String(totalBDSurv).padStart(6)}`);

  // Total pools with outcomes (any version)
  subheader('All pools with outcomes (any version)');
  const allOutcomes = db.prepare(`
    SELECT pool_outcome, COUNT(*) as n FROM detected_pools
    WHERE pool_outcome IN ('rug', 'survivor')
    GROUP BY pool_outcome
  `).all();
  for (const o of allOutcomes) {
    console.log(`  ${o.pool_outcome}: ${o.n}`);
  }

  // Positions that can JOIN to penalty data
  subheader('Positions joinable to penalty breakdowns');
  const joinable = db.prepare(`
    SELECT COUNT(*) as n FROM positions p
    JOIN detected_pools d ON p.pool_id = d.id
    WHERE ${versionWherePos('p.bot_version')} AND d.dp_final_score IS NOT NULL
      AND p.status IN ('stopped', 'closed')
  `).get();
  console.log(`  Positions with penalty data: ${joinable.n}`);

  // Shadow positions status
  subheader('Shadow positions data quality');
  const shadowStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN rug_detected > 0 THEN 1 ELSE 0 END) as with_rug,
      SUM(CASE WHEN tp1_hit > 0 THEN 1 ELSE 0 END) as with_tp1,
      SUM(CASE WHEN peak_multiplier > 1.01 THEN 1 ELSE 0 END) as with_peak,
      SUM(CASE WHEN total_polls > 0 THEN 1 ELSE 0 END) as with_polls,
      SUM(CASE WHEN status = 'tracking' THEN 1 ELSE 0 END) as tracking,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
    FROM shadow_positions
  `).get();
  console.log(`  Total shadow positions: ${shadowStats.total}`);
  console.log(`  With rug_detected: ${shadowStats.with_rug}`);
  console.log(`  With tp1_hit: ${shadowStats.with_tp1}`);
  console.log(`  With peak > 1.01x: ${shadowStats.with_peak}`);
  console.log(`  With any polls: ${shadowStats.with_polls}`);
  console.log(`  Still tracking: ${shadowStats.tracking}`);
  console.log(`  Closed: ${shadowStats.closed}`);
  if (shadowStats.with_polls === 0 && shadowStats.total > 100) {
    console.log(`  ** WARNING: ALL shadow positions have 0 polls — outcomes BROKEN **`);
    console.log(`     Cause: live mode uses data-only shadow (no RPC polling)`);
    console.log(`     Impact: ${shadowStats.total} unlabeled samples lost for ML training`);
  }

  // NULL rate per penalty column
  subheader('Penalty column NULL rates (v11o+ with outcomes)');
  for (const p of PENALTY_COLS) {
    const result = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN ${p.col} IS NULL THEN 1 ELSE 0 END) as nulls
      FROM detected_pools
      WHERE dp_final_score IS NOT NULL AND pool_outcome IN ('rug', 'survivor')
        AND ${versionWhereDP()}
    `).get();
    const nullPct = pct(result.nulls, result.total);
    const flag = result.nulls > 0 ? ' !' : '';
    console.log(`  ${p.label.padEnd(16)} ${String(result.nulls).padStart(4)}/${result.total} NULL (${nullPct}%)${flag}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION: Penalty vs Outcome
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('penalty_vs_outcome')) {
  header('PENALTY vs OUTCOME — Which components discriminate? (v11o+)');

  const rows = db.prepare(`
    SELECT pool_outcome, ${PENALTY_COLS.map(p => p.col).join(', ')}, dp_funder_fan_out
    FROM detected_pools
    WHERE dp_final_score IS NOT NULL AND pool_outcome IN ('rug', 'survivor')
      AND ${versionWhereDP()}
  `).all();

  const rugs = rows.filter(r => r.pool_outcome === 'rug');
  const survivors = rows.filter(r => r.pool_outcome === 'survivor');

  console.log(`\n  Dataset: ${rows.length} pools (${rugs.length} rugs, ${survivors.length} survivors)`);

  if (rows.length < 10) {
    console.log('  Not enough data for meaningful analysis.');
  } else {
    // Per-penalty analysis
    subheader('Effect size ranking (Cohen\'s d — higher abs = better discriminator)');
    console.log(`  ${'Component'.padEnd(18)} ${'AvgRug'.padStart(8)} ${'AvgSurv'.padStart(8)} ${'Cohen d'.padStart(8)} ${'%Rug'.padStart(6)} ${'%Surv'.padStart(6)} ${'Dir'.padStart(5)}`);
    console.log(`  ${'-'.repeat(60)}`);

    const effectSizes = [];

    for (const p of PENALTY_COLS) {
      const rugVals = rugs.map(r => r[p.col] ?? 0);
      const survVals = survivors.map(r => r[p.col] ?? 0);

      const avgRug = rugVals.reduce((s, v) => s + v, 0) / rugVals.length;
      const avgSurv = survVals.reduce((s, v) => s + v, 0) / survVals.length;
      const d = cohensD(rugVals, survVals);

      // Percentage that have non-zero value
      const pctRug = pct(rugVals.filter(v => v !== 0).length, rugVals.length);
      const pctSurv = pct(survVals.filter(v => v !== 0).length, survVals.length);

      effectSizes.push({ ...p, avgRug, avgSurv, d, pctRug, pctSurv });
    }

    // Sort by absolute effect size
    effectSizes.sort((a, b) => Math.abs(b.d ?? 0) - Math.abs(a.d ?? 0));

    for (const e of effectSizes) {
      const dStr = e.d !== null ? e.d.toFixed(3) : 'N/A';
      const dirFlag = e.d !== null ? (e.d > 0.2 ? ' <<<' : e.d < -0.2 ? ' >>>' : '') : '';
      console.log(`  ${e.label.padEnd(18)} ${e.avgRug.toFixed(1).padStart(8)} ${e.avgSurv.toFixed(1).padStart(8)} ${dStr.padStart(8)} ${(e.pctRug + '%').padStart(6)} ${(e.pctSurv + '%').padStart(6)} ${dirFlag}`);
    }

    console.log(`\n  Key: d > 0 means rugs have HIGHER values (more negative penalty = lower d)`);
    console.log(`  For penalties (negative values): d < 0 means rugs are penalized MORE (good)`);
    console.log(`  For bonuses (positive values): d < 0 means survivors get MORE bonus (good)`);
    console.log(`  |d| > 0.8 = large, 0.5-0.8 = medium, 0.2-0.5 = small`);

    // Funder fan-out special analysis (text column)
    subheader('Funder fan-out (text signal)');
    const rugFanOut = rugs.filter(r => r.dp_funder_fan_out && r.dp_funder_fan_out !== '' && r.dp_funder_fan_out !== 'null').length;
    const survFanOut = survivors.filter(r => r.dp_funder_fan_out && r.dp_funder_fan_out !== '' && r.dp_funder_fan_out !== 'null').length;
    console.log(`  Rugs with funder fan-out: ${rugFanOut}/${rugs.length} (${pct(rugFanOut, rugs.length)}%)`);
    console.log(`  Survivors with funder fan-out: ${survFanOut}/${survivors.length} (${pct(survFanOut, survivors.length)}%)`);

    // Top 3 discriminators summary
    subheader('Top 3 Discriminating Components');
    for (let i = 0; i < Math.min(3, effectSizes.length); i++) {
      const e = effectSizes[i];
      const dStr = e.d !== null ? e.d.toFixed(3) : 'N/A';
      const direction = e.d > 0
        ? 'rugs score higher (penalty misses rugs, or bonus gives to rugs)'
        : 'survivors score higher (penalty catches rugs, or bonus rewards survivors)';
      console.log(`  ${i + 1}. ${e.label} (d=${dStr}) — ${direction}`);
      console.log(`     Rugs avg: ${e.avgRug.toFixed(1)} (${e.pctRug}% non-zero) | Surv avg: ${e.avgSurv.toFixed(1)} (${e.pctSurv}% non-zero)`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION: Penalty Combos
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('penalty_combos')) {
  header('PENALTY COMBOS — Which combinations predict outcome? (v11o+)');

  const rows = db.prepare(`
    SELECT pool_outcome, ${PENALTY_COLS.map(p => p.col).join(', ')}
    FROM detected_pools
    WHERE dp_final_score IS NOT NULL AND pool_outcome IN ('rug', 'survivor')
      AND ${versionWhereDP()}
  `).all();

  const rugs = rows.filter(r => r.pool_outcome === 'rug');
  const survivors = rows.filter(r => r.pool_outcome === 'survivor');

  if (rows.length < 10) {
    console.log('  Not enough data.');
  } else {
    // Encode active signals per row
    function getActiveSignals(row) {
      const active = [];
      for (const p of PENALTY_COLS) {
        const val = row[p.col] ?? 0;
        if (p.dir === 'penalty' && val < 0) active.push(p.label);
        if (p.dir === 'bonus' && val > 0) active.push('+' + p.label);
        if (p.dir === 'mixed' && val !== 0) active.push((val < 0 ? '' : '+') + p.label);
      }
      return active;
    }

    // Two-way penalty combos
    subheader('Two-way penalty combos (penalties only)');
    const comboCounts = {};
    for (const row of rows) {
      const penalties = getActiveSignals(row).filter(s => !s.startsWith('+'));
      if (penalties.length < 2) continue;
      for (let i = 0; i < penalties.length; i++) {
        for (let j = i + 1; j < penalties.length; j++) {
          const key = [penalties[i], penalties[j]].sort().join(' + ');
          if (!comboCounts[key]) comboCounts[key] = { rug: 0, surv: 0 };
          if (row.pool_outcome === 'rug') comboCounts[key].rug++;
          else comboCounts[key].surv++;
        }
      }
    }

    const sortedCombos = Object.entries(comboCounts)
      .filter(([, v]) => v.rug + v.surv >= 3)
      .sort((a, b) => {
        const aRate = a[1].rug / (a[1].rug + a[1].surv);
        const bRate = b[1].rug / (b[1].rug + b[1].surv);
        return bRate - aRate;
      });

    if (sortedCombos.length > 0) {
      console.log(`  ${'Combo'.padEnd(35)} ${'N'.padStart(4)} ${'Rugs'.padStart(5)} ${'Surv'.padStart(5)} ${'Rug%'.padStart(6)}`);
      console.log(`  ${'-'.repeat(58)}`);
      for (const [combo, counts] of sortedCombos.slice(0, 15)) {
        const total = counts.rug + counts.surv;
        const rugRate = pct(counts.rug, total);
        console.log(`  ${combo.padEnd(35)} ${String(total).padStart(4)} ${String(counts.rug).padStart(5)} ${String(counts.surv).padStart(5)} ${(rugRate + '%').padStart(6)}`);
      }
    } else {
      console.log('  No penalty combos found with N >= 3.');
    }

    // Three-way combos
    subheader('Three-way penalty combos (N >= 3)');
    const triCounts = {};
    for (const row of rows) {
      const penalties = getActiveSignals(row).filter(s => !s.startsWith('+'));
      if (penalties.length < 3) continue;
      for (let i = 0; i < penalties.length; i++) {
        for (let j = i + 1; j < penalties.length; j++) {
          for (let k = j + 1; k < penalties.length; k++) {
            const key = [penalties[i], penalties[j], penalties[k]].sort().join(' + ');
            if (!triCounts[key]) triCounts[key] = { rug: 0, surv: 0 };
            if (row.pool_outcome === 'rug') triCounts[key].rug++;
            else triCounts[key].surv++;
          }
        }
      }
    }

    const sortedTri = Object.entries(triCounts)
      .filter(([, v]) => v.rug + v.surv >= 3)
      .sort((a, b) => {
        const aRate = a[1].rug / (a[1].rug + a[1].surv);
        const bRate = b[1].rug / (b[1].rug + b[1].surv);
        return bRate - aRate;
      });

    if (sortedTri.length > 0) {
      console.log(`  ${'Combo'.padEnd(45)} ${'N'.padStart(4)} ${'Rugs'.padStart(5)} ${'Surv'.padStart(5)} ${'Rug%'.padStart(6)}`);
      console.log(`  ${'-'.repeat(68)}`);
      for (const [combo, counts] of sortedTri.slice(0, 10)) {
        const total = counts.rug + counts.surv;
        const rugRate = pct(counts.rug, total);
        console.log(`  ${combo.padEnd(45)} ${String(total).padStart(4)} ${String(counts.rug).padStart(5)} ${String(counts.surv).padStart(5)} ${(rugRate + '%').padStart(6)}`);
      }
    } else {
      console.log('  No 3-way combos found with N >= 3.');
    }

    // Bonus combos among survivors vs rugs
    subheader('Bonus patterns: survivors vs rugs');
    for (const label of ['+Graduation', '+Observation', '+Organic', '+Smart Wallet']) {
      const rugWith = rugs.filter(r => getActiveSignals(r).includes(label)).length;
      const survWith = survivors.filter(r => getActiveSignals(r).includes(label)).length;
      console.log(`  ${label.padEnd(20)} Rugs: ${rugWith}/${rugs.length} (${pct(rugWith, rugs.length)}%) | Surv: ${survWith}/${survivors.length} (${pct(survWith, survivors.length)}%)`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION: Position Correlation
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('position_correlation')) {
  header('POSITION CORRELATION — Penalties vs actual PnL (v11o+)');

  const rows = db.prepare(`
    SELECT
      p.pnl_sol, p.pnl_pct, p.peak_multiplier, p.exit_reason,
      ${PENALTY_COLS.map(c => 'd.' + c.col).join(', ')}
    FROM positions p
    JOIN detected_pools d ON p.pool_id = d.id
    WHERE ${versionWherePos('p.bot_version')} AND d.dp_final_score IS NOT NULL
      AND p.status IN ('stopped', 'closed')
  `).all();

  console.log(`\n  Positions with penalty breakdowns: N=${rows.length}`);

  if (rows.length < 5) {
    console.log('  Not enough data for correlation analysis.');
  } else {
    // Correlation of each penalty with PnL
    subheader('Penalty correlation with PnL (Pearson r)');
    console.log(`  ${'Component'.padEnd(18)} ${'r(PnL)'.padStart(8)} ${'r(Peak)'.padStart(8)} ${'Avg(W)'.padStart(8)} ${'Avg(L)'.padStart(8)}`);
    console.log(`  ${'-'.repeat(55)}`);

    const winners = rows.filter(r => r.pnl_sol > 0);
    const losers = rows.filter(r => r.pnl_sol <= 0);

    for (const p of PENALTY_COLS) {
      const vals = rows.map(r => r[p.col] ?? 0);
      const pnls = rows.map(r => r.pnl_sol);
      const peaks = rows.map(r => r.peak_multiplier ?? 1);

      const rPnl = pearsonR(vals, pnls);
      const rPeak = pearsonR(vals, peaks);

      const avgW = winners.length > 0 ? winners.reduce((s, r) => s + (r[p.col] ?? 0), 0) / winners.length : 0;
      const avgL = losers.length > 0 ? losers.reduce((s, r) => s + (r[p.col] ?? 0), 0) / losers.length : 0;

      console.log(`  ${p.label.padEnd(18)} ${(rPnl !== null ? rPnl.toFixed(3) : 'N/A').padStart(8)} ${(rPeak !== null ? rPeak.toFixed(3) : 'N/A').padStart(8)} ${avgW.toFixed(1).padStart(8)} ${avgL.toFixed(1).padStart(8)}`);
    }

    // Breakdown by exit reason
    subheader('PnL by exit reason (positions with breakdowns)');
    const byExit = {};
    for (const r of rows) {
      const reason = r.exit_reason || 'unknown';
      if (!byExit[reason]) byExit[reason] = { n: 0, pnl: 0 };
      byExit[reason].n++;
      byExit[reason].pnl += r.pnl_sol;
    }
    for (const [reason, data] of Object.entries(byExit).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${reason.padEnd(20)} N=${String(data.n).padStart(3)} | PnL: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)} SOL`);
    }

    // Rug exits — which penalties were present?
    const rugExits = rows.filter(r => r.exit_reason === 'rug_pull');
    if (rugExits.length > 0) {
      subheader(`Penalties on rug_pull positions (N=${rugExits.length})`);
      for (const p of PENALTY_COLS) {
        const nonZero = rugExits.filter(r => (r[p.col] ?? 0) !== 0).length;
        const avg = rugExits.reduce((s, r) => s + (r[p.col] ?? 0), 0) / rugExits.length;
        if (nonZero > 0) {
          console.log(`  ${p.label.padEnd(18)} avg: ${avg.toFixed(1)} | ${nonZero}/${rugExits.length} non-zero (${pct(nonZero, rugExits.length)}%)`);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION: Broad Features
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('broad_features')) {
  header('BROAD FEATURES — All pools with outcomes (N=1,475)');

  // Score bucket analysis with 5-point buckets
  subheader('Score buckets (5-point) with rug rate');
  const buckets = db.prepare(`
    SELECT
      CASE
        WHEN security_score IS NULL THEN 'NULL'
        WHEN security_score >= 90 THEN '90+'
        WHEN security_score >= 85 THEN '85-89'
        WHEN security_score >= 80 THEN '80-84'
        WHEN security_score >= 75 THEN '75-79'
        WHEN security_score >= 70 THEN '70-74'
        WHEN security_score >= 65 THEN '65-69'
        WHEN security_score >= 60 THEN '60-64'
        WHEN security_score >= 55 THEN '55-59'
        WHEN security_score >= 50 THEN '50-54'
        ELSE '<50'
      END as bucket,
      COUNT(*) as n,
      SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
      SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors
    FROM detected_pools
    WHERE pool_outcome IN ('rug', 'survivor')
    GROUP BY bucket
    ORDER BY MIN(COALESCE(security_score, -1)) DESC
  `).all();

  console.log(`  ${'Score'.padEnd(8)} ${'Total'.padStart(6)} ${'Rugs'.padStart(6)} ${'Surv'.padStart(6)} ${'Rug%'.padStart(7)} ${'Bar'}`);
  console.log(`  ${'-'.repeat(55)}`);
  for (const b of buckets) {
    const rugRate = b.n > 0 ? (b.rugs / b.n) * 100 : 0;
    const bar = '#'.repeat(Math.round(rugRate / 2));
    console.log(`  ${b.bucket.padEnd(8)} ${String(b.n).padStart(6)} ${String(b.rugs).padStart(6)} ${String(b.survivors).padStart(6)} ${(rugRate.toFixed(1) + '%').padStart(7)} ${bar}`);
  }

  // Feature analysis on all pools with outcomes
  subheader('Feature averages: Rugs vs Survivors (all pools)');
  const featureRows = db.prepare(`
    SELECT
      pool_outcome,
      dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
      dp_rugcheck_score, dp_honeypot_verified, dp_lp_burned,
      security_score
    FROM detected_pools
    WHERE pool_outcome IN ('rug', 'survivor')
  `).all();

  const rugFeats = featureRows.filter(r => r.pool_outcome === 'rug');
  const survFeats = featureRows.filter(r => r.pool_outcome === 'survivor');

  const features = [
    { col: 'security_score', label: 'Security Score' },
    { col: 'dp_liquidity_usd', label: 'Liquidity USD' },
    { col: 'dp_holder_count', label: 'Holder Count' },
    { col: 'dp_top_holder_pct', label: 'Top Holder %' },
    { col: 'dp_rugcheck_score', label: 'RugCheck Score' },
  ];

  console.log(`  ${'Feature'.padEnd(18)} ${'AvgRug'.padStart(10)} ${'AvgSurv'.padStart(10)} ${'Cohen d'.padStart(8)} ${'N(valid)'.padStart(10)}`);
  console.log(`  ${'-'.repeat(60)}`);

  for (const f of features) {
    const rVals = rugFeats.map(r => r[f.col]).filter(v => v != null);
    const sVals = survFeats.map(r => r[f.col]).filter(v => v != null);
    const avgR = rVals.length > 0 ? rVals.reduce((s, v) => s + v, 0) / rVals.length : 0;
    const avgS = sVals.length > 0 ? sVals.reduce((s, v) => s + v, 0) / sVals.length : 0;
    const d = cohensD(rVals, sVals);
    const nValid = rVals.length + sVals.length;
    console.log(`  ${f.label.padEnd(18)} ${avgR.toFixed(1).padStart(10)} ${avgS.toFixed(1).padStart(10)} ${(d !== null ? d.toFixed(3) : 'N/A').padStart(8)} ${String(nValid).padStart(10)}`);
  }

  // Optimal threshold analysis
  subheader('Optimal score threshold analysis');
  const threshRows = db.prepare(`
    SELECT security_score, pool_outcome
    FROM detected_pools
    WHERE pool_outcome IN ('rug', 'survivor') AND security_score IS NOT NULL
    ORDER BY security_score
  `).all();

  if (threshRows.length > 0) {
    const totalSurvs = threshRows.filter(r => r.pool_outcome === 'survivor').length;
    console.log(`  ${'Threshold'.padEnd(12)} ${'Pass'.padStart(6)} ${'Rugs'.padStart(6)} ${'Surv'.padStart(6)} ${'Rug%'.padStart(7)} ${'SurvLost'.padStart(9)}`);
    console.log(`  ${'-'.repeat(50)}`);
    for (const thresh of [60, 65, 70, 75, 80, 85]) {
      const passing = threshRows.filter(r => r.security_score >= thresh);
      const passingRugs = passing.filter(r => r.pool_outcome === 'rug').length;
      const passingSurvs = passing.filter(r => r.pool_outcome === 'survivor').length;
      const survLost = totalSurvs - passingSurvs;
      const rugRate = passing.length > 0 ? (passingRugs / passing.length) * 100 : 0;
      console.log(`  ${('>=' + thresh).padEnd(12)} ${String(passing.length).padStart(6)} ${String(passingRugs).padStart(6)} ${String(passingSurvs).padStart(6)} ${(rugRate.toFixed(1) + '%').padStart(7)} ${String(survLost).padStart(9)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION: Rejection Analysis
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('rejection_analysis')) {
  header('REJECTION ANALYSIS — Rugs that escaped & Survivors we blocked (v11o+)');

  // Rugs that PASSED security (they got through)
  subheader('Rugs that passed security (escaped)');
  const escapedRugs = db.prepare(`
    SELECT
      substr(base_mint, 1, 8) as token, dp_final_score as score,
      ${PENALTY_COLS.map(p => p.col).join(', ')}
    FROM detected_pools
    WHERE ${versionWhereDP()} AND security_passed = 1 AND pool_outcome = 'rug'
      AND dp_final_score IS NOT NULL
    ORDER BY dp_final_score DESC
  `).all();

  if (escapedRugs.length > 0) {
    console.log(`  ${escapedRugs.length} rugs passed security checks:`);
    console.log(`  ${'Token'.padEnd(10)} ${'Score'.padStart(6)} ${'Active penalties/bonuses'}`);
    console.log(`  ${'-'.repeat(68)}`);
    for (const r of escapedRugs.slice(0, 20)) {
      const active = [];
      for (const p of PENALTY_COLS) {
        const val = r[p.col] ?? 0;
        if (val !== 0) active.push(`${p.label}:${val}`);
      }
      console.log(`  ${r.token.padEnd(10)} ${String(r.score).padStart(6)} ${(active.join(', ') || 'none')}`);
    }

    // Aggregate: which penalties are MISSING on escaped rugs?
    subheader('Penalty gaps — what WASN\'T applied to escaped rugs?');
    for (const p of PENALTY_COLS) {
      if (p.dir === 'bonus') continue;
      const applied = escapedRugs.filter(r => (r[p.col] ?? 0) < 0).length;
      const notApplied = escapedRugs.length - applied;
      if (notApplied > 0) {
        console.log(`  ${p.label.padEnd(18)} NOT applied: ${notApplied}/${escapedRugs.length} (${pct(notApplied, escapedRugs.length)}%)`);
      }
    }
  } else {
    console.log('  No escaped rugs found with breakdown data.');
  }

  // Survivors that were REJECTED (false positives of the filter)
  subheader('Survivors rejected (missed winners)');
  const blockedSurvivors = db.prepare(`
    SELECT
      substr(base_mint, 1, 8) as token, dp_final_score as score,
      dp_rejection_stage as stage,
      ${PENALTY_COLS.map(p => p.col).join(', ')}
    FROM detected_pools
    WHERE ${versionWhereDP()} AND security_passed = 0 AND pool_outcome = 'survivor'
      AND dp_final_score IS NOT NULL
    ORDER BY dp_final_score DESC
  `).all();

  if (blockedSurvivors.length > 0) {
    console.log(`  ${blockedSurvivors.length} survivors were rejected:`);
    console.log(`  ${'Token'.padEnd(10)} ${'Score'.padStart(6)} ${'Stage'.padEnd(20)} ${'Key penalties'}`);
    console.log(`  ${'-'.repeat(78)}`);
    for (const r of blockedSurvivors.slice(0, 20)) {
      const active = [];
      for (const p of PENALTY_COLS) {
        const val = r[p.col] ?? 0;
        if (val < 0) active.push(`${p.label}:${val}`);
      }
      console.log(`  ${r.token.padEnd(10)} ${String(r.score).padStart(6)} ${(r.stage || '?').padEnd(20)} ${active.join(', ') || 'none'}`);
    }

    // What penalty blocked them most?
    subheader('Which penalties blocked the most survivors?');
    const blockReasons = {};
    for (const r of blockedSurvivors) {
      for (const p of PENALTY_COLS) {
        const val = r[p.col] ?? 0;
        if (val < 0) {
          blockReasons[p.label] = (blockReasons[p.label] || 0) + 1;
        }
      }
    }
    const sorted = Object.entries(blockReasons).sort((a, b) => b[1] - a[1]);
    for (const [label, count] of sorted) {
      console.log(`  ${label.padEnd(18)} ${count} survivors blocked (${pct(count, blockedSurvivors.length)}%)`);
    }
  } else {
    console.log('  No rejected survivors found.');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION: ML Readiness
// ═══════════════════════════════════════════════════════════════════════
if (shouldShow('ml_readiness')) {
  header('ML READINESS ASSESSMENT');

  subheader('Dataset sizes');
  const counts = {
    breakdownsWithOutcome: db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE dp_final_score IS NOT NULL AND pool_outcome IN ('rug', 'survivor') AND ${versionWhereDP()}`).get().n,
    allWithOutcome: db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE pool_outcome IN ('rug', 'survivor')`).get().n,
    positions: db.prepare(`SELECT COUNT(*) as n FROM positions WHERE status IN ('stopped', 'closed')`).get().n,
    shadowBroken: db.prepare(`SELECT COUNT(*) as n FROM shadow_positions WHERE total_polls = 0`).get().n,
    shadowWorking: db.prepare(`SELECT COUNT(*) as n FROM shadow_positions WHERE total_polls > 0`).get().n,
  };

  console.log(`  Breakdowns + outcome (v11o+):  ${counts.breakdownsWithOutcome}`);
  console.log(`  All pools with outcome:         ${counts.allWithOutcome}`);
  console.log(`  Positions (traded):             ${counts.positions}`);
  console.log(`  Shadow (broken, 0 polls):       ${counts.shadowBroken}`);
  console.log(`  Shadow (working, >0 polls):     ${counts.shadowWorking}`);

  // Class balance
  subheader('Class balance');
  const balance = db.prepare(`
    SELECT pool_outcome, COUNT(*) as n
    FROM detected_pools WHERE pool_outcome IN ('rug', 'survivor')
    GROUP BY pool_outcome
  `).all();
  for (const b of balance) {
    console.log(`  ${b.pool_outcome}: ${b.n}`);
  }
  const rugN = balance.find(b => b.pool_outcome === 'rug')?.n || 0;
  const survN = balance.find(b => b.pool_outcome === 'survivor')?.n || 0;
  const ratio = survN > 0 ? (rugN / survN).toFixed(2) : 'inf';
  console.log(`  Rug:Survivor ratio: ${ratio}:1`);

  // Feature coverage (breakdown dataset)
  subheader('Feature coverage (v11o+ breakdowns)');
  const breakdownCount = counts.breakdownsWithOutcome;
  for (const p of PENALTY_COLS) {
    const nulls = db.prepare(`
      SELECT SUM(CASE WHEN ${p.col} IS NULL THEN 1 ELSE 0 END) as n
      FROM detected_pools
      WHERE dp_final_score IS NOT NULL AND pool_outcome IN ('rug', 'survivor') AND ${versionWhereDP()}
    `).get().n;
    const coverage = pct(breakdownCount - nulls, breakdownCount);
    const flag = parseFloat(coverage) < 90 ? ' WARNING' : '';
    console.log(`  ${p.label.padEnd(18)} ${coverage}% coverage${flag}`);
  }

  // Feature coverage for broad features
  const broadFeatures = ['dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct', 'dp_rugcheck_score', 'dp_lp_burned'];
  subheader('Feature coverage (all pools with outcomes)');
  const totalWithOutcome = counts.allWithOutcome;
  for (const col of broadFeatures) {
    const nonNull = db.prepare(`
      SELECT COUNT(*) as n FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor') AND ${col} IS NOT NULL
    `).get().n;
    console.log(`  ${col.replace('dp_', '').padEnd(20)} ${pct(nonNull, totalWithOutcome)}% (${nonNull}/${totalWithOutcome})`);
  }

  // Recommendations
  subheader('ML Recommendations');
  console.log(`  1. DATASET:  ${counts.breakdownsWithOutcome} breakdown samples (v11o+) — ${counts.breakdownsWithOutcome >= 100 ? 'sufficient for tree models' : 'marginal'}`);
  console.log(`     - DecisionTree (depth 3-4): OK with 100+ samples`);
  console.log(`     - Random Forest: OK with 200+ samples`);
  console.log(`     - Gradient Boosting: Needs 500+ ideally`);

  if (counts.breakdownsWithOutcome >= 100) {
    console.log(`\n  2. ACTION: TRAIN NOW with breakdown features (N=${counts.breakdownsWithOutcome})`);
    console.log(`     - Use DecisionTree or small RandomForest (max_depth=3)`);
    console.log(`     - 5-fold stratified cross-validation`);
    console.log(`     - Class weight: balanced (${ratio}:1 imbalance)`);
  } else {
    console.log(`\n  2. ACTION: WAIT — need at least 100 samples with breakdowns`);
    console.log(`     - Currently: ${counts.breakdownsWithOutcome}`);
  }

  console.log(`\n  3. SHADOW FIX: Fixing shadow outcomes would unlock ~${counts.shadowBroken} labels`);
  console.log(`     - These have pool_id -> can JOIN to detected_pools.pool_outcome`);
  console.log(`     - No penalty breakdowns though — useful for broad feature models only`);

  console.log(`\n  4. BROAD MODEL: ${counts.allWithOutcome} pools with outcomes + basic features`);
  console.log(`     - Can train on security_score, liquidity, holders, rugcheck_score`);
  console.log(`     - Good baseline to compare against breakdown-enhanced model`);
}

db.close();
console.log('\n');
