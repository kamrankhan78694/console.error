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

export interface InterceptConfig {
  onEvent: (event: UnifErrEvent) => void | Promise<void>;
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
}
