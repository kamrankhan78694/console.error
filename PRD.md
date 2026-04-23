
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROBLEM STATEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The current console.error() landscape is broken by fragmentation:
  - Winston/Bunyan: Node-only, no browser support, no unified API
  - Sentry: Paid/SaaS lock-in, not embeddable as a local library
  - Browser DevTools: Non-programmable, disappears in production
  - React's component-stack patch: Framework-specific, not portable
  - Custom overrides: Duplicated per-project, no standard schema

Build a single framework that replaces all of the above with one
composable, pluggable, fully typed intercept → enrich → route → transport pipeline.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARCHITECTURE CONSTRAINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ZERO dependencies in core (no Winston, no Sentry SDK, no axios)
2. ESM + CJS dual output via tsup
3. Tree-shakeable — importing only the console transport must NOT bundle
   the file transport or the DB transport
4. Runtime targets: Browser, Node.js ≥18, Deno, Cloudflare Workers, LWC
5. TypeScript strict mode throughout. No `any`. No type assertions.
6. Bundle size budget: core ≤ 4 KB gzipped


<img width="986" height="754" alt="image" src="https://github.com/user-attachments/assets/a38a67dc-7b01-4605-ab9c-03fd0bd02424" />






━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — CORE INTERCEPT ENGINE  (build this first)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
File: packages/core/src/intercept.ts

Implement `installIntercept(config: InterceptConfig): () => void`
  - Override console.error, console.warn, console.debug, console.info
    via Object.defineProperty to make them non-configurable post-install
  - In browser: also attach window.onerror and 
    window.addEventListener('unhandledrejection', ...)
  - In Node: also attach process.on('uncaughtException', ...)
    and process.on('unhandledRejection', ...)
  - Return a teardown function that fully restores the original methods
  - Must be idempotent — calling installIntercept twice must be a no-op
    (detect via a hidden Symbol on the console object)

The canonical error event schema (ErrorEvent — NOT the DOM type):
  interface UnifErrEvent {
    id: string                  // crypto.randomUUID()
    timestamp: number           // Date.now()
    level: 'fatal'|'error'|'warn'|'info'|'debug'
    message: string
    args: unknown[]             // original console args preserved
    stack?: string              // parsed StackFrame[] (see Phase 2)
    env: RuntimeEnv             // see below
    tags: Record<string, string>
    extras: Record<string, unknown>
    fingerprint?: string        // sha256 of message+stack[0]
  }

  interface RuntimeEnv {
    runtime: 'browser'|'node'|'deno'|'worker'
    release?: string            // injected at build time via __UNIFERR_RELEASE__
    url?: string                // window.location.href if browser
    userAgent?: string          // navigator.userAgent if browser
    nodeVersion?: string        // process.version if node
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 — ENRICHMENT PIPELINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
File: packages/core/src/pipeline.ts

Implement a middleware pipeline identical in shape to Koa's but synchronous
and async-dual (each enricher can be sync or return Promise<void>):

  type Enricher = (event: UnifErrEvent, next: () => Promise<void>) => 
    void | Promise<void>

  createPipeline(enrichers: Enricher[]): (event: UnifErrEvent) => Promise<void>

Ship these built-in enrichers as named exports (individually tree-shakeable):

  stackTraceEnricher  — parse Error.stack using a hand-rolled regex 
                        (no dependency on source-map or stacktrace-js in core).
                        Produce StackFrame[]: { file, line, col, fn, native }
                        
  dedupEnricher       — attach a fingerprint (SHA-256 via SubtleCrypto or
                        Node crypto, whichever is available). Suppress
                        re-emitting the same fingerprint more than N times
                        per session (configurable, default 3).
                        
  contextEnricher     — reads from a thread-local-style store:
                        In Node use AsyncLocalStorage.
                        In browser use a module-level WeakMap keyed on 
                        the current microtask queue position (best-effort).
                        Expose setContext(key, value) and withContext(fn).
                        
  reactEnricher       — monkey-patches React.__SECRET_INTERNALS if present
                        to extract the current fiber's displayName chain.
                        Attaches component stack to event.extras.componentStack
                        Guards behind typeof React !== 'undefined'.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 3 — LEVEL ROUTER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
File: packages/core/src/router.ts

  interface RouterRule {
    match: (event: UnifErrEvent) => boolean
    transports: Transport[]
    transform?: (event: UnifErrEvent) => UnifErrEvent
  }

  createRouter(rules: RouterRule[]): Transport

Rules evaluate in order; first match wins. 
Provide helper matchers as named exports:
  byLevel(min: Level): (e) => boolean
  byTag(key: string, value: string): (e) => boolean
  byMessage(pattern: RegExp): (e) => boolean
  always(): (e) => boolean

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 4 — BUILT-IN TRANSPORTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each transport is its own sub-package for tree-shaking:

packages/transport-console/
  - Pretty-print with ANSI colors in Node (detect via process.stdout.isTTY)
  - Structured JSON in non-TTY (CI, Docker)
  - In browser: use console.group/groupEnd with color via %c
  - Respects the original console methods (call the SAVED originals, 
    not the overridden ones, to avoid infinite loops)

packages/transport-file/  (Node only)
  - Append-only NDJSON log rotation:
    rotate when file exceeds maxSize (default 10 MB)
    keep maxFiles rotated files (default 5), gzip the old ones
  - Non-blocking: use fs.createWriteStream with { flags:'a' }
  - Batch + flush on process.exit via process.on('exit')

packages/transport-http/
  - POST event as JSON to a configurable endpoint
  - Retry with exponential backoff (3 attempts, jitter)
  - In browser: prefer sendBeacon for fatal/page-unload events
  - Respect a queueSize limit; drop oldest when full (circuit-breaker pattern)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 5 — PLUGIN API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
File: packages/core/src/plugin.ts

  interface UnifErrPlugin {
    name: string
    install(sdk: UnifErrSDK): void | Promise<void>
  }

  interface UnifErrSDK {
    addEnricher(e: Enricher): void
    addTransport(t: Transport): void
    addRule(r: RouterRule): void
    getConfig(): Readonly<UnifErrConfig>
    on(event: 'error'|'drop'|'flush', handler: Function): void
  }

Ship one reference plugin as the integration test target:
packages/plugin-apex/  (Salesforce LWC + Apex bridge)
  - Enricher: reads lwc:ref and component.name from the LWC event target
  - Transport: POST to an Apex @AuraEnabled endpoint via LDS wire adapter
  - Include the companion Apex class: UnifErrLogger.cls

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 6 — TESTING & QUALITY GATES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Vitest for all unit tests. 100% coverage on core packages.
- Playwright for browser E2E: open a blank page, install intercept, 
  throw an error, assert the event reaches transport-http mock.
- Add a GitHub Actions workflow: lint → typecheck → test → bundle-size-check
  (fail if core gzip > 4096 bytes).
- Provide a /examples directory with three runnable demos:
    examples/node-express  — express app with file + console transports
    examples/react-app     — CRA app with dedup + reactEnricher + http transport
    examples/cloudflare-worker — Worker with json console transport

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MONOREPO STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
uniferr/
├── packages/
│   ├── core/
│   ├── transport-console/
│   ├── transport-file/
│   ├── transport-http/
│   └── plugin-apex/
├── examples/
├── docs/
│   └── architecture.md      ← generate this from the code, not from scratch
├── pnpm-workspace.yaml
└── turbo.json               ← use Turborepo for build orchestration

Use pnpm workspaces + Turborepo. tsup for builds. Vitest for tests.
ESLint with @typescript-eslint/strict. Prettier.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXECUTION ORDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Do NOT skip phases or generate stubs. Build each phase fully before moving
to the next. After each phase, run `pnpm test` and fix all failures before
proceeding. If a design decision is genuinely ambiguous, implement the
simplest correct option and leave a // DECISION: comment explaining the
trade-off — do not ask me, just decide and document.

Start with Phase 1. Show me the file tree first, then implement.
