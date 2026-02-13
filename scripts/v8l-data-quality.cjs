const db = require('better-sqlite3')('data/bot.db');

// Check if v8l features are actually affecting scoring
console.log('=== v8l SCORING IMPACT ===');

// 1. Are ANY tokens being blocked by graduation timing?
const gradBlocked = db.prepare(`
  SELECT dp_graduation_time_s, COUNT(*) as n
  FROM detected_pools
  WHERE dp_graduation_time_s IS NOT NULL
  GROUP BY CASE
    WHEN dp_graduation_time_s < 300 THEN '<5min'
    WHEN dp_graduation_time_s < 2700 THEN '5-45min'
    ELSE '>45min'
  END
`).all();
console.log('Graduation time distribution:');
gradBlocked.forEach(r => console.log(`  ${r.dp_graduation_time_s}s (${Math.round(r.dp_graduation_time_s / 60)}min): ${r.n} pools`));

// Better query - group by ranges
const gradRanges = db.prepare(`
  SELECT
    CASE
      WHEN dp_graduation_time_s < 60 THEN '<1min'
      WHEN dp_graduation_time_s < 300 THEN '1-5min'
      WHEN dp_graduation_time_s < 2700 THEN '5-45min'
      ELSE '>45min'
    END as range,
    COUNT(*) as n,
    ROUND(AVG(dp_graduation_time_s), 0) as avg_time
  FROM detected_pools
  WHERE dp_graduation_time_s IS NOT NULL AND dp_graduation_time_s > 0
  GROUP BY range ORDER BY avg_time
`).all();
console.log('\nGraduation time ranges:');
gradRanges.forEach(r => console.log(`  ${r.range}: ${r.n} pools (avg ${r.avg_time}s)`));

// 2. Are ANY tokens being blocked by insiders?
const insidersBlocked = db.prepare(`
  SELECT dp_insiders_count, COUNT(*) as n
  FROM detected_pools
  WHERE dp_insiders_count IS NOT NULL
  GROUP BY dp_insiders_count
  ORDER BY dp_insiders_count
`).all();
console.log('\nInsiders count distribution:');
insidersBlocked.forEach(r => console.log(`  ${r.dp_insiders_count} insiders: ${r.n} pools`));

// 3. Check token_analysis for score breakdown of recently analyzed tokens
const scoreBreakdown = db.prepare(`
  SELECT
    CASE
      WHEN score < 40 THEN '<40'
      WHEN score < 60 THEN '40-59'
      WHEN score < 70 THEN '60-69'
      WHEN score < 75 THEN '70-74'
      WHEN score < 80 THEN '75-79'
      WHEN score < 85 THEN '80-84'
      ELSE '85+'
    END as band,
    COUNT(*) as n
  FROM token_analysis
  WHERE id IN (SELECT MAX(id) FROM token_analysis GROUP BY token_mint)
    AND id > (SELECT MAX(id) - 500 FROM token_analysis)
  GROUP BY band ORDER BY band
`).all();
console.log('\nScore distribution (last 500 analyses):');
scoreBreakdown.forEach(r => console.log(`  Score ${r.band}: ${r.n} tokens`));

// 4. Check for 429 error patterns
console.log('\n=== 429 ERROR PATTERN ===');
const errors429 = db.prepare(`
  SELECT
    CASE
      WHEN sell_attempts <= 2 THEN 'normal (<=2)'
      WHEN sell_attempts <= 6 THEN 'elevated (3-6)'
      WHEN sell_attempts <= 10 THEN 'high (7-10)'
      ELSE 'leaked (>10)'
    END as category,
    COUNT(*) as n,
    GROUP_CONCAT(exit_reason) as reasons
  FROM positions
  WHERE status IN ('closed','stopped') AND sell_attempts > 0
  GROUP BY category ORDER BY MIN(sell_attempts)
`).all();
errors429.forEach(r => console.log(`  ${r.category}: ${r.n} positions`));

// 5. What % of detected pools become trades?
const conversionRate = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM detected_pools WHERE detected_at > ?) as detected,
    (SELECT COUNT(*) FROM positions WHERE opened_at > ?) as traded
`).get(Date.now() - 24 * 3600000, Date.now() - 24 * 3600000);
console.log(`\n=== CONVERSION RATE (24h) ===`);
console.log(`Detected: ${conversionRate.detected}, Traded: ${conversionRate.traded}`);
console.log(`Rate: ${(conversionRate.traded / conversionRate.detected * 100).toFixed(1)}%`);

// 6. Missed gains - what we left on the table
console.log('\n=== MISSED GAINS (recent sells) ===');
try {
  const missed = db.prepare(`
    SELECT substr(p.token_mint,1,8) as tok,
      ROUND(p.pnl_pct, 1) as our_pnl,
      p.exit_reason,
      mg.gecko_1h_mult, mg.gecko_4h_mult, mg.gecko_24h_mult,
      mg.dex_24h_change_pct, mg.dex_volume_usd, mg.dex_fdv_usd
    FROM positions p
    LEFT JOIN missed_gains mg ON p.token_mint = mg.token_mint
    WHERE p.status IN ('closed','stopped') AND p.pnl_sol > 0
      AND p.opened_at > ?
    ORDER BY p.opened_at DESC LIMIT 10
  `).all(Date.now() - 24 * 3600000);
  missed.forEach(r => {
    const afterSell = r.gecko_1h_mult ? `gecko1h=${r.gecko_1h_mult}x` : '';
    const dex = r.dex_24h_change_pct ? `dex24h=${r.dex_24h_change_pct}%` : '';
    console.log(`  ${r.tok} | our: ${r.our_pnl}% | ${r.exit_reason} | ${afterSell} ${dex} vol=$${r.dex_volume_usd} fdv=$${r.dex_fdv_usd}`);
  });
} catch(e) {
  console.log('Missed gains table not found:', e.message.slice(0, 60));
}

db.close();
