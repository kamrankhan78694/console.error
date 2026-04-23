// Public surface of @uniferr/core. Everything here is part of the stable API.

export type { Level, RuntimeEnv, UnifErrEvent, Transport, InterceptConfig } from './types';
export { installIntercept, getOriginalConsole } from './intercept';
export type { OriginalConsole } from './intercept';
export { createEvent, deriveMessage, deriveStack } from './event';
export type { EventFactoryOptions } from './event';
export { resolveRuntimeEnv, isBrowserRuntime, isNodeRuntime, isDenoRuntime, isWorkerRuntime } from './runtime';

// Pipeline
export { createPipeline } from './pipeline';
export type { Enricher, Pipeline } from './pipeline';

// Built-in enrichers
export {
  stackTraceEnricher,
  parseStack,
  dedupEnricher,
  contextEnricher,
  setContext,
  withContext,
  clearContext,
  reactEnricher
} from './enrichers';
export type { StackFrame, DedupOptions } from './enrichers';

// Router
export { createRouter, byLevel, byTag, byMessage, always } from './router';
export type { RouterRule, Matcher, RouterOptions } from './router';

// Plugin SDK
export { Lifecycle } from './plugin';
export type {
  UnifErrPlugin,
  UnifErrSDK,
  RegistrySnapshot,
  LifecycleEvent,
  LifecycleHandlers
} from './plugin';

// High-level façade
export { createUnifErr } from './sdk';
export type { CreateSdkOptions, UnifErrInstance } from './sdk';
