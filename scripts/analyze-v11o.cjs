#!/usr/bin/env node
/**
 * analyze-v11o.cjs — Analysis script focused on v11o+ data
 *
 * Usage:
 *   node scripts/analyze-v11o.cjs              # Full report from v11o onwards
 *   node scripts/analyze-v11o.cjs --version v11p  # Filter to specific version
 *   node scripts/analyze-v11o.cjs --since 2h      # Last 2 hours only
 *   node scripts/analyze-v11o.cjs --section trades # Only show trades section
 *   node scripts/analyze-v11o.cjs --csv            # Export trades as CSV
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const BASELINE_VERSIONS = ['v11o', 'v11p', 'v11q', 'v11r', 'v11s', 'v11t', 'v11u', 'v11v', 'v11w', 'v11x', 'v11y', 'v11z', 'v12a', 'v12b', 'v12c', 'v12d', 'v12e'];

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] || true;
}

const filterVersion = getArg('version');
const sinceArg = getArg('since');
const sectionFilter = getArg('section');
const csvMode = args.includes('--csv');

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

// Build WHERE clause for version filtering
function versionWhere(col = 'bot_version') {
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

function header(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function subheader(title) {
  console.log(`\n--- ${title} ---`);
}

function shouldShow(section) {
  return !sectionFilter || sectionFilter === section;
}

// ─── SECTION: Overview ──────────────────────────────────────────
if (shouldShow('overview')) {
  header('OVERVIEW (v11o+)');

  const overview = db.prepare(`
    SELECT
      bot_version,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN exit_reason = 'rug_pull' THEN 1 ELSE 0 END) as rugs,
      ROUND(SUM(pnl_sol), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 1) as avg_pnl_pct,
      ROUND(AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END), 4) as avg_win,
      ROUND(AVG(CASE WHEN pnl_sol <= 0 THEN pnl_sol END), 4) as avg_loss,
      ROUND(MAX(peak_multiplier), 2) as best_peak,
      MIN(datetime(opened_at/1000, 'unixepoch', 'localtime')) as first_trade,
      MAX(datetime(opened_at/1000, 'unixepoch', 'localtime')) as last_trade
    FROM positions
    WHERE ${versionWhere()} AND status IN ('stopped', 'closed')
    GROUP BY bot_version
    ORDER BY MIN(opened_at)
  `).all();

  if (overview.length === 0) {
    console.log('  No trades found for the selected filter.');
  }

  for (const v of overview) {
    const wr = v.trades > 0 ? Math.round((v.wins / v.trades) * 100) : 0;
    const pnlEmoji = v.total_pnl >= 0 ? '+' : '';
    console.log(`\n  ${v.bot_version}: ${v.trades} trades | ${v.wins}W/${v.losses}L/${v.rugs}R | WR ${wr}%`);
    console.log(`    PnL: ${pnlEmoji}${v.total_pnl} SOL | Avg win: +${v.avg_win || 0} | Avg loss: ${v.avg_loss || 0}`);
    console.log(`    Best peak: ${v.best_peak}x | ${v.first_trade} → ${v.last_trade}`);
  }

  // Totals
  const totals = db.prepare(`
    SELECT
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason = 'rug_pull' THEN 1 ELSE 0 END) as rugs,
      ROUND(SUM(pnl_sol), 4) as total_pnl,
      ROUND(SUM(sol_invested), 4) as total_invested
    FROM positions
    WHERE ${versionWhere()} AND status IN ('stopped', 'closed')
  `).get();

  if (totals.trades > 0) {
    const wr = Math.round((totals.wins / totals.trades) * 100);
    subheader('TOTALS');
    console.log(`  ${totals.trades} trades | ${totals.wins}W/${totals.rugs}R | WR ${wr}%`);
    console.log(`  PnL: ${totals.total_pnl >= 0 ? '+' : ''}${totals.total_pnl} SOL`);
    console.log(`  Total invested: ${totals.total_invested} SOL`);
    console.log(`  ROI: ${((totals.total_pnl / totals.total_invested) * 100).toFixed(1)}%`);
  }
}

// ─── SECTION: Trades ────────────────────────────────────────────
if (shouldShow('trades')) {
  header('TRADES (v11o+)');

  const trades = db.prepare(`
    SELECT
      p.id,
      p.bot_version as ver,
      substr(p.token_mint, 1, 6) as token,
      p.security_score as score,
      p.source,
      ROUND(p.sol_invested, 4) as invested,
      ROUND(p.sol_returned, 4) as returned,
      ROUND(p.pnl_sol, 4) as pnl,
      ROUND(p.pnl_pct, 1) as pnl_pct,
      ROUND(p.peak_multiplier, 2) as peak,
      p.exit_reason,
      ROUND((p.closed_at - p.opened_at) / 1000.0, 0) as dur_s,
      p.tp_levels_hit as tps,
      datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened,
      p.holder_count,
      p.liquidity_usd as liq_usd,
      d.dp_final_score as dp_score,
      d.dp_liquidity_usd as dp_liq
    FROM positions p
    LEFT JOIN detected_pools d ON p.pool_id = d.id
    WHERE ${versionWhere('p.bot_version')} AND p.status IN ('stopped', 'closed')
    ORDER BY p.opened_at DESC
  `).all();

  if (csvMode) {
    console.log('ver,token,score,source,invested,returned,pnl,pnl_pct,peak,exit_reason,dur_s,tps,opened,holders,liq_usd');
    for (const t of trades) {
      console.log(`${t.ver},${t.token},${t.score},${t.source},${t.invested},${t.returned},${t.pnl},${t.pnl_pct},${t.peak},${t.exit_reason},${t.dur_s},${t.tps},${t.opened},${t.holder_count || ''},${t.liq_usd || ''}`);
    }
  } else {
    for (const t of trades) {
      const emoji = t.pnl >= 0 ? (t.pnl_pct >= 5 ? '++' : '+ ') : (t.pnl_pct <= -5 ? '--' : '- ');
      const pnlSign = t.pnl >= 0 ? '+' : '';
      const dur = t.dur_s < 60 ? `${t.dur_s}s` : `${(t.dur_s / 60).toFixed(1)}m`;
      const exit = (t.exit_reason || '?').replace(/_/g, ' ');
      console.log(`  ${emoji} ${t.ver} ${t.token} | sc:${t.score} | ${pnlSign}${t.pnl_pct}% (${pnlSign}${t.pnl} SOL) | peak:${t.peak || '?'}x | ${dur} | ${exit}`);
    }
    console.log(`\n  Total: ${trades.length} trades`);
  }
}

// ─── SECTION: Exit Reasons ──────────────────────────────────────
if (shouldShow('exits')) {
  header('EXIT REASONS (v11o+)');

  const exits = db.prepare(`
    SELECT
      exit_reason,
      COUNT(*) as n,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_sol), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 1) as avg_pnl_pct,
      ROUND(AVG(peak_multiplier), 2) as avg_peak
    FROM positions
    WHERE ${versionWhere()} AND status IN ('stopped', 'closed')
    GROUP BY exit_reason
    ORDER BY n DESC
  `).all();

  console.log(`  ${'Exit Reason'.padEnd(25)} ${'N'.padStart(4)} ${'Wins'.padStart(5)} ${'PnL'.padStart(10)} ${'Avg%'.padStart(7)} ${'AvgPeak'.padStart(8)}`);
  console.log(`  ${'-'.repeat(65)}`);
  for (const e of exits) {
    const pnlSign = e.total_pnl >= 0 ? '+' : '';
    console.log(`  ${(e.exit_reason || '?').padEnd(25)} ${String(e.n).padStart(4)} ${String(e.wins).padStart(5)} ${(pnlSign + e.total_pnl).padStart(10)} ${(e.avg_pnl_pct + '%').padStart(7)} ${(e.avg_peak + 'x').padStart(8)}`);
  }
}

// ─── SECTION: Score Distribution ────────────────────────────────
if (shouldShow('scores')) {
  header('SCORE DISTRIBUTION (v11o+)');

  // Positions by score bucket
  subheader('Trades by Score Bucket');
  const scoreBuckets = db.prepare(`
    SELECT
      CASE
        WHEN security_score >= 85 THEN '85+'
        WHEN security_score >= 80 THEN '80-84'
        WHEN security_score >= 75 THEN '75-79'
        WHEN security_score >= 70 THEN '70-74'
        WHEN security_score >= 65 THEN '65-69'
        ELSE '<65'
      END as bucket,
      COUNT(*) as n,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN exit_reason = 'rug_pull' THEN 1 ELSE 0 END) as rugs,
      ROUND(SUM(pnl_sol), 4) as total_pnl,
      ROUND(AVG(pnl_pct), 1) as avg_pnl
    FROM positions
    WHERE ${versionWhere()} AND status IN ('stopped', 'closed')
    GROUP BY bucket
    ORDER BY MIN(security_score) DESC
  `).all();

  console.log(`  ${'Score'.padEnd(8)} ${'N'.padStart(4)} ${'W'.padStart(3)} ${'R'.padStart(3)} ${'WR%'.padStart(5)} ${'PnL'.padStart(10)} ${'Avg%'.padStart(7)}`);
  console.log(`  ${'-'.repeat(45)}`);
  for (const b of scoreBuckets) {
    const wr = b.n > 0 ? Math.round((b.wins / b.n) * 100) : 0;
    const pnlSign = b.total_pnl >= 0 ? '+' : '';
    console.log(`  ${b.bucket.padEnd(8)} ${String(b.n).padStart(4)} ${String(b.wins).padStart(3)} ${String(b.rugs).padStart(3)} ${(wr + '%').padStart(5)} ${(pnlSign + b.total_pnl).padStart(10)} ${(b.avg_pnl + '%').padStart(7)}`);
  }
}

// ─── SECTION: Pool Funnel ───────────────────────────────────────
if (shouldShow('funnel')) {
  header('POOL FUNNEL (v11o+)');

  const totalPools = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE ${versionWhereDP()}`).get();
  const passedPools = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE ${versionWhereDP()} AND security_passed = 1`).get();
  const boughtPools = db.prepare(`SELECT COUNT(*) as n FROM positions WHERE ${versionWhere()} AND status IN ('stopped', 'closed')`).get();

  // Rejection reasons breakdown
  const rejections = db.prepare(`
    SELECT dp_rejection_stage, COUNT(*) as n
    FROM detected_pools
    WHERE ${versionWhereDP()} AND security_passed = 0 AND dp_rejection_stage IS NOT NULL
    GROUP BY dp_rejection_stage
    ORDER BY n DESC
    LIMIT 10
  `).all();

  console.log(`  Detected:  ${totalPools.n} pools`);
  console.log(`  Passed:    ${passedPools.n} (${totalPools.n > 0 ? ((passedPools.n / totalPools.n) * 100).toFixed(1) : 0}%)`);
  console.log(`  Bought:    ${boughtPools.n}`);
  console.log(`  Pass rate: ${totalPools.n > 0 ? ((boughtPools.n / totalPools.n) * 100).toFixed(2) : 0}%`);

  if (rejections.length > 0) {
    subheader('Top Rejection Stages');
    for (const r of rejections) {
      console.log(`  ${(r.dp_rejection_stage || '?').padEnd(25)} ${r.n}`);
    }
  }

  // Score distribution of rejected pools
  const rejectedScores = db.prepare(`
    SELECT
      CASE
        WHEN dp_final_score >= 75 THEN '75+ (would pass)'
        WHEN dp_final_score >= 65 THEN '65-74'
        WHEN dp_final_score >= 50 THEN '50-64'
        ELSE '<50'
      END as bucket,
      COUNT(*) as n
    FROM detected_pools
    WHERE ${versionWhereDP()} AND security_passed = 0 AND dp_final_score IS NOT NULL
    GROUP BY bucket
    ORDER BY MIN(dp_final_score) DESC
  `).all();

  if (rejectedScores.length > 0) {
    subheader('Rejected Pool Score Distribution');
    for (const s of rejectedScores) {
      console.log(`  ${s.bucket.padEnd(20)} ${s.n}`);
    }
  }
}

// ─── SECTION: Pool Outcomes ─────────────────────────────────────
if (shouldShow('outcomes')) {
  header('POOL OUTCOMES — Did we miss winners? (v11o+)');

  // Pools we rejected but that survived (pool_outcome_checks)
  const missedWinners = db.prepare(`
    SELECT
      substr(dp.base_mint, 1, 6) as token,
      dp.dp_final_score as score,
      dp.dp_rejection_stage as rejection,
      ROUND(MAX(poc.liquidity_usd), 0) as max_liq,
      MAX(poc.delay_minutes) as last_check_min,
      MAX(poc.is_alive) as still_alive,
      ROUND(MAX(poc.market_cap), 0) as max_mcap
    FROM detected_pools dp
    JOIN pool_outcome_checks poc ON poc.pool_id = dp.id
    WHERE ${versionWhereDP('dp.bot_version')}
      AND dp.security_passed = 0
      AND poc.is_alive = 1
      AND poc.liquidity_usd > 20000
    GROUP BY dp.id
    ORDER BY max_liq DESC
    LIMIT 15
  `).all();

  if (missedWinners.length > 0) {
    console.log(`\n  Rejected pools that grew to $20K+ liquidity:`);
    console.log(`  ${'Token'.padEnd(8)} ${'Score'.padStart(6)} ${'MaxLiq'.padStart(10)} ${'MaxMCap'.padStart(12)} ${'Rejection'.padEnd(20)}`);
    console.log(`  ${'-'.repeat(60)}`);
    for (const m of missedWinners) {
      console.log(`  ${m.token.padEnd(8)} ${String(m.score || '?').padStart(6)} ${('$' + (m.max_liq || 0)).padStart(10)} ${('$' + (m.max_mcap || 0)).padStart(12)} ${(m.rejection || '?').padEnd(20)}`);
    }
  } else {
    console.log('  No rejected pools found with $20K+ liquidity.');
  }
}

// ─── SECTION: Shadow Positions ──────────────────────────────────
if (shouldShow('shadow')) {
  header('SHADOW POSITIONS (v11o+)');

  const shadow = db.prepare(`
    SELECT
      bot_version,
      COUNT(*) as n,
      SUM(tp1_hit) as tp1,
      SUM(tp2_hit) as tp2,
      SUM(tp3_hit) as tp3,
      SUM(sl_hit) as sl,
      SUM(rug_detected) as rugs,
      ROUND(AVG(peak_multiplier), 2) as avg_peak,
      ROUND(MAX(peak_multiplier), 2) as max_peak,
      ROUND(AVG(total_polls), 0) as avg_polls
    FROM shadow_positions
    WHERE ${versionWhere()} AND status IN ('expired', 'closed')
    GROUP BY bot_version
    ORDER BY MIN(opened_at)
  `).all();

  if (shadow.length === 0) {
    console.log('  No shadow positions found.');
  } else {
    console.log(`  ${'Ver'.padEnd(6)} ${'N'.padStart(5)} ${'TP1'.padStart(5)} ${'TP2'.padStart(5)} ${'TP3'.padStart(5)} ${'SL'.padStart(5)} ${'Rug'.padStart(5)} ${'AvgPk'.padStart(7)} ${'MaxPk'.padStart(7)}`);
    console.log(`  ${'-'.repeat(55)}`);
    for (const s of shadow) {
      console.log(`  ${s.bot_version.padEnd(6)} ${String(s.n).padStart(5)} ${String(s.tp1).padStart(5)} ${String(s.tp2).padStart(5)} ${String(s.tp3).padStart(5)} ${String(s.sl).padStart(5)} ${String(s.rugs).padStart(5)} ${String(s.avg_peak + 'x').padStart(7)} ${String(s.max_peak + 'x').padStart(7)}`);
    }
  }
}

// ─── SECTION: Timing ────────────────────────────────────────────
if (shouldShow('timing')) {
  header('TIMING ANALYSIS (v11o+)');

  const timing = db.prepare(`
    SELECT
      ROUND(AVG(entry_latency_ms), 0) as avg_latency,
      ROUND(MIN(entry_latency_ms), 0) as min_latency,
      ROUND(MAX(entry_latency_ms), 0) as max_latency,
      ROUND(AVG(time_to_peak_ms), 0) as avg_time_to_peak,
      ROUND(AVG((closed_at - opened_at) / 1000.0), 0) as avg_duration_s,
      ROUND(MIN((closed_at - opened_at) / 1000.0), 0) as min_duration_s,
      ROUND(MAX((closed_at - opened_at) / 1000.0), 0) as max_duration_s
    FROM positions
    WHERE ${versionWhere()} AND status IN ('stopped', 'closed') AND closed_at IS NOT NULL
  `).get();

  if (timing) {
    console.log(`  Entry latency:   avg ${timing.avg_latency}ms | min ${timing.min_latency}ms | max ${timing.max_latency}ms`);
    console.log(`  Time to peak:    avg ${timing.avg_time_to_peak}ms (${((timing.avg_time_to_peak || 0) / 1000).toFixed(1)}s)`);
    console.log(`  Position duration: avg ${timing.avg_duration_s}s | min ${timing.min_duration_s}s | max ${timing.max_duration_s}s`);
  }

  // Win/loss by duration bucket
  const durBuckets = db.prepare(`
    SELECT
      CASE
        WHEN (closed_at - opened_at) < 30000 THEN '<30s'
        WHEN (closed_at - opened_at) < 60000 THEN '30s-1m'
        WHEN (closed_at - opened_at) < 180000 THEN '1-3m'
        WHEN (closed_at - opened_at) < 600000 THEN '3-10m'
        ELSE '10m+'
      END as bucket,
      COUNT(*) as n,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_sol), 4) as pnl
    FROM positions
    WHERE ${versionWhere()} AND status IN ('stopped', 'closed') AND closed_at IS NOT NULL
    GROUP BY bucket
    ORDER BY MIN(closed_at - opened_at)
  `).all();

  if (durBuckets.length > 0) {
    subheader('PnL by Duration');
    for (const b of durBuckets) {
      const wr = b.n > 0 ? Math.round((b.wins / b.n) * 100) : 0;
      console.log(`  ${b.bucket.padEnd(10)} ${String(b.n).padStart(4)} trades | ${String(b.wins).padStart(2)}W | WR ${wr}% | PnL: ${b.pnl >= 0 ? '+' : ''}${b.pnl} SOL`);
    }
  }
}

// ─── SECTION: Scoring Penalties ─────────────────────────────────
if (shouldShow('penalties')) {
  header('SCORING PENALTIES — What blocked pools? (v11o+)');

  const penalties = db.prepare(`
    SELECT
      ROUND(AVG(dp_hhi_penalty), 1) as avg_hhi_pen,
      ROUND(AVG(dp_concentrated_penalty), 1) as avg_conc_pen,
      ROUND(AVG(dp_holder_penalty), 1) as avg_holder_pen,
      ROUND(AVG(dp_creator_age_penalty), 1) as avg_creator_pen,
      ROUND(AVG(dp_rugcheck_penalty), 1) as avg_rugcheck_pen,
      ROUND(AVG(dp_velocity_penalty), 1) as avg_velocity_pen,
      ROUND(AVG(dp_insider_penalty), 1) as avg_insider_pen,
      ROUND(AVG(dp_whale_penalty), 1) as avg_whale_pen,
      ROUND(AVG(dp_timing_cv_penalty), 1) as avg_timing_pen,
      ROUND(AVG(dp_wash_penalty), 1) as avg_wash_pen,
      ROUND(AVG(dp_bundle_penalty), 1) as avg_bundle_pen,
      ROUND(AVG(dp_graduation_bonus), 1) as avg_grad_bonus,
      ROUND(AVG(dp_obs_bonus), 1) as avg_obs_bonus,
      ROUND(AVG(dp_organic_bonus), 1) as avg_organic_bonus,
      ROUND(AVG(dp_smart_wallet_bonus), 1) as avg_sw_bonus
    FROM detected_pools
    WHERE ${versionWhereDP()} AND dp_final_score IS NOT NULL
  `).get();

  if (penalties) {
    console.log('  Average penalties across all detected pools:');
    console.log(`  HHI:          ${penalties.avg_hhi_pen}`);
    console.log(`  Concentrated: ${penalties.avg_conc_pen}`);
    console.log(`  Holders:      ${penalties.avg_holder_pen}`);
    console.log(`  Creator age:  ${penalties.avg_creator_pen}`);
    console.log(`  RugCheck:     ${penalties.avg_rugcheck_pen}`);
    console.log(`  Velocity:     ${penalties.avg_velocity_pen}`);
    console.log(`  Insiders:     ${penalties.avg_insider_pen}`);
    console.log(`  Whales:       ${penalties.avg_whale_pen}`);
    console.log(`  Timing CV:    ${penalties.avg_timing_pen}`);
    console.log(`  Wash:         ${penalties.avg_wash_pen}`);
    console.log(`  Bundle:       ${penalties.avg_bundle_pen}`);
    console.log(`  --- Bonuses ---`);
    console.log(`  Graduation:   ${penalties.avg_grad_bonus}`);
    console.log(`  Observation:  ${penalties.avg_obs_bonus}`);
    console.log(`  Organic:      ${penalties.avg_organic_bonus}`);
    console.log(`  Smart wallet: ${penalties.avg_sw_bonus}`);
  }
}

// ─── SECTION: Smart TP Analysis ───────────────────────────────────
if (shouldShow('smart_tp')) {
  header('SMART TP ANALYSIS (v11s+)');

  const snapshots = db.prepare(`
    SELECT
      t.position_id,
      substr(t.token_mint, 1, 6) as token,
      t.time_to_tp1_ms,
      ROUND(t.reserve_change_pct, 1) as reserve_pct,
      ROUND(t.buy_sell_ratio, 1) as ratio,
      t.buy_count_30s,
      t.sell_count_15s,
      t.cumulative_sell_count,
      ROUND(t.current_multiplier, 3) as tp1_mult,
      t.smart_tp_decision as decision,
      t.smart_tp_signals_passed as signals,
      ROUND(t.post_tp1_peak, 2) as post_peak,
      t.post_tp1_exit_reason as post_exit,
      ROUND(t.post_tp1_duration_ms / 1000.0, 0) as post_dur_s,
      p.pnl_sol,
      p.pnl_pct,
      p.exit_reason,
      p.bot_version
    FROM tp1_snapshots t
    LEFT JOIN positions p ON t.position_id = p.id
    ORDER BY t.created_at DESC
  `).all();

  if (snapshots.length === 0) {
    console.log('  No TP1 snapshots found yet. Wait for trades to hit TP1.');
  } else {
    subheader(`All TP1 Snapshots (N=${snapshots.length})`);
    console.log(`  ${'Token'.padEnd(8)} ${'Ver'.padEnd(6)} ${'Res%'.padStart(6)} ${'Ratio'.padStart(6)} ${'TP1s'.padStart(5)} ${'Sells'.padStart(6)} ${'Decis'.padEnd(6)} ${'Sig'.padStart(4)} ${'Peak'.padStart(6)} ${'PostExit'.padEnd(12)} ${'PnL%'.padStart(7)}`);
    console.log(`  ${'-'.repeat(80)}`);
    for (const s of snapshots) {
      const resPct = s.reserve_pct != null ? (s.reserve_pct >= 0 ? '+' : '') + s.reserve_pct : '?';
      const tp1s = s.time_to_tp1_ms ? Math.round(s.time_to_tp1_ms / 1000) : '?';
      const postPeak = s.post_peak ? s.post_peak + 'x' : '?';
      const postExit = (s.post_exit || s.exit_reason || '?').slice(0, 11);
      const pnlPct = s.pnl_pct != null ? (s.pnl_pct >= 0 ? '+' : '') + s.pnl_pct.toFixed(1) + '%' : '?';
      console.log(`  ${(s.token || '?').padEnd(8)} ${(s.bot_version || '?').padEnd(6)} ${String(resPct).padStart(6)} ${String(s.ratio || '?').padStart(6)} ${String(tp1s).padStart(5)} ${String(s.cumulative_sell_count || 0).padStart(6)} ${(s.decision || '?').padEnd(6)} ${String(s.signals || '?').padStart(4)} ${postPeak.padStart(6)} ${postExit.padEnd(12)} ${pnlPct.padStart(7)}`);
    }

    // Signal correlation analysis
    const withOutcome = snapshots.filter(s => s.post_peak != null);
    if (withOutcome.length >= 3) {
      subheader('Signal Correlation with Post-TP1 Peak');

      // Reserve growth vs continuation
      const resGrowing = withOutcome.filter(s => s.reserve_pct != null && s.reserve_pct >= 5);
      const resFlat = withOutcome.filter(s => s.reserve_pct != null && s.reserve_pct < 5);
      if (resGrowing.length > 0 || resFlat.length > 0) {
        const avgPeakGrowing = resGrowing.length > 0 ? resGrowing.reduce((sum, s) => sum + (s.post_peak || 1), 0) / resGrowing.length : 0;
        const avgPeakFlat = resFlat.length > 0 ? resFlat.reduce((sum, s) => sum + (s.post_peak || 1), 0) / resFlat.length : 0;
        console.log(`  Reserve >=5%:  N=${resGrowing.length}, avg post-TP1 peak: ${avgPeakGrowing.toFixed(2)}x`);
        console.log(`  Reserve <5%:   N=${resFlat.length}, avg post-TP1 peak: ${avgPeakFlat.toFixed(2)}x`);
      }

      // Speed to TP1 vs continuation
      const fast = withOutcome.filter(s => s.time_to_tp1_ms && s.time_to_tp1_ms <= 15000);
      const slow = withOutcome.filter(s => s.time_to_tp1_ms && s.time_to_tp1_ms > 15000);
      if (fast.length > 0 || slow.length > 0) {
        const avgPeakFast = fast.length > 0 ? fast.reduce((sum, s) => sum + (s.post_peak || 1), 0) / fast.length : 0;
        const avgPeakSlow = slow.length > 0 ? slow.reduce((sum, s) => sum + (s.post_peak || 1), 0) / slow.length : 0;
        console.log(`  TP1 <=15s:     N=${fast.length}, avg post-TP1 peak: ${avgPeakFast.toFixed(2)}x`);
        console.log(`  TP1 >15s:      N=${slow.length}, avg post-TP1 peak: ${avgPeakSlow.toFixed(2)}x`);
      }

      // Smart TP decision accuracy
      const holdDecisions = withOutcome.filter(s => s.decision === 'HOLD');
      const sellDecisions = withOutcome.filter(s => s.decision === 'SELL');
      if (holdDecisions.length > 0) {
        const avgPeakHold = holdDecisions.reduce((sum, s) => sum + (s.post_peak || 1), 0) / holdDecisions.length;
        const runnersHold = holdDecisions.filter(s => s.post_peak >= 1.15).length;
        console.log(`\n  Smart TP "HOLD": N=${holdDecisions.length}, avg peak: ${avgPeakHold.toFixed(2)}x, runners(>1.15x): ${runnersHold}`);
      }
      if (sellDecisions.length > 0) {
        const avgPeakSell = sellDecisions.reduce((sum, s) => sum + (s.post_peak || 1), 0) / sellDecisions.length;
        const runnersSell = sellDecisions.filter(s => s.post_peak >= 1.15).length;
        console.log(`  Smart TP "SELL": N=${sellDecisions.length}, avg peak: ${avgPeakSell.toFixed(2)}x, runners(>1.15x): ${runnersSell}`);
      }

      // EV calculation
      subheader('Hypothetical EV (if smart TP was active)');
      let totalDelta = 0;
      let deltaCount = 0;
      for (const s of withOutcome) {
        if (s.decision === 'HOLD' && s.post_peak && s.pnl_sol != null) {
          const tp1Mult = 1.08;
          const solInvested = Math.abs(s.pnl_sol / ((s.pnl_pct || 0) / 100)) || 0.015;
          const realPnl = s.pnl_sol;
          const tp1Portion = 0.6;
          const holdPortion = 0.4;
          const tp1PnlSol = solInvested * tp1Portion * (tp1Mult - 1);
          const holdPnlSolAtPeak = solInvested * holdPortion * (s.post_peak - 1);
          const extraFee = 0.0004;
          const hypothetical = tp1PnlSol + holdPnlSolAtPeak - extraFee;
          const delta = hypothetical - realPnl;
          totalDelta += delta;
          deltaCount++;
        }
      }
      if (deltaCount > 0) {
        console.log(`  Total delta (N=${deltaCount} HOLD decisions): ${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(4)} SOL`);
        console.log(`  Avg delta per trade: ${(totalDelta / deltaCount) >= 0 ? '+' : ''}${(totalDelta / deltaCount).toFixed(4)} SOL`);
        console.log(`  NOTE: Uses peak price (best case). Real exit would be lower.`);
      } else {
        console.log(`  No HOLD decisions with outcomes yet.`);
      }
    }
  }
}

// ─── SECTION: Reverse Analysis — What did we miss? ────────────────
if (shouldShow('reverse')) {
  header('REVERSE ANALYSIS — Rejected Token Investigation (v11o+)');

  // NOTE: Uses market_cap at LATEST outcome check as primary metric.
  // liquidity_usd is unreliable for PumpSwap pools (DexScreener often returns 0).
  // "Strong" = mcap >= $50K at last check (token survived and grew)
  // "OK" = mcap $20-50K (alive but not booming)
  // "Weak" = mcap $5-20K (barely surviving)
  // "Dying" = mcap < $5K or 0 (dead or near-dead)
  // CAVEAT: A pool having $50K mcap at 1h doesn't mean the bot would have profited.
  // The bot needs +8% in ~12min and a successful sell.

  // Get rejected pools with their LATEST outcome check (not MAX/peak)
  const allRejectedWithOutcome = db.prepare(`
    SELECT
      dp.id,
      dp.base_mint,
      dp.dp_final_score as score,
      dp.dp_rejection_stage as stage,
      dp.rejection_reasons as reasons,
      dp.dp_holder_penalty,
      dp.dp_rugcheck_penalty,
      dp.dp_creator_age_penalty,
      dp.dp_hhi_penalty,
      dp.dp_concentrated_penalty,
      dp.dp_obs_bonus,
      dp.dp_organic_bonus,
      dp.dp_smart_wallet_bonus,
      dp.dp_velocity_penalty,
      dp.dp_insider_penalty,
      dp.dp_whale_penalty,
      dp.dp_timing_cv_penalty,
      dp.dp_wash_penalty,
      dp.dp_bundle_penalty,
      dp.dp_graduation_bonus,
      dp.dp_creator_reputation,
      dp.dp_funder_fan_out,
      latest.latest_mcap,
      latest.latest_liq,
      latest.latest_delay,
      peak.max_mcap,
      peak.max_liq
    FROM detected_pools dp
    LEFT JOIN (
      -- Latest check per pool (most recent snapshot, not peak)
      SELECT poc1.pool_id,
        poc1.market_cap as latest_mcap,
        poc1.liquidity_usd as latest_liq,
        poc1.delay_minutes as latest_delay
      FROM pool_outcome_checks poc1
      INNER JOIN (
        SELECT pool_id, MAX(delay_minutes) as max_delay
        FROM pool_outcome_checks GROUP BY pool_id
      ) poc2 ON poc1.pool_id = poc2.pool_id AND poc1.delay_minutes = poc2.max_delay
    ) latest ON latest.pool_id = dp.id
    LEFT JOIN (
      -- Peak values (for reference)
      SELECT pool_id,
        MAX(COALESCE(market_cap, 0)) as max_mcap,
        MAX(COALESCE(liquidity_usd, 0)) as max_liq
      FROM pool_outcome_checks GROUP BY pool_id
    ) peak ON peak.pool_id = dp.id
    WHERE ${versionWhereDP('dp.bot_version')}
      AND dp.security_passed = 0
    GROUP BY dp.id
  `).all();

  // Also get bought positions for comparison
  const boughtPositions = db.prepare(`
    SELECT
      dp.id,
      dp.base_mint,
      dp.dp_final_score as score,
      dp.dp_holder_penalty,
      dp.dp_rugcheck_penalty,
      dp.dp_creator_age_penalty,
      dp.dp_hhi_penalty,
      dp.dp_concentrated_penalty,
      dp.dp_obs_bonus,
      dp.dp_organic_bonus,
      dp.dp_smart_wallet_bonus,
      p.pnl_sol,
      p.exit_reason,
      p.peak_multiplier,
      latest.latest_mcap,
      latest.latest_liq,
      peak.max_mcap,
      peak.max_liq
    FROM positions p
    JOIN detected_pools dp ON dp.id = p.pool_id
    LEFT JOIN (
      SELECT poc1.pool_id, poc1.market_cap as latest_mcap, poc1.liquidity_usd as latest_liq
      FROM pool_outcome_checks poc1
      INNER JOIN (
        SELECT pool_id, MAX(delay_minutes) as max_delay
        FROM pool_outcome_checks GROUP BY pool_id
      ) poc2 ON poc1.pool_id = poc2.pool_id AND poc1.delay_minutes = poc2.max_delay
    ) latest ON latest.pool_id = dp.id
    LEFT JOIN (
      SELECT pool_id, MAX(COALESCE(market_cap, 0)) as max_mcap, MAX(COALESCE(liquidity_usd, 0)) as max_liq
      FROM pool_outcome_checks GROUP BY pool_id
    ) peak ON peak.pool_id = dp.id
    WHERE ${versionWhere('p.bot_version')} AND p.status IN ('stopped', 'closed')
    GROUP BY dp.id
  `).all();

  // Pools with outcome data = have at least one check
  const hasOutcome = (r) => r.latest_mcap != null || r.max_mcap != null;
  const rejectedWithChecks = allRejectedWithOutcome.filter(hasOutcome);
  const rejectedNoChecks = allRejectedWithOutcome.filter(r => !hasOutcome(r));

  // Use latest_mcap as primary metric (falls back to max_mcap, then max_liq)
  function getMcap(r) {
    if (r.latest_mcap != null && r.latest_mcap > 0) return r.latest_mcap;
    if (r.max_mcap != null && r.max_mcap > 0) return r.max_mcap;
    if (r.max_liq != null && r.max_liq > 0) return r.max_liq; // fallback
    return 0;
  }

  const STRONG = 50000;  // $50K mcap at last check
  const OK = 20000;      // $20K
  const WEAK = 5000;     // $5K

  // ─── A. Score Bucket Summary ───
  subheader('A. Score Bucket Summary (mcap at LATEST outcome check)');

  const scoreBuckets = [
    { label: '65-74 (borderline)', min: 65, max: 74 },
    { label: '55-64', min: 55, max: 64 },
    { label: '45-54', min: 45, max: 54 },
    { label: '<45', min: -999, max: 44 },
    { label: 'No score', min: null, max: null },
  ];

  console.log(`  ${'Score'.padEnd(22)} ${'N'.padStart(5)} ${'>50K'.padStart(5)} ${'20-50'.padStart(6)} ${'5-20K'.padStart(6)} ${'<5K'.padStart(5)} ${'Str%'.padStart(6)} ${'OK%'.padStart(6)}`);
  console.log(`  ${'-'.repeat(62)}`);

  // Bought row first (reference line)
  if (boughtPositions.length > 0) {
    const bp = boughtPositions;
    const bStrong = bp.filter(p => getMcap(p) >= STRONG).length;
    const bOk = bp.filter(p => getMcap(p) >= OK && getMcap(p) < STRONG).length;
    const bWeak = bp.filter(p => getMcap(p) >= WEAK && getMcap(p) < OK).length;
    const bDying = bp.filter(p => getMcap(p) < WEAK).length;
    const bStrPct = Math.round((bStrong / bp.length) * 100);
    const bOkPct = Math.round(((bStrong + bOk) / bp.length) * 100);
    console.log(`  ${'75+ (BOUGHT)'.padEnd(22)} ${String(bp.length).padStart(5)} ${String(bStrong).padStart(5)} ${String(bOk).padStart(6)} ${String(bWeak).padStart(6)} ${String(bDying).padStart(5)} ${(bStrPct + '%').padStart(6)} ${(bOkPct + '%').padStart(6)}`);
  }

  // Rejected buckets
  for (const bucket of scoreBuckets) {
    let pools;
    if (bucket.min === null) {
      pools = rejectedWithChecks.filter(r => r.score == null);
    } else {
      pools = rejectedWithChecks.filter(r => r.score != null && r.score >= bucket.min && r.score <= bucket.max);
    }
    if (pools.length === 0) continue;

    const strong = pools.filter(p => getMcap(p) >= STRONG).length;
    const ok = pools.filter(p => getMcap(p) >= OK && getMcap(p) < STRONG).length;
    const weak = pools.filter(p => getMcap(p) >= WEAK && getMcap(p) < OK).length;
    const dying = pools.filter(p => getMcap(p) < WEAK).length;
    const strPct = Math.round((strong / pools.length) * 100);
    const okPct = Math.round(((strong + ok) / pools.length) * 100);

    console.log(`  ${bucket.label.padEnd(22)} ${String(pools.length).padStart(5)} ${String(strong).padStart(5)} ${String(ok).padStart(6)} ${String(weak).padStart(6)} ${String(dying).padStart(5)} ${(strPct + '%').padStart(6)} ${(okPct + '%').padStart(6)}`);
  }

  console.log(`\n  >50K = mcap >= $50K at last check (strong) | OK% = $20K+ | <5K = dying/dead`);
  console.log(`  Pools with outcome checks: ${rejectedWithChecks.length} / ${allRejectedWithOutcome.length} (${rejectedNoChecks.length} excluded, mostly token_2022)`);

  // Bias warning
  const noCheckReasons = {};
  for (const r of rejectedNoChecks) {
    const key = r.reasons || '(none)';
    noCheckReasons[key] = (noCheckReasons[key] || 0) + 1;
  }
  const topNoCheck = Object.entries(noCheckReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`  No-check pools breakdown: ${topNoCheck.map(([r, n]) => `${r}:${n}`).join(', ')}`);

  // ─── B. Top Missed Winners ───
  subheader('B. Top Missed Winners (rejected, mcap > $50K at last check)');

  const missedWinners = rejectedWithChecks
    .filter(r => getMcap(r) >= STRONG)
    .sort((a, b) => getMcap(b) - getMcap(a))
    .slice(0, 20);

  if (missedWinners.length === 0) {
    console.log('  No missed winners found.');
  } else {
    console.log(`  ${'Token'.padEnd(8)} ${'Score'.padStart(6)} ${'LastMCap'.padStart(12)} ${'PeakMCap'.padStart(12)} ${'Chk'.padStart(4)} ${'Stage'.padEnd(18)} ${'Reasons'.padEnd(24)} Penalties`);
    console.log(`  ${'-'.repeat(110)}`);
    for (const m of missedWinners) {
      const token = (m.base_mint || '?').slice(0, 6);
      const score = m.score != null ? String(m.score) : 'N/A';
      const lastMcap = '$' + Math.round(getMcap(m)).toLocaleString();
      const peakMcap = m.max_mcap > 0 ? '$' + Math.round(m.max_mcap).toLocaleString() : '?';
      const delay = m.latest_delay ? m.latest_delay + 'm' : '?';
      const stage = (m.stage || '?').slice(0, 17);
      const reasons = (m.reasons || '').slice(0, 23);

      const penalties = [];
      if (m.dp_holder_penalty) penalties.push(`hld:${m.dp_holder_penalty}`);
      if (m.dp_rugcheck_penalty) penalties.push(`rc:${m.dp_rugcheck_penalty}`);
      if (m.dp_creator_age_penalty) penalties.push(`age:${m.dp_creator_age_penalty}`);
      if (m.dp_hhi_penalty) penalties.push(`hhi:${m.dp_hhi_penalty}`);
      if (m.dp_concentrated_penalty) penalties.push(`conc:${m.dp_concentrated_penalty}`);
      if (m.dp_velocity_penalty) penalties.push(`vel:${m.dp_velocity_penalty}`);
      if (m.dp_insider_penalty) penalties.push(`ins:${m.dp_insider_penalty}`);
      if (m.dp_whale_penalty) penalties.push(`whl:${m.dp_whale_penalty}`);
      if (m.dp_wash_penalty) penalties.push(`wsh:${m.dp_wash_penalty}`);
      if (m.dp_bundle_penalty) penalties.push(`bnd:${m.dp_bundle_penalty}`);
      if (m.dp_obs_bonus) penalties.push(`obs:+${m.dp_obs_bonus}`);
      if (m.dp_organic_bonus) penalties.push(`org:+${m.dp_organic_bonus}`);

      console.log(`  ${token.padEnd(8)} ${score.padStart(6)} ${lastMcap.padStart(12)} ${peakMcap.padStart(12)} ${delay.padStart(4)} ${stage.padEnd(18)} ${reasons.padEnd(24)} ${penalties.join(' ')}`);
    }
  }

  // ─── C. Penalty Effectiveness ───
  subheader('C. Penalty Effectiveness — Do penalties distinguish strong from dying?');

  // Focus on scored rejected pools with outcome data
  const scoredRejected = rejectedWithChecks.filter(r => r.score != null);
  const scoredStrong = scoredRejected.filter(r => getMcap(r) >= STRONG);
  const scoredDying = scoredRejected.filter(r => getMcap(r) < WEAK);

  if (scoredStrong.length < 3 || scoredDying.length < 3) {
    console.log(`  Insufficient data: ${scoredStrong.length} strong ($50K+), ${scoredDying.length} dying (<$5K) — need >=3 each`);
    console.log(`  (Mid-range pools excluded to sharpen signal)`);
  } else {
    const penaltyColumns = [
      { key: 'dp_holder_penalty', label: 'holder_penalty' },
      { key: 'dp_rugcheck_penalty', label: 'rugcheck_penalty' },
      { key: 'dp_creator_age_penalty', label: 'creator_age' },
      { key: 'dp_hhi_penalty', label: 'hhi_penalty' },
      { key: 'dp_concentrated_penalty', label: 'concentrated' },
      { key: 'dp_velocity_penalty', label: 'velocity_penalty' },
      { key: 'dp_insider_penalty', label: 'insider_penalty' },
      { key: 'dp_whale_penalty', label: 'whale_penalty' },
      { key: 'dp_timing_cv_penalty', label: 'timing_cv' },
      { key: 'dp_wash_penalty', label: 'wash_penalty' },
      { key: 'dp_bundle_penalty', label: 'bundle_penalty' },
      { key: 'dp_obs_bonus', label: 'obs_bonus' },
      { key: 'dp_organic_bonus', label: 'organic_bonus' },
      { key: 'dp_smart_wallet_bonus', label: 'smart_wallet' },
      { key: 'dp_graduation_bonus', label: 'graduation' },
      { key: 'dp_creator_reputation', label: 'creator_rep' },
    ];

    function avg(arr, key) {
      const vals = arr.map(r => r[key]).filter(v => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }

    console.log(`  Comparing extremes: ${scoredStrong.length} strong ($50K+ mcap) vs ${scoredDying.length} dying (<$5K mcap)`);
    console.log(`  (Mid-range pools excluded to sharpen the contrast)`);
    console.log(`\n  ${'Penalty'.padEnd(20)} ${'Strong'.padStart(9)} ${'Dying'.padStart(9)} ${'Diff'.padStart(7)} ${'Signal?'.padEnd(10)}`);
    console.log(`  ${'-'.repeat(58)}`);

    for (const col of penaltyColumns) {
      const sAvg = avg(scoredStrong, col.key);
      const dAvg = avg(scoredDying, col.key);
      if (sAvg === null && dAvg === null) continue;

      const sStr = sAvg != null ? sAvg.toFixed(1) : 'N/A';
      const dStr = dAvg != null ? dAvg.toFixed(1) : 'N/A';
      const diff = (sAvg != null && dAvg != null) ? (sAvg - dAvg) : null;
      const diffStr = diff != null ? ((diff >= 0 ? '+' : '') + diff.toFixed(1)) : 'N/A';

      let signal = '';
      if (diff != null) {
        const absDiff = Math.abs(diff);
        if (absDiff < 0.5) signal = 'NOISE';
        else if (diff > 0 && col.key.includes('penalty')) signal = 'ANTI-PRED!';
        else if (diff < -0.5 && col.key.includes('penalty')) signal = 'useful';
        else if (diff > 0.5 && col.key.includes('bonus')) signal = 'useful';
        else if (diff < 0 && col.key.includes('bonus')) signal = 'ANTI-PRED!';
        else if (absDiff >= 0.5) signal = 'weak';
      }

      console.log(`  ${col.label.padEnd(20)} ${sStr.padStart(9)} ${dStr.padStart(9)} ${diffStr.padStart(7)} ${signal.padEnd(10)}`);
    }

    console.log(`\n  NOISE = diff < 0.5 (indistinguishable)`);
    console.log(`  ANTI-PRED = penalty HIGHER in strong pools (counterproductive)`);
    console.log(`  useful = penalty correctly higher in dying pools`);
  }

  // ─── D. Rejection Stage FP Rates ───
  subheader('D. Rejection Stage False Positive Rates (using mcap $50K+)');

  // By rejection_reasons
  const reasonGroups = {};
  for (const r of rejectedWithChecks) {
    const reason = r.reasons || '(score too low)';
    if (!reasonGroups[reason]) reasonGroups[reason] = { total: 0, strong: 0, dying: 0 };
    reasonGroups[reason].total++;
    if (getMcap(r) >= STRONG) reasonGroups[reason].strong++;
    if (getMcap(r) < WEAK) reasonGroups[reason].dying++;
  }

  const reasonEntries = Object.entries(reasonGroups)
    .map(([reason, data]) => ({
      reason,
      ...data,
      fpRate: data.total > 0 ? Math.round((data.strong / data.total) * 100) : 0,
      drRate: data.total > 0 ? Math.round((data.dying / data.total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  console.log(`\n  ${'Reason'.padEnd(30)} ${'Total'.padStart(6)} ${'Strong'.padStart(7)} ${'Dying'.padStart(6)} ${'FP%'.padStart(5)} ${'DR%'.padStart(5)} ${'Flag'.padEnd(10)}`);
  console.log(`  ${'-'.repeat(72)}`);
  for (const r of reasonEntries) {
    const flag = r.fpRate >= 30 ? 'HIGH FP' : (r.fpRate >= 15 ? 'moderate' : '');
    console.log(`  ${r.reason.padEnd(30)} ${String(r.total).padStart(6)} ${String(r.strong).padStart(7)} ${String(r.dying).padStart(6)} ${(r.fpRate + '%').padStart(5)} ${(r.drRate + '%').padStart(5)} ${flag.padEnd(10)}`);
  }
  console.log(`  FP% = strong pools falsely rejected | DR% = dying pools correctly rejected`);

  // ─── E. "What If" Threshold Simulations ───
  subheader('E. "What If" Threshold Simulations (mcap-based)');

  // Get all scored pools with outcome data
  const allPoolsWithOutcome = db.prepare(`
    SELECT
      dp.id,
      dp.dp_final_score as score,
      dp.security_passed,
      dp.dp_hhi_penalty,
      dp.dp_concentrated_penalty,
      dp.rejection_reasons as reasons,
      latest.latest_mcap,
      peak.max_mcap,
      peak.max_liq,
      p.pnl_sol,
      p.exit_reason
    FROM detected_pools dp
    LEFT JOIN (
      SELECT poc1.pool_id, poc1.market_cap as latest_mcap
      FROM pool_outcome_checks poc1
      INNER JOIN (
        SELECT pool_id, MAX(delay_minutes) as max_delay
        FROM pool_outcome_checks GROUP BY pool_id
      ) poc2 ON poc1.pool_id = poc2.pool_id AND poc1.delay_minutes = poc2.max_delay
    ) latest ON latest.pool_id = dp.id
    LEFT JOIN (
      SELECT pool_id, MAX(COALESCE(market_cap, 0)) as max_mcap, MAX(COALESCE(liquidity_usd, 0)) as max_liq
      FROM pool_outcome_checks GROUP BY pool_id
    ) peak ON peak.pool_id = dp.id
    LEFT JOIN positions p ON p.pool_id = dp.id AND p.status IN ('stopped', 'closed')
    WHERE ${versionWhereDP('dp.bot_version')}
      AND dp.dp_final_score IS NOT NULL
    GROUP BY dp.id
  `).all();

  function simGetMcap(r) {
    if (r.latest_mcap != null && r.latest_mcap > 0) return r.latest_mcap;
    if (r.max_mcap != null && r.max_mcap > 0) return r.max_mcap;
    if (r.max_liq != null && r.max_liq > 0) return r.max_liq;
    return 0;
  }

  const poolsForSim = allPoolsWithOutcome.filter(p => simGetMcap(p) > 0 || p.pnl_sol != null);

  function simulate(label, filterFn) {
    const wouldPass = poolsForSim.filter(filterFn);
    const newTrades = wouldPass.filter(p => p.security_passed !== 1);

    // Exclude killshot reasons that wouldn't change with threshold
    const killshots = ['token_2022', 'freeze_auth', 'deployer_blacklisted', 'deployer_rate_limit'];
    const nonKillshot = newTrades.filter(p => {
      const reasons = (p.reasons || '').split(',');
      return !reasons.some(r => killshots.includes(r.trim()));
    });

    const strong = nonKillshot.filter(p => simGetMcap(p) >= STRONG).length;
    const ok = nonKillshot.filter(p => simGetMcap(p) >= OK && simGetMcap(p) < STRONG).length;
    const weak = nonKillshot.filter(p => simGetMcap(p) >= WEAK && simGetMcap(p) < OK).length;
    const dying = nonKillshot.filter(p => simGetMcap(p) < WEAK).length;

    console.log(`\n  ${label}:`);
    console.log(`    New non-killshot trades: ${nonKillshot.length}`);
    if (nonKillshot.length > 0) {
      console.log(`    Strong ($50K+): ${strong} (${Math.round((strong / nonKillshot.length) * 100)}%)`);
      console.log(`    OK ($20-50K):   ${ok} (${Math.round((ok / nonKillshot.length) * 100)}%)`);
      console.log(`    Weak ($5-20K):  ${weak} (${Math.round((weak / nonKillshot.length) * 100)}%)`);
      console.log(`    Dying (<$5K):   ${dying} (${Math.round((dying / nonKillshot.length) * 100)}%)`);
    }
  }

  simulate('Threshold 75 → 70', p => p.score >= 70);
  simulate('Threshold 75 → 65', p => p.score >= 65);
  simulate('Remove HHI+Concentrated (keep 75)', p => {
    const adj = p.score - (p.dp_hhi_penalty || 0) - (p.dp_concentrated_penalty || 0);
    return adj >= 75;
  });
  simulate('Remove HHI+Conc + threshold 70', p => {
    const adj = p.score - (p.dp_hhi_penalty || 0) - (p.dp_concentrated_penalty || 0);
    return adj >= 70;
  });

  // ─── Summary & Caveats ───
  subheader('Summary & Caveats');
  const totalChecked = rejectedWithChecks.length;
  const totalStrong = rejectedWithChecks.filter(r => getMcap(r) >= STRONG).length;
  const totalDying = rejectedWithChecks.filter(r => getMcap(r) < WEAK).length;
  console.log(`  Rejected pools with outcome data: ${totalChecked} / ${allRejectedWithOutcome.length}`);
  console.log(`  Strong ($50K+ mcap at last check): ${totalStrong} (${totalChecked > 0 ? Math.round((totalStrong / totalChecked) * 100) : 0}%)`);
  console.log(`  Dying (<$5K mcap at last check):   ${totalDying} (${totalChecked > 0 ? Math.round((totalDying / totalChecked) * 100) : 0}%)`);
  console.log(`  Bought positions: ${boughtPositions.length}`);
  const boughtStrong = boughtPositions.filter(p => getMcap(p) >= STRONG).length;
  if (boughtPositions.length > 0) {
    console.log(`  Bought strong ($50K+): ${boughtStrong} (${Math.round((boughtStrong / boughtPositions.length) * 100)}%)`);
    const boughtProfit = boughtPositions.filter(p => p.pnl_sol > 0).length;
    console.log(`  Bought profitable: ${boughtProfit} (${Math.round((boughtProfit / boughtPositions.length) * 100)}%)`);
  }
  console.log(`\n  CAVEATS:`);
  console.log(`  1. mcap at 1h check != bot would have profited (bot needs +8% in 12min)`);
  console.log(`  2. ${rejectedNoChecks.length} rejected pools have NO outcome data (selection bias)`);
  console.log(`  3. DexScreener liquidity_usd = 0 for many PumpSwap pools (using mcap instead)`);
  console.log(`  4. Outcome checks at 5/15/30/60 min — misses tokens that pump-and-dump in <5min`);
}

db.close();
console.log('\n');
