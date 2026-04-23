import { getOriginalConsole, isNodeRuntime, type Level, type Transport, type UnifErrEvent } from '@uniferr/core';

export interface ConsoleTransportOptions {
  /** Force a specific output mode. Defaults to auto-detect (TTY → pretty, otherwise JSON). */
  format?: 'pretty' | 'json';
  /** Override the sink. Used in tests to capture writes deterministically. */
  sink?: {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
}

const ANSI: Record<Level, string> = {
  fatal: '\u001b[35m', // magenta
  error: '\u001b[31m', // red
  warn: '\u001b[33m',  // yellow
  info: '\u001b[36m',  // cyan
  debug: '\u001b[90m'  // grey
};
const RESET = '\u001b[0m';

const methodForLevel: Record<Level, 'error' | 'warn' | 'info' | 'debug'> = {
  fatal: 'error',
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug'
};

function detectPretty(): boolean {
  if (isNodeRuntime()) {
    const stdout = (process as unknown as { stdout?: { isTTY?: boolean } }).stdout;
    return stdout?.isTTY === true;
  }
  // Browsers can render colors via %c; treat as pretty.
  return typeof window !== 'undefined';
}

function formatPretty(event: UnifErrEvent): string {
  const color = ANSI[event.level] ?? '';
  const ts = new Date(event.timestamp).toISOString();
  const tags = Object.keys(event.tags).length
    ? ' ' + Object.entries(event.tags).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  return `${color}[${ts}] ${event.level.toUpperCase()}${RESET} ${event.message}${tags}`;
}

export function consoleTransport(options: ConsoleTransportOptions = {}): Transport {
  const sink = options.sink ?? getOriginalConsole();
  const pretty = options.format
    ? options.format === 'pretty'
    : detectPretty();

  return {
    send(event: UnifErrEvent): void {
      const method = methodForLevel[event.level];
      try {
        if (pretty) {
          const line = formatPretty(event);
          if (event.stack) {
            sink[method](line + '\n' + event.stack);
          } else {
            sink[method](line);
          }
        } else {
          // Structured JSON: safe-stringify to avoid throwing on cycles.
          sink[method](safeStringify(event));
        }
      } catch {
        // Never let the transport throw — last resort: drop the line.
      }
    }
  };
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) {
        return '[Circular]';
      }
      seen.add(v as object);
    }
    if (typeof v === 'bigint') {
      return v.toString();
    }
    if (typeof v === 'function') {
      return `[Function ${(v as { name?: string }).name ?? 'anonymous'}]`;
    }
    return v;
  });
}
