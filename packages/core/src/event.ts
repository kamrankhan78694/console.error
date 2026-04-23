import type { Level, UnifErrEvent } from './types';
import { resolveRuntimeEnv } from './runtime';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: monotonically unique enough for environments without WebCrypto.
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveMessage(args: readonly unknown[]): string {
  if (args.length === 0) {
    return '';
  }
  const first = args[0];
  if (first instanceof Error) {
    return first.message;
  }
  if (typeof first === 'string') {
    return first;
  }
  return String(first);
}

export function deriveStack(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error && typeof arg.stack === 'string') {
      return arg.stack;
    }
  }
  return undefined;
}

export interface EventFactoryOptions {
  level: Level;
  args: unknown[];
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
  release?: string;
}

export function createEvent(options: EventFactoryOptions): UnifErrEvent {
  const event: UnifErrEvent = {
    id: generateId(),
    timestamp: Date.now(),
    level: options.level,
    message: deriveMessage(options.args),
    args: options.args,
    env: resolveRuntimeEnv(options.release),
    tags: { ...(options.tags ?? {}) },
    extras: { ...(options.extras ?? {}) }
  };

  const stack = deriveStack(options.args);
  if (stack) {
    event.stack = stack;
  }

  return event;
}
