import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { resolve } from 'path';
import { readdirSync, unlinkSync, statSync } from 'fs';

const LOG_DIR = resolve(process.cwd(), 'data');

// v9z: Session-based log files — each bot start gets its own log
// Format: bot-YYYY-MM-DD_HHmmss.log (e.g., bot-2026-02-12_131459.log)
const SESSION_START = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const SESSION_TS = `${SESSION_START.getFullYear()}-${pad(SESSION_START.getMonth() + 1)}-${pad(SESSION_START.getDate())}_${pad(SESSION_START.getHours())}${pad(SESSION_START.getMinutes())}${pad(SESSION_START.getSeconds())}`;
const SESSION_LOG_FILE = `bot-${SESSION_TS}.log`;

// Export for bot-status.cjs and other scripts
export const SESSION_LOG_PATH = resolve(LOG_DIR, SESSION_LOG_FILE);

// Cleanup old log files (keep last 14 days)
function cleanupOldLogs(): void {
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const files = readdirSync(LOG_DIR).filter(f => f.startsWith('bot-') && f.endsWith('.log'));
    for (const f of files) {
      try {
        const fpath = resolve(LOG_DIR, f);
        const stat = statSync(fpath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fpath);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
cleanupOldLogs();

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    if (stack) {
      return `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}${metaStr}`;
    }
    return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
  }),
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ` ${JSON.stringify(meta, null, 0)}`
      : '';
    return `${timestamp} ${level} ${message}${metaStr}`;
  }),
);

// Prevent EPIPE from crashing the process (happens when stdout pipe breaks)
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return; // Ignore broken pipe on stdout
});
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return; // Ignore broken pipe on stderr
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  exitOnError: false, // Don't exit on transport errors
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
      handleExceptions: false,
    }),
    // v9z: Session log — one file per bot start
    new winston.transports.File({
      dirname: LOG_DIR,
      filename: SESSION_LOG_FILE,
      format: logFormat,
      maxsize: 50 * 1024 * 1024, // 50MB max per session file
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d',
      format: logFormat,
    }),
  ],
});
