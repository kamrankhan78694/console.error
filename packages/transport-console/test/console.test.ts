import { describe, expect, it } from 'vitest';
import { createEvent } from '@uniferr/core';

import { consoleTransport } from '../src/index';

function makeSink() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    sink: {
      error: (...args: unknown[]) => { calls.push({ method: 'error', args }); },
      warn: (...args: unknown[]) => { calls.push({ method: 'warn', args }); },
      info: (...args: unknown[]) => { calls.push({ method: 'info', args }); },
      debug: (...args: unknown[]) => { calls.push({ method: 'debug', args }); }
    }
  };
}

describe('consoleTransport', () => {
  it('writes pretty lines including the level and message', () => {
    const { sink, calls } = makeSink();
    const transport = consoleTransport({ format: 'pretty', sink });
    transport.send(createEvent({ level: 'error', args: ['boom'] }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('error');
    const line = String(calls[0]?.args[0]);
    expect(line).toContain('ERROR');
    expect(line).toContain('boom');
  });

  it('writes JSON in non-pretty mode and survives circular references', () => {
    const { sink, calls } = makeSink();
    const transport = consoleTransport({ format: 'json', sink });
    const event = createEvent({ level: 'warn', args: ['hi'] });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    event.extras.cycle = cyclic;
    transport.send(event);
    expect(calls[0]?.method).toBe('warn');
    const json = String(calls[0]?.args[0]);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('[Circular]');
  });

  it('maps fatal to console.error', () => {
    const { sink, calls } = makeSink();
    consoleTransport({ format: 'json', sink }).send(createEvent({ level: 'fatal', args: ['x'] }));
    expect(calls[0]?.method).toBe('error');
  });

  it('does not throw if the sink throws', () => {
    const transport = consoleTransport({
      format: 'json',
      sink: {
        error: () => { throw new Error('sink-fail'); },
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined
      }
    });
    expect(() => transport.send(createEvent({ level: 'error', args: ['x'] }))).not.toThrow();
  });
});
