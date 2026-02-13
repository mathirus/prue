const fs = require('fs');

const analysisFile = 'C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/analysis/pool-patterns-analysis.json';
const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
const outputDir = 'C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/analysis';

// Helper: generar barra ASCII
function bar(value, maxValue, width = 40) {
  const filled = Math.round((value / maxValue) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// HTML template
let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Pool Patterns Analysis</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 1400px; margin: 20px auto; padding: 20px; background: #f5f5f5; }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 40px; background: #ecf0f1; padding: 10px; border-left: 4px solid #3498db; }
    .chart { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .bar { height: 30px; background: linear-gradient(90deg, #3498db, #2980b9); margin: 5px 0; border-radius: 4px; display: flex; align-items: center; padding-left: 10px; color: white; font-weight: bold; }
    .label { display: inline-block; width: 120px; font-weight: bold; }
    .value { color: #e74c3c; font-weight: bold; }
    .finding { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
    .actionable-high { background: #d4edda; border-left: 4px solid #28a745; }
    .actionable-medium { background: #fff3cd; border-left: 4px solid #ffc107; }
    .actionable-low { background: #f8d7da; border-left: 4px solid #dc3545; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; background: white; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #3498db; color: white; }
    tr:hover { background: #f5f5f5; }
    .meta { color: #7f8c8d; font-size: 0.9em; }
    .highlight { background: #ffffcc; font-weight: bold; }
  </style>
</head>
<body>
  <h1>📊 Pool Patterns Analysis</h1>
  <p class="meta">Generated: ${analysis.timestamp} | Total pools analyzed: 9,844</p>
`;

console.log('=== GENERANDO VISUALIZACIONES ===\n');

// ============================================================================
// 1. HORA DEL DÍA
// ============================================================================
const hourly = analysis.analyses.find(a => a.question === '1. Hora del día');
const hourlyData = hourly.data;
const maxHourlyPools = Math.max(...hourlyData.map(h => h.total_pools));

html += `
  <h2>1. Hora del día (UTC) - Rug Rate por Hora</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Hora UTC</th><th>Total Pools</th><th>Rugs</th><th>Rug %</th><th>Visual</th></tr>
      </thead>
      <tbody>
`;

hourlyData.forEach(h => {
  const barWidth = (h.total_pools / maxHourlyPools) * 100;
  const color = h.rug_pct > 3 ? '#e74c3c' : h.rug_pct > 1.5 ? '#f39c12' : '#27ae60';
  html += `
        <tr style="${h.rug_pct > 3 ? 'background: #fee;' : ''}">
          <td>${h.hour_utc}:00</td>
          <td>${h.total_pools}</td>
          <td>${h.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${h.rug_pct}%</td>
          <td><div class="bar" style="width: ${barWidth}%; background: ${color};">&nbsp;</div></td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${hourly.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${hourly.finding}<br>
      <strong>N:</strong> ${hourly.n} | <strong>Confidence:</strong> ${hourly.confidence} | <strong>Actionable:</strong> ${hourly.actionable}
    </div>
  </div>
`;

console.log('✅ Hora del día visualizado');

// ============================================================================
// 2. POOL SIZE
// ============================================================================
const poolSize = analysis.analyses.find(a => a.question === '2. Pool size sweet spot');
const liquidityData = poolSize.data.liquidity;
const shadowLiqData = poolSize.data.shadow;

html += `
  <h2>2. Pool Size Sweet Spot - Liquidez vs Rug Rate</h2>
  <div class="chart">
    <h3>Detected Pools por Rango de Liquidez</h3>
    <table>
      <thead>
        <tr><th>Rango Liquidez</th><th>Total Pools</th><th>Rugs</th><th>Rug %</th><th>Avg Liquidity USD</th></tr>
      </thead>
      <tbody>
`;

liquidityData.forEach(l => {
  const color = l.rug_pct > 2 ? '#e74c3c' : l.rug_pct > 0.5 ? '#f39c12' : '#27ae60';
  html += `
        <tr class="${l.rug_pct === 0 ? 'highlight' : ''}">
          <td><strong>${l.liq_range}</strong></td>
          <td>${l.total_pools}</td>
          <td>${l.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${l.rug_pct}%</td>
          <td>$${l.avg_liq.toLocaleString()}</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>

    <h3>Shadow Positions - Peak Multiplier por Reserve</h3>
    <table>
      <thead>
        <tr><th>Reserve Range</th><th>Total</th><th>Rugs</th><th>Avg Peak</th><th>Max Peak</th><th>Avg Peak (No Rug)</th></tr>
      </thead>
      <tbody>
`;

shadowLiqData.forEach(s => {
  html += `
        <tr>
          <td><strong>${s.reserve_range}</strong></td>
          <td>${s.total}</td>
          <td>${s.rugs}</td>
          <td>${s.avg_peak}x</td>
          <td style="color: #27ae60; font-weight: bold;">${s.max_peak}x</td>
          <td style="color: #3498db; font-weight: bold;">${s.avg_peak_no_rug || 'N/A'}x</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${poolSize.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${poolSize.finding}<br>
      <strong>N:</strong> ${poolSize.n} | <strong>Confidence:</strong> ${poolSize.confidence} | <strong>Actionable:</strong> ${poolSize.actionable}
    </div>
  </div>
`;

console.log('✅ Pool size visualizado');

// ============================================================================
// 3. GRADUATION TIME
// ============================================================================
const gradTime = analysis.analyses.find(a => a.question === '3. Graduation time');
const gradData = gradTime.data;

html += `
  <h2>3. Graduation Time - Correlación con Rug Rate</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Grad Time Range</th><th>Total Pools</th><th>Rugs</th><th>Rug %</th><th>Avg Time (s)</th></tr>
      </thead>
      <tbody>
`;

gradData.forEach(g => {
  const color = g.rug_pct > 5 ? '#e74c3c' : g.rug_pct > 1 ? '#f39c12' : '#27ae60';
  html += `
        <tr class="${g.rug_pct === 0 ? 'highlight' : ''}">
          <td><strong>${g.grad_time_range}</strong></td>
          <td>${g.total_pools}</td>
          <td>${g.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${g.rug_pct}%</td>
          <td>${g.avg_time_s.toLocaleString()} (${Math.round(g.avg_time_s / 60)} min)</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${gradTime.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${gradTime.finding}<br>
      <strong>N:</strong> ${gradTime.n} | <strong>Confidence:</strong> ${gradTime.confidence} | <strong>Actionable:</strong> ${gradTime.actionable}
    </div>
  </div>
`;

console.log('✅ Graduation time visualizado');

// ============================================================================
// 4. HOLDER COUNT
// ============================================================================
const holderCount = analysis.analyses.find(a => a.question === '4. Holder count óptimo');
const holderData = holderCount.data;

html += `
  <h2>4. Holder Count Óptimo</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Holder Range</th><th>Total Pools</th><th>Rugs</th><th>Rug %</th><th>Avg Holders</th></tr>
      </thead>
      <tbody>
`;

holderData.forEach(h => {
  const color = h.rug_pct > 2 ? '#e74c3c' : h.rug_pct > 0.5 ? '#f39c12' : '#27ae60';
  html += `
        <tr class="${h.rug_pct < 0.5 ? 'highlight' : ''}">
          <td><strong>${h.holder_range}</strong></td>
          <td>${h.total_pools}</td>
          <td>${h.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${h.rug_pct}%</td>
          <td>${h.avg_holders}</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${holderCount.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${holderCount.finding}<br>
      <strong>N:</strong> ${holderCount.n} | <strong>Confidence:</strong> ${holderCount.confidence} | <strong>Actionable:</strong> ${holderCount.actionable}
    </div>
  </div>
`;

console.log('✅ Holder count visualizado');

// ============================================================================
// 5. RESERVE ÓPTIMA
// ============================================================================
const reserve = analysis.analyses.find(a => a.question === '5. Reserve óptima');
const reserveData = reserve.data;

html += `
  <h2>5. Reserve Óptima - Peak Multiplier vs Rug Rate</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Reserve Range</th><th>Total</th><th>Rugs</th><th>Rug %</th><th>Avg Peak</th><th>Avg Peak (No Rug)</th><th>Max Peak</th></tr>
      </thead>
      <tbody>
`;

reserveData.forEach(r => {
  const color = r.rug_pct > 30 ? '#e74c3c' : r.rug_pct > 15 ? '#f39c12' : '#27ae60';
  html += `
        <tr class="${r.avg_peak_no_rug > 2 ? 'highlight' : ''}">
          <td><strong>${r.reserve_range}</strong></td>
          <td>${r.total}</td>
          <td>${r.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${r.rug_pct}%</td>
          <td>${r.avg_peak}x</td>
          <td style="color: #3498db; font-weight: bold;">${r.avg_peak_no_rug || 'N/A'}x</td>
          <td style="color: #27ae60; font-weight: bold;">${r.max_peak}x</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${reserve.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${reserve.finding}<br>
      <strong>N:</strong> ${reserve.n} | <strong>Confidence:</strong> ${reserve.confidence} | <strong>Actionable:</strong> ${reserve.actionable}
    </div>
  </div>
`;

console.log('✅ Reserve óptima visualizado');

// ============================================================================
// 6. EVOLUCIÓN POST-DETECCIÓN
// ============================================================================
const evolution = analysis.analyses.find(a => a.question === '6. Evolución post-detección');
const evolutionData = evolution.data;

html += `
  <h2>6. Evolución Post-Detección (Liquidez a 5/15/30/60 min)</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Outcome</th><th>Liq @ 5min</th><th>Liq @ 15min</th><th>Liq @ 30min</th><th>Liq @ 60min</th><th>Pools Checked</th></tr>
      </thead>
      <tbody>
`;

evolutionData.forEach(e => {
  html += `
        <tr>
          <td><strong>${e.pool_outcome}</strong></td>
          <td>$${e.liq_5min?.toLocaleString() || 'N/A'}</td>
          <td>$${e.liq_15min?.toLocaleString() || 'N/A'}</td>
          <td>$${e.liq_30min?.toLocaleString() || 'N/A'}</td>
          <td>$${e.liq_60min?.toLocaleString() || 'N/A'}</td>
          <td>${e.pools_checked}</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${evolution.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${evolution.finding}<br>
      <strong>N:</strong> ${evolution.n} | <strong>Confidence:</strong> ${evolution.confidence} | <strong>Actionable:</strong> ${evolution.actionable}
    </div>
  </div>
`;

console.log('✅ Evolución post-detección visualizado');

// ============================================================================
// 7. CREATOR REPUTATION
// ============================================================================
const reputation = analysis.analyses.find(a => a.question === '7. Creator reputation');
const reputationData = reputation.data;

html += `
  <h2>7. Creator Reputation - Predice Outcomes?</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Reputation Range</th><th>Total Pools</th><th>Rugs</th><th>Rug %</th><th>Avg Reputation</th></tr>
      </thead>
      <tbody>
`;

reputationData.forEach(r => {
  const color = r.rug_pct > 0 ? '#e74c3c' : '#27ae60';
  html += `
        <tr class="${r.rug_pct === 0 ? 'highlight' : ''}">
          <td><strong>${r.reputation_range}</strong></td>
          <td>${r.total_pools}</td>
          <td>${r.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${r.rug_pct}%</td>
          <td>${r.avg_reputation}</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${reputation.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${reputation.finding}<br>
      <strong>N:</strong> ${reputation.n} | <strong>Confidence:</strong> ${reputation.confidence} | <strong>Actionable:</strong> ${reputation.actionable}
      <p><strong>⚠️ IMPORTANTE:</strong> Rug rate 0% en TODOS los rangos puede indicar: (1) Datos insuficientes de rugs con reputation tracked, (2) Reputation tracking comenzó tarde (post-rugs), o (3) Reputation NO es predictiva.</p>
    </div>
  </div>
`;

console.log('✅ Creator reputation visualizado');

// ============================================================================
// 8. BONUS: SECURITY SCORE
// ============================================================================
const score = analysis.analyses.find(a => a.question === '8. BONUS: Security score vs outcomes');
const scoreData = score.data;

html += `
  <h2>8. BONUS: Security Score vs Outcomes (Score Paradox)</h2>
  <div class="chart">
    <table>
      <thead>
        <tr><th>Score Range</th><th>Total Pools</th><th>Rugs</th><th>Rug %</th><th>Avg Score</th></tr>
      </thead>
      <tbody>
`;

scoreData.forEach(s => {
  const color = s.rug_pct > 3 ? '#e74c3c' : s.rug_pct > 1 ? '#f39c12' : '#27ae60';
  html += `
        <tr class="${s.rug_pct > 4 ? 'highlight' : ''}">
          <td><strong>${s.score_range}</strong></td>
          <td>${s.total_pools}</td>
          <td>${s.rugs}</td>
          <td style="color: ${color}; font-weight: bold;">${s.rug_pct}%</td>
          <td>${s.avg_score}</td>
        </tr>
  `;
});

html += `
      </tbody>
    </table>
    <div class="finding actionable-${score.actionable.toLowerCase()}">
      <strong>Finding:</strong> ${score.finding}<br>
      <strong>N:</strong> ${score.n} | <strong>Confidence:</strong> ${score.confidence} | <strong>Actionable:</strong> ${score.actionable}
      <p><strong>⚠️ PARADOJA CONFIRMADA:</strong> Score 75-79 tiene MAYOR rug rate (4.16%) que Score 85+ (0.97%). Scammers optimizan para pasar checks altos.</p>
    </div>
  </div>
`;

console.log('✅ Security score visualizado');

// ============================================================================
// SUMMARY
// ============================================================================
html += `
  <h2>📌 Summary & Actionable Insights</h2>
  <div class="chart">
    <h3>Top Actionable Findings (Confidence MEDIUM+)</h3>
    <ul>
`;

const actionableFindings = analysis.analyses
  .filter(a => a.actionable !== 'LOW' && a.confidence !== 'LOW')
  .sort((a, b) => {
    const priorityMap = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    return priorityMap[b.actionable] - priorityMap[a.actionable];
  });

actionableFindings.forEach(a => {
  html += `<li><strong>${a.question}</strong>: ${a.finding} (N=${a.n}, Confidence=${a.confidence}, Actionable=${a.actionable})</li>`;
});

html += `
    </ul>

    <h3>Key Takeaways</h3>
    <ol>
      <li><strong>Liquidez 5K-10K USD = sweet spot</strong>: 0.02% rug rate (N=4633), vs 3.65% en &lt;5K.</li>
      <li><strong>Score 75-79 tiene MAYOR rug rate</strong> (4.16%) que score 85+ (0.97%). No confiar ciegamente en score alto.</li>
      <li><strong>Holders &lt;10 = óptimo</strong>: 0.14% rug rate, pero sample pequeño (tokens muy nuevos).</li>
      <li><strong>Graduation time paradox</strong>: &lt;5min = 0.33% rug, 60min+ = 14.12% rug. Tokens que tardan mucho en graduarse tienden a ser rugs lentos.</li>
      <li><strong>Creator reputation NO es predictiva</strong> en data actual (rug rate = 0% en todos los rangos, probablemente datos insuficientes).</li>
      <li><strong>Reserve 80-100 SOL = mejor peak multiplier</strong> (2.06x avg no-rug) con rug rate moderado (14.29%).</li>
      <li><strong>Horas peligrosas (UTC)</strong>: 16:00 (4.6% rug), 3:00 (4.05%), 21:00 (3.8%). Horas seguras: 8:00 (0.3%), 1:00 (0.35%), 19:00 (0.42%).</li>
    </ol>

    <h3>Próximos Pasos</h3>
    <ul>
      <li>Implementar filtro de liquidez: solo comprar pools con liq 5K-50K USD (rug rate cercano a 0%).</li>
      <li>Ajustar scoring: dar menos peso a score alto (scammers ganan esa batalla).</li>
      <li>Evitar graduations lentas (60min+): posible indicador de rug coordinado.</li>
      <li>Recolectar más datos de rugs con creator reputation tracked para validar feature.</li>
      <li>Considerar time-of-day weighting: +bonus en horas seguras, -penalty en horas peligrosas.</li>
    </ul>
  </div>
`;

html += `
</body>
</html>
`;

// Guardar HTML
const htmlPath = `${outputDir}/pool-patterns-report.html`;
fs.writeFileSync(htmlPath, html);

console.log(`\n✅ Reporte HTML generado: ${htmlPath}`);
console.log('\n=== ANÁLISIS COMPLETADO ===');
