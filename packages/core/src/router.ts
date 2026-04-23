import type { Level, Transport, UnifErrEvent } from './types';

export type Matcher = (event: UnifErrEvent) => boolean;

export interface RouterRule {
  match: Matcher;
  transports: ReadonlyArray<Transport>;
  transform?: (event: UnifErrEvent) => UnifErrEvent;
}

const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
};

export function byLevel(min: Level): Matcher {
  const minRank = LEVEL_RANK[min];
  return (event) => LEVEL_RANK[event.level] >= minRank;
}

export function byTag(key: string, value: string): Matcher {
  return (event) => event.tags[key] === value;
}

export function byMessage(pattern: RegExp): Matcher {
  return (event) => pattern.test(event.message);
}

export function always(): Matcher {
  return () => true;
}

export interface RouterOptions {
  /** Called when no rule matches. Defaults to a no-op. */
  onUnmatched?: (event: UnifErrEvent) => void;
}

export function createRouter(
  rules: ReadonlyArray<RouterRule>,
  options: RouterOptions = {}
): Transport {
  const compiled = rules.slice();

  return {
    async send(event: UnifErrEvent): Promise<void> {
      for (const rule of compiled) {
        let matched = false;
        try {
          matched = rule.match(event);
        } catch {
          matched = false;
        }
        if (!matched) {
          continue;
        }

        const transformed = rule.transform ? rule.transform(event) : event;
        await Promise.allSettled(
          rule.transports.map((transport) => Promise.resolve().then(() => transport.send(transformed)))
        );
        return;
      }
      options.onUnmatched?.(event);
    }
  };
}
