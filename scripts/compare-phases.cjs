/**
 * Compare trading metrics between baseline and current period.
 * Generates formatted comparison tables with delta analysis.
 *
 * Usage:
 *   node scripts/compare-phases.cjs                           # Compare baseline vs all post-baseline
 *   node scripts/compare-phases.cjs --from "2026-02-10"       # Compare from specific date
 *   node scripts/compare-phases.cjs --from "2026-02-10" --to "2026-02-15"
 *   node scripts/compare-phases.cjs --output data/report.txt  # Save to file
 */

const Database = require('better-sqlite3');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');
const BASELINE_PATH = path.resolve(process.cwd(), 'data', 'baseline-metrics.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { from: null, to: null, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) opts.from = args[++i];
    if (args[i] === '--to' && args[i + 1]) opts.to = args[++i];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function getMetrics(db, fromMs, toMs) {
  const params = [];
  let where = "WHERE status IN ('closed', 'stopped')";
  if (fromMs) { where += ' AND opened_at >= ?'; params.push(fromMs); }
  if (toMs) { where += ' AND opened_at <= ?'; params.push(toMs); }

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
      SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_pct BETWEEN -80 AND -5 THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
      ROUND(SUM(pnl_sol), 6) as total_pnl_sol,
      ROUND(AVG(CASE WHEN pnl_pct > 5 THEN pnl_pct END), 2) as avg_win_pct,
      ROUND(AVG(CASE WHEN pnl_pct <= -80 THEN pnl_pct END), 2) as avg_rug_pct,
      ROUND(AVG(sol_invested), 6) as avg_position_size,
      MIN(opened_at) as first_at,
      MAX(COALESCE(closed_at, opened_at)) as last_at
    FROM positions
    ${where}
  `).get(...params);

  if (!row || row.total_trades === 0) return null;

  return {
    total_trades: row.total_trades,
    rugs: row.rugs,
    wins: row.wins,
    losses: row.losses,
    rug_rate_pct: Number(((row.rugs / row.total_trades) * 100).toFixed(1)),
    win_rate_pct: Number(((row.wins / row.total_trades) * 100).toFixed(1)),
    avg_pnl_pct: row.avg_pnl_pct,
    total_pnl_sol: row.total_pnl_sol,
    pnl_per_trade_sol: Number((row.total_pnl_sol / row.total_trades).toFixed(6)),
    avg_win_pct: row.avg_win_pct,
    avg_rug_pct: row.avg_rug_pct,
    avg_position_size: row.avg_position_size,
    period_from: row.first_at ? new Date(row.first_at).toISOString().slice(0, 10) : 'N/A',
    period_to: row.last_at ? new Date(row.last_at).toISOString().slice(0, 10) : 'N/A',
  };
}

function delta(current, baseline, suffix = '') {
  if (current == null || baseline == null) return 'N/A';
  const diff = current - baseline;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}${suffix}`;
}

function verdict(current, baseline, lowerIsBetter = false) {
  if (current == null || baseline == null) return '';
  const diff = current - baseline;
  if (Math.abs(diff) < 0.5) return 'EQUAL';
  if (lowerIsBetter) return diff < 0 ? 'BETTER' : 'WORSE';
  return diff > 0 ? 'BETTER' : 'WORSE';
}

function main() {
  const opts = parseArgs();
  const db = new Database(DB_PATH, { readonly: true });

  // Load baseline
  let baseline = null;
  if (existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  }

  // Determine comparison period
  let fromMs = null;
  if (opts.from) {
    fromMs = new Date(opts.from).getTime();
  } else if (baseline) {
    // Use baseline snapshot time as the start of comparison period
    fromMs = new Date(baseline.snapshot_at).getTime();
  }
  const toMs = opts.to ? new Date(opts.to).getTime() : null;

  const current = getMetrics(db, fromMs, toMs);

  if (!current) {
    console.error('No trades found in the specified period.');
    db.close();
    process.exit(1);
  }

  // Build report
  const lines = [];
  const p = (s) => { lines.push(s); console.log(s); };

  p('=== PHASE COMPARISON REPORT ===\n');

  if (baseline) {
    p(`Baseline period:  ${baseline.period?.from?.slice(0, 10) ?? 'N/A'} to ${baseline.period?.to?.slice(0, 10) ?? 'N/A'} (${baseline.total_trades} trades)`);
  } else {
    p('Baseline: NOT FOUND (run: node scripts/snapshot-baseline.cjs first)');
  }
  p(`Current period:   ${current.period_from} to ${current.period_to} (${current.total_trades} trades)\n`);

  const bsl = baseline || {};
  const fmt = (label, cur, base, suffix, lowerBetter) => {
    const d = baseline ? delta(cur, base, suffix) : 'N/A';
    const v = baseline ? verdict(cur, base, lowerBetter) : '';
    p(`${label.padEnd(22)} ${String(base ?? 'N/A').padStart(10)}  ${String(cur).padStart(10)}  ${d.padStart(10)}  ${v}`);
  };

  p('METRIC                   BASELINE     CURRENT       DELTA  VERDICT');
  p('-'.repeat(75));
  fmt('Total trades', current.total_trades, bsl.total_trades, '', false);
  fmt('Rug rate %', current.rug_rate_pct, bsl.rug_rate_pct, 'pp', true);
  fmt('Win rate %', current.win_rate_pct, bsl.win_rate_pct, 'pp', false);
  fmt('Avg PnL %', current.avg_pnl_pct, bsl.avg_pnl_pct, '%', false);
  fmt('Total PnL (SOL)', current.total_pnl_sol, bsl.total_pnl_sol, '', false);
  fmt('PnL/trade (SOL)', current.pnl_per_trade_sol, bsl.pnl_per_trade_sol, '', false);
  fmt('Avg win %', current.avg_win_pct, bsl.avg_win_pct, '%', false);
  fmt('Avg rug %', current.avg_rug_pct, bsl.avg_rug_pct, '%', false);
  fmt('Avg position (SOL)', current.avg_position_size, bsl.avg_position_size, '', false);

  // Blocked tokens analysis
  p('\n=== FILTER ANALYSIS ===\n');
  const blocked = db.prepare(`
    SELECT rejection_reasons, COUNT(*) as cnt
    FROM detected_pools
    WHERE rejection_reasons IS NOT NULL AND rejection_reasons != ''
      ${fromMs ? 'AND detected_at >= ?' : ''}
      ${toMs ? 'AND detected_at <= ?' : ''}
    GROUP BY rejection_reasons
    ORDER BY cnt DESC
    LIMIT 15
  `).all(...[fromMs, toMs].filter(Boolean));

  if (blocked.length > 0) {
    p('Rejection reasons:');
    for (const b of blocked) {
      p(`  ${b.rejection_reasons}: ${b.cnt} tokens`);
    }
  } else {
    p('No rejection data found in this period.');
  }

  // Statistical significance note
  if (baseline && current.total_trades >= 50) {
    p('\nNote: With 50+ trades, differences of 5+ percentage points are likely meaningful.');
  } else if (current.total_trades < 50) {
    p(`\nWarning: Only ${current.total_trades} trades - need 50+ for reliable comparison.`);
  }

  // Save to file if requested
  if (opts.output) {
    writeFileSync(opts.output, lines.join('\n'));
    console.log(`\nReport saved to: ${opts.output}`);
  }

  db.close();
}

main();
