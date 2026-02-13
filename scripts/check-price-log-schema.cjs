const Database = require('better-sqlite3');
const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%price%'").all();
console.log('Price-related tables:', tables);

if (tables.length > 0) {
  tables.forEach(t => {
    console.log(`\nSchema for ${t.name}:`);
    const schema = db.prepare(`PRAGMA table_info(${t.name})`).all();
    schema.forEach(col => {
      console.log(`  ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}${col.pk ? ' PRIMARY KEY' : ''}`);
    });

    const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${t.name}`).get();
    console.log(`  Rows: ${count.cnt}`);
  });
}

db.close();
