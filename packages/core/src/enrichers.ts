import type { UnifErrEvent } from './types';
import type { Enricher } from './pipeline';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Stack trace enricher                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export interface StackFrame {
  fn?: string;
  file?: string;
  line?: number;
  col?: number;
  native: boolean;
}

const V8_FRAME_RE = /^\s{0,8}at\s+(?:(.{1,200}?)\s+\()?(?:(.{1,1000}?):(\d{1,10}):(\d{1,10})|([^)]{1,1000}))\)?\s*$/;
const SAFARI_FRAME_RE = /^\s{0,8}(?:([^@\s]{1,200})@)?(.{1,1000}?):(\d{1,10}):(\d{1,10})\s*$/;

const MAX_FRAME_LINE_LENGTH = 2000;

export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = stack.split('\n');
  for (const raw of lines) {
    // Bound line length to keep regex matching strictly linear and safe
    // against pathological / adversarial inputs (ReDoS-resistant).
    const line = (raw.length > MAX_FRAME_LINE_LENGTH ? raw.slice(0, MAX_FRAME_LINE_LENGTH) : raw).trim();
    if (!line || line.startsWith('Error') || line.endsWith(':')) {
      continue;
    }

    const v8 = V8_FRAME_RE.exec(line);
    if (v8) {
      const fn = v8[1];
      const file = v8[2] ?? v8[5];
      const lineNo = v8[3];
      const colNo = v8[4];
      const native = !file || file === 'native' || file === '<anonymous>';
      const frame: StackFrame = { native };
      if (fn) {
        frame.fn = fn;
      }
      if (file && !native) {
        frame.file = file;
      }
      if (lineNo) {
        frame.line = Number(lineNo);
      }
      if (colNo) {
        frame.col = Number(colNo);
      }
      frames.push(frame);
      continue;
    }

    const safari = SAFARI_FRAME_RE.exec(line);
    if (safari) {
      const frame: StackFrame = { native: false };
      if (safari[1]) {
        frame.fn = safari[1];
      }
      if (safari[2]) {
        frame.file = safari[2];
      }
      if (safari[3]) {
        frame.line = Number(safari[3]);
      }
      if (safari[4]) {
        frame.col = Number(safari[4]);
      }
      frames.push(frame);
    }
  }
  return frames;
}

export const stackTraceEnricher: Enricher = (event, next) => {
  if (typeof event.stack === 'string' && event.stack.length > 0) {
    const frames = parseStack(event.stack);
    if (frames.length > 0) {
      event.extras.stackFrames = frames;
    }
  }
  return next();
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  Dedup enricher                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

export interface DedupOptions {
  /** Suppress events after this many occurrences of the same fingerprint. */
  maxOccurrences?: number;
  /** Bound the in-memory fingerprint cache. */
  maxEntries?: number;
}

async function digestSha256(input: string): Promise<string> {
  // Prefer WebCrypto (browser, Node ≥18, workers, deno)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const bytes = new TextEncoder().encode(input);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(hash);
    let hex = '';
    for (const byte of view) {
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }
  // Last-resort non-cryptographic hash; only used when no crypto is present.
  // (djb2-style polynomial hash; not for security purposes.)
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return `poly_${(h >>> 0).toString(16)}`;
}

export function dedupEnricher(options: DedupOptions = {}): Enricher {
  const maxOccurrences = Math.max(1, options.maxOccurrences ?? 3);
  const maxEntries = Math.max(16, options.maxEntries ?? 1024);
  const counts = new Map<string, number>();

  return async (event, next) => {
    const stackHead = event.stack ? event.stack.split('\n').slice(0, 2).join('\n') : '';
    const key = `${event.level}|${event.message}|${stackHead}`;
    const fingerprint = await digestSha256(key);
    event.fingerprint = fingerprint;

    const seen = counts.get(fingerprint) ?? 0;
    counts.set(fingerprint, seen + 1);
    if (counts.size > maxEntries) {
      // Evict oldest entry (Map preserves insertion order).
      const firstKey = counts.keys().next().value;
      if (typeof firstKey === 'string') {
        counts.delete(firstKey);
      }
    }

    if (seen >= maxOccurrences) {
      event.extras.suppressed = true;
      event.extras.occurrences = seen + 1;
      return; // Do not call next(): stop the pipeline.
    }

    event.extras.occurrences = seen + 1;
    await next();
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Context enricher                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

type ContextStore = Record<string, unknown>;

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

let als: AsyncLocalStorageLike<ContextStore> | undefined;

async function loadAsyncLocalStorage(): Promise<AsyncLocalStorageLike<ContextStore> | undefined> {
  if (als) {
    return als;
  }
  if (typeof process === 'undefined' || typeof process.versions?.node !== 'string') {
    return undefined;
  }
  try {
    const mod = (await import('node:async_hooks')) as {
      AsyncLocalStorage: new <T>() => AsyncLocalStorageLike<T>;
    };
    als = new mod.AsyncLocalStorage<ContextStore>();
    return als;
  } catch {
    return undefined;
  }
}

const globalStore: ContextStore = {};

export function setContext(key: string, value: unknown): void {
  globalStore[key] = value;
}

export function clearContext(): void {
  for (const key of Object.keys(globalStore)) {
    delete globalStore[key];
  }
}

export async function withContext<T>(values: ContextStore, fn: () => Promise<T> | T): Promise<T> {
  const store = await loadAsyncLocalStorage();
  if (store) {
    const merged: ContextStore = { ...(store.getStore() ?? {}), ...values };
    return store.run(merged, () => Promise.resolve(fn()));
  }
  // Browser/worker fallback: shallow merge into the global store and restore.
  const previous: ContextStore = {};
  for (const key of Object.keys(values)) {
    previous[key] = globalStore[key];
    globalStore[key] = values[key];
  }
  try {
    return await Promise.resolve(fn());
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) {
        delete globalStore[key];
      } else {
        globalStore[key] = previous[key];
      }
    }
  }
}

export const contextEnricher: Enricher = async (event, next) => {
  const fromAls = als?.getStore();
  const merged: ContextStore = { ...globalStore, ...(fromAls ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') {
      event.tags[key] = value;
    } else if (value !== undefined) {
      event.extras[key] = value;
    }
  }
  await next();
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  React enricher                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

interface ReactInternals {
  ReactCurrentOwner?: { current?: { type?: { displayName?: string; name?: string } | null } | null };
}

interface ReactGlobal {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: ReactInternals;
}

export const reactEnricher: Enricher = (event: UnifErrEvent, next) => {
  const react = (globalThis as { React?: ReactGlobal }).React;
  if (!react) {
    return next();
  }
  try {
    const internals = react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    const owner = internals?.ReactCurrentOwner?.current;
    const type = owner?.type;
    if (type) {
      const name = type.displayName ?? type.name;
      if (name) {
        event.extras.componentStack = `<${name}>`;
      }
    }
  } catch {
    // Never let optional enrichment crash the pipeline.
  }
  return next();
};
