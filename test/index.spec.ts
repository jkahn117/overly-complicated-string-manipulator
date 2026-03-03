import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Tenant, PipelineEnvelope } from "../src/types";

let testCounter = 0;
const nextId = (): string => `tenant-${++testCounter}`;

const makeTenant = (
  overrides: Partial<Tenant> = {},
): { tenantId: string; tenant: Tenant } => {
  const tenantId = nextId();
  const tenant: Tenant = {
    name: overrides.name ?? tenantId,
    status: "active",
    pipelineVersion: `v-${testCounter}`,
    pipeline: {
      steps: [{ type: "builtin", op: "uppercase" }],
    },
    ...overrides,
  };
  return { tenantId, tenant };
};

const seedTenant = async (
  overrides: Partial<Tenant> = {},
): Promise<string> => {
  const { tenantId, tenant } = makeTenant(overrides);
  await env.TENANTS.put(tenantId, JSON.stringify(tenant));
  return tenantId;
};

const postPipeline = (
  body: string,
  tenantId: string,
): Promise<Response> =>
  SELF.fetch("https://example.com/", {
    method: "POST",
    body,
    headers: {
      "content-type": "text/plain",
      "x-tenant-id": tenantId,
    },
  });

describe("middleware: tenant resolution", () => {
  it("returns 400 when x-tenant-id header is missing", async () => {
    const response = await SELF.fetch("https://example.com/", {
      method: "POST",
      body: "hello",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Missing tenant id");
  });

  it("returns 404 when tenant does not exist in KV", async () => {
    const response = await postPipeline("hello", "nonexistent");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Unknown tenant");
  });

  it("returns 403 when tenant is disabled", async () => {
    const tenantId = await seedTenant({ status: "disabled" });

    const response = await postPipeline("hello", tenantId);

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Tenant disabled");
  });

  it("returns 500 when tenant config is invalid JSON", async () => {
    const tenantId = nextId();
    await env.TENANTS.put(tenantId, "not-valid-json{{{");

    const response = await postPipeline("hello", tenantId);

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Invalid tenant configuration");
  });
});

describe("pipeline: missing or empty pipeline", () => {
  it("returns 400 when tenant has no pipeline steps", async () => {
    const tenantId = await seedTenant({
      pipeline: { steps: [] },
    });

    const response = await postPipeline("hello", tenantId);

    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("Tenant has no pipeline configured");
  });
});

describe("pipeline: builtin operations", () => {
  it("executes single uppercase step", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [{ type: "builtin", op: "uppercase" }],
      },
    });

    const response = await postPipeline("hello world", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();
    expect(result.data).toBe("HELLO WORLD");
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      step: 0,
      type: "builtin",
      op: "uppercase",
      input: "hello world",
      output: "HELLO WORLD",
    });
  });

  it("executes multi-step builtin pipeline", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [
          { type: "builtin", op: "uppercase" },
          {
            type: "builtin",
            op: "replace",
            config: { find: "HELLO", replace: "HI" },
          },
          { type: "builtin", op: "trim" },
        ],
      },
    });

    const response = await postPipeline("  hello world  ", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();
    expect(result.data).toBe("HI WORLD");
    expect(result.history).toHaveLength(3);

    expect(result.history[0]).toMatchObject({
      step: 0,
      op: "uppercase",
      input: "  hello world  ",
      output: "  HELLO WORLD  ",
    });
    expect(result.history[1]).toMatchObject({
      step: 1,
      op: "replace",
      input: "  HELLO WORLD  ",
      output: "  HI WORLD  ",
    });
    expect(result.history[2]).toMatchObject({
      step: 2,
      op: "trim",
      input: "  HI WORLD  ",
      output: "HI WORLD",
    });
  });

  it("executes lowercase step", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [{ type: "builtin", op: "lowercase" }],
      },
    });

    const response = await postPipeline("HELLO", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();
    expect(result.data).toBe("hello");
  });

  it("executes prefix step", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [
          { type: "builtin", op: "prefix", config: { value: ">>> " } },
        ],
      },
    });

    const response = await postPipeline("hello", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();
    expect(result.data).toBe(">>> hello");
  });

  it("executes suffix step", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [
          { type: "builtin", op: "suffix", config: { value: " <<<" } },
        ],
      },
    });

    const response = await postPipeline("hello", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();
    expect(result.data).toBe("hello <<<");
  });

  it("executes replace step with multiple occurrences", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [
          {
            type: "builtin",
            op: "replace",
            config: { find: "o", replace: "0" },
          },
        ],
      },
    });

    const response = await postPipeline("hello world foo", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();
    expect(result.data).toBe("hell0 w0rld f00");
  });
});

describe("pipeline: history tracking", () => {
  it("records input and output for every step", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [
          { type: "builtin", op: "trim" },
          { type: "builtin", op: "uppercase" },
          { type: "builtin", op: "suffix", config: { value: "!" } },
        ],
      },
    });

    const response = await postPipeline("  hello  ", tenantId);

    expect(response.status).toBe(200);
    const result: PipelineEnvelope = await response.json();

    expect(result.history).toHaveLength(3);

    // Each history entry has all required fields
    for (const entry of result.history) {
      expect(entry).toHaveProperty("step");
      expect(entry).toHaveProperty("type");
      expect(entry).toHaveProperty("op");
      expect(entry).toHaveProperty("input");
      expect(entry).toHaveProperty("output");
    }

    // Chain: each step's input === previous step's output
    expect(result.history[1].input).toBe(result.history[0].output);
    expect(result.history[2].input).toBe(result.history[1].output);

    // Final data matches last step's output
    expect(result.data).toBe(result.history[2].output);
    expect(result.data).toBe("HELLO!");
  });
});

describe("pipeline: error handling", () => {
  it("returns error with partial history when custom step fails", async () => {
    const tenantId = await seedTenant({
      pipeline: {
        steps: [
          { type: "builtin", op: "uppercase" },
          { type: "custom", workerName: "nonexistent-worker" },
          { type: "builtin", op: "trim" },
        ],
      },
    });

    const response = await postPipeline("hello", tenantId);

    // The isolate catches the error (either missing binding or DISPATCHER
    // not available locally) and the dispatch worker converts it to a FlowError
    expect(response.status).toBe(500);
    const result = (await response.json()) as {
      error: string;
      step: number;
      op: string;
      history: Array<{ step: number; op: string }>;
    };

    // Error response has the right structure
    expect(result).toHaveProperty("error");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);

    // Failed at the custom step (index 1)
    expect(result.step).toBe(1);
    expect(result.op).toContain("custom:nonexistent-worker");

    // Partial history: only the successful builtin step before the failure
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      step: 0,
      type: "builtin",
      op: "uppercase",
      input: "hello",
      output: "HELLO",
    });
  });
});
