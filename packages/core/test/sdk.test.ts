import { afterEach, describe, expect, it } from 'vitest';

import { createUnifErr } from '../src/sdk';
import type { UnifErrEvent } from '../src/types';
import { always, byLevel } from '../src/router';
import type { UnifErrPlugin } from '../src/plugin';

let teardowns: Array<() => void> = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.();
});

describe('createUnifErr (high-level façade)', () => {
  it('wires enrichers, router and transports together', async () => {
    const fatalSink: UnifErrEvent[] = [];
    const defaultSink: UnifErrEvent[] = [];
    const seen: UnifErrEvent[] = [];

    const tagAll: UnifErrPlugin = {
      name: 'tag-all',
      install(sdk) {
        sdk.addEnricher(async (event, next) => {
          event.tags.app = 'demo';
          await next();
        });
      }
    };

    const ux = await createUnifErr({
      plugins: [tagAll],
      rules: [
        { match: byLevel('fatal'), transports: [{ send: (e) => { fatalSink.push(e); } }] },
        { match: always(), transports: [{ send: (e) => { defaultSink.push(e); } }] }
      ],
      transports: [{ send: (e) => { seen.push(e); } }]
    });

    teardowns.push(ux.install());

    console.error('fail');
    console.info('hello');
    await new Promise((r) => setImmediate(r));

    expect(seen.map((e) => e.tags.app)).toEqual(['demo', 'demo']);
    expect(defaultSink.map((e) => e.message)).toEqual(['fail', 'hello']);
    expect(fatalSink).toHaveLength(0);
  });

  it('lifecycle.on(error) receives transport failures', async () => {
    const errors: unknown[] = [];
    const ux = await createUnifErr({
      transports: [{ send: () => { throw new Error('xxx'); } }]
    });
    ux.sdk.on('error', (err) => errors.push(err));

    teardowns.push(ux.install());
    console.error('boom');
    await new Promise((r) => setImmediate(r));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('xxx');
  });

  it('plugin install order is preserved and getConfig reflects the registry', async () => {
    const order: string[] = [];
    const p1: UnifErrPlugin = { name: 'p1', install: (s) => { order.push('p1'); s.addRule({ match: always(), transports: [] }); } };
    const p2: UnifErrPlugin = { name: 'p2', install: (s) => { order.push('p2'); s.addEnricher((_e, n) => n()); } };
    const ux = await createUnifErr({ plugins: [p1, p2] });
    expect(order).toEqual(['p1', 'p2']);
    expect(ux.sdk.getConfig().rules).toHaveLength(1);
    expect(ux.sdk.getConfig().enrichers).toHaveLength(1);
  });
});
