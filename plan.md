# Implementation Plan (v2)

## Architecture: Single Isolate per Pipeline

**Previous (v1)**: one isolate per builtin step + separate DISPATCHER calls for custom steps.
**Current (v2)**: one LOADER isolate per pipeline execution. The generated code runs ALL steps — builtins inline as JS, custom steps via service bindings injected through `ctx.exports`.

```
Dispatch Worker (Hono)
  |
  |-- Middleware: resolve tenant from KV, validate status
  |-- POST /: build pipeline isolate
  |     |
  |     |-- Generate JS that runs ALL steps in sequence
  |     |-- Inject custom Worker bindings via ctx.exports.CustomProxy
  |     |     (one per custom step, scoped to allowed workerNames)
  |     |-- env.LOADER.get(isolateId, callback) -> single isolate
  |     |
  |     v
  |   Single LOADER Isolate
  |     |-- Step 1: builtin (inline JS)
  |     |-- Step 2: builtin (inline JS)
  |     |-- Step 3: env.CUSTOM_acme_step.fetch(data) -> CustomProxy -> DISPATCHER
  |     |-- Step 4: builtin (inline JS)
  |     |-- Returns JSON envelope { data, history }
  |     |
  v
Response (JSON envelope with history)
```

### CustomProxy Entrypoint

Exported from the dispatch worker. Wraps `DISPATCHER.get()` so the isolate can call
tenant Workers as service bindings. Validates that the requested `workerName` is in the
allowed list (passed via `ctx.props`).

```ts
export class CustomProxy extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const { workerName, allowedWorkers } = this.ctx.props;
    if (!allowedWorkers.includes(workerName)) {
      return new Response("Unauthorized worker", { status: 403 });
    }
    const worker = this.env.DISPATCHER.get(workerName);
    return worker.fetch(request);
  }
}
```

### Design Decisions

1. **Middleware-only disabled check** — middleware rejects disabled tenants with 403. No redundant check in the POST route.
2. **Rename `workerName` to `name`** — tenant identifier is `name`, not `workerName`. Custom steps have their own `workerName` field.
3. **Cross-tenant isolation via `ctx.props`** — `CustomProxy` receives `allowedWorkers` list in `ctx.props` and validates before dispatching. Prevents tenant A's pipeline from invoking tenant B's Workers.
4. **Single isolate per pipeline** — all steps (builtin + custom) run in one LOADER isolate. Builtins are inline JS. Custom steps call back to the dispatch worker via injected service bindings.
5. **Aggressive error handling in generated code** — each step is wrapped in try/catch. Errors include step index, operation name, input at time of failure, and partial history.
6. **JSON envelope with history** — response includes `data` (final string) and `history` (array of step-by-step transformations with input/output).
7. **Pipeline short-circuits on error** — if any step fails, the pipeline stops and returns an error response with partial history.

---

## Current State

### Files

| File | Status | Issues |
|------|--------|--------|
| `src/types.ts` | Partial | `KVNamespace`/`DispatchNamespace`/`WorkerLoader` not resolved globally; `FlowStep` lacks discriminated union; no `PipelineEnvelope`/`HistoryEntry` types; `Tenant.workerName` needs rename to `name` |
| `src/index.ts` | Partial | `generateWorkerCode` is a stub; broken template string; `FlowError` class inline; redundant disabled check; old execution model (per-step isolate) |
| `src/middleware.ts` | Working | Imports `Env` from `./index` (should be `./types`) |
| `src/admin.ts` | Working | `CreateTenantRequest` empty; stores minimal tenant data |

### Response Format (target)

**Success:**

```json
{
  "data": "HELLO BAR!!!",
  "history": [
    { "step": 0, "type": "builtin", "op": "uppercase", "input": "  hello foo  ", "output": "  HELLO FOO  " },
    { "step": 1, "type": "builtin", "op": "replace", "input": "  HELLO FOO  ", "output": "  HELLO BAR  " },
    { "step": 2, "type": "custom", "workerName": "acme-custom-step", "input": "  HELLO BAR  ", "output": "  HELLO BAR!!!" },
    { "step": 3, "type": "builtin", "op": "trim", "input": "  HELLO BAR!!!", "output": "HELLO BAR!!!" }
  ]
}
```

**Error:**

```json
{
  "error": "Pipeline failed at step 2 (custom:acme-custom-step): Worker returned 500",
  "step": 2,
  "op": "custom:acme-custom-step",
  "history": [
    { "step": 0, "type": "builtin", "op": "uppercase", "input": "...", "output": "..." },
    { "step": 1, "type": "builtin", "op": "replace", "input": "...", "output": "..." }
  ]
}
```

---

## Tasks

### 1. Update shared types (`src/types.ts`)

- Fix `Env.Bindings` to use `typeof TENANTS` / `typeof DISPATCHER` / `typeof LOADER`
- Rename `Tenant.workerName` to `Tenant.name`
- Rename `Tenant.flow` to `Tenant.pipeline` (type stays `FlowDefinition`)
- Add discriminated union for `FlowStep`:
  - `BuiltinStep`: `{ type: "builtin", op: BuiltinOp, config?: Record<string, unknown> }`
  - `CustomStep`: `{ type: "custom", workerName: string }`
- Add `BuiltinOp` type: `"uppercase" | "lowercase" | "trim" | "replace" | "prefix" | "suffix"`
- Add `PipelineEnvelope` type: `{ data: string, history: HistoryEntry[] }`
- Add `HistoryEntry` type: `{ step: number, type: string, op: string, input: string, output: string }`
- Add `FlowError` class with `step`, `op`, `history` fields
- Export `AppVariables` (currently not exported)

### 2. Fix imports (`src/middleware.ts`)

- Import `Env` from `./types` instead of `./index`

### 3. Implement codegen (`src/codegen.ts` — new file)

- `generatePipelineWorkerCode(pipeline, tenantName)` returns a JS module string
- The generated Worker:
  - Reads input string from request body
  - Iterates steps sequentially
  - For builtin steps: runs inline JS (`toUpperCase()`, `trim()`, `replaceAll()`, etc.)
  - For custom steps: calls `env.CUSTOM_<sanitized_worker_name>.fetch(...)` (service binding)
  - Builds `history` array as it goes
  - Returns JSON envelope `{ data, history }` on success
  - On error at any step: returns JSON error with partial history, step index, and op name
- Each step wrapped in individual try/catch for precise error reporting
- Config values are JSON-serialized into the generated code (not injected via env)

### 4. Implement CustomProxy entrypoint (`src/proxy.ts` — new file)

- `CustomProxy` extends `WorkerEntrypoint` from `cloudflare:workers`
- `fetch(request)`:
  - Reads `workerName` and `allowedWorkers` from `this.ctx.props`
  - Validates `workerName` is in `allowedWorkers` array
  - Calls `this.env.DISPATCHER.get(workerName).fetch(request)`
  - Returns response from tenant Worker
  - On validation failure: returns 403
- Export from the worker's main module (required for `ctx.exports` to work)

### 5. Rewrite main entry point (`src/index.ts`)

- Export `CustomProxy` (re-export from `./proxy`) so it's available via `ctx.exports`
- Remove inline `FlowError`, `generateWorkerCode` stub
- POST `/` route:
  - Read request body as text
  - Extract list of custom workerNames from tenant pipeline (for allowedWorkers)
  - Generate pipeline code via `generatePipelineWorkerCode()`
  - Build LOADER env object:
    - `TENANT_NAME`: tenant name string
    - For each custom step: `CUSTOM_<sanitized_name>`: `ctx.exports.CustomProxy({ props: { workerName, allowedWorkers } })`
  - `globalOutbound: null` (block raw internet)
  - Isolate ID: `${tenant.name}:${tenant.flowVersion}`
  - Call `worker.getEntrypoint().fetch(c.req.raw)`
  - Parse isolate response and return as Hono JSON response
- `onError` handler:
  - `FlowError` -> return error JSON with partial history
  - Other errors -> generic 500
- Remove redundant disabled tenant check (middleware handles it)

### 6. Update admin router (`src/admin.ts`)

- Import `Env` from `./types`
- Update `CreateTenantRequest` to accept pipeline definition
- Store full tenant config in KV (name, status, flowVersion, pipeline)
- Use `name` instead of `workerName`

### 7. Update README.md

- Update architecture diagram to show single-isolate model with `ctx.exports` proxy
- Add LOADER to bindings table
- Add CustomProxy section explaining cross-tenant isolation
- Update response/error format with JSON envelope + history
- Update design decisions to reflect single-isolate model
- Add section on how tenants supply custom Workers

### 8. Regenerate types and verify

- Run `npx wrangler types`
- Run `npx tsc --noEmit` — zero errors
- Run `npx wrangler dev` — smoke test

---

## File Structure (target)

```
src/
  index.ts        — Hono app, routes, error handler, re-exports CustomProxy
  types.ts        — Shared types, FlowError class
  middleware.ts   — Tenant resolution middleware
  admin.ts        — Admin routes for tenant CRUD
  codegen.ts      — Pipeline code generation (JS string for LOADER isolate)
  proxy.ts        — CustomProxy WorkerEntrypoint (wraps DISPATCHER for isolate use)
```

## Dependency Graph

```
index.ts
  ├── types.ts
  ├── middleware.ts   -> types.ts
  ├── admin.ts        -> types.ts
  ├── codegen.ts      -> types.ts
  └── proxy.ts        -> types.ts (uses cloudflare:workers)
```
