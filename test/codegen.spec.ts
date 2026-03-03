import { describe, it, expect } from "vitest";
import {
  generatePipelineWorkerCode,
  sanitizeBindingName,
} from "../src/codegen";
import type { FlowDefinition } from "../src/types";

describe("sanitizeBindingName", () => {
  it("replaces hyphens with underscores", () => {
    expect(sanitizeBindingName("acme-custom-step")).toBe("acme_custom_step");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeBindingName("acme.step.v2")).toBe("acme_step_v2");
  });

  it("leaves alphanumeric names unchanged", () => {
    expect(sanitizeBindingName("acmeStep1")).toBe("acmeStep1");
  });

  it("replaces multiple special characters", () => {
    expect(sanitizeBindingName("my@worker!name")).toBe("my_worker_name");
  });
});

describe("generatePipelineWorkerCode", () => {
  it("generates valid JS module with export default", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "builtin", op: "uppercase" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain("export default");
    expect(code).toContain("async fetch(request, env, ctx)");
  });

  it("generates builtin uppercase step", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "builtin", op: "uppercase" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain("data.toUpperCase()");
    expect(code).toContain('type: "builtin"');
    expect(code).toContain('op: "uppercase"');
  });

  it("generates builtin lowercase step", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "builtin", op: "lowercase" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain("data.toLowerCase()");
  });

  it("generates builtin trim step", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "builtin", op: "trim" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain("data.trim()");
  });

  it("generates builtin replace step with config", () => {
    const pipeline: FlowDefinition = {
      steps: [
        {
          type: "builtin",
          op: "replace",
          config: { find: "foo", replace: "bar" },
        },
      ],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain('data.replaceAll("foo", "bar")');
  });

  it("generates builtin prefix step with config", () => {
    const pipeline: FlowDefinition = {
      steps: [
        { type: "builtin", op: "prefix", config: { value: ">>>" } },
      ],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain('">>>" + data');
  });

  it("generates builtin suffix step with config", () => {
    const pipeline: FlowDefinition = {
      steps: [
        { type: "builtin", op: "suffix", config: { value: "<<<" } },
      ],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain('data + "<<<');
  });

  it("generates custom step with RPC transform call", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "custom", workerName: "acme-custom-step" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain("CUSTOM_acme_custom_step");
    expect(code).toContain("binding.transform(data)");
    expect(code).toContain('type: "custom"');
    expect(code).toContain('op: "acme-custom-step"');
  });

  it("generates multi-step pipeline in order", () => {
    const pipeline: FlowDefinition = {
      steps: [
        { type: "builtin", op: "trim" },
        { type: "builtin", op: "uppercase" },
        { type: "custom", workerName: "my-worker" },
      ],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");

    // Verify step ordering via comments
    const trimIdx = code.indexOf("Step 0: builtin:trim");
    const upperIdx = code.indexOf("Step 1: builtin:uppercase");
    const customIdx = code.indexOf("Step 2: custom:my-worker");

    expect(trimIdx).toBeGreaterThan(-1);
    expect(upperIdx).toBeGreaterThan(trimIdx);
    expect(customIdx).toBeGreaterThan(upperIdx);
  });

  it("generates history tracking for each step", () => {
    const pipeline: FlowDefinition = {
      steps: [
        { type: "builtin", op: "uppercase" },
        { type: "custom", workerName: "my-worker" },
      ],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");

    // Each step should push to history
    const historyPushCount = (code.match(/history\.push/g) || []).length;
    expect(historyPushCount).toBe(2);
  });

  it("wraps each step in try/catch for error isolation", () => {
    const pipeline: FlowDefinition = {
      steps: [
        { type: "builtin", op: "uppercase" },
        { type: "builtin", op: "trim" },
        { type: "custom", workerName: "my-worker" },
      ],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");

    // Each step block has its own try/catch
    const tryCatchCount = (code.match(/try\s*\{/g) || []).length;
    // 3 per-step try/catches + 1 outer try/catch = 4
    expect(tryCatchCount).toBe(4);
  });

  it("generates error response with partial history on failure", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "builtin", op: "uppercase" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    // The outer catch returns a 500 with history
    expect(code).toContain("status: 500");
    expect(code).toContain("err.message");
    expect(code).toContain("history,");
  });

  it("checks for missing custom worker binding", () => {
    const pipeline: FlowDefinition = {
      steps: [{ type: "custom", workerName: "missing-worker" }],
    };

    const code = generatePipelineWorkerCode(pipeline, "test-tenant");
    expect(code).toContain('typeof binding.transform !== "function"');
    expect(code).toContain("Missing or invalid binding for custom worker");
  });
});
