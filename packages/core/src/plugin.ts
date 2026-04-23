import type { Level, Transport, UnifErrEvent } from './types';
import type { Enricher } from './pipeline';
import type { RouterRule } from './router';

export type LifecycleEvent = 'error' | 'drop' | 'flush';

export interface LifecycleHandlers {
  error?: (error: unknown, event?: UnifErrEvent) => void;
  drop?: (event: UnifErrEvent, reason: string) => void;
  flush?: () => void;
}

export interface UnifErrSDK {
  addEnricher(enricher: Enricher): void;
  addTransport(transport: Transport): void;
  addRule(rule: RouterRule): void;
  on(event: 'error', handler: NonNullable<LifecycleHandlers['error']>): void;
  on(event: 'drop', handler: NonNullable<LifecycleHandlers['drop']>): void;
  on(event: 'flush', handler: NonNullable<LifecycleHandlers['flush']>): void;
  getConfig(): Readonly<RegistrySnapshot>;
}

export interface RegistrySnapshot {
  enrichers: ReadonlyArray<Enricher>;
  transports: ReadonlyArray<Transport>;
  rules: ReadonlyArray<RouterRule>;
  levels: ReadonlyArray<Level>;
}

export interface UnifErrPlugin {
  name: string;
  install(sdk: UnifErrSDK): void | Promise<void>;
}

interface ListenerSets {
  error: Set<NonNullable<LifecycleHandlers['error']>>;
  drop: Set<NonNullable<LifecycleHandlers['drop']>>;
  flush: Set<NonNullable<LifecycleHandlers['flush']>>;
}

export class Lifecycle {
  private readonly listeners: ListenerSets = {
    error: new Set(),
    drop: new Set(),
    flush: new Set()
  };

  on(event: 'error', handler: NonNullable<LifecycleHandlers['error']>): void;
  on(event: 'drop', handler: NonNullable<LifecycleHandlers['drop']>): void;
  on(event: 'flush', handler: NonNullable<LifecycleHandlers['flush']>): void;
  on(event: LifecycleEvent, handler: (...args: never[]) => void): void {
    // Cast is safe: each branch only ever stores a handler matching the event union.
    if (event === 'error') {
      this.listeners.error.add(handler as unknown as NonNullable<LifecycleHandlers['error']>);
    } else if (event === 'drop') {
      this.listeners.drop.add(handler as unknown as NonNullable<LifecycleHandlers['drop']>);
    } else {
      this.listeners.flush.add(handler as unknown as NonNullable<LifecycleHandlers['flush']>);
    }
  }

  emitError(error: unknown, event?: UnifErrEvent): void {
    for (const handler of this.listeners.error) {
      try {
        handler(error, event);
      } catch {
        // Swallow listener errors to preserve invariants.
      }
    }
  }

  emitDrop(event: UnifErrEvent, reason: string): void {
    for (const handler of this.listeners.drop) {
      try {
        handler(event, reason);
      } catch {
        // Swallow listener errors to preserve invariants.
      }
    }
  }

  emitFlush(): void {
    for (const handler of this.listeners.flush) {
      try {
        handler();
      } catch {
        // Swallow listener errors to preserve invariants.
      }
    }
  }
}
