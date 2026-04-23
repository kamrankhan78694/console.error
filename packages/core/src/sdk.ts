import type { InterceptConfig, Level, Transport, UnifErrEvent } from './types';
import type { Enricher } from './pipeline';
import { createPipeline } from './pipeline';
import type { RouterRule } from './router';
import { createRouter } from './router';
import {
  Lifecycle,
  type RegistrySnapshot,
  type UnifErrPlugin,
  type UnifErrSDK
} from './plugin';
import { installIntercept } from './intercept';

export interface CreateSdkOptions {
  enrichers?: ReadonlyArray<Enricher>;
  transports?: ReadonlyArray<Transport>;
  rules?: ReadonlyArray<RouterRule>;
  levels?: ReadonlyArray<Level>;
  plugins?: ReadonlyArray<UnifErrPlugin>;
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
  release?: string;
}

export interface UnifErrInstance {
  sdk: UnifErrSDK;
  install(): () => void;
  use(plugin: UnifErrPlugin): Promise<void>;
}

export async function createUnifErr(options: CreateSdkOptions = {}): Promise<UnifErrInstance> {
  const enrichers: Enricher[] = options.enrichers ? [...options.enrichers] : [];
  const transports: Transport[] = options.transports ? [...options.transports] : [];
  const rules: RouterRule[] = options.rules ? [...options.rules] : [];
  const levels: Level[] = options.levels ? [...options.levels] : ['fatal', 'error', 'warn', 'info', 'debug'];
  const lifecycle = new Lifecycle();

  const snapshot = (): RegistrySnapshot => ({
    enrichers: enrichers.slice(),
    transports: transports.slice(),
    rules: rules.slice(),
    levels: levels.slice()
  });

  const sdk: UnifErrSDK = {
    addEnricher(e) {
      enrichers.push(e);
    },
    addTransport(t) {
      transports.push(t);
    },
    addRule(r) {
      rules.push(r);
    },
    on(event, handler) {
      // Type narrowing handled inside Lifecycle.on overloads.
      lifecycle.on(event as 'error', handler as Parameters<Lifecycle['on']>[1]);
    },
    getConfig() {
      return snapshot();
    }
  };

  for (const plugin of options.plugins ?? []) {
    await plugin.install(sdk);
  }

  const install = (): (() => void) => {
    const pipeline = createPipeline(enrichers);
    const router = rules.length > 0
      ? createRouter(rules, {
        onUnmatched: (event) => lifecycle.emitDrop(event, 'unmatched')
      })
      : undefined;

    const fanout: Transport = {
      async send(event: UnifErrEvent): Promise<void> {
        if (router) {
          await router.send(event);
        }
        for (const transport of transports) {
          try {
            await transport.send(event);
          } catch (error) {
            lifecycle.emitError(error, event);
          }
        }
      },
      async flush(): Promise<void> {
        for (const transport of transports) {
          if (transport.flush) {
            try {
              await transport.flush();
            } catch (error) {
              lifecycle.emitError(error);
            }
          }
        }
        lifecycle.emitFlush();
      }
    };

    const config: InterceptConfig = {
      transport: fanout,
      pipeline,
      levels,
      onError: (error, event) => lifecycle.emitError(error, event),
      onDrop: (event, reason) => lifecycle.emitDrop(event, reason),
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.extras ? { extras: options.extras } : {}),
      ...(options.release ? { release: options.release } : {})
    };

    return installIntercept(config);
  };

  const use = async (plugin: UnifErrPlugin): Promise<void> => {
    await plugin.install(sdk);
  };

  return { sdk, install, use };
}
