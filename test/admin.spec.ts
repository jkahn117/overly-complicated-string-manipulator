import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Tenant } from "../src/types";

/** Seed a tenant directly into KV, returning its id. */
let counter = 0;
const seedTenant = async (
  overrides: Partial<Tenant> = {},
): Promise<string> => {
  const tenantId = `admin-test-${++counter}`;
  const tenant: Tenant = {
    name: overrides.name ?? tenantId,
    status: overrides.status ?? "active",
    pipelineVersion: overrides.pipelineVersion ?? "v1",
    pipeline: overrides.pipeline ?? {
      steps: [{ type: "builtin", op: "uppercase" }],
    },
  };
  await env.TENANTS.put(tenantId, JSON.stringify(tenant));
  return tenantId;
};

const getTenantFromKV = async (tenantId: string): Promise<Tenant | null> => {
  const raw = await env.TENANTS.get(tenantId);
  return raw ? (JSON.parse(raw) as Tenant) : null;
};

const updatePipeline = (
  tenantId: string,
  body: unknown,
): Promise<Response> =>
  SELF.fetch("https://example.com/pipeline", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-tenant-id": tenantId,
    },
  });

describe("PUT /pipeline", () => {
  it("updates pipeline and increments version", async () => {
    const tenantId = await seedTenant();

    const res = await updatePipeline(tenantId, {
      pipeline: {
        steps: [
          { type: "builtin", op: "lowercase" },
          { type: "builtin", op: "trim" },
        ],
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      name: string;
      pipelineVersion: string;
    };
    expect(body.pipelineVersion).toBe("v2");
    expect(body.tenantId).toBe(tenantId);

    const stored = await getTenantFromKV(tenantId);
    expect(stored!.pipelineVersion).toBe("v2");
    expect(stored!.pipeline.steps).toHaveLength(2);
    expect(stored!.pipeline.steps[0]).toMatchObject({
      type: "builtin",
      op: "lowercase",
    });
  });

  it("increments version on successive updates", async () => {
    const tenantId = await seedTenant();

    await updatePipeline(tenantId, {
      pipeline: { steps: [{ type: "builtin", op: "trim" }] },
    });
    const res = await updatePipeline(tenantId, {
      pipeline: { steps: [{ type: "builtin", op: "lowercase" }] },
    });

    const body = (await res.json()) as { pipelineVersion: string };
    expect(body.pipelineVersion).toBe("v3");

    const stored = await getTenantFromKV(tenantId);
    expect(stored!.pipelineVersion).toBe("v3");
  });

  it("preserves tenant name and status", async () => {
    const tenantId = await seedTenant({ name: "preserve-me" });

    await updatePipeline(tenantId, {
      pipeline: { steps: [{ type: "builtin", op: "trim" }] },
    });

    const stored = await getTenantFromKV(tenantId);
    expect(stored!.name).toBe("preserve-me");
    expect(stored!.status).toBe("active");
  });

  it("rejects empty steps array", async () => {
    const tenantId = await seedTenant();

    const res = await updatePipeline(tenantId, {
      pipeline: { steps: [] },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("at least one step");
  });

  it("rejects missing pipeline field", async () => {
    const tenantId = await seedTenant();

    const res = await updatePipeline(tenantId, {});

    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent tenant", async () => {
    const res = await updatePipeline("nonexistent-id", {
      pipeline: { steps: [{ type: "builtin", op: "trim" }] },
    });

    expect(res.status).toBe(404);
  });
});
