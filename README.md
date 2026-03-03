# Workers for Platforms — Dynamic Pipeline Execution

## Project Overview

A Cloudflare Workers for Platforms dispatch worker that orchestrates tenant request processing through configurable pipelines. It combines two execution models in a single isolate:

- **Built-in operations** — Platform-provided string manipulation functions, generated as inline JS and executed inside a Dynamic Worker Loader isolate.
- **Custom tenant Workers** — Pre-deployed Workers in a dispatch namespace, called from within the isolate via `ctx.exports`-injected service bindings.

Each tenant defines a pipeline of ordered steps. The dispatch worker resolves the tenant, generates a single Worker module containing all steps, loads it via Worker Loader, and returns a JSON envelope with the final result and step-by-step history.

## Architecture

```
Request (POST with string body + x-tenant-id header)
  |
  v
Dispatch Worker (Hono)
  |-- Middleware: resolve tenant from KV, validate status
  |-- Generate pipeline Worker code (all steps in one module)
  |-- Inject custom Worker bindings via ctx.exports.CustomProxy
  |     (one service binding per custom step, scoped to allowed workerNames)
  |-- env.LOADER.get(isolateId, callback) -> single isolate
  |
  v
Single LOADER Isolate
  |-- Step 0: builtin (inline JS, e.g. toUpperCase())
  |-- Step 1: builtin (inline JS, e.g. replaceAll())
  |-- Step 2: env.CUSTOM_acme_step.fetch(data) -> CustomProxy -> DISPATCHER
  |-- Step 3: builtin (inline JS, e.g. trim())
  |-- Returns JSON envelope { data, history }
  |
  v
Response (JSON envelope with history)
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `TENANTS` | KV Namespace | Stores tenant config (pipeline definition, status) |
| `DISPATCHER` | Dispatch Namespace | Routes to pre-deployed custom tenant Workers |
| `LOADER` | Worker Loader | Loads dynamically generated pipeline isolates |

## Tenant Configuration

Tenant config is stored in KV, keyed by tenant ID.

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

### Step Types

**`builtin`** — Platform-provided operations. The `op` field selects the operation. Some operations accept a `config` object.

| Operation | Description | Config |
|-----------|-------------|--------|
| `uppercase` | Convert string to uppercase | -- |
| `lowercase` | Convert string to lowercase | -- |
| `trim` | Remove leading/trailing whitespace | -- |
| `replace` | Find and replace substring | `{ "find": string, "replace": string }` |
| `prefix` | Prepend a string | `{ "value": string }` |
| `suffix` | Append a string | `{ "value": string }` |

**`custom`** — Tenant-deployed Worker in the dispatch namespace. The `workerName` field identifies which Worker to invoke.

### Custom Tenant Worker Contract

- Receives: `POST` request with `text/plain` body (the current pipeline string)
- Returns: `200` response with `text/plain` body (the transformed string)
- No auth required (dispatch worker handles that)
- Runs in untrusted mode (dispatch namespace isolation)
- Deployed to the dispatch namespace via the Cloudflare REST API (not wrangler)

## Execution Flow

Given the sample config above and a request body of `"  hello foo  "`:

```
Input:  "  hello foo  "
  Step 0 [builtin:uppercase]              -> "  HELLO FOO  "
  Step 1 [builtin:replace FOO->BAR]       -> "  HELLO BAR  "
  Step 2 [custom:acme-custom-step]        -> "  HELLO BAR!!!"
  Step 3 [builtin:trim]                   -> "HELLO BAR!!!"
Output: "HELLO BAR!!!"
```

### Response Format

**Success (200):**

```json
{
  "data": "HELLO BAR!!!",
  "history": [
    { "step": 0, "type": "builtin", "op": "uppercase", "input": "  hello foo  ", "output": "  HELLO FOO  " },
    { "step": 1, "type": "builtin", "op": "replace", "input": "  HELLO FOO  ", "output": "  HELLO BAR  " },
    { "step": 2, "type": "custom", "op": "acme-custom-step", "input": "  HELLO BAR  ", "output": "  HELLO BAR!!!" },
    { "step": 3, "type": "builtin", "op": "trim", "input": "  HELLO BAR!!!", "output": "HELLO BAR!!!" }
  ]
}
```

**Error (500):**

```json
{
  "error": "Pipeline failed at step 2 (custom:acme-custom-step): Custom worker returned status 500",
  "step": 2,
  "op": "custom:acme-custom-step",
  "history": [
    { "step": 0, "type": "builtin", "op": "uppercase", "input": "...", "output": "..." },
    { "step": 1, "type": "builtin", "op": "replace", "input": "...", "output": "..." }
  ]
}
```

Errors include partial history (steps completed before failure).

## CustomProxy and Cross-Tenant Isolation

Custom pipeline steps call tenant Workers through a `CustomProxy` WorkerEntrypoint exported from the dispatch worker. The proxy is injected into each isolate as a service binding via `ctx.exports`.

Each `CustomProxy` instance receives:
- `workerName` — which tenant Worker to dispatch to
- `allowedWorkers` — list of worker names the current tenant is authorized to call

Before dispatching, `CustomProxy` validates that `workerName` is in `allowedWorkers`. This prevents a tenant's pipeline config from invoking another tenant's Workers.

## How Tenants Supply Custom Workers

Tenants do not deploy Workers directly. The platform's control plane deploys on their behalf using the Cloudflare REST API:

```sh
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/dispatch/namespaces/production/scripts/acme-custom-step" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: multipart/form-data" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-02-27"}' \
  -F 'worker.js=@/path/to/tenant-code.js'
```

A minimal tenant Worker:

```js
export default {
  async fetch(request) {
    const input = await request.text();
    return new Response(input + "!!!");
  }
};
```

## Design Decisions

1. **Single isolate per pipeline** — All steps (builtin + custom) run in one Worker Loader isolate. Built-in ops are inline JS. Custom steps call back to the dispatch worker via `ctx.exports`-injected service bindings. This avoids per-step isolate creation overhead.

2. **String-in, string-out contract** — Every step takes a plain string as input and returns a plain string. The JSON envelope with history is assembled by the generated pipeline code, not by individual steps.

3. **Custom ops via ctx.exports proxy** — Tenant Workers are called through a `CustomProxy` WorkerEntrypoint, not directly from the isolate. This allows cross-tenant validation and keeps `globalOutbound: null` (no raw internet access from the isolate).

4. **Cross-tenant isolation** — `CustomProxy` validates worker names against an allowed list before dispatching. Tenants cannot invoke other tenants' Workers.

5. **Pipeline short-circuits on error** — If any step fails, the pipeline stops and returns an error response with partial history. Each step in the generated code is wrapped in its own try/catch for precise error reporting.

6. **Tenant config in KV** — Pipeline definitions live in KV for low-latency reads at the edge. Config changes take effect on next request (no redeploy needed for flow changes).

7. **Isolate caching by version** — Isolate ID is `tenantName:pipelineVersion`. Unchanged pipelines reuse cached isolates. Bumping `pipelineVersion` in KV invalidates the cache.

8. **Routing by header** — Tenant identity comes from the `x-tenant-id` request header. Suitable for API-first platforms. Could be extended to hostname or path-based routing.

9. **Middleware-only disabled check** — Middleware rejects disabled tenants with 403. No redundant checks in route handlers.
