export type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

export interface RuntimeEnv {
  runtime: 'browser' | 'node' | 'deno' | 'worker';
  release?: string;
  url?: string;
  userAgent?: string;
  nodeVersion?: string;
}

export interface UnifErrEvent {
  id: string;
  timestamp: number;
  level: Level;
  message: string;
  args: unknown[];
  stack?: string;
  env: RuntimeEnv;
  tags: Record<string, string>;
  extras: Record<string, unknown>;
  fingerprint?: string;
}

/**
 * A transport receives a fully enriched event and is responsible for
 * delivering it to a sink (console, file, http, etc). Transports SHOULD NOT
 * throw — internal failures are surfaced through the lifecycle hooks.
 */
export interface Transport {
  send(event: UnifErrEvent): void | Promise<void>;
  /** Optional flush hook called on teardown / process exit. */
  flush?(): void | Promise<void>;
}

export interface InterceptConfig {
  /**
   * Terminal sink for fully-formed events. Either `transport` or `onEvent`
   * (or both) must be provided.
   */
  transport?: Transport;
  /** Convenience hook; receives every event after enrichment. */
  onEvent?: (event: UnifErrEvent) => void | Promise<void>;
  /** Pipeline applied before the transport / onEvent. */
  pipeline?: (event: UnifErrEvent) => Promise<void>;
  /** Default tags merged into every event. */
  tags?: Record<string, string>;
  /** Default extras merged into every event. */
  extras?: Record<string, unknown>;
  /** Restrict capture to the listed levels. Defaults to all levels. */
  levels?: ReadonlyArray<Level>;
  /** Override the build-time release identifier. */
  release?: string;
  /** Called when an event is dropped (reentrancy, level filter, etc). */
  onDrop?: (event: UnifErrEvent, reason: string) => void;
  /** Called when an internal error escapes a stage. */
  onError?: (error: unknown, event?: UnifErrEvent) => void;
}
