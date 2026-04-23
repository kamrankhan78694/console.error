import { describe, expect, it, vi } from 'vitest';
import { createEvent } from '@uniferr/core';

import { httpTransport } from '../src/index';

type FetchFn = typeof globalThis.fetch;

function okFetch(): ReturnType<typeof vi.fn<FetchFn>> {
  return vi.fn<FetchFn>(async () => new Response(null, { status: 200 }));
}

describe('httpTransport', () => {
  it('POSTs events as JSON', async () => {
    const fetch = okFetch();
    const t = httpTransport({ url: 'https://example.com/ingest', fetch });
    t.send(createEvent({ level: 'error', args: ['boom'] }));
    await t.flush?.();
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).message).toBe('boom');
  });

  it('retries failed requests with exponential backoff', async () => {
    let calls = 0;
    const fetch = vi.fn<FetchFn>(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 200 });
    });
    const t = httpTransport({
      url: 'https://example.com/ingest',
      fetch,
      maxRetries: 5,
      initialBackoffMs: 1
    });
    t.send(createEvent({ level: 'error', args: ['x'] }));
    await t.flush?.();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('drops events from the queue after maxRetries and surfaces onError', async () => {
    const fetch = vi.fn<FetchFn>(async () => new Response(null, { status: 500 }));
    const errors: unknown[] = [];
    const t = httpTransport({
      url: 'https://example.com/ingest',
      fetch,
      maxRetries: 2,
      initialBackoffMs: 1,
      onError: (e) => errors.push(e)
    });
    t.send(createEvent({ level: 'error', args: ['x'] }));
    await t.flush?.();
    expect(errors).toHaveLength(1);
  });

  it('drops oldest entries when the queue is full', async () => {
    const dropped: string[] = [];
    // A fetch that never resolves so the queue fills.
    const fetch = vi.fn<FetchFn>((): Promise<Response> => new Promise(() => undefined));
    const t = httpTransport({
      url: 'https://example.com/ingest',
      fetch,
      queueSize: 2,
      onDrop: (e) => dropped.push(e.message)
    });
    t.send(createEvent({ level: 'error', args: ['a'] }));
    t.send(createEvent({ level: 'error', args: ['b'] }));
    t.send(createEvent({ level: 'error', args: ['c'] }));
    expect(dropped).toEqual(['a']);
  });

  it('uses sendBeacon for fatal events when available', () => {
    const sendBeacon = vi.fn<(url: string, data: string) => boolean>(() => true);
    const fetch = okFetch();
    const t = httpTransport({
      url: 'https://example.com/ingest',
      fetch,
      sendBeacon
    });
    t.send(createEvent({ level: 'fatal', args: ['die'] }));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
