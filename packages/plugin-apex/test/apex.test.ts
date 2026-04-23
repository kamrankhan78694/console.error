import { describe, expect, it, vi } from 'vitest';

import { createEvent, createPipeline, createUnifErr } from '@uniferr/core';
import { apexPlugin, apexTransport, lwcEnricher } from '../src/index';

describe('@uniferr/plugin-apex', () => {
  it('lwcEnricher promotes ref/componentName into tags', async () => {
    const event = createEvent({ level: 'error', args: ['oops'] });
    event.extras.lwc = { ref: 'orderForm', componentName: 'c-order' };
    await createPipeline([lwcEnricher])(event);
    expect(event.tags['lwc.ref']).toBe('orderForm');
    expect(event.tags['lwc.component']).toBe('c-order');
  });

  it('apexTransport invokes the provided Apex bridge with the event', async () => {
    const invoke = vi.fn<(payload: { event: import('@uniferr/core').UnifErrEvent }) => Promise<void>>(
      async () => undefined
    );
    const t = apexTransport({ invoke });
    await t.send(createEvent({ level: 'fatal', args: ['die'] }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0].event.message).toBe('die');
  });

  it('apexPlugin registers both an enricher and a transport via the SDK', async () => {
    const invoke = vi.fn<(payload: { event: import('@uniferr/core').UnifErrEvent }) => Promise<void>>(
      async () => undefined
    );
    const ux = await createUnifErr({ plugins: [apexPlugin({ invoke })] });
    const cfg = ux.sdk.getConfig();
    expect(cfg.enrichers).toHaveLength(1);
    expect(cfg.transports).toHaveLength(1);
  });
});
