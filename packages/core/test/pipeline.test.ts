import { describe, expect, it } from 'vitest';

import { createPipeline, type Enricher } from '../src/pipeline';
import { createEvent } from '../src/event';

function makeEvent() {
  return createEvent({ level: 'error', args: ['m'] });
}

describe('createPipeline', () => {
  it('runs enrichers in order and awaits async ones', async () => {
    const order: string[] = [];
    const a: Enricher = async (_, next) => {
      order.push('a:before');
      await next();
      order.push('a:after');
    };
    const b: Enricher = async (_, next) => {
      order.push('b:before');
      await new Promise<void>((r) => setTimeout(r, 1));
      await next();
      order.push('b:after');
    };
    const c: Enricher = (event, next) => {
      order.push('c');
      event.tags.touched = 'yes';
      return next();
    };

    const event = makeEvent();
    await createPipeline([a, b, c])(event);
    expect(order).toEqual(['a:before', 'b:before', 'c', 'b:after', 'a:after']);
    expect(event.tags.touched).toBe('yes');
  });

  it('throws when next() is called twice', async () => {
    const buggy: Enricher = async (_e, next) => {
      await next();
      await next();
    };
    await expect(createPipeline([buggy])(makeEvent())).rejects.toThrow(/multiple times/);
  });

  it('supports an empty pipeline', async () => {
    await expect(createPipeline([])(makeEvent())).resolves.toBeUndefined();
  });

  it('propagates errors from enrichers', async () => {
    const boom: Enricher = () => {
      throw new Error('nope');
    };
    await expect(createPipeline([boom])(makeEvent())).rejects.toThrow('nope');
  });

  it('stops downstream enrichers when an enricher does not call next()', async () => {
    const order: string[] = [];
    const stop: Enricher = () => {
      order.push('stop');
    };
    const after: Enricher = (_e, next) => {
      order.push('after');
      return next();
    };
    await createPipeline([stop, after])(makeEvent());
    expect(order).toEqual(['stop']);
  });
});
