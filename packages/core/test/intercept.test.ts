import { afterEach, describe, expect, it, vi } from 'vitest';

import { installIntercept } from '../src/intercept';
import type { UnifErrEvent } from '../src/types';

describe('installIntercept', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('intercepts console methods and emits events', async () => {
    const events: UnifErrEvent[] = [];
    const teardown = installIntercept({
      onEvent: (event): void => {
        events.push(event);
      },
      tags: { app: 'core-test' },
      extras: { feature: 'intercept' }
    });

    console.error('err-message', { code: 1 });
    console.warn('warn-message');
    console.info('info-message');
    console.debug('debug-message');

    teardown();

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.level)).toEqual(['error', 'warn', 'info', 'debug']);

    const first = events[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    expect(first.message).toBe('err-message');
    expect(first.args).toEqual(['err-message', { code: 1 }]);
    expect(first.tags).toEqual({ app: 'core-test' });
    expect(first.extras).toEqual({ feature: 'intercept' });
    expect(first.env.runtime).toBe('node');
    expect(typeof first.id).toBe('string');
    expect(first.id.length).toBeGreaterThan(0);
  });

  it('is idempotent when installed multiple times', () => {
    const events: UnifErrEvent[] = [];

    const teardownA = installIntercept({
      onEvent: (event): void => {
        events.push(event);
      }
    });

    const teardownB = installIntercept({
      onEvent: (event): void => {
        events.push(event);
      }
    });

    console.error('single-event');
    teardownA();

    expect(teardownB).toBe(teardownA);
    expect(events).toHaveLength(1);
    const first = events[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    expect(first.message).toBe('single-event');
  });

  it('restores original console methods on teardown', () => {
    const before = console.error;
    const teardown = installIntercept({
      onEvent: (): void => {
        // no-op
      }
    });

    expect(console.error).not.toBe(before);

    teardown();

    expect(console.error).toBe(before);
  });
});
