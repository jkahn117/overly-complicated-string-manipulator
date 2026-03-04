import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import type { Tenant, CustomWorkerRecord } from "../src/types";

// Deploy calls hit the real Cloudflare API when .dev.vars has credentials,
// so we need a generous timeout for tests that trigger dispatch deploys.
const DEPLOY_TIMEOUT = 15_000;

let counter = 0;

const seedTenant = async (): Promise<string> => {
  const tenantId = `worker-test-${++counter}`;
  const tenant: Tenant = {
    name: tenantId,
    status: "active",
    pipelineVersion: "v1",
    pipeline: { steps: [{ type: "builtin", op: "trim" }] },
  };
  await env.TENANTS.put(tenantId, JSON.stringify(tenant));
  return tenantId;
};

const headers = (tenantId: string, extra: Record<string, string> = {}) => ({
  "x-tenant-id": tenantId,
  ...extra,
});

const jsonHeaders = (tenantId: string) =>
  headers(tenantId, { "content-type": "application/json" });

// ── CRUD helpers ────────────────────────────────────────────────────

const listWorkers = (tenantId: string) =>
  SELF.fetch("https://example.com/workers", {
    headers: headers(tenantId),
  });

const getWorker = (tenantId: string, name: string) =>
  SELF.fetch(`https://example.com/workers/${name}`, {
    headers: headers(tenantId),
  });

const createWorker = (tenantId: string, body: unknown) =>
  SELF.fetch("https://example.com/workers", {
    method: "POST",
    headers: jsonHeaders(tenantId),
    body: JSON.stringify(body),
  });

const updateWorker = (tenantId: string, name: string, body: unknown) =>
  SELF.fetch(`https://example.com/workers/${name}`, {
    method: "PUT",
    headers: jsonHeaders(tenantId),
    body: JSON.stringify(body),
  });

const deleteWorker = (tenantId: string, name: string) =>
  SELF.fetch(`https://example.com/workers/${name}`, {
    method: "DELETE",
    headers: headers(tenantId),
  });

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /workers (create)", () => {
  it("creates a worker with default code", { timeout: DEPLOY_TIMEOUT }, async () => {
    const tenantId = await seedTenant();

    const res = await createWorker(tenantId, { name: "my-step" });
    expect(res.status).toBe(201);

    const record = (await res.json()) as CustomWorkerRecord;
    expect(record.name).toBe("my-step");
    expect(record.code).toContain("async fetch(request)");
    expect(record.createdAt).toBeTruthy();
    expect(record.updatedAt).toBe(record.createdAt);
  });

  it("creates a worker with custom code", async () => {
    const tenantId = await seedTenant();
    const code = 'export default { async fetch(r) { return new Response("hi"); } };';

    const res = await createWorker(tenantId, { name: "custom-code", code });
    expect(res.status).toBe(201);

    const record = (await res.json()) as CustomWorkerRecord;
    expect(record.code).toBe(code);
  });

  it("rejects duplicate names", { timeout: DEPLOY_TIMEOUT }, async () => {
    const tenantId = await seedTenant();
    await createWorker(tenantId, { name: "dup" });

    const res = await createWorker(tenantId, { name: "dup" });
    expect(res.status).toBe(409);
  });

  it("rejects missing name", async () => {
    const tenantId = await seedTenant();

    const res = await createWorker(tenantId, {});
    expect(res.status).toBe(400);
  });

  it("rejects invalid names", async () => {
    const tenantId = await seedTenant();

    const invalid = ["123start", "has spaces", "a".repeat(65), "-dash-start"];
    for (const name of invalid) {
      const res = await createWorker(tenantId, { name });
      expect(res.status, `expected 400 for name "${name}"`).toBe(400);
    }
  });

  it("isolates workers between tenants", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();

    await createWorker(t1, { name: "shared-name" });

    // t2 should not see t1's worker
    const listRes = await listWorkers(t2);
    const { workers } = (await listRes.json()) as { workers: unknown[] };
    expect(workers).toHaveLength(0);
  });
});

describe("GET /workers (list)", () => {
  it("returns empty list for new tenant", async () => {
    const tenantId = await seedTenant();

    const res = await listWorkers(tenantId);
    expect(res.status).toBe(200);

    const { workers } = (await res.json()) as { workers: unknown[] };
    expect(workers).toHaveLength(0);
  });

  it("lists all workers for the tenant", { timeout: DEPLOY_TIMEOUT }, async () => {
    const tenantId = await seedTenant();
    await createWorker(tenantId, { name: "alpha" });
    await createWorker(tenantId, { name: "beta" });

    const res = await listWorkers(tenantId);
    const { workers } = (await res.json()) as {
      workers: Array<{ name: string; updatedAt: string }>;
    };
    expect(workers).toHaveLength(2);

    const names = workers.map((w) => w.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

describe("GET /workers/:name (get)", () => {
  it("returns a worker by name", async () => {
    const tenantId = await seedTenant();
    await createWorker(tenantId, { name: "fetched", code: "// my code" });

    const res = await getWorker(tenantId, "fetched");
    expect(res.status).toBe(200);

    const record = (await res.json()) as CustomWorkerRecord;
    expect(record.name).toBe("fetched");
    expect(record.code).toBe("// my code");
  });

  it("returns 404 for nonexistent worker", async () => {
    const tenantId = await seedTenant();

    const res = await getWorker(tenantId, "nope");
    expect(res.status).toBe(404);
  });
});

describe("PUT /workers/:name (update)", () => {
  it("updates worker code", { timeout: DEPLOY_TIMEOUT }, async () => {
    const tenantId = await seedTenant();
    await createWorker(tenantId, { name: "updatable" });

    const res = await updateWorker(tenantId, "updatable", {
      code: "// updated",
    });
    expect(res.status).toBe(200);

    const record = (await res.json()) as CustomWorkerRecord;
    expect(record.code).toBe("// updated");
    expect(record.name).toBe("updatable");
  });

  it("preserves createdAt on update", async () => {
    const tenantId = await seedTenant();

    const createRes = await createWorker(tenantId, { name: "timestamps" });
    const created = (await createRes.json()) as CustomWorkerRecord;

    const updateRes = await updateWorker(tenantId, "timestamps", {
      code: "// v2",
    });
    const updated = (await updateRes.json()) as CustomWorkerRecord;

    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("returns 404 for nonexistent worker", async () => {
    const tenantId = await seedTenant();

    const res = await updateWorker(tenantId, "ghost", { code: "// x" });
    expect(res.status).toBe(404);
  });

  it("rejects missing code field", { timeout: DEPLOY_TIMEOUT }, async () => {
    const tenantId = await seedTenant();
    await createWorker(tenantId, { name: "no-code" });

    const res = await updateWorker(tenantId, "no-code", {});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /workers/:name", () => {
  it("deletes an existing worker", async () => {
    const tenantId = await seedTenant();
    await createWorker(tenantId, { name: "doomed" });

    const res = await deleteWorker(tenantId, "doomed");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { deleted: string };
    expect(body.deleted).toBe("doomed");

    // Verify it's gone
    const getRes = await getWorker(tenantId, "doomed");
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for nonexistent worker", async () => {
    const tenantId = await seedTenant();

    const res = await deleteWorker(tenantId, "nope");
    expect(res.status).toBe(404);
  });
});
