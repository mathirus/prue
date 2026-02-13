#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

async function fetchDex(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.pairs || !d.pairs.length) return { alive: false };
    const p = d.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      alive: true,
      priceUsd: parseFloat(p.priceUsd || 0),
      liqUsd: p.liquidity?.usd || 0,
      fdv: p.fdv || 0,
      vol24h: p.volume?.h24 || 0,
      chg5m: p.priceChange?.m5 || 0,
      chg1h: p.priceChange?.h1 || 0,
      buys5m: p.txns?.m5?.buys || 0,
      sells5m: p.txns?.m5?.sells || 0,
    };
  } catch { return null; }
}

async function main() {
  const now = Date.now();
  const cutoff = now - 30 * 60 * 1000; // last 30 min

  // All detected in last 30 min
  const all = db.prepare(`
    SELECT base_mint, pool_address, security_score, security_passed,
      dp_rejection_stage, rejection_reasons, dp_liquidity_usd,
      dp_holder_count, dp_top_holder_pct, dp_graduation_time_s,
      dp_creator_reputation, dp_observation_stable, dp_observation_drop_pct,
      pool_outcome, detected_at
    FROM detected_pools WHERE detected_at > ? AND base_mint IS NOT NULL
    ORDER BY detected_at DESC
  `).all(cutoff);

  // Bought in last 2h
  const bought = db.prepare(`
    SELECT p.token_mint, p.pool_address, p.security_score, p.pnl_sol, p.pnl_pct,
      p.exit_reason, p.peak_multiplier, p.status, p.opened_at
    FROM positions p WHERE p.opened_at > ? ORDER BY p.opened_at DESC
  `).all(now - 2 * 3600 * 1000);

  const boughtMints = new Set(bought.map(b => b.token_mint));

  console.log(`Tokens detected (30min): ${all.length}`);
  console.log(`Positions opened (2h): ${bought.length}\n`);

  // Check prices
  const results = [];
  for (const t of all) {
    const price = await fetchDex(t.base_mint);
    const ageMin = ((now - t.detected_at) / 60000).toFixed(1);
    const wasBought = boughtMints.has(t.base_mint);
    const pos = bought.find(b => b.token_mint === t.base_mint);
    results.push({ ...t, price, ageMin, wasBought, pos });
    await new Promise(r => setTimeout(r, 350));
  }

  // REJECTED tokens
  console.log('='.repeat(110));
  console.log('  RECHAZADOS — ¿Deberiamos haberlos comprado?');
  console.log('='.repeat(110));

  const rejected = results.filter(r => !r.security_passed);
  let missed = 0, correctReject = 0;

  for (const r of rejected) {
    const alive = r.price && r.price.alive && r.price.liqUsd > 500;
    const liqNow = alive ? r.price.liqUsd : 0;
    const liqThen = r.dp_liquidity_usd || 0;
    const liqChange = liqThen > 0 && alive ? ((liqNow - liqThen) / liqThen * 100).toFixed(0) : '?';

    let verdict;
    if (!alive || liqNow < 500) {
      verdict = 'DEAD -> BIEN RECHAZADO';
      correctReject++;
    } else if (liqNow > liqThen * 1.5 && liqNow > 5000) {
      verdict = 'GROWING -> OPORTUNIDAD PERDIDA?';
      missed++;
    } else if (liqNow > liqThen * 0.8) {
      verdict = 'ESTABLE -> quizas perdida';
      missed++;
    } else {
      verdict = 'CAYENDO -> BIEN RECHAZADO';
      correctReject++;
    }

    const reasons = (r.rejection_reasons || '').substring(0, 70);
    const stage = (r.dp_rejection_stage || '?').padEnd(15);
    console.log(
      `${r.base_mint.substring(0, 10)}.. | s=${String(r.security_score || '?').padStart(3)} | ${stage} | ` +
      `liq: $${liqThen.toFixed(0)} -> $${liqNow.toFixed(0)} (${liqChange}%) | ` +
      `${r.ageMin}min | ${verdict}`
    );
    if (alive && liqNow > 3000) {
      console.log(`  NOW: liq=$${r.price.liqUsd.toFixed(0)}, fdv=$${r.price.fdv.toFixed(0)}, 5mChg=${r.price.chg5m}%, buys5m=${r.price.buys5m}, sells5m=${r.price.sells5m}`);
    }
    console.log(`  reasons: ${reasons}`);
    console.log('');
  }

  // PASSED/BOUGHT tokens
  console.log('='.repeat(110));
  console.log('  COMPRADOS O PASADOS — ¿Fue buena decision?');
  console.log('='.repeat(110));

  const passed = results.filter(r => r.security_passed);
  for (const r of passed) {
    const alive = r.price && r.price.alive && r.price.liqUsd > 500;
    const liqNow = alive ? r.price.liqUsd : 0;

    let verdict;
    if (r.pos) {
      verdict = r.pos.pnl_sol > 0 ? `WIN +${(r.pos.pnl_pct||0).toFixed(1)}%` :
                r.pos.exit_reason?.includes('rug') ? `RUG ${(r.pos.pnl_pct||0).toFixed(1)}%` :
                `LOSS ${(r.pos.pnl_pct||0).toFixed(1)}%`;
      verdict += ` (peak=${r.pos.peak_multiplier ? r.pos.peak_multiplier.toFixed(2) + 'x' : '?'})`;
    } else {
      verdict = 'PASSED but not bought (max_concurrent?)';
    }

    console.log(
      `${r.base_mint.substring(0, 10)}.. | s=${String(r.security_score || '?').padStart(3)} | ` +
      `nowLiq=$${liqNow.toFixed(0)} | ${r.ageMin}min | ${verdict}`
    );
    if (alive) {
      console.log(`  NOW: liq=$${r.price.liqUsd.toFixed(0)}, fdv=$${r.price.fdv.toFixed(0)}, 5mChg=${r.price.chg5m}%, buys=${r.price.buys5m}, sells=${r.price.sells5m}`);
    }
    console.log('');
  }

  console.log('='.repeat(110));
  console.log(`RESUMEN:`);
  console.log(`  Rechazados: ${rejected.length} (${correctReject} bien rechazados, ${missed} posibles oportunidades perdidas)`);
  console.log(`  Tasa acierto rechazo: ${(correctReject / Math.max(rejected.length, 1) * 100).toFixed(0)}%`);
  console.log('='.repeat(110));

  db.close();
}

main().catch(console.error);
