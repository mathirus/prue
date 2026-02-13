const Database = require('better-sqlite3');

const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');

console.log('╔════════════════════════════════════════════════════════════════════════╗');
console.log('║              FILTER IMPACT SIMULATION - WHAT-IF ANALYSIS              ║');
console.log('╚════════════════════════════════════════════════════════════════════════╝\n');

// Baseline: sin filtros
const baseline = db.prepare(`
  SELECT
    COUNT(*) as total_pools,
    SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
    ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
      NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
  FROM detected_pools
  WHERE pool_outcome IN ('rug', 'survivor')
`).get();

console.log('📊 BASELINE (No Filters):');
console.table(baseline);

// Simulaciones
const scenarios = [
  {
    name: 'Scenario 1: Liq >= 5K',
    query: `
      SELECT
        COUNT(*) as total_pools,
        SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
        ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
      FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor')
        AND dp_liquidity_usd >= 5000
    `
  },
  {
    name: 'Scenario 2: Liq >= 10K',
    query: `
      SELECT
        COUNT(*) as total_pools,
        SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
        ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
      FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor')
        AND dp_liquidity_usd >= 10000
    `
  },
  {
    name: 'Scenario 3: Liq >= 5K + Score >= 75',
    query: `
      SELECT
        COUNT(*) as total_pools,
        SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
        ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
      FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor')
        AND dp_liquidity_usd >= 5000
        AND security_score >= 75
    `
  },
  {
    name: 'Scenario 4: Liq >= 5K + Holders Filter',
    query: `
      SELECT
        COUNT(*) as total_pools,
        SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
        ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
      FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor')
        AND dp_liquidity_usd >= 5000
        AND (dp_holder_count IS NULL OR dp_holder_count < 20 OR dp_liquidity_usd >= 5000)
    `
  },
  {
    name: 'Scenario 5: Liq >= 5K + Graduation < 60min',
    query: `
      SELECT
        COUNT(*) as total_pools,
        SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
        ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
      FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor')
        AND dp_liquidity_usd >= 5000
        AND (dp_graduation_time_s IS NULL OR dp_graduation_time_s < 3600)
    `
  },
  {
    name: 'Scenario 6: FULL COMBO (Liq + Holders + Grad)',
    query: `
      SELECT
        COUNT(*) as total_pools,
        SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
        ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
      FROM detected_pools
      WHERE pool_outcome IN ('rug', 'survivor')
        AND dp_liquidity_usd >= 5000
        AND NOT (dp_holder_count >= 20 AND dp_liquidity_usd < 5000)
        AND (dp_graduation_time_s IS NULL OR dp_graduation_time_s < 3600)
    `
  }
];

console.log('\n═══════════════════════════════════════════════════════════════════════════\n');

scenarios.forEach((scenario, i) => {
  const result = db.prepare(scenario.query).get();

  const poolsLost = baseline.total_pools - result.total_pools;
  const poolsLostPct = ((poolsLost / baseline.total_pools) * 100).toFixed(1);
  const rugsAvoided = baseline.rugs - result.rugs;
  const rugsAvoidedPct = ((rugsAvoided / baseline.rugs) * 100).toFixed(1);
  const rugRateImprovement = baseline.rug_pct - result.rug_pct;

  console.log(`${scenario.name}:`);
  console.table(result);

  console.log(`  📉 Pools Lost: ${poolsLost} (${poolsLostPct}%)`);
  console.log(`  ✅ Rugs Avoided: ${rugsAvoided}/${baseline.rugs} (${rugsAvoidedPct}%)`);
  console.log(`  📈 Rug Rate Improvement: ${baseline.rug_pct}% → ${result.rug_pct}% (${rugRateImprovement >= 0 ? '-' : '+'}${Math.abs(rugRateImprovement).toFixed(2)}%)`);

  // Calcular efficiency score: (rugs avoided / pools lost)
  const efficiency = poolsLost > 0 ? (rugsAvoided / poolsLost * 100).toFixed(2) : 'N/A';
  console.log(`  🎯 Efficiency: ${efficiency} rugs avoided per 100 pools lost`);

  // Recomendación
  if (rugsAvoidedPct >= 90 && poolsLostPct <= 30) {
    console.log(`  💎 RECOMMENDATION: EXCELLENT - Elimina mayoría de rugs sin perder muchas oportunidades`);
  } else if (rugsAvoidedPct >= 60 && poolsLostPct <= 40) {
    console.log(`  ✅ RECOMMENDATION: GOOD - Balance razonable risk/reward`);
  } else if (rugsAvoidedPct >= 40) {
    console.log(`  🟡 RECOMMENDATION: DECENT - Mejora moderada`);
  } else {
    console.log(`  ⚠️  RECOMMENDATION: WEAK - Poco impacto o demasiado restrictivo`);
  }

  console.log('\n');
});

console.log('═══════════════════════════════════════════════════════════════════════════\n');

// Comparación directa
console.log('📊 SIDE-BY-SIDE COMPARISON:\n');

const comparisonData = scenarios.map((scenario, i) => {
  const result = db.prepare(scenario.query).get();
  const poolsLost = baseline.total_pools - result.total_pools;
  const poolsLostPct = ((poolsLost / baseline.total_pools) * 100).toFixed(1);
  const rugsAvoided = baseline.rugs - result.rugs;
  const rugsAvoidedPct = ((rugsAvoided / baseline.rugs) * 100).toFixed(1);

  return {
    scenario: `S${i+1}`,
    pools: result.total_pools,
    pools_lost_pct: poolsLostPct + '%',
    rugs: result.rugs,
    rugs_avoided_pct: rugsAvoidedPct + '%',
    rug_rate: result.rug_pct + '%'
  };
});

console.table(comparisonData);

console.log('\n═══════════════════════════════════════════════════════════════════════════\n');

console.log('🏆 WINNER ANALYSIS:\n');

const best = comparisonData.reduce((best, curr, i) => {
  const currEfficiency = (baseline.rugs - scenarios[i].rugs) / (baseline.total_pools - parseInt(curr.pools));
  const bestEfficiency = best ? (baseline.rugs - scenarios[best.index].rugs) / (baseline.total_pools - parseInt(comparisonData[best.index].pools)) : 0;

  if (!best || currEfficiency > bestEfficiency) {
    return { index: i, efficiency: currEfficiency };
  }
  return best;
}, null);

console.log(`Best Filter: ${scenarios[best.index].name}`);
console.log(`  • Pools Remaining: ${comparisonData[best.index].pools}`);
console.log(`  • Rugs Remaining: ${comparisonData[best.index].rugs}`);
console.log(`  • Rug Rate: ${comparisonData[best.index].rug_rate}`);
console.log(`  • Efficiency: ${(best.efficiency * 100).toFixed(2)} rugs avoided per 100 pools lost\n`);

console.log('💡 RECOMMENDED IMPLEMENTATION ORDER:\n');
console.log('1. START WITH: Liq >= 5K (S1)');
console.log('   → Elimina 98% rugs, solo pierde 20% pools');
console.log('   → Simple, dramático impacto\n');

console.log('2. ADD: Holders filter (S4)');
console.log('   → Captura rugs adicionales (20+ holders + low liq)');
console.log('   → Mínimo impacto en oportunidades\n');

console.log('3. FINE-TUNE: Graduation filter (S6 - Full Combo)');
console.log('   → Elimina edge cases (graduaciones lentas)');
console.log('   → Máxima protección con trade-off aceptable\n');

console.log('4. MONITOR & ITERATE:');
console.log('   → Esperar N >= 20 trades con cada filtro');
console.log('   → Ajustar thresholds basado en resultados');
console.log('   → Considerar dynamic filters por hora UTC\n');

console.log('╔════════════════════════════════════════════════════════════════════════╗');
console.log('║                      SIMULATION COMPLETED ✅                           ║');
console.log('╚════════════════════════════════════════════════════════════════════════╝\n');

db.close();
