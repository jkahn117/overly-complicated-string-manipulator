import { Hono } from "hono";
import { except } from "hono/combine";
import type { AppEnv, CustomStep, FlowDefinition, HistoryEntry, PipelineEnvelope, Tenant, UsageEvent } from "./types";
import { FlowError } from "./types";
import { getTenant } from "./middleware";
import { adminRouter } from "./routes/admin";
import { workersRouter } from "./routes/workers";
import { generatePipelineWorkerCode, sanitizeBindingName } from "./codegen";

// Re-export CustomProxy so it's available via ctx.exports
export { CustomProxy } from "./proxy";

const app = new Hono<AppEnv>();

// Middleware — tenant resolution (skipped for admin routes)
app.use("*", except("/admin/*", (c, next) => {
	// Skip tenant resolution for GET requests to static assets.
	// /workers routes need tenant resolution for all methods.
	if (c.req.method === "GET" && !c.req.path.startsWith("/workers")) return next();
	return getTenant(c, next);
}));

// Admin routes
app.route("/admin", adminRouter);

// Custom worker CRUD (requires tenant middleware)
app.route("/workers", workersRouter);

/** Parse "v<N>" -> N, defaulting to 0 for unexpected formats. */
const parseVersion = (version: string): number => {
  const n = parseInt(version.replace(/^v/, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

// Update pipeline configuration
app.put("/pipeline", async (c) => {
  const tenantId = c.get("tenantId");
  const tenant = c.get("tenant");

  const body = await c.req.json<{ pipeline: FlowDefinition }>();

  if (!body.pipeline?.steps?.length) {
    return c.json({ error: "Pipeline must have at least one step" }, 400);
  }

  const nextVersion = `v${parseVersion(tenant.pipelineVersion) + 1}`;

  const updated: Tenant = {
    ...tenant,
    pipeline: body.pipeline,
    pipelineVersion: nextVersion,
  };

  await c.env.TENANTS.put(tenantId, JSON.stringify(updated));

  return c.json({
    tenantId,
    name: updated.name,
    pipelineVersion: nextVersion,
  });
});

// Pipeline execution
app.post("/", async (c) => {
  const tenant = c.get("tenant");
  const input = await c.req.text();

  if (!tenant.pipeline?.steps?.length) {
    return c.json({ error: "Tenant has no pipeline configured" }, 400);
  }

  // Collect custom worker names for cross-tenant validation
  const customSteps = tenant.pipeline.steps.filter(
    (s): s is CustomStep => s.type === "custom",
  );
  const allowedWorkers = customSteps.map((s) => s.workerName);

  // Generate the pipeline Worker code
  const pipelineCode = generatePipelineWorkerCode(
    tenant.pipeline,
    tenant.name,
  );

  // Build env bindings for the isolate
  const isolateEnv: Record<string, unknown> = {
    TENANT_NAME: tenant.name,
  };

  // Inject a CustomProxy service binding per custom step
  const tenantId = c.get("tenantId");
  const ctx = c.executionCtx as ExecutionContext;
  for (const step of customSteps) {
    const stepIndex = tenant.pipeline.steps.indexOf(step);
    const bindingKey = `CUSTOM_${sanitizeBindingName(step.workerName)}`;
    isolateEnv[bindingKey] = ctx.exports.CustomProxy({
      props: {
        tenantId,
        tenantName: tenant.name,
        workerName: step.workerName,
        allowedWorkers,
        stepIndex,
        pipelineVersion: tenant.pipelineVersion,
      },
    });
  }

  // Load (or reuse) a single isolate for this tenant + pipeline version
  const isolateId = `${tenant.name}:${tenant.pipelineVersion}`;
  const worker = c.env.LOADER.get(isolateId, async () => ({
    compatibilityDate: "2026-02-27",
    mainModule: "pipeline.js",
    modules: {
      "pipeline.js": pipelineCode,
    },
    globalOutbound: null,
    env: isolateEnv,
  }));

  // Forward the input string to the isolate
  const isolateResponse = await worker.getEntrypoint().fetch(
    new Request("http://internal/", {
      method: "POST",
      body: input,
      headers: { "content-type": "text/plain" },
    }),
  );

  // Parse the isolate's response
  const result = (await isolateResponse.json()) as
    | PipelineEnvelope
    | { error: string; step: number; op: string; history: unknown[] };

  // Emit usage events for builtin steps (custom steps handled by CustomProxy)
  const builtinEvents: Array<{ value: UsageEvent }> = [];
  const history = "history" in result
    ? (result.history as HistoryEntry[])
    : [];

  for (const entry of history) {
    if (entry.type === "builtin") {
      builtinEvents.push({
        value: {
          tenantId,
          tenantName: tenant.name,
          stepType: "builtin",
          opName: entry.op,
          stepIndex: entry.step,
          pipelineVersion: tenant.pipelineVersion,
          durationMs: entry.durationMs ?? 0,
          success: true,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  // For failed pipelines, emit failure event for the builtin step that errored
  if (!isolateResponse.ok && "step" in result && "op" in result) {
    const errResult = result as { step: number; op: string };
    if (errResult.op.startsWith("builtin:")) {
      builtinEvents.push({
        value: {
          tenantId,
          tenantName: tenant.name,
          stepType: "builtin",
          opName: errResult.op.replace(/^builtin:/, ""),
          stepIndex: errResult.step,
          pipelineVersion: tenant.pipelineVersion,
          durationMs: 0,
          success: false,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  // Non-blocking write — guard for local dev where binding may not exist
  if (builtinEvents.length > 0 && c.env.USAGE_PIPELINE) {
    c.executionCtx.waitUntil(c.env.USAGE_PIPELINE.send(builtinEvents));
  }

  if (!isolateResponse.ok) {
    const errorResult = result as {
      error: string;
      step: number;
      op: string;
      history: unknown[];
    };
    throw new FlowError(
      errorResult.step,
      errorResult.op,
      errorResult.error,
      errorResult.history as PipelineEnvelope["history"],
    );
  }

  const includeCode = c.req.query("include")?.split(",").includes("code");
  const envelope: PipelineEnvelope = { ...result as PipelineEnvelope };
  if (includeCode) {
    envelope.generatedCode = pipelineCode;
  }
  return c.json(envelope);
});

// Static asset fallback (serves frontend via the ASSETS binding)
app.get("*", async (c) => {
	if (c.env.ASSETS) {
		return c.env.ASSETS.fetch(c.req.raw);
	}
	return c.notFound();
});

// Global error handler
app.onError((error, c) => {
  if (error instanceof FlowError) {
    return c.json(
      {
        error: error.message,
        step: error.step,
        op: error.op,
        history: error.history,
      },
      500,
    );
  }

  console.error("Unhandled error:", error);
  return c.json({ error: "Internal error" }, 500);
});

export default app;
