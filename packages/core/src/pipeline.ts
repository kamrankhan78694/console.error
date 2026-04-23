import type { UnifErrEvent } from './types';

/**
 * Koa-style middleware that may be sync or async. Each enricher MUST call
 * `next()` at most once. Calling it more than once throws synchronously to
 * surface contract violations early.
 */
export type Enricher = (event: UnifErrEvent, next: () => Promise<void>) => void | Promise<void>;

export type Pipeline = (event: UnifErrEvent) => Promise<void>;

export function createPipeline(enrichers: ReadonlyArray<Enricher>): Pipeline {
  const chain = enrichers.slice();

  return async function dispatch(event: UnifErrEvent): Promise<void> {
    let lastIndex = -1;

    const invoke = async (index: number): Promise<void> => {
      if (index <= lastIndex) {
        throw new Error('uniferr: next() called multiple times');
      }
      lastIndex = index;

      const enricher = chain[index];
      if (!enricher) {
        return;
      }

      const result = enricher(event, () => invoke(index + 1));
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
    };

    await invoke(0);
  };
}
