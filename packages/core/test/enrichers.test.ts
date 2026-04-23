import { describe, expect, it } from 'vitest';

import {
  contextEnricher,
  dedupEnricher,
  parseStack,
  reactEnricher,
  setContext,
  clearContext,
  stackTraceEnricher,
  withContext
} from '../src/enrichers';
import { createPipeline } from '../src/pipeline';
import { createEvent } from '../src/event';

function event(level: 'error' | 'warn' | 'info' | 'debug' | 'fatal' = 'error', stack?: string) {
  const e = createEvent({ level, args: ['boom'] });
  if (stack) {
    e.stack = stack;
  }
  return e;
}

describe('stackTraceEnricher', () => {
  it('parses a V8-style stack trace', async () => {
    const stack = `Error: oops
    at fn (/tmp/a.js:10:15)
    at /tmp/b.js:20:5
    at <anonymous>`;
    const ev = event('error', stack);
    await createPipeline([stackTraceEnricher])(ev);
    const frames = ev.extras.stackFrames as Array<Record<string, unknown>>;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ fn: 'fn', file: '/tmp/a.js', line: 10, col: 15, native: false });
  });

  it('parses a Safari-style stack trace', () => {
    const stack = `doSomething@/foo/bar.js:42:7
    @/baz.js:1:1`;
    const frames = parseStack(stack);
    expect(frames[0]).toMatchObject({ fn: 'doSomething', file: '/foo/bar.js', line: 42, col: 7 });
  });

  it('is a no-op when no stack is present', async () => {
    const ev = event('error');
    await createPipeline([stackTraceEnricher])(ev);
    expect(ev.extras.stackFrames).toBeUndefined();
  });
});

describe('dedupEnricher', () => {
  it('attaches a fingerprint and counts occurrences', async () => {
    const enricher = dedupEnricher({ maxOccurrences: 2 });
    const downstream: number[] = [];
    const pipeline = createPipeline([
      enricher,
      (_e, next) => {
        downstream.push(1);
        return next();
      }
    ]);

    const a = event('error', 'Error: same\n    at x (/a.js:1:1)');
    const b = event('error', 'Error: same\n    at x (/a.js:1:1)');
    const c = event('error', 'Error: same\n    at x (/a.js:1:1)');

    await pipeline(a);
    await pipeline(b);
    await pipeline(c);

    expect(typeof a.fingerprint).toBe('string');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(downstream).toHaveLength(2); // Third event suppressed.
    expect(c.extras.suppressed).toBe(true);
  });

  it('different messages produce different fingerprints', async () => {
    const enricher = dedupEnricher();
    const a = event('error', 'Error: a');
    const b = event('error', 'Error: b');
    await createPipeline([enricher])(a);
    await createPipeline([enricher])(b);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('contextEnricher', () => {
  it('promotes string values into tags and other values into extras', async () => {
    setContext('userId', 'usr_1');
    setContext('count', 7);
    try {
      const ev = event('info');
      await createPipeline([contextEnricher])(ev);
      expect(ev.tags.userId).toBe('usr_1');
      expect(ev.extras.count).toBe(7);
    } finally {
      clearContext();
    }
  });

  it('withContext scopes values to its callback', async () => {
    const inside = await withContext({ requestId: 'r-1' }, async () => {
      const ev = event('info');
      await createPipeline([contextEnricher])(ev);
      return ev.tags.requestId;
    });
    expect(inside).toBe('r-1');

    const outside = event('info');
    await createPipeline([contextEnricher])(outside);
    expect(outside.tags.requestId).toBeUndefined();
  });
});

describe('reactEnricher', () => {
  it('captures the current owner displayName when React is present', async () => {
    const g = globalThis as { React?: unknown };
    g.React = {
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
        ReactCurrentOwner: { current: { type: { displayName: 'MyComponent' } } }
      }
    };
    try {
      const ev = event('error');
      await createPipeline([reactEnricher])(ev);
      expect(ev.extras.componentStack).toBe('<MyComponent>');
    } finally {
      delete g.React;
    }
  });

  it('is a no-op when React is not on the global scope', async () => {
    const ev = event('error');
    await createPipeline([reactEnricher])(ev);
    expect(ev.extras.componentStack).toBeUndefined();
  });
});
