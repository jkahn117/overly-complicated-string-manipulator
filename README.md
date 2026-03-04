# Workers for Platforms — Dynamic Pipeline Execution

A Cloudflare Workers demo that orchestrates tenant request processing through configurable pipelines, with a browser-based pipeline builder UI.

Users build a pipeline of ordered transformation steps (built-in string operations and custom tenant Workers), execute it against the dispatch worker, and view step-by-step results alongside the generated isolate code.

## How It Works

This project combines two Cloudflare Workers primitives — **Worker Loader** and **Workers for Platforms (WfP)** — to run tenant-defined logic safely and dynamically, without redeploying the dispatch worker.

### Worker Loader: dynamic code generation

The dispatch worker doesn't hardcode pipeline logic. Instead, on each execution request it:

1. Reads the tenant's pipeline definition from KV (an ordered list of steps).
2. **Generates a complete Worker module at runtime** (`codegen.ts`) — a valid ES module with a `fetch` handler that executes each step sequentially.
3. Loads the generated code into a **Worker Loader isolate** via the `LOADER` binding. The isolate is keyed by `{tenantName}:{pipelineVersion}`, so unchanged pipelines reuse a cached isolate and config changes invalidate it automatically.

Built-in steps (uppercase, trim, replace, etc.) compile to inline JavaScript inside the generated module. The isolate runs with `globalOutbound: null` — no raw internet access.

### Workers for Platforms: custom tenant code

Custom steps can't be inlined because they contain **tenant-authored code** that must run in its own isolated environment. The execution flow for a custom step is:

1. When a tenant creates or updates a custom worker through the CRUD API, the code is saved to KV **and** deployed to a WfP **dispatch namespace** via the Cloudflare REST API. Script names are scoped per tenant (`{tenantId}--{workerName}`) to prevent collisions.

2. At pipeline execution time, the dispatch worker creates a **`CustomProxy` WorkerEntrypoint** per custom step via `ctx.exports.CustomProxy()` and injects it into the isolate's `env` as a service binding (e.g. `env.CUSTOM_acme_step`).

3. Inside the generated isolate code, a custom step calls `await env.CUSTOM_acme_step.transform(data)` — an **RPC call** to the proxy, not an HTTP request.

4. The `CustomProxy` validates the worker name against the tenant's allowed list (cross-tenant isolation), then calls `DISPATCHER.get("{tenantId}--{workerName}")` to obtain the tenant's script from the dispatch namespace and forwards the input via `fetch()`.

```
Isolate (generated code)
  |
  | env.CUSTOM_xyz.transform(data)   ← RPC, not HTTP
  v
CustomProxy (WorkerEntrypoint)
  |
  | DISPATCHER.get("tenant--xyz")    ← WfP dispatch namespace lookup
  v
Tenant Worker (isolated)
  |
  | fetch(POST, text/plain body)     ← HTTP (dispatch namespace stubs are Fetcher-based)
  v
Response (text/plain) flows back up
```

The two execution models coexist in a single pipeline. A four-step pipeline might run steps 0, 1, and 3 as inline JS in the isolate, while step 2 calls out to the dispatch namespace through the proxy.

### Request lifecycle

```
Browser → POST / (x-tenant-id header, text/plain body)
  → Tenant middleware: resolve tenant config from KV
  → codegen: generate Worker module from pipeline definition
  → LOADER.get(): load (or reuse cached) isolate with generated code
  → Inject CustomProxy service bindings into isolate env
  → isolate.fetch(): run pipeline, each step transforms the string
     ├── builtin steps: inline JS (toUpperCase, replaceAll, trim, ...)
     └── custom steps: RPC → CustomProxy → DISPATCHER → tenant Worker
  → Return JSON envelope { data, history, generatedCode? }
```

## Quick Start

```sh
pnpm install
pnpm build:web   # build the frontend into dist/
pnpm dev          # start wrangler dev on :8787
```

Open `http://localhost:8787` to use the pipeline builder.

> **Note:** Custom steps that call the dispatch namespace will fail in local dev
> (miniflare limitation). Built-in steps work fully offline.

### Deploy

Custom workers are deployed to the dispatch namespace via the Cloudflare REST API
whenever they are created or updated through the CRUD routes. This requires three
pieces of configuration:

1. Set your account ID in `wrangler.jsonc` under `vars.CF_ACCOUNT_ID`
2. Create an API token with **Workers Scripts:Edit** permission
3. Add the token as a secret:

```sh
npx wrangler secret put CF_API_TOKEN
```

The dispatch namespace name (`CF_DISPATCH_NAMESPACE`) defaults to `wfp-dynamics`
and is already set in `wrangler.jsonc`. Create the namespace in the dashboard or
via the API before deploying:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/dispatch/namespaces" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "wfp-dynamics"}'
```

Then deploy:

```sh
pnpm deploy       # builds frontend + wrangler deploy
```

If `CF_ACCOUNT_ID` or `CF_API_TOKEN` are not set, the CRUD routes still work
(code is saved to KV) but scripts are not deployed to the dispatch namespace,
so custom pipeline steps will fail at execution time.

### Run Tests

```sh
pnpm test         # 52 tests across 4 suites
```

## Project Structure

```
├── src/
│   ├── index.ts           # Hono app: middleware, pipeline execution, asset fallback
│   ├── types.ts           # PipelineEnvelope, Tenant, CustomWorkerRecord, FlowError
│   ├── middleware.ts       # Tenant resolution from x-tenant-id header + KV
│   ��── codegen.ts         # Generates pipeline Worker code (builtin + custom steps)
│   ├── dispatch.ts        # WfP REST API client (deploy/delete scripts in dispatch namespace)
│   ├── proxy.ts           # CustomProxy WorkerEntrypoint (RPC → dispatch namespace)
│   └── routes/
│       ├── admin.ts       # POST /admin/tenants (create tenant)
│       └── workers.ts     # Custom worker CRUD (list, get, create, update, delete)
├── web/                   # Frontend (Astro static site)
│   ├── src/
│   │   ├── pages/index.astro
│   │   ├── layouts/Base.astro
│   │   ├── components/    # Header, InputField, PipelineEditor, StepCard,
│   │   │                  # RunButton, OutputPanel, Arrow
│   │   ├── scripts/pipeline.ts   # Alpine.js store: state, API calls, worker CRUD
│   │   └── styles/global.css     # Tailwind v4 + design tokens
│   └── astro.config.mjs          # Static output to ../dist/
├── test/
│   ├── index.spec.ts      # Pipeline execution (13 tests)
│   ├── admin.spec.ts      # Admin routes (6 tests)
│   ├── workers.spec.ts    # Worker CRUD (16 tests)
│   └── codegen.spec.ts    # Code generation (17 tests)
├── wrangler.jsonc         # Bindings: KV, DISPATCHER, LOADER, ASSETS
├── pnpm-workspace.yaml    # Workspace: root + web/
└── package.json           # Scripts: dev, build:web, deploy, test
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `TENANTS` | KV Namespace | Tenant config + custom worker code storage |
| `DISPATCHER` | Dispatch Namespace | Routes to custom tenant Workers at runtime |
| `LOADER` | Worker Loader | Loads dynamically generated pipeline isolates |
| `ASSETS` | Assets | Serves the static frontend (with `run_worker_first: true`) |

### Environment Variables

| Variable | Type | Purpose |
|----------|------|---------|
| `CF_ACCOUNT_ID` | var | Cloudflare account ID (set in `wrangler.jsonc`) |
| `CF_DISPATCH_NAMESPACE` | var | Dispatch namespace name (default: `wfp-dynamics`) |
| `CF_API_TOKEN` | secret | API token with Workers Scripts:Edit permission |

## API

All API routes (except `/admin/*`) require the `x-tenant-id` header.

### Pipeline Execution

**`POST /`** — Execute the tenant's saved pipeline.

- Body: `text/plain` (input string)
- Query: `?include=code` to include generated isolate source in response
- Response: JSON envelope with `data`, `history`, and optionally `generatedCode`

**`PUT /pipeline`** — Save/update the tenant's pipeline definition.

- Body: `{ "pipeline": { "steps": [...] } }`
- Response: `{ "tenantId", "name", "pipelineVersion" }`

### Tenant Management

**`POST /admin/tenants`** — Create a new tenant.

- Body: `{ "name", "pipeline", "tenantId?" }`
- The optional `tenantId` field lets the caller choose the ID (used by the frontend's auto-create-on-first-run flow).

### Custom Worker CRUD

All routes under `/workers` are scoped to the current tenant.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workers` | List all custom workers (name + updatedAt) |
| `GET` | `/workers/:name` | Get worker details including code |
| `POST` | `/workers` | Create a worker (`{ "name", "code?" }`) |
| `PUT` | `/workers/:name` | Update worker code (`{ "code" }`) |
| `DELETE` | `/workers/:name` | Delete a worker |

Create and update are **synchronous** — the response is not sent until the worker is deployed to the dispatch namespace, so the pipeline can execute against the latest code immediately. If the deploy fails, the KV write still succeeds and the response includes a `warning` field.

## Tenant Configuration

Stored in KV, keyed by tenant ID:

```json
{
  "name": "acme",
  "status": "active",
  "pipelineVersion": "v1",
  "pipeline": {
    "steps": [
      { "type": "builtin", "op": "uppercase" },
      { "type": "builtin", "op": "replace", "config": { "find": "FOO", "replace": "BAR" } },
      { "type": "custom", "workerName": "acme-custom-step" },
      { "type": "builtin", "op": "trim" }
    ]
  }
}
```

### Built-in Operations

| Operation | Description | Config |
|-----------|-------------|--------|
| `uppercase` | Convert to uppercase | -- |
| `lowercase` | Convert to lowercase | -- |
| `trim` | Remove leading/trailing whitespace | -- |
| `replace` | Find and replace substring | `{ "find", "replace" }` |
| `prefix` | Prepend a string | `{ "value" }` |
| `suffix` | Append a string | `{ "value" }` |

### Custom Worker Contract

Custom workers are tenant-authored JavaScript modules deployed to the dispatch namespace:

```js
export default {
  async fetch(request) {
    const input = await request.text();
    const output = input.toUpperCase() + "!!!";
    return new Response(output);
  }
};
```

- Receives: `POST` with `text/plain` body
- Returns: `text/plain` body (transformed string)
- Runs in the dispatch namespace (untrusted, isolated per-request)

## Frontend

The UI is a single-page Astro static site using Alpine.js for reactivity and Tailwind CSS v4 for styling. It builds to `dist/` and is served by the worker via the `ASSETS` binding.

### Features

- **Tenant selector** — Text input synced to `?tenant=` URL param, defaults to "playground". Auto-creates the tenant on first use if it doesn't exist.
- **Pipeline builder** — Add/remove/reorder built-in and custom steps. Built-in steps show blue badges; custom steps show amber badges. Steps with config (replace, prefix, suffix) show inline config fields.
- **Custom worker editor** — Create, edit, and delete custom workers with an inline code editor. Shows deploying/saving/deleting progress with spinners. Surfaces deploy warnings and success confirmations.
- **Run** — Saves the pipeline, executes it, and displays the result. Ctrl/Cmd+Enter keyboard shortcut.
- **Output panel** — Tabbed view showing the final result with step-by-step history, and a "Generated Code" tab with the isolate source and a copy button.

### Tech Stack

- [Astro](https://astro.build/) — Static site generator (output mode: `static`)
- [Alpine.js](https://alpinejs.dev/) ��� Lightweight reactivity (installed via pnpm, not CDN)
- [Tailwind CSS v4](https://tailwindcss.com/) — Utility-first CSS via `@tailwindcss/vite`

## Response Format

**Success (200):**

```json
{
  "data": "HELLO BAR!!!",
  "history": [
    { "step": 0, "type": "builtin", "op": "uppercase", "input": "  hello foo  ", "output": "  HELLO FOO  " },
    { "step": 1, "type": "builtin", "op": "replace", "input": "  HELLO FOO  ", "output": "  HELLO BAR  " },
    { "step": 2, "type": "custom", "op": "acme-custom-step", "input": "  HELLO BAR  ", "output": "  HELLO BAR!!!" },
    { "step": 3, "type": "builtin", "op": "trim", "input": "  HELLO BAR!!!", "output": "HELLO BAR!!!" }
  ],
  "generatedCode": "..."
}
```

**Error (500):**

```json
{
  "error": "Custom worker \"acme-custom-step\" returned status 500",
  "step": 2,
  "op": "custom:acme-custom-step",
  "history": [
    { "step": 0, "type": "builtin", "op": "uppercase", "input": "...", "output": "..." },
    { "step": 1, "type": "builtin", "op": "replace", "input": "...", "output": "..." }
  ]
}
```

Errors include partial history (steps completed before failure).

## Design Decisions

1. **Single isolate per pipeline** — All steps run in one Worker Loader isolate. Built-in ops are inline JS; custom steps call back via `ctx.exports`-injected service bindings. Avoids per-step isolate overhead.

2. **String-in, string-out** — Every step takes a plain string and returns a plain string. The JSON envelope is assembled by the generated pipeline code, not by individual steps.

3. **RPC between isolate and proxy** — The isolate calls `CustomProxy.transform(data)` via RPC (not HTTP). Only the proxy-to-tenant hop uses `fetch()` because dispatch namespace stubs are Fetcher-based. This keeps serialization overhead minimal for the internal hop.

4. **CustomProxy for tenant isolation** — Tenant Workers are called through a `CustomProxy` WorkerEntrypoint, not directly from the isolate. The proxy validates worker names against an allowed list, preventing cross-tenant invocation. The isolate runs with `globalOutbound: null` (no raw internet access).

5. **Synchronous dispatch deploy** — Worker create/update routes `await` the dispatch namespace deployment before responding. This prevents a race condition where the frontend runs the pipeline before the updated code is live.

6. **Assets + API coexistence** — `run_worker_first: true` sends all requests to the worker first. API routes are handled by Hono; unmatched GET requests fall through to `env.ASSETS.fetch()` for static files.

7. **KV for everything** — Tenant config and custom worker code share the same KV namespace. Worker keys use `{tenantId}:worker:{name}` with metadata for cheap listing without fetching values.

8. **Isolate caching by version** — Isolate ID is `tenantName:pipelineVersion`. Unchanged pipelines reuse cached isolates. Saving a pipeline bumps the version, invalidating the cache.

9. **Auto-create tenant** — The frontend auto-creates the tenant on first use by probing `GET /workers` and calling `POST /admin/tenants` on 404. No manual setup required.

10. **Pipeline short-circuits on error** — If any step fails, the pipeline stops and returns partial history. Each step is wrapped in its own try/catch for precise error attribution.
