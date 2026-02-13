#!/usr/bin/env node
/**
 * v9m: Watchdog — Auto-restart bot on crash with exponential backoff.
 * Max 5 restarts in 10 min window, then stops + alerts.
 *
 * Usage: node scripts/watchdog.cjs
 */

const { spawn } = require('child_process');
const path = require('path');

const BOT_DIR = path.resolve(__dirname, '..');
const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const MAX_UPTIME_MS = 6 * 60 * 60 * 1000; // v11a: 6 hours (was 3h). Paid tier = less memory pressure from retry queues

let restarts = 0;
let windowStart = Date.now();
let child = null;
let uptimeTimer = null;

function sendTelegramAlert(message) {
  try {
    const dotenvPath = path.join(BOT_DIR, '.env');
    const fs = require('fs');
    const envContent = fs.readFileSync(dotenvPath, 'utf8');
    const botToken = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim();
    const chatId = envContent.match(/TELEGRAM_CHAT_ID=(.+)/)?.[1]?.trim();
    if (!botToken || !chatId) return;

    const https = require('https');
    const data = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    });
    req.write(data);
    req.end();
  } catch {
    // Best-effort — don't crash watchdog over Telegram failure
  }
}

function startBot() {
  const now = Date.now();

  // Reset window if enough time has passed
  if (now - windowStart > WINDOW_MS) {
    restarts = 0;
    windowStart = now;
  }

  if (restarts >= MAX_RESTARTS) {
    const msg = `🚨 <b>WATCHDOG STOPPED</b>: Bot crashed ${MAX_RESTARTS}+ times in 10 min. Manual intervention needed.`;
    console.error(`[watchdog] ${msg}`);
    sendTelegramAlert(msg);
    process.exit(1);
  }

  console.log(`[watchdog] Starting bot... (restart #${restarts})`);

  child = spawn('node', ['--max-old-space-size=1024', 'dist/index.js'], {
    stdio: 'inherit',
    cwd: BOT_DIR,
    env: { ...process.env, NODE_ENV: 'production' },
  });

  // v9w: Schedule preventive restart every 3h to avoid OOM (2 crashes at 507/512MB overnight)
  if (uptimeTimer) clearTimeout(uptimeTimer);
  uptimeTimer = setTimeout(() => {
    console.log(`[watchdog] Scheduled restart (${MAX_UPTIME_MS / 3600000}h uptime). Sending SIGTERM...`);
    sendTelegramAlert(`🔄 Scheduled restart (${MAX_UPTIME_MS / 3600000}h uptime). Restarting cleanly...`);
    if (child) child.kill('SIGTERM');
  }, MAX_UPTIME_MS);

  child.on('exit', (code, signal) => {
    if (uptimeTimer) { clearTimeout(uptimeTimer); uptimeTimer = null; }
    const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[watchdog] Bot exited (${exitInfo}) at ${new Date().toISOString()}`);

    // Code 0 = graceful shutdown, don't restart
    if (code === 0) {
      console.log('[watchdog] Graceful exit, not restarting.');
      return;
    }

    // v9w: SIGTERM from scheduled restart = don't count as crash, restart immediately
    const isScheduledRestart = signal === 'SIGTERM';
    if (!isScheduledRestart) {
      restarts++;
    }
    const delay = isScheduledRestart ? 3000 : Math.min(5000 * restarts, 30000);
    console.log(`[watchdog] Restarting in ${delay / 1000}s... (${restarts}/${MAX_RESTARTS} in window)${isScheduledRestart ? ' [scheduled]' : ''}`);

    if (!isScheduledRestart) {
      sendTelegramAlert(`⚠️ Bot crashed (${exitInfo}), restarting in ${delay / 1000}s... (${restarts}/${MAX_RESTARTS})`);
    }

    setTimeout(startBot, delay);
  });

  child.on('error', (err) => {
    console.error(`[watchdog] Failed to start bot: ${err.message}`);
    restarts++;
    const delay = Math.min(5000 * restarts, 30000);
    setTimeout(startBot, delay);
  });
}

// Handle watchdog shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n[watchdog] SIGINT received, stopping bot...');
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 5000);
});

process.on('SIGTERM', () => {
  console.log('[watchdog] SIGTERM received, stopping bot...');
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000);
});

console.log(`[watchdog] Starting watchdog for bot in ${BOT_DIR}`);
console.log(`[watchdog] Max ${MAX_RESTARTS} restarts per ${WINDOW_MS / 60000} min window`);
startBot();
