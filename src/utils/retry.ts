import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === options.maxRetries) break;

      let delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt),
        options.maxDelayMs,
      );

      if (options.jitter) {
        delay = delay * (0.5 + Math.random() * 0.5);
      }

      logger.warn(`[retry] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`, {
        error: lastError.message,
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
