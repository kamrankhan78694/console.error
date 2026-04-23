import { afterEach, describe, expect, it } from 'vitest';

import { installIntercept } from '../src/intercept';
import type { UnifErrEvent } from '../src/types';

let pendingTeardowns: Array<() => void> = [];

function track(teardown: () => void): () => void {
  pendingTeardowns.push(teardown);
  return teardown;
}

afterEach(() => {
  while (pendingTeardowns.length > 0) {
    const t = pendingTeardowns.pop();
    try {
      t?.();
    } catch {
      // ignore
    }
  }
});

describe('installIntercept', () => {
  it('intercepts console methods and emits events', () => {
    const events: UnifErrEvent[] = [];
    const teardown = track(
      installIntercept({
        onEvent: (event) => {
          events.push(event);
        },
        tags: { app: 'core-test' },
        extras: { feature: 'intercept' }
      })
    );

    console.error('err-message', { code: 1 });
    console.warn('warn-message');
    console.info('info-message');
    console.debug('debug-message');

    teardown();

    expect(events).toHaveLength(4);
    expect(events.map((e) => e.level)).toEqual(['error', 'warn', 'info', 'debug']);
    const first = events[0];
    expect(first?.message).toBe('err-message');
    expect(first?.args).toEqual(['err-message', { code: 1 }]);
    expect(first?.tags).toEqual({ app: 'core-test' });
    expect(first?.extras).toEqual({ feature: 'intercept' });
    expect(first?.env.runtime).toBe('node');
    expect(typeof first?.id).toBe('string');
  });

  it('is idempotent — second install returns the existing teardown', () => {
    const events: UnifErrEvent[] = [];
    const teardownA = track(installIntercept({ onEvent: (e) => { events.push(e); } }));
    const teardownB = installIntercept({ onEvent: (e) => { events.push(e); } });
    expect(teardownB).toBe(teardownA);

    console.error('once');
    expect(events).toHaveLength(1);
  });

  it('restores original console methods on teardown', () => {
    const before = console.error;
    const teardown = installIntercept({ onEvent: () => undefined });
    expect(console.error).not.toBe(before);
    teardown();
    expect(console.error).toBe(before);
  });

  it('respects the levels filter', () => {
    const events: UnifErrEvent[] = [];
    track(
      installIntercept({
        onEvent: (e) => { events.push(e); },
        levels: ['error']
      })
    );

    console.error('keep');
    console.warn('drop');
    console.info('drop');
    console.debug('drop');

    expect(events.map((e) => e.level)).toEqual(['error']);
  });

  it('throws when neither transport nor onEvent is provided', () => {
    expect(() => installIntercept({} as Parameters<typeof installIntercept>[0])).toThrow(
      /transport.*onEvent/
    );
  });

  it('captures uncaughtException via process handler in Node', async () => {
    const events: UnifErrEvent[] = [];
    track(installIntercept({ onEvent: (e) => { events.push(e); } }));

    process.emit('uncaughtException', new Error('boom'));
    process.emit(
      'unhandledRejection',
      new Error('rej'),
      Promise.resolve() as unknown as Promise<unknown>
    );
    await new Promise((r) => setImmediate(r));

    expect(events.map((e) => e.level)).toEqual(['fatal', 'fatal']);
    expect(events[0]?.message).toBe('boom');
    expect(events[1]?.message).toBe('rej');
  });

  it('does not recurse when the transport itself logs via console.error', async () => {
    const captured: string[] = [];
    track(
      installIntercept({
        transport: {
          send: (e) => {
            captured.push(e.message);
            // Simulate a transport mistake; must NOT recurse infinitely.
            console.error('inside-transport');
          }
        }
      })
    );

    console.error('outer');
    // Allow microtask flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(captured).toEqual(['outer']);
  });
});
