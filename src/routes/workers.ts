import { Hono } from "hono";
import type { AppEnv, CustomWorkerRecord } from "../types";
import {
  deployToDispatchNamespace,
  deleteFromDispatchNamespace,
  isDispatchConfigured,
} from "../dispatch";

export const workersRouter = new Hono<AppEnv>();

/**
 * KV key scheme: `{tenantId}:worker:{workerName}`
 *
 * This co-locates worker code alongside tenant config in the same KV
 * namespace. The prefix `{tenantId}:worker:` enables listing all workers
 * for a tenant via KV list with a prefix scan.
 */
const workerKey = (tenantId: string, name: string): string =>
  `${tenantId}:worker:${name}`;

const workerPrefix = (tenantId: string): string =>
  `${tenantId}:worker:`;

/**
 * Dispatch namespace script names are scoped per tenant to avoid collisions.
 * Must match the naming convention in CustomProxy.
 */
const dispatchScriptName = (tenantId: string, name: string): string =>
  `${tenantId}--${name}`;

/** Validates a worker name (alphanumeric, hyphens, underscores, 1-64 chars). */
const isValidName = (name: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);

const DEFAULT_CODE = `export default {
  async fetch(request) {
    const input = await request.text();

    // Transform the input string
    const output = input;

    return new Response(output);
  }
};
`;

// ── List all custom workers for the tenant ──────────────────────────

workersRouter.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  const prefix = workerPrefix(tenantId);

  const list = await c.env.TENANTS.list({ prefix });

  const workers: Array<{ name: string; updatedAt: string }> = [];
  for (const key of list.keys) {
    const name = key.name.slice(prefix.length);
    workers.push({
      name,
      updatedAt: (key.metadata as { updatedAt?: string })?.updatedAt ?? "",
    });
  }

  return c.json({ workers });
});

// ── Get a single worker ─────────────────────────────────────────────

workersRouter.get("/:name", async (c) => {
  const tenantId = c.get("tenantId");
  const name = c.req.param("name");

  const raw = await c.env.TENANTS.get(workerKey(tenantId, name));
  if (!raw) {
    return c.json({ error: `Worker "${name}" not found` }, 404);
  }

  const record = JSON.parse(raw) as CustomWorkerRecord;
  return c.json(record);
});

// ── Create a new worker ─────────────────────────────────────────────

type CreateWorkerBody = {
  name: string;
  code?: string;
};

workersRouter.post("/", async (c) => {
  const tenantId = c.get("tenantId");
  const body = await c.req.json<CreateWorkerBody>();

  if (!body.name) {
    return c.json({ error: "Missing worker name" }, 400);
  }

  if (!isValidName(body.name)) {
    return c.json(
      {
        error:
          "Invalid worker name. Must start with a letter, contain only alphanumeric characters, hyphens, or underscores, and be 1-64 characters.",
      },
      400,
    );
  }

  const key = workerKey(tenantId, body.name);

  // Check for duplicates
  const existing = await c.env.TENANTS.get(key);
  if (existing) {
    return c.json({ error: `Worker "${body.name}" already exists` }, 409);
  }

  const now = new Date().toISOString();
  const record: CustomWorkerRecord = {
    name: body.name,
    code: body.code ?? DEFAULT_CODE,
    createdAt: now,
    updatedAt: now,
  };

  await c.env.TENANTS.put(key, JSON.stringify(record), {
    metadata: { updatedAt: now },
  });

  // Deploy to dispatch namespace synchronously so the script is live
  // before the client can run the pipeline against it.
  if (isDispatchConfigured(c.env)) {
    try {
      await deployToDispatchNamespace(
        c.env,
        dispatchScriptName(tenantId, body.name),
        record.code,
      );
    } catch (err) {
      console.error("Dispatch deploy failed (create):", err instanceof Error ? err.message : err);
      // KV write succeeded — return the record but warn the caller
      return c.json({ ...record, warning: "Saved to KV but dispatch deploy failed" }, 201);
    }
  }

  return c.json(record, 201);
});

// ── Update an existing worker ───────────────────────────────────────

type UpdateWorkerBody = {
  code: string;
};

workersRouter.put("/:name", async (c) => {
  const tenantId = c.get("tenantId");
  const name = c.req.param("name");

  const key = workerKey(tenantId, name);
  const raw = await c.env.TENANTS.get(key);
  if (!raw) {
    return c.json({ error: `Worker "${name}" not found` }, 404);
  }

  const existing = JSON.parse(raw) as CustomWorkerRecord;
  const body = await c.req.json<UpdateWorkerBody>();

  if (typeof body.code !== "string") {
    return c.json({ error: "Missing or invalid 'code' field" }, 400);
  }

  const now = new Date().toISOString();
  const updated: CustomWorkerRecord = {
    ...existing,
    code: body.code,
    updatedAt: now,
  };

  await c.env.TENANTS.put(key, JSON.stringify(updated), {
    metadata: { updatedAt: now },
  });

  // Re-deploy to dispatch namespace synchronously so the updated script
  // is live before the client can run the pipeline against it.
  if (isDispatchConfigured(c.env)) {
    try {
      await deployToDispatchNamespace(
        c.env,
        dispatchScriptName(tenantId, name),
        updated.code,
      );
    } catch (err) {
      console.error("Dispatch deploy failed (update):", err instanceof Error ? err.message : err);
      return c.json({ ...updated, warning: "Saved to KV but dispatch deploy failed" });
    }
  }

  return c.json(updated);
});

// ── Delete a worker ─────────────────────────────────────────────────

workersRouter.delete("/:name", async (c) => {
  const tenantId = c.get("tenantId");
  const name = c.req.param("name");

  const key = workerKey(tenantId, name);
  const raw = await c.env.TENANTS.get(key);
  if (!raw) {
    return c.json({ error: `Worker "${name}" not found` }, 404);
  }

  await c.env.TENANTS.delete(key);

  // Remove from dispatch namespace in the background (non-blocking, non-fatal)
  if (isDispatchConfigured(c.env)) {
    c.executionCtx.waitUntil(
      deleteFromDispatchNamespace(
        c.env,
        dispatchScriptName(tenantId, name),
      ).catch((err) => {
        console.error("Dispatch delete failed:", err instanceof Error ? err.message : err);
      }),
    );
  }

  return c.json({ deleted: name });
});
