const db = require('better-sqlite3')('data/bot.db');
const rows = db.prepare("SELECT token_mint, security_score, exit_reason, pnl_pct, bot_version, holder_count FROM positions ORDER BY opened_at DESC LIMIT 30").all();
rows.forEach(r => {
  const token = (r.token_mint || '').slice(0, 8);
  const win = r.pnl_pct > 0 ? 'WIN' : (r.exit_reason||'').includes('rug') ? 'RUG' : 'LOSS';
  console.log(`${token} score=${r.security_score} ${win} pnl=${(r.pnl_pct||0).toFixed(1)}% holders=${r.holder_count||'?'} exit=${r.exit_reason} ver=${r.bot_version}`);
});
