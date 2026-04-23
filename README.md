# console.error
"framework" for console.error()


# uniferr · `console.error`, unified

[![npm version](https://img.shields.io/npm/v/uniferr?color=7F77DD&style=flat-square)](https://www.npmjs.com/package/uniferr)
[![bundle size](https://img.shields.io/bundlephobia/minzip/uniferr?label=core%20gzip&color=1D9E75&style=flat-square)](https://bundlephobia.com/package/uniferr)
[![CI](https://img.shields.io/github/actions/workflow/status/kamrankhan78694/console.error/ci.yml?style=flat-square)](https://github.com/kamrankhan78694/console.error/actions)
[![license](https://img.shields.io/github/license/kamrankhan78694/console.error?style=flat-square&color=888780)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-185FA5?style=flat-square)](https://www.typescriptlang.org/)

> A zero-dependency, environment-agnostic error framework that replaces the fragmented `console.error()` ecosystem with one composable **intercept → enrich → route → transport** pipeline.

---

## The problem

The current JavaScript error-handling landscape is split across incompatible tools:

| Tool | What it does well | What it doesn't |
|---|---|---|
| Winston / Bunyan | Structured logging, log levels | Node-only, no browser support |
| Sentry | Production monitoring, dashboards | SaaS lock-in, not embeddable |
| Browser DevTools | Interactive inspection | Non-programmable, gone in production |
| React error boundary | Component stack traces | React-only, not portable |
| Custom `console.error` override | Flexible | Re-implemented per project, no standard schema |

**`uniferr`** fixes this by providing a single pipeline that works everywhere — browser, Node.js, Deno, Cloudflare Workers, and Salesforce LWC — with a plugin API that lets you extend or replace any layer.

---

## Features

- 🌍 **Universal** — one API across Browser, Node ≥ 18, Deno, and Edge Workers
- 🪶 **Zero dependencies** in core — no Winston, no Sentry SDK, no axios
- 🌲 **Tree-shakeable** — importing `transport-console` never bundles `transport-file`
- 🔌 **Plugin API** — extend enrichment, routing, or transports without forking
- 🧩 **Composable middleware** — Koa-style async enricher pipeline
- 🔁 **Deduplication** — fingerprint-based suppression prevents log storms
- ⚛️ **React-aware** — optional enricher extracts the full component stack
- 📦 **≤ 4 KB gzipped** for core
- 💯 **TypeScript strict** throughout — no `any`, no type assertions

---

## Installation

```bash
# Core (required)
pnpm add uniferr

# Pick your transports (only bundle what you use)
pnpm add @uniferr/transport-console
pnpm add @uniferr/transport-file      # Node.js only
pnpm add @uniferr/transport-http

# Optional enrichers / plugins
pnpm add @uniferr/plugin-react
pnpm add @uniferr/plugin-apex         # Salesforce LWC + Apex
```

---

## Quick start

```ts
import { installIntercept, createPipeline, createRouter } from 'uniferr'
import { consoleTransport } from '@uniferr/transport-console'
import { stackTraceEnricher, dedupEnricher } from 'uniferr/enrichers'

// 1. Build your enrichment pipeline
const enrich = createPipeline([
  stackTraceEnricher,
  dedupEnricher({ maxOccurrences: 3 }),
])

// 2. Build your router
const transport = createRouter([
  {
    match: byLevel('fatal'),
    transports: [consoleTransport, httpTransport({ url: '/api/errors' })],
  },
  {
    match: always(),
    transports: [consoleTransport],
  },
])

// 3. Install — returns a teardown function
const uninstall = installIntercept({
  pipeline: enrich,
  transport,
})

// All console.error(), uncaught exceptions, and unhandled rejections
// now flow through your pipeline automatically.
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Error sources                       │
│  Browser  ·  Node.js  ·  React / LWC  ·  Edge Workers  │
└───────────────────────────┬─────────────────────────────┘
                            ↓
             ┌──────────────────────────┐
             │      Intercept core      │   ← console.error override
             │  + uncaught handlers     │     + window.onerror
             └──────────────┬───────────┘     + process.uncaughtException
                            ↓
        ┌───────────────────────────────────────┐
        │         Enrichment pipeline           │   ← async middleware
        │  stack trace · env · dedup · context  │     (Koa-style)
        └───────────────────┬───────────────────┘
                            ↓                         ╔══════════════╗
             ┌──────────────────────────┐             ║  Plugin API  ║
             │     Level + rule router  │ ← ─ ─ ─ ─  ║  addEnricher ║
             │  fatal · error · warn    │             ║  addTransport║
             └──────┬──────┬──────┬────┘             ╚══════════════╝
                    ↓      ↓      ↓
             Console  File  HTTP/Webhook  DB / Analytics
```

---

## Core concepts

### 1. The `UnifErrEvent` schema

Every error — wherever it originates — becomes a typed, structured event:

```ts
interface UnifErrEvent {
  id: string                          // crypto.randomUUID()
  timestamp: number                   // Date.now()
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug'
  message: string
  args: unknown[]                     // original console args, preserved
  stack?: StackFrame[]                // parsed, not raw string
  env: RuntimeEnv                     // runtime, release, url, userAgent…
  tags: Record<string, string>
  extras: Record<string, unknown>
  fingerprint?: string                // sha256(message + stack[0])
}
```

### 2. Enrichment pipeline

Enrichers are async middleware functions. They receive an event, mutate it, and call `next()`. They compose just like Express middleware — but dual sync/async and fully typed:

```ts
const myEnricher: Enricher = async (event, next) => {
  event.tags.region = getRegion()
  await next()
}

const pipeline = createPipeline([
  stackTraceEnricher,
  dedupEnricher({ maxOccurrences: 3 }),
  contextEnricher,
  myEnricher,
])
```

**Built-in enrichers:**

| Enricher | What it adds |
|---|---|
| `stackTraceEnricher` | Parses `Error.stack` into `StackFrame[]` (no source-map dep in core) |
| `dedupEnricher` | SHA-256 fingerprint; suppresses repeated events after N occurrences |
| `contextEnricher` | Thread-local context via `AsyncLocalStorage` (Node) / WeakMap (browser) |
| `reactEnricher` | Extracts component stack from React's fiber tree |

### 3. Router

Rules evaluate top-to-bottom; first match wins. Helper matchers are provided as named exports:

```ts
import { createRouter, byLevel, byTag, byMessage, always } from 'uniferr'

const transport = createRouter([
  {
    match: byMessage(/ChunkLoadError/),
    transports: [silentTransport],             // suppress noisy deploy errors
  },
  {
    match: byLevel('fatal'),
    transports: [consoleTransport, httpTransport, pagerdutyTransport],
  },
  {
    match: always(),
    transports: [consoleTransport],
  },
])
```

### 4. Transports

Each transport is its own package for tree-shaking. Any object matching `{ send(event: UnifErrEvent): void | Promise<void> }` qualifies as a transport.

**`@uniferr/transport-console`**
Pretty-prints with ANSI colours in TTY, structured JSON in non-TTY (CI, Docker). Uses the saved original `console` methods — no infinite loops.

**`@uniferr/transport-file`** *(Node.js only)*
Append-only NDJSON with log rotation (`maxSize`, `maxFiles`, gzip on rotate). Non-blocking `fs.createWriteStream`. Flushes on `process.exit`.

**`@uniferr/transport-http`**
POST as JSON to any endpoint. Exponential backoff with jitter (3 retries). Uses `sendBeacon` automatically for `fatal` events during page unload. Configurable `queueSize` with oldest-drop circuit breaker.

---

## Context API

Attach structured context to all events emitted within a scope:

```ts
import { setContext, withContext } from 'uniferr/context'

// Set globally for the session
setContext('userId', 'usr_abc123')
setContext('release', '2.4.1')

// Or scope to a single async operation (uses AsyncLocalStorage in Node)
await withContext({ requestId: req.id, route: req.path }, async () => {
  await processOrder(order)
  // Any console.error inside here carries requestId and route
})
```

---

## Plugin API

Plugins receive the full SDK and can add enrichers, transports, rules, and event listeners:

```ts
import type { UnifErrPlugin } from 'uniferr'

const myPlugin: UnifErrPlugin = {
  name: 'my-plugin',
  install(sdk) {
    sdk.addEnricher(async (event, next) => {
      event.tags.team = lookupTeam(event.stack?.[0]?.file)
      await next()
    })

    sdk.on('drop', (event) => {
      metrics.increment('uniferr.dropped', { level: event.level })
    })
  },
}
```

### Official plugins

**`@uniferr/plugin-react`**
Patches `React.__SECRET_INTERNALS` (guards behind `typeof React !== 'undefined'`) to extract the full fiber `displayName` chain. Attaches to `event.extras.componentStack`.

**`@uniferr/plugin-apex`** *(Salesforce LWC)*
Enriches events with `lwc:ref` and `component.name` from the LWC event target. Transports to an `@AuraEnabled` Apex endpoint via the LDS wire adapter. Ships with the companion `UnifErrLogger.cls` Apex class.

---

## Monorepo structure

```
uniferr/
├── packages/
│   ├── core/                   ← intercept, pipeline, router, plugin API
│   ├── transport-console/
│   ├── transport-file/
│   ├── transport-http/
│   └── plugin-apex/
├── examples/
│   ├── node-express/           ← file + console transports
│   ├── react-app/              ← dedup + reactEnricher + http transport
│   └── cloudflare-worker/      ← JSON console transport
└── docs/
    └── architecture.md
```

Built with **pnpm workspaces** + **Turborepo**. Compiled with **tsup** (ESM + CJS dual output). Tested with **Vitest** (unit) and **Playwright** (browser E2E).

---

## Development

```bash
# Clone and install
git clone https://github.com/kamrankhan78694/console.error.git
cd console.error
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test --watch

# Check bundle size (fails CI if core > 4 KB gzipped)
pnpm size

# Lint + typecheck
pnpm lint
pnpm typecheck
```

### Running examples

```bash
# Node.js + Express
cd examples/node-express && pnpm dev

# React app (CRA)
cd examples/react-app && pnpm dev

# Cloudflare Worker
cd examples/cloudflare-worker && pnpm dev
```

---

## Configuration reference

```ts
interface InterceptConfig {
  pipeline:       (event: UnifErrEvent) => Promise<void>
  transport:      Transport
  levels?:        Level[]           // default: all levels
  plugins?:       UnifErrPlugin[]
  onDrop?:        (event: UnifErrEvent) => void
  release?:       string            // overrides __UNIFERR_RELEASE__
}
```

### Environment variable / build-time injection

```ts
// vite.config.ts / webpack DefinePlugin
define: {
  __UNIFERR_RELEASE__: JSON.stringify(process.env.npm_package_version)
}
```

---

## Comparison

| | `uniferr` | Winston | Sentry SDK | Custom override |
|---|---|---|---|---|
| Browser support | ✅ | ❌ | ✅ | ✅ |
| Node.js support | ✅ | ✅ | ✅ | ✅ |
| Edge / Workers | ✅ | ❌ | ⚠️ partial | ✅ |
| Zero dependencies | ✅ | ❌ | ❌ | ✅ |
| Structured schema | ✅ | ✅ | ✅ | ❌ |
| Composable pipeline | ✅ | ⚠️ | ❌ | ❌ |
| Self-hosted | ✅ | ✅ | ❌ | ✅ |
| React component stack | ✅ (plugin) | ❌ | ✅ | ⚠️ manual |
| Deduplication | ✅ built-in | ❌ | ✅ | ❌ |
| TypeScript strict | ✅ | ⚠️ | ⚠️ | ❌ |
| Bundle size | ≤ 4 KB | ~120 KB | ~80 KB | ~0 KB |

---

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/): `feat(core): add sampling support`
4. Open a pull request against `main`

All PRs must pass `pnpm lint && pnpm typecheck && pnpm test` and must not increase core bundle size beyond 4 KB gzipped.

---

## Roadmap

- [ ] Source-map support in `stackTraceEnricher` (opt-in, separate package)
- [ ] `transport-datadog` and `transport-logtail` official packages
- [ ] Sampling API: `sample({ rate: 0.1, levels: ['warn'] })`
- [ ] OpenTelemetry span correlation enricher
- [ ] Browser session replay integration hooks
- [ ] `uniferr init` CLI scaffold

---

## License

[MIT](./LICENSE) © [Kamran Khan](https://github.com/kamrankhan78694)
