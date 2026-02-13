import EE3 from 'eventemitter3';
import type { BotEvents } from '../types.js';

// Cast eventemitter3 to a constructable class
const EventEmitter = EE3 as unknown as { new (): {
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
}};

class TypedEmitter extends EventEmitter {
  emit<K extends keyof BotEvents>(event: K, ...args: Parameters<BotEvents[K]>): boolean {
    return super.emit(event as string, ...args);
  }

  on<K extends keyof BotEvents>(event: K, fn: BotEvents[K]): this {
    super.on(event as string, fn as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof BotEvents>(event?: K): this {
    super.removeAllListeners(event as string | undefined);
    return this;
  }
}

export const botEmitter = new TypedEmitter();
