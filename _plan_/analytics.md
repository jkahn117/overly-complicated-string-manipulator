# Analytics Plan: Usage Metrics via Cloudflare Pipelines

## Overview

Instrument the dispatch worker and `CustomProxy` to emit **one usage event per
step executed** to a Cloudflare Pipeline. Events are written as NDJSON to an R2
bucket, forming a data lake suitable for billing aggregation and visualization
(e.g., DuckDB queries, dashboard demo).

The use case models **usage-based pricing**: different cost tiers for builtin vs.
custom operations (e.g., 1,000 builtin steps = $0.10, 1,000 custom steps =
$0.25). All metrics instrumentation lives in the platform layer — the
customer-facing generated code never contains pipeline write calls.

---

## Event Schema

Each step execution produces one record:

```typescript
type UsageEvent = {
  tenantId: string;          // e.g. "t_a1b2c3..."
  tenantName: string;        // e.g. "acme-corp"
  stepType: "builtin" | "custom";
  opName: string;            // e.g. "uppercase", "reverse" (worker name)
  stepIndex: number;         // position in the pipeline (0-based)
  pipelineVersion: string;   // e.g. "v3"
  durationMs: number;        // wall-clock time for this step
  success: boolean;          // false for failed steps (still emitted)
  timestamp: string;         // ISO 8601
};
```

### Schema rationale

| Field | Why |
|-------|-----|
| `tenantId` | Primary key for per-tenant billing aggregation |
| `tenantName` | Human-readable label for dashboards (avoids KV lookups) |
| `stepType` | Discriminator for pricing tiers |
| `opName` | Enables per-operation analytics and debugging |
| `stepIndex` | Preserves pipeline structure for latency analysis |
| `pipelineVersion` | Tracks which pipeline version generated the usage |
| `durationMs` | Latency analysis, SLA monitoring |
| `success` | Emitted for both success and failure; billing model may exclude failures |
| `timestamp` | Time-series bucketing for dashboards and invoicing periods |

---

## Architecture

### Where metrics are captured

We instrument at **two points** — one for each step type — ensuring complete
coverage without touching the generated isolate code.

```
                      ┌���─────────────────────────────────────────────┐
                      │          Dispatch Worker (index.ts)           │
  POST / ───────────► │                                              │
  x-tenant-id: t_abc  │  1. Parse pipeline definition                │
                      │  2. Generate isolate code (codegen.ts)       │
                      │  3. LOADER.get(isolateId) → run isolate      │
                      │          │                                    │
                      │          ▼                                    │
                      │  ┌─────────────────────┐                     │
                      │  │   LOADER Isolate     │                     │
                      │  │  (generated code)    │                     │
                      │  │                      │                     │
                      │  │  Step 0: uppercase ──┤                     │
                      │  │  Step 1: trim ───────┤ builtins            │
                      │  │  Step 2: custom:rev ─┼──► CustomProxy      │
                      │  │                      │     .transform()    │
                      │  │  returns history ◄───��                     │
                      │  └───��─────────────────┘          │           │
                      │                                   │           │
                      │  4. Parse history from response    │           │
                      │  5. Emit BUILTIN events ��────────►│           │
                      │     (waitUntil)                   ▼           │
                      │                            USAGE_PIPELINE     │
                      │  6. CustomProxy emits ────►  .send()          │
                      │     CUSTOM events                 │           │
                      │     (waitUntil)                   ▼           │
                      │                            ┌────────────┐     │
                      │  7. Return response        │  R2 Bucket │     │
                      │     to caller              │  (NDJSON)  │     │
                      └────────────────────────────┴────────────┘     │
```

### Custom steps → `CustomProxy.transform()` (src/proxy.ts)

The proxy already wraps every custom step call. We add:

1. Timing around the `worker.fetch()` call
2. `this.env.USAGE_PIPELINE.send([event])` after the call
3. `this.ctx.waitUntil()` to make the write non-blocking

The proxy currently does not know `stepIndex` or `tenantName`. We extend
`CustomProxyProps` to include them (passed when the binding is created in
`index.ts`).

```typescript
type CustomProxyProps = {
  tenantId: string;
  tenantName: string;          // NEW
  workerName: string;
  allowedWorkers: string[];
  stepIndex: number;           // NEW
  pipelineVersion: string;     // NEW
};
```

### Builtin steps → dispatch worker (src/index.ts)

Builtin steps run as inline JS inside the LOADER isolate. The dispatch worker
never directly executes them. To get per-step timing:

1. **Enrich codegen**: modify `generateBuiltinStepBlock()` in `codegen.ts` to
   wrap each step with `performance.now()` calls and include `durationMs` in the
   history entry.
2. **Emit from index.ts**: after parsing the isolate response, iterate the
   `history` array. For each **builtin** entry, construct a `UsageEvent` and
   batch them into a single `USAGE_PIPELINE.send()` call via
   `c.executionCtx.waitUntil()`.

Custom entries in the history are **skipped** here — `CustomProxy` already
emitted events for those.

### Why not instrument inside the generated code?

Three reasons:

1. **Customer visibility**: the generated code is shown in the UI via
   `?include=code`. Pipeline writes would leak platform internals.
2. **Binding complexity**: the LOADER isolate's env is tightly controlled
   (`globalOutbound: null`). Adding a pipeline binding to the isolate would
   require passing it through the loader config and would expose it to
   tenant-visible code.
3. **Separation of concerns**: billing is a platform concern. Keeping it in
   `proxy.ts` and `index.ts` means changes to the billing schema never affect
   generated isolate code or cached isolate versions.

### Implementation constraint: analytics isolation

> **CONSTRAINT**: `USAGE_PIPELINE` must NEVER be added to `isolateEnv`. The
> pipeline binding must only be referenced from `proxy.ts` (via `this.env`) and
> `index.ts` (via `c.env`). The generated code string must never contain any
> reference to the pipeline binding or analytics infrastructure.

This constraint must be enforced with automated tests:

1. **`test/codegen.spec.ts`**: Assert that the output of
   `generatePipelineWorkerCode()` does not contain any of the following
   substrings: `USAGE_PIPELINE`, `PIPELINE`, `send(`, `analytics`, `metrics`,
   `billing`. This catches accidental leakage if someone later modifies codegen.
2. **`test/index.spec.ts`**: Assert that the `isolateEnv` object passed to
   `LOADER.get()` does not contain a `USAGE_PIPELINE` key.

**Audit of customer-visible surfaces** (all verified clean under this plan):

| Surface | What the customer sees | Analytics exposure |
|---------|----------------------|-------------------|
| Generated Code tab (`?include=code`) | The string from `generatePipelineWorkerCode()` — pure transform logic + `performance.now()` timing | None. `codegen.ts` never references the pipeline binding. |
| Response envelope (`data`, `history`) | Transform results + per-step history with `durationMs` | None. `USAGE_PIPELINE.send()` is a `waitUntil` side-effect in the dispatch worker, not added to the envelope. |
| Error responses | `FlowError` with `step`, `op`, `message`, partial `history` | None. Error shape unchanged; failure events emitted via `waitUntil` only. |
| Isolate `env` bindings | `TENANT_NAME` + `CUSTOM_*` RPC stubs | None. `USAGE_PIPELINE` is never in `isolateEnv`. `globalOutbound: null` blocks all other access. |

---

## Data Flow: What the Customer Sees vs. Doesn't See

| Visible to customer | Hidden from customer |
|---------------------|---------------------|
| Pipeline result (`data`, `history`) | `USAGE_PIPELINE.send()` calls |
| Generated code (via `?include=code`) | `CustomProxy` metrics internals |
| `durationMs` in history entries | R2 bucket / NDJSON files |
| | Event schema and billing logic |

The `durationMs` field in history entries is visible and useful to the customer
(debugging slow steps). The pipeline writes that consume this data are not.

---

## Billing Model Notes

- **Both successful and failed steps emit events** (`success: true|false`).
- The billing system downstream can choose to exclude failures. This gives
  maximum flexibility — e.g., charge for failures during abuse, waive them
  during legitimate errors.
- **Pricing tiers are determined by `stepType`**:
  - `builtin` — cheaper (runs inline, no external dispatch)
  - `custom` — more expensive (involves RPC + dispatch namespace + tenant isolate)
- Example pricing (for demo): 1,000 builtin steps = $0.10, 1,000 custom steps = $0.25.

---

## Infrastructure Setup

### Step 1: Create R2 bucket and Pipeline

```bash
npx wrangler r2 bucket create wfp-usage-metrics
npx wrangler pipelines create wfp-usage-pipeline --r2-bucket wfp-usage-metrics
```

The pipeline will be configured with:
- **Source**: Worker binding (JSON format)
- **Destination**: R2 bucket `wfp-usage-metrics`, NDJSON, GZIP compressed
- **Batching**: default (100MB / 300s / 100K records)

### Step 2: Add Pipeline binding to `wrangler.jsonc`

```jsonc
{
  // ... existing config ...
  "pipelines": [
    {
      "pipeline": "wfp-usage-pipeline",
      "binding": "USAGE_PIPELINE"
    }
  ]
}
```

Then regenerate types:

```bash
npx wrangler types
```

This adds `USAGE_PIPELINE: Pipeline` to `Cloudflare.Env` in
`worker-configuration.d.ts`.

---

## Implementation Steps

### Step 1: Infrastructure — create R2 bucket and Pipeline

Run the wrangler commands above. Verify the pipeline is created and the binding
is configured.

### Step 2: `wrangler.jsonc` — add Pipeline binding

Add the `pipelines` array. Run `wrangler types` to regenerate
`worker-configuration.d.ts`.

### Step 3: `src/types.ts` — add `UsageEvent` type

```typescript
export type UsageEvent = {
  tenantId: string;
  tenantName: string;
  stepType: "builtin" | "custom";
  opName: string;
  stepIndex: number;
  pipelineVersion: string;
  durationMs: number;
  success: boolean;
  timestamp: string;
};
```

### Step 4: `src/proxy.ts` — extend props, add timing + pipeline write

Extend `CustomProxyProps` with `tenantName`, `stepIndex`, `pipelineVersion`.

Instrument `transform()`:

```typescript
async transform(input: string): Promise<string> {
  const { tenantId, tenantName, workerName, allowedWorkers, stepIndex, pipelineVersion } =
    this.ctx.props as CustomProxyProps;

  if (!allowedWorkers.includes(workerName)) {
    throw new Error(`Worker "${workerName}" is not authorized for this tenant`);
  }

  const scriptName = `${tenantId}--${workerName}`;
  const worker = this.env.DISPATCHER.get(scriptName);

  const start = performance.now();
  let success = true;

  try {
    const response = await worker.fetch("http://internal/", {
      method: "POST",
      body: input,
      headers: { "content-type": "text/plain" },
    });

    if (!response.ok) {
      success = false;
      throw new Error(`Custom worker "${workerName}" returned status ${response.status}`);
    }

    return response.text();
  } catch (err) {
    success = false;
    throw err;
  } finally {
    const durationMs = Math.round(performance.now() - start);
    const event: UsageEvent = {
      tenantId,
      tenantName,
      stepType: "custom",
      opName: workerName,
      stepIndex,
      pipelineVersion,
      durationMs,
      success,
      timestamp: new Date().toISOString(),
    };
    this.ctx.waitUntil(this.env.USAGE_PIPELINE.send([event]));
  }
}
```

Key details:
- `finally` block ensures the event is emitted even on failure
- `waitUntil` makes the write non-blocking — doesn't delay the response
- `success` is set to `false` in the catch block before rethrowing

### Step 5: `src/index.ts` — pass new props to CustomProxy

Update the binding creation loop:

```typescript
for (const step of customSteps) {
  const stepIndex = tenant.pipeline.steps.indexOf(step);
  const bindingKey = `CUSTOM_${sanitizeBindingName(step.workerName)}`;
  isolateEnv[bindingKey] = ctx.exports.CustomProxy({
    props: {
      tenantId,
      tenantName: tenant.name,         // NEW
      workerName: step.workerName,
      allowedWorkers,
      stepIndex,                        // NEW
      pipelineVersion: tenant.pipelineVersion,  // NEW
    },
  });
}
```

### Step 6: `src/codegen.ts` — add `durationMs` to history entries

Modify `generateBuiltinStepBlock()` to wrap each step with timing:

```typescript
const generateBuiltinStepBlock = (step: BuiltinStep, index: number): string => {
  const opLabel = `builtin:${step.op}`;

  // ... existing transform logic unchanged ...

  return `
      // Step ${index}: ${opLabel}
      {
        const input = data;
        const _t0 = performance.now();
        try {
          ${transform}
          const _dur = Math.round(performance.now() - _t0);
          history.push({ step: ${index}, type: "builtin", op: ${JSON.stringify(step.op)}, input, output: data, durationMs: _dur });
        } catch (err) {
          err.step = ${index};
          err.op = ${JSON.stringify(opLabel)};
          err.message = err.message || "Builtin op failed";
          throw err;
        }
      }`;
};
```

Similarly update `generateCustomStepBlock()` to include `durationMs`:

```typescript
const generateCustomStepBlock = (step: CustomStep, index: number): string => {
  const bindingName = `CUSTOM_${sanitizeBindingName(step.workerName)}`;
  const opLabel = `custom:${step.workerName}`;

  return `
      // Step ${index}: ${opLabel} (via RPC)
      {
        const input = data;
        const _t0 = performance.now();
        try {
          const binding = env[${JSON.stringify(bindingName)}];
          if (!binding || typeof binding.transform !== "function") {
            throw Object.assign(
              new Error("Missing or invalid binding for custom worker: ${step.workerName}"),
              { step: ${index}, op: ${JSON.stringify(opLabel)} },
            );
          }
          data = await binding.transform(data);
          const _dur = Math.round(performance.now() - _t0);
          history.push({ step: ${index}, type: "custom", op: ${JSON.stringify(step.workerName)}, input, output: data, durationMs: _dur });
        } catch (err) {
          err.step = err.step ?? ${index};
          err.op = err.op ?? ${JSON.stringify(opLabel)};
          err.message = err.message || "Custom worker call failed";
          throw err;
        }
      }`;
};
```

Note: the `durationMs` in the custom step history entry measures the time from
the isolate's perspective (including RPC overhead). The `CustomProxy` measures
its own `durationMs` independently (just the dispatch call). Both are useful
data points but only the proxy's value is written to the pipeline.

### Step 7: `src/index.ts` — emit builtin events from history

After parsing the isolate response, emit events for builtin steps:

```typescript
// After: const result = (await isolateResponse.json()) as ...

// Emit usage events for builtin steps (custom steps handled by CustomProxy)
const builtinEvents: UsageEvent[] = [];
const history = "history" in result ? (result.history as HistoryEntry[]) : [];

for (const entry of history) {
  if (entry.type === "builtin") {
    builtinEvents.push({
      tenantId,
      tenantName: tenant.name,
      stepType: "builtin",
      opName: entry.op,
      stepIndex: entry.step,
      pipelineVersion: tenant.pipelineVersion,
      durationMs: (entry as HistoryEntry & { durationMs?: number }).durationMs ?? 0,
      success: true,
      timestamp: new Date().toISOString(),
    });
  }
}

// For failed pipelines, emit failure event for the step that errored
if (!isolateResponse.ok && "step" in result && "op" in result) {
  const errResult = result as { step: number; op: string };
  const errOp = errResult.op.replace(/^builtin:/, "");
  // Only emit if it's a builtin step failure (custom failures are handled by proxy)
  if (errResult.op.startsWith("builtin:")) {
    builtinEvents.push({
      tenantId,
      tenantName: tenant.name,
      stepType: "builtin",
      opName: errOp,
      stepIndex: errResult.step,
      pipelineVersion: tenant.pipelineVersion,
      durationMs: 0,
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
}

if (builtinEvents.length > 0) {
  c.executionCtx.waitUntil(c.env.USAGE_PIPELINE.send(builtinEvents));
}
```

Key details:
- Single `send()` call for all builtin events in the pipeline (batched)
- `waitUntil` ensures the response isn't delayed
- Failed builtin steps get `success: false`
- Custom entries in history are skipped (proxy handles those)

### Step 8: Update `HistoryEntry` type

Add the optional `durationMs` field:

```typescript
export type HistoryEntry = {
  step: number;
  type: string;
  op: string;
  input: string;
  output: string;
  durationMs?: number;   // NEW — added by codegen timing
};
```

### Step 9: Update tests

| Test file | Changes needed |
|-----------|---------------|
| `test/codegen.spec.ts` | Verify `durationMs` and `performance.now()` appear in generated code |
| `test/codegen.spec.ts` | **Analytics isolation**: assert generated code does NOT contain `USAGE_PIPELINE`, `PIPELINE`, `send(`, `analytics`, `metrics`, `billing` |
| `test/index.spec.ts` | Mock `USAGE_PIPELINE.send()`, verify builtin events are emitted with correct shape |
| `test/index.spec.ts` | **Analytics isolation**: assert `isolateEnv` passed to `LOADER.get()` does not contain `USAGE_PIPELINE` |
| `test/workers.spec.ts` | May need updates if proxy props interface changed |

---

## Files Changed

| File | Change |
|------|--------|
| `wrangler.jsonc` | Add `pipelines` binding for `USAGE_PIPELINE` |
| `worker-configuration.d.ts` | Regenerated via `wrangler types` |
| `src/types.ts` | Add `UsageEvent` type, extend `HistoryEntry` with `durationMs?` |
| `src/proxy.ts` | Extend `CustomProxyProps`, add timing + `USAGE_PIPELINE.send()` |
| `src/index.ts` | Pass new props to `CustomProxy`, emit builtin events from history |
| `src/codegen.ts` | Add `performance.now()` timing to both step block generators |
| `test/codegen.spec.ts` | Update expected generated code patterns |
| `test/index.spec.ts` | Add tests for builtin event emission |

---

## Querying the Data (Visualization Preview)

Once events accumulate in R2, the NDJSON files can be queried with DuckDB:

```sql
-- Per-tenant usage summary
SELECT
  tenantId,
  tenantName,
  stepType,
  COUNT(*) as totalSteps,
  COUNT(*) FILTER (WHERE success) as successfulSteps,
  ROUND(AVG(durationMs), 2) as avgDurationMs
FROM read_json_auto('s3://wfp-usage-metrics/**/*.json.gz')
GROUP BY tenantId, tenantName, stepType;

-- Estimated billing
SELECT
  tenantId,
  tenantName,
  SUM(CASE WHEN stepType = 'builtin' THEN 1 ELSE 0 END) * 0.0001 as builtinCost,
  SUM(CASE WHEN stepType = 'custom'  THEN 1 ELSE 0 END) * 0.00025 as customCost,
  SUM(CASE WHEN stepType = 'builtin' THEN 1 ELSE 0 END) * 0.0001 +
  SUM(CASE WHEN stepType = 'custom'  THEN 1 ELSE 0 END) * 0.00025 as totalCost
FROM read_json_auto('s3://wfp-usage-metrics/**/*.json.gz')
WHERE success = true
GROUP BY tenantId, tenantName;

-- Latency percentiles by operation
SELECT
  opName,
  stepType,
  QUANTILE_CONT(durationMs, 0.5) as p50,
  QUANTILE_CONT(durationMs, 0.95) as p95,
  QUANTILE_CONT(durationMs, 0.99) as p99
FROM read_json_auto('s3://wfp-usage-metrics/**/*.json.gz')
WHERE success = true
GROUP BY opName, stepType;
```

For the demo visualization, the chosen approach is:
- **Workers route + Astro page**: a `GET /admin/usage` endpoint reads R2 objects,
  decompresses NDJSON, and returns aggregated per-tenant JSON. A standalone
  `/usage` page renders the data as summary cards + a table.

### Dashboard implementation

**API route** (`src/routes/admin.ts` — `GET /admin/usage`):
- Lists R2 objects from `USAGE_METRICS` bucket (up to `?limit=50`, max 100)
- Takes the most recent N objects (lexicographic order ≈ chronological for
  Pipeline-generated keys)
- Decompresses gzip via `DecompressionStream`, parses NDJSON lines
- Unwraps Pipeline's `{ value: <UsageEvent> }` envelope
- Aggregates in-memory: groups by `tenantId`, computes counts, success rates,
  average duration, and last-seen timestamp
- Returns `{ summary, tenants[] }` — see response shape below

**Response shape**:

```typescript
{
  summary: {
    totalEvents: number;
    totalBuiltin: number;
    totalCustom: number;
    uniqueTenants: number;
  };
  tenants: Array<{
    tenantId: string;
    tenantName: string;
    builtinSteps: number;
    customSteps: number;
    totalSteps: number;
    successRate: number;        // 0-1
    avgDurationMs: number;
    lastSeen: string;           // ISO 8601
  }>;
}
```

**Frontend page** (`web/src/pages/usage.astro` — `/usage`):
- Standalone Astro page using `Base.astro` layout with `wide` prop
- Alpine.js `x-data="usageData()"` component, fetches `/admin/usage` on init
- Summary cards: Total Steps, Builtin Steps, Custom Steps, Active Tenants
- Table columns: Tenant (name + ID), Builtin, Custom, Total, Success Rate,
  Avg ms, Last Seen
- Success rate color-coded: green (≥95%), neutral (80-95%), red (<80%)
- Loading, error, and empty states consistent with existing components
- Refresh button for manual reload

**Bindings added**: `USAGE_METRICS` (R2 bucket: `wfp-usage-metrics`)

---

## Edge Cases and Error Handling

### Pipeline binding unavailable in local dev

Wrangler's local dev mode may not fully support Pipelines bindings. If
`USAGE_PIPELINE` is undefined in dev:
- Wrap all `send()` calls with a guard: `if (env.USAGE_PIPELINE) { ... }`
- This makes metrics opt-in — present in production, silently skipped in dev

### Isolate returns partial history on failure

When a pipeline step fails, the isolate returns partial history (all steps up to
the failure). The builtin event emission code in `index.ts` handles this:
- Successful builtin steps in history → `success: true`
- The failed step (if builtin) → `success: false` (detected from error result)
- Steps after the failure → not emitted (never executed)

### Duplicate events

If `CustomProxy` emits a custom step event AND `index.ts` also sees it in
history, we'd double-count. The plan avoids this: `index.ts` **only emits for
builtin entries** (`entry.type === "builtin"`). Custom entries are skipped.

### High-throughput tenants

Pipelines handles up to 100 MB/s ingestion. Each `UsageEvent` is ~250 bytes.
Even at 400K events/second, we're under 100 MB/s. No concern for this demo.

---

## Open Questions

1. **R2 bucket region**: Pipelines writes to a single R2 bucket. For a demo,
   default region is fine. For production, consider placing the bucket near your
   billing system.

2. **Event retention**: R2 objects are stored indefinitely unless a lifecycle
   policy is set. For the demo, no action needed. For production, configure
   lifecycle rules to age out old data.

3. **Schema evolution**: if we add fields to `UsageEvent` later, NDJSON handles
   this gracefully (new fields appear in new records, old records lack them).
   DuckDB's `read_json_auto` union-types handle this seamlessly.
