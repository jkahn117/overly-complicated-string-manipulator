import { Hono } from "hono";
import type { AppEnv, FlowDefinition, UsageEvent } from "../types";

type CreateTenantRequest = {
  tenantId?: string;
  name: string;
  pipeline: FlowDefinition;
};

type TenantUsageSummary = {
  tenantId: string;
  tenantName: string;
  builtinSteps: number;
  customSteps: number;
  totalSteps: number;
  successRate: number;
  avgDurationMs: number;
  lastSeen: string;
};

type UsageResponse = {
  summary: {
    totalEvents: number;
    totalBuiltin: number;
    totalCustom: number;
    uniqueTenants: number;
  };
  tenants: TenantUsageSummary[];
};

export const adminRouter = new Hono<AppEnv>();

const generateTenantId = (): string => {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return (
    "t_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
};

adminRouter.post("/tenants", async (c) => {
  const body = await c.req.json<CreateTenantRequest>();

  if (!body.name) {
    return c.json({ error: "Missing tenant name" }, 400);
  }

  if (!body.pipeline?.steps?.length) {
    return c.json({ error: "Missing pipeline definition" }, 400);
  }

  const tenantId = body.tenantId || generateTenantId();
  await c.env.TENANTS.put(
    tenantId,
    JSON.stringify({
      name: body.name,
      status: "active",
      pipelineVersion: "v1",
      pipeline: body.pipeline,
    }),
  );

  return c.json({ tenantId, name: body.name }, 201);
});

// ---------------------------------------------------------------------------
// GET /admin/usage — aggregated usage metrics from R2
// ---------------------------------------------------------------------------

/** Parse an NDJSON R2 object into UsageEvent[]. */
const parseR2Object = async (
  obj: R2ObjectBody,
): Promise<UsageEvent[]> => {
  const text = await obj.text();
  const events: UsageEvent[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // Pipeline double-wraps: { value: { value: <UsageEvent> } }
      // Unwrap until we reach the actual event (has tenantId field).
      let raw: Record<string, unknown> = JSON.parse(trimmed);
      while (raw.value && typeof raw.value === "object" && !("tenantId" in raw)) {
        raw = raw.value as Record<string, unknown>;
      }
      events.push(raw as unknown as UsageEvent);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
};

/** Aggregate a flat list of events into per-tenant summaries. */
const aggregateEvents = (events: UsageEvent[]): UsageResponse => {
  const byTenant = new Map<
    string,
    {
      tenantName: string;
      builtin: number;
      custom: number;
      successes: number;
      totalDurationMs: number;
      lastSeen: string;
    }
  >();

  for (const ev of events) {
    let entry = byTenant.get(ev.tenantId);
    if (!entry) {
      entry = {
        tenantName: ev.tenantName,
        builtin: 0,
        custom: 0,
        successes: 0,
        totalDurationMs: 0,
        lastSeen: ev.timestamp,
      };
      byTenant.set(ev.tenantId, entry);
    }

    if (ev.stepType === "builtin") entry.builtin++;
    else entry.custom++;

    if (ev.success) entry.successes++;
    entry.totalDurationMs += ev.durationMs;

    if (ev.timestamp > entry.lastSeen) {
      entry.lastSeen = ev.timestamp;
    }
  }

  let totalBuiltin = 0;
  let totalCustom = 0;
  const tenants: TenantUsageSummary[] = [];

  for (const [tenantId, entry] of byTenant) {
    const total = entry.builtin + entry.custom;
    totalBuiltin += entry.builtin;
    totalCustom += entry.custom;

    tenants.push({
      tenantId,
      tenantName: entry.tenantName,
      builtinSteps: entry.builtin,
      customSteps: entry.custom,
      totalSteps: total,
      successRate: total > 0 ? entry.successes / total : 1,
      avgDurationMs:
        total > 0 ? Math.round((entry.totalDurationMs / total) * 100) / 100 : 0,
      lastSeen: entry.lastSeen,
    });
  }

  // Sort by total steps descending (busiest tenants first)
  tenants.sort((a, b) => b.totalSteps - a.totalSteps);

  return {
    summary: {
      totalEvents: events.length,
      totalBuiltin,
      totalCustom,
      uniqueTenants: tenants.length,
    },
    tenants,
  };
};

adminRouter.get("/usage", async (c) => {
  const bucket = c.env.USAGE_METRICS;
  if (!bucket) {
    return c.json(
      { error: "USAGE_METRICS R2 binding not available" },
      503,
    );
  }

  const maxObjects = Math.min(
    Number(c.req.query("limit") || "50"),
    100,
  );

  // List objects — R2 returns lexicographic order, Pipeline keys include
  // timestamps so newer files sort later. We read the most recent batch.
  const listed = await bucket.list({ limit: 1000 });

  // Take the last N objects (most recent) from the lexicographically sorted list
  const keys = listed.objects.map((o: R2Object) => o.key);
  const recentKeys = keys.slice(-maxObjects);

  const allEvents: UsageEvent[] = [];

  // Read objects in parallel (capped at maxObjects)
  const bodies = await Promise.all(
    recentKeys.map((key: string) => bucket.get(key)),
  );

  for (const obj of bodies) {
    if (!obj) continue;
    try {
      const events = await parseR2Object(obj);
      allEvents.push(...events);
    } catch {
      // Skip objects that fail to decompress/parse
    }
  }

  const response = aggregateEvents(allEvents);
  return c.json(response);
});
