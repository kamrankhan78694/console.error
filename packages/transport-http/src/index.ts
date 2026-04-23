import type { Transport, UnifErrEvent } from '@uniferr/core';

export interface HttpTransportOptions {
  /** Endpoint URL to POST events to. */
  url: string;
  /** Extra headers added to every request. */
  headers?: Record<string, string>;
  /** Maximum number of queued events; oldest is dropped when exceeded. Default 1000. */
  queueSize?: number;
  /** Maximum number of attempts (including the first). Default 3. */
  maxRetries?: number;
  /** Initial backoff in ms; doubled per retry, with jitter. Default 250. */
  initialBackoffMs?: number;
  /** Inject `fetch` for testability. */
  fetch?: typeof globalThis.fetch;
  /**
   * Inject `sendBeacon` for testability. Defaults to `navigator.sendBeacon`
   * in browsers. Used for `fatal` events to maximise delivery during unload.
   */
  sendBeacon?: (url: string, data: string) => boolean;
  /** Surface delivery failures (after retries are exhausted). */
  onError?: (error: unknown, event: UnifErrEvent) => void;
  /** Called when an event is dropped from the queue. */
  onDrop?: (event: UnifErrEvent, reason: 'queue-full') => void;
}

interface QueueEntry {
  event: UnifErrEvent;
  attempts: number;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) return '[Circular]';
      seen.add(v as object);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return `[Function]`;
    return v;
  });
}

export function httpTransport(options: HttpTransportOptions): Transport {
  const url = options.url;
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  const queueSize = Math.max(1, options.queueSize ?? 1000);
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const initialBackoff = Math.max(1, options.initialBackoffMs ?? 250);
  const doFetch =
    options.fetch ??
    (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
  const beacon =
    options.sendBeacon ??
    (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
      ? (navigator.sendBeacon.bind(navigator) as (url: string, data: string) => boolean)
      : undefined);

  const queue: QueueEntry[] = [];
  let processing = false;
  let drainPromise: Promise<void> = Promise.resolve();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function attempt(entry: QueueEntry): Promise<void> {
    if (!doFetch) {
      throw new Error('@uniferr/transport-http: no fetch implementation available');
    }
    const body = safeStringify(entry.event);
    const response = await doFetch(url, { method: 'POST', headers, body });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  async function drain(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const entry = queue[0]!;
        try {
          await attempt(entry);
          queue.shift();
        } catch (error) {
          entry.attempts += 1;
          if (entry.attempts >= maxRetries) {
            queue.shift();
            options.onError?.(error, entry.event);
          } else {
            const backoff = initialBackoff * 2 ** (entry.attempts - 1);
            const jitter = Math.floor(Math.random() * backoff * 0.5);
            await sleep(backoff + jitter);
          }
        }
      }
    } finally {
      processing = false;
    }
  }

  function enqueue(event: UnifErrEvent): void {
    if (queue.length >= queueSize) {
      const dropped = queue.shift();
      if (dropped) {
        options.onDrop?.(dropped.event, 'queue-full');
      }
    }
    queue.push({ event, attempts: 0 });
  }

  function scheduleDrain(): void {
    if (processing) {
      // Already running — the active drain will pick up the newly enqueued
      // entries before it returns. The existing `drainPromise` remains the
      // canonical "wait until queue is empty" handle for flush().
      return;
    }
    drainPromise = drain();
  }

  return {
    send(event: UnifErrEvent): void {
      // Best-effort beacon delivery for fatal/unload paths.
      if (event.level === 'fatal' && beacon) {
        try {
          if (beacon(url, safeStringify(event))) {
            return;
          }
        } catch {
          // Fall through to queued delivery.
        }
      }
      enqueue(event);
      scheduleDrain();
    },
    async flush(): Promise<void> {
      // Wait for any active drain. If new sends arrive during the wait,
      // `drainPromise` is replaced with a chain that covers them too — we
      // re-await until two consecutive observations are equal, meaning the
      // queue truly settled. Under a continuous send-firehose this loop
      // intentionally tracks new arrivals; callers wanting an upper bound
      // should race flush() against their own timeout.
      let prev: Promise<void> | undefined;
      while (drainPromise !== prev) {
        prev = drainPromise;
        await drainPromise;
      }
    }
  };
}
