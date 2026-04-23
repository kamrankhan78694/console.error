import { describe, expect, it } from 'vitest';

import { always, byLevel, byMessage, byTag, createRouter, type RouterRule } from '../src/router';
import { createEvent } from '../src/event';
import type { Transport, UnifErrEvent } from '../src/types';

function recorder(label: string, sink: Array<{ label: string; event: UnifErrEvent }>): Transport {
  return {
    send(event) {
      sink.push({ label, event });
    }
  };
}

describe('createRouter', () => {
  it('dispatches the first matching rule and stops', async () => {
    const sink: Array<{ label: string; event: UnifErrEvent }> = [];
    const rules: RouterRule[] = [
      { match: byLevel('error'), transports: [recorder('errors', sink)] },
      { match: always(), transports: [recorder('default', sink)] }
    ];
    const router = createRouter(rules);
    await router.send(createEvent({ level: 'error', args: ['x'] }));
    await router.send(createEvent({ level: 'info', args: ['x'] }));
    expect(sink.map((s) => s.label)).toEqual(['errors', 'default']);
  });

  it('applies transform before the transport receives the event', async () => {
    const sink: Array<{ label: string; event: UnifErrEvent }> = [];
    const rules: RouterRule[] = [
      {
        match: always(),
        transform: (e) => ({ ...e, message: `[T] ${e.message}` }),
        transports: [recorder('out', sink)]
      }
    ];
    await createRouter(rules).send(createEvent({ level: 'warn', args: ['hi'] }));
    expect(sink[0]?.event.message).toBe('[T] hi');
  });

  it('calls onUnmatched when no rule matches', async () => {
    const dropped: string[] = [];
    await createRouter(
      [{ match: byLevel('fatal'), transports: [] }],
      { onUnmatched: (e) => dropped.push(e.level) }
    ).send(createEvent({ level: 'info', args: ['x'] }));
    expect(dropped).toEqual(['info']);
  });

  it('isolates transport failures (Promise.allSettled)', async () => {
    const sink: Array<{ label: string; event: UnifErrEvent }> = [];
    const failing: Transport = {
      send() {
        throw new Error('fail');
      }
    };
    const ok = recorder('ok', sink);
    await createRouter([{ match: always(), transports: [failing, ok] }]).send(
      createEvent({ level: 'error', args: ['x'] })
    );
    expect(sink.map((s) => s.label)).toEqual(['ok']);
  });

  describe('matchers', () => {
    it('byLevel respects ordinal ranking', () => {
      const m = byLevel('warn');
      expect(m(createEvent({ level: 'debug', args: [] }))).toBe(false);
      expect(m(createEvent({ level: 'info', args: [] }))).toBe(false);
      expect(m(createEvent({ level: 'warn', args: [] }))).toBe(true);
      expect(m(createEvent({ level: 'fatal', args: [] }))).toBe(true);
    });

    it('byTag matches exact key/value pairs', () => {
      const event = createEvent({ level: 'info', args: [], tags: { region: 'us' } });
      expect(byTag('region', 'us')(event)).toBe(true);
      expect(byTag('region', 'eu')(event)).toBe(false);
    });

    it('byMessage matches by regex', () => {
      const m = byMessage(/Chunk/);
      expect(m(createEvent({ level: 'error', args: ['ChunkLoadError'] }))).toBe(true);
      expect(m(createEvent({ level: 'error', args: ['hello'] }))).toBe(false);
    });

    it('always matches everything', () => {
      expect(always()(createEvent({ level: 'debug', args: [] }))).toBe(true);
    });
  });
});
