/**
 * restart-bot.cjs - Kill running bot + start fresh
 * Usage: npm run restart (compiles first via package.json)
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const LOCK_FILE = path.resolve(__dirname, '..', '.bot.lock');

// 1. Kill existing bot if running
if (fs.existsSync(LOCK_FILE)) {
  const raw = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
  // Lock file can be plain PID or JSON {"pid":12345,"timestamp":...}
  let pid;
  try {
    const parsed = JSON.parse(raw);
    pid = parsed.pid ?? parsed;
  } catch {
    pid = raw;
  }
  // Fallback: extract first number from string
  if (typeof pid !== 'number') {
    const match = String(pid).match(/\d+/);
    pid = match ? Number(match[0]) : null;
  }
  if (pid) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`[restart] Killed old bot (PID ${pid})`);
      execSync('timeout /t 2 /nobreak >nul 2>&1', { stdio: 'ignore' });
    } catch {
      console.log(`[restart] Old bot (PID ${pid}) already dead`);
    }
  }
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// 2. Also check for orphaned processes (no lock file but dist/index.js running)
try {
  const result = execSync('wmic process where "commandline like \'%dist/index.js%\'" get processid 2>nul', {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const pids = result.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[restart] Killed orphaned bot (PID ${pid})`);
    } catch {}
  }
  if (pids.length > 0) {
    execSync('timeout /t 2 /nobreak >nul 2>&1', { stdio: 'ignore' });
  }
} catch {}

// 3. Start new bot (detached so this script can exit)
console.log('[restart] Starting new bot...');
const child = spawn('node', ['dist/index.js'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'ignore',
  detached: true,
});
child.unref();
console.log(`[restart] New bot started (PID ${child.pid})`);
console.log('[restart] Done. Check logs/bot.log for output.');
