import type { Enricher, Transport, UnifErrPlugin, UnifErrEvent } from '@uniferr/core';

/**
 * Optional shape for the LWC error info that can be attached to event.extras
 * by host code. The enricher promotes recognised fields into structured tags.
 */
export interface LwcErrorMeta {
  ref?: string;
  componentName?: string;
}

/** Minimal LDS-style adapter: a function that POSTs the event to Apex. */
export type ApexInvoker = (payload: { event: UnifErrEvent }) => Promise<void>;

export interface ApexPluginOptions {
  /**
   * Function that calls the `@AuraEnabled` Apex method, e.g.:
   * `({ event }) => logUnifErr({ payload: JSON.stringify(event) })`.
   */
  invoke: ApexInvoker;
}

export const lwcEnricher: Enricher = (event, next) => {
  const meta = event.extras.lwc as LwcErrorMeta | undefined;
  if (meta && typeof meta === 'object') {
    if (typeof meta.ref === 'string') {
      event.tags['lwc.ref'] = meta.ref;
    }
    if (typeof meta.componentName === 'string') {
      event.tags['lwc.component'] = meta.componentName;
    }
  }
  return next();
};

export function apexTransport(options: ApexPluginOptions): Transport {
  return {
    async send(event: UnifErrEvent): Promise<void> {
      await options.invoke({ event });
    }
  };
}

export function apexPlugin(options: ApexPluginOptions): UnifErrPlugin {
  return {
    name: '@uniferr/plugin-apex',
    install(sdk) {
      sdk.addEnricher(lwcEnricher);
      sdk.addTransport(apexTransport(options));
    }
  };
}
