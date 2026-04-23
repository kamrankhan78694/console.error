import type { InterceptConfig, Level, UnifErrEvent } from './types';
import { createEvent } from './event';
import { isBrowserRuntime, isNodeRuntime } from './runtime';

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
// Module-private symbol — never registered with Symbol.for so it cannot
// collide with state placed by other libraries on `console`.
const STATE_SYMBOL = Symbol('uniferr.intercept.state');

const levelByMethod: Record<ConsoleMethod, Level> = {
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  info: 'info'
};

function isInterceptState(value: unknown): value is InterceptState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<InterceptState>;
  return (
    typeof candidate.installed === 'boolean' &&
    typeof candidate.teardown === 'function' &&
    typeof candidate.originals === 'object' &&
    candidate.originals !== null
  );
}

function getState(): InterceptState | undefined {
  const maybe = Reflect.get(console, STATE_SYMBOL);
  return isInterceptState(maybe) ? maybe : undefined;
}

/**
 * Saved console methods captured at install time. These are the only
 * functions internal code (e.g. transports) should use to log without
 * recursing back through the intercept.
 */
export interface OriginalConsole {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

let originalConsole: OriginalConsole | undefined;

export function getOriginalConsole(): OriginalConsole {
  return (
    originalConsole ?? {
      error: console.error,
      warn: console.warn,
      debug: console.debug,
      info: console.info
    }
  );
}

export function installIntercept(config: InterceptConfig): () => void {
  const existing = getState();
  if (existing?.installed) {
    return existing.teardown;
  }

  if (!config.transport && !config.onEvent) {
    throw new Error('uniferr: installIntercept requires a `transport` or `onEvent`');
  }

  const originals: ConsoleMethodMap = {
    error: console.error,
    warn: console.warn,
    debug: console.debug,
    info: console.info
  };
  originalConsole = originals;

  const allowedLevels = new Set<Level>(config.levels ?? ['fatal', 'error', 'warn', 'info', 'debug']);

  // Reentrancy guard: only blocks SYNCHRONOUS recursion (e.g. a transport
  // that itself calls console.error during its own send()). Async overlapping
  // host calls run on different ticks with depth back at zero, so they are
  // captured normally.
  let syncDepth = 0;

  const reportError = (error: unknown, event?: UnifErrEvent): void => {
    if (typeof config.onError === 'function') {
      try {
        config.onError(error, event);
      } catch {
        // Never let onError crash the host process.
      }
      return;
    }
    try {
      originals.error('[uniferr] internal error:', error);
    } catch {
      // Last-resort: swallow.
    }
  };

  const reportDrop = (event: UnifErrEvent, reason: string): void => {
    if (typeof config.onDrop !== 'function') {
      return;
    }
    try {
      config.onDrop(event, reason);
    } catch {
      // Never let onDrop crash the host.
    }
  };

  const handlePromise = (p: Promise<void>, event: UnifErrEvent): Promise<void> =>
    p.catch((error) => {
      reportError(error, event);
    });

  const runChain = (
    stages: Array<((event: UnifErrEvent) => void | Promise<void>) | undefined>,
    event: UnifErrEvent
  ): void => {
    let i = 0;
    const next = (): void | Promise<void> => {
      while (i < stages.length) {
        const fn = stages[i];
        i += 1;
        if (!fn) continue;
        syncDepth += 1;
        let result: void | Promise<void>;
        try {
          result = fn(event);
        } catch (error) {
          syncDepth -= 1;
          reportError(error, event);
          return;
        }
        syncDepth -= 1;
        if (result && typeof (result as Promise<void>).then === 'function') {
          // Async stage: continue the chain after it resolves.
          void handlePromise(
            (result as Promise<void>).then(() => {
              const tail = next();
              if (tail) {
                return tail;
              }
              return undefined;
            }),
            event
          );
          return;
        }
      }
    };
    next();
  };

  const emit = (level: Level, args: unknown[]): void => {
    if (!allowedLevels.has(level)) {
      return;
    }
    if (syncDepth > 0) {
      // Synchronous recursion from a transport / pipeline call — drop to
      // prevent infinite loops. Use the original sink so we never lose the log.
      try {
        const sink = originals[level === 'fatal' ? 'error' : (level as ConsoleMethod)];
        sink.apply(console, args);
      } catch {
        // ignore
      }
      return;
    }
    let event: UnifErrEvent;
    try {
      event = createEvent({
        level,
        args,
        ...(config.tags ? { tags: config.tags } : {}),
        ...(config.extras ? { extras: config.extras } : {}),
        ...(config.release ? { release: config.release } : {})
      });
    } catch (error) {
      reportError(error);
      return;
    }
    runChain(
      [
        config.pipeline,
        config.transport ? (e) => config.transport!.send(e) : undefined,
        config.onEvent
      ],
      event
    );
  };

  for (const method of METHODS) {
    const original = originals[method];
    const replacement = (...args: unknown[]): void => {
      try {
        emit(levelByMethod[method], args);
      } catch (error) {
        reportError(error);
      }
      original.apply(console, args);
    };

    // `configurable: true` is required so that teardown() can restore the
    // original method via a second defineProperty call. The PRD originally
    // suggested `configurable: false`, but that prevents reliable teardown
    // and double-install recovery in tests / hot-reload scenarios.
    Object.defineProperty(console, method, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: replacement
    });
  }

  const nodeHandlers: {
    uncaughtException?: (error: Error) => void;
    unhandledRejection?: (reason: unknown) => void;
  } = {};

  const browserHandlers: {
    onError?: OnErrorEventHandler | null;
    unhandledRejection?: (event: PromiseRejectionEvent) => void;
  } = {};

  if (isBrowserRuntime()) {
    browserHandlers.onError = window.onerror;
    window.onerror = (
      message: string | Event,
      source?: string,
      lineno?: number,
      colno?: number,
      error?: Error
    ): boolean => {
      try {
        emit('error', error ? [error] : [message, source, lineno, colno]);
      } catch (err) {
        reportError(err);
      }
      const prev = browserHandlers.onError;
      if (typeof prev === 'function') {
        return prev(message, source, lineno, colno, error);
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
      Object.defineProperty(console, method, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: originals[method]
      });
    }

    if (isBrowserRuntime()) {
      window.onerror = browserHandlers.onError ?? null;
      if (browserHandlers.unhandledRejection) {
        window.removeEventListener('unhandledrejection', browserHandlers.unhandledRejection);
      }
    }

    if (isNodeRuntime()) {
      if (nodeHandlers.uncaughtException) {
        process.off('uncaughtException', nodeHandlers.uncaughtException);
      }
      if (nodeHandlers.unhandledRejection) {
        process.off('unhandledRejection', nodeHandlers.unhandledRejection);
      }
    }

    if (config.transport?.flush) {
      try {
        void config.transport.flush();
      } catch (error) {
        reportError(error);
      }
    }

    const state = getState();
    if (state) {
      state.installed = false;
    }
    originalConsole = undefined;
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
