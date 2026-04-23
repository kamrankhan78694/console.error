import type { InterceptConfig, RuntimeEnv, UnifErrEvent } from './types';

declare const __UNIFERR_RELEASE__: string | undefined;
declare const Deno: { version: { deno: string } } | undefined;

type ConsoleMethod = 'error' | 'warn' | 'debug' | 'info';

type ConsoleMethodMap = {
  [K in ConsoleMethod]: (...args: unknown[]) => void;
};

interface InterceptState {
  installed: boolean;
  teardown: () => void;
  originals: ConsoleMethodMap;
}

const METHODS: readonly ConsoleMethod[] = ['error', 'warn', 'debug', 'info'];
const STATE_SYMBOL = Symbol('uniferr.intercept.state');

const levelByMethod: Record<ConsoleMethod, UnifErrEvent['level']> = {
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  info: 'info'
};

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.version === 'string';
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

function isWorkerRuntime(): boolean {
  return !isBrowserRuntime() && !isNodeRuntime() && !isDenoRuntime();
}

function isDenoRuntime(): boolean {
  return typeof Deno !== 'undefined';
}

function resolveRuntimeEnv(): RuntimeEnv {
  const release = typeof __UNIFERR_RELEASE__ === 'string' ? __UNIFERR_RELEASE__ : undefined;

  if (isBrowserRuntime()) {
    const env: RuntimeEnv = {
      runtime: 'browser',
      url: window.location.href,
      userAgent: navigator.userAgent
    };
    if (release) {
      env.release = release;
    }
    return env;
  }

  if (isNodeRuntime()) {
    const env: RuntimeEnv = {
      runtime: 'node',
      nodeVersion: process.version
    };
    if (release) {
      env.release = release;
    }
    return env;
  }

  if (isDenoRuntime()) {
    const env: RuntimeEnv = { runtime: 'deno' };
    if (release) {
      env.release = release;
    }
    return env;
  }

  if (isWorkerRuntime()) {
    const env: RuntimeEnv = { runtime: 'worker' };
    if (release) {
      env.release = release;
    }
    return env;
  }

  const env: RuntimeEnv = { runtime: 'worker' };
  if (release) {
    env.release = release;
  }
  return env;
}

function createMessage(args: unknown[]): string {
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

function getStack(args: unknown[]): string | undefined {
  const first = args[0];
  if (first instanceof Error && typeof first.stack === 'string') {
    return first.stack;
  }
  return undefined;
}

function createEvent(level: UnifErrEvent['level'], args: unknown[], config: InterceptConfig): UnifErrEvent {
  const stack = getStack(args);
  const event: UnifErrEvent = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    level,
    message: createMessage(args),
    args,
    env: resolveRuntimeEnv(),
    tags: config.tags ?? {},
    extras: config.extras ?? {}
  };

  if (stack) {
    event.stack = stack;
  }

  return event;
}

function getState(): InterceptState | undefined {
  const maybeState = Reflect.get(console, STATE_SYMBOL);

  if (!isInterceptState(maybeState)) {
    return undefined;
  }

  return maybeState;
}

function isInterceptState(value: unknown): value is InterceptState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('installed' in value) || !('teardown' in value) || !('originals' in value)) {
    return false;
  }

  if (typeof value.installed !== 'boolean' || typeof value.teardown !== 'function') {
    return false;
  }

  if (typeof value.originals !== 'object' || value.originals === null) {
    return false;
  }

  if (!('error' in value.originals) || typeof value.originals.error !== 'function') {
    return false;
  }
  if (!('warn' in value.originals) || typeof value.originals.warn !== 'function') {
    return false;
  }
  if (!('debug' in value.originals) || typeof value.originals.debug !== 'function') {
    return false;
  }
  if (!('info' in value.originals) || typeof value.originals.info !== 'function') {
    return false;
  }

  return true;
}

export function installIntercept(config: InterceptConfig): () => void {
  const currentState = getState();
  if (currentState?.installed) {
    return currentState.teardown;
  }

  const originals: ConsoleMethodMap = {
    error: console.error,
    warn: console.warn,
    debug: console.debug,
    info: console.info
  };

  const nodeHandlers: {
    uncaughtException?: (error: Error) => void;
    unhandledRejection?: (reason: unknown) => void;
  } = {};

  const browserHandlers: {
    onError?: OnErrorEventHandler | null;
    unhandledRejection?: (event: PromiseRejectionEvent) => void;
  } = {};

  const emit = (level: UnifErrEvent['level'], args: unknown[]): void => {
    void config.onEvent(createEvent(level, args, config));
  };

  for (const method of METHODS) {
    const original = originals[method];
    const replacement = (...args: unknown[]): void => {
      emit(levelByMethod[method], args);
      original.apply(console, args);
    };

    Object.defineProperty(console, method, {
      configurable: false,
      enumerable: true,
      writable: true,
      value: replacement
    });
  }

  if (isBrowserRuntime()) {
    browserHandlers.onError = window.onerror;
    window.onerror = (
      message: string | Event,
      source?: string,
      lineno?: number,
      colno?: number,
      error?: Error
    ): boolean => {
      emit('error', [message, source, lineno, colno, error]);

      const prevHandler = browserHandlers.onError;
      if (typeof prevHandler === 'function') {
        return prevHandler(message, source, lineno, colno, error);
      }

      return false;
    };

    browserHandlers.unhandledRejection = (event: PromiseRejectionEvent): void => {
      emit('fatal', [event.reason]);
    };
    window.addEventListener('unhandledrejection', browserHandlers.unhandledRejection);
  }

  if (isNodeRuntime()) {
    nodeHandlers.uncaughtException = (error: Error): void => {
      emit('fatal', [error]);
    };

    nodeHandlers.unhandledRejection = (reason: unknown): void => {
      emit('fatal', [reason]);
    };

    process.on('uncaughtException', nodeHandlers.uncaughtException);
    process.on('unhandledRejection', nodeHandlers.unhandledRejection);
  }

  const teardown = (): void => {
    for (const method of METHODS) {
      console[method] = originals[method];
    }

    if (isBrowserRuntime()) {
      window.onerror = browserHandlers.onError ?? null;

      const unhandledRejectionHandler = browserHandlers.unhandledRejection;
      if (typeof unhandledRejectionHandler === 'function') {
        window.removeEventListener('unhandledrejection', unhandledRejectionHandler);
      }
    }

    if (isNodeRuntime()) {
      if (typeof nodeHandlers.uncaughtException === 'function') {
        process.off('uncaughtException', nodeHandlers.uncaughtException);
      }

      if (typeof nodeHandlers.unhandledRejection === 'function') {
        process.off('unhandledRejection', nodeHandlers.unhandledRejection);
      }
    }

    const state = getState();
    if (state) {
      state.installed = false;
    }
  };

  const state: InterceptState = {
    installed: true,
    teardown,
    originals
  };

  Object.defineProperty(console, STATE_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: state
  });

  return teardown;
}
