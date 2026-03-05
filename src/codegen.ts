import type { FlowDefinition, BuiltinStep, CustomStep } from "./types";

/**
 * Sanitize a worker name into a valid JS identifier for use as an env binding key.
 * e.g. "acme-custom-step" -> "acme_custom_step"
 */
export const sanitizeBindingName = (workerName: string): string =>
  workerName.replace(/[^a-zA-Z0-9]/g, "_");

/**
 * Generate a complete Worker module string that executes all pipeline steps
 * in a single isolate. Built-in ops run as inline JS. Custom ops call
 * service bindings injected via env (e.g. env.CUSTOM_acme_step).
 */
export const generatePipelineWorkerCode = (
  pipeline: FlowDefinition,
  tenantName: string,
): string => {
  const stepBlocks = pipeline.steps.map((step, i) => {
    if (step.type === "builtin") {
      return generateBuiltinStepBlock(step, i);
    }
    return generateCustomStepBlock(step, i);
  });

  return `
export default {
  async fetch(request, env, ctx) {
    const history = [];
    let data = await request.text();

    if (typeof data !== "string") {
      return new Response(JSON.stringify({
        error: "Request body must be a string",
        step: -1,
        op: "input",
        history: [],
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    try {
${stepBlocks.join("\n\n")}

      return new Response(JSON.stringify({
        data,
        history,
      }), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message || "Unknown pipeline error",
        step: err.step ?? -1,
        op: err.op ?? "unknown",
        history,
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }
};
`;
};

const generateBuiltinStepBlock = (step: BuiltinStep, index: number): string => {
  const opLabel = `builtin:${step.op}`;

  let transform: string;
  switch (step.op) {
    case "uppercase":
      transform = "data = data.toUpperCase();";
      break;
    case "lowercase":
      transform = "data = data.toLowerCase();";
      break;
    case "trim":
      transform = "data = data.trim();";
      break;
    case "replace": {
      const find = JSON.stringify(step.config?.find ?? "");
      const replace = JSON.stringify(step.config?.replace ?? "");
      transform = `data = data.replaceAll(${find}, ${replace});`;
      break;
    }
    case "prefix": {
      const value = JSON.stringify(step.config?.value ?? "");
      transform = `data = ${value} + data;`;
      break;
    }
    case "suffix": {
      const value = JSON.stringify(step.config?.value ?? "");
      transform = `data = data + ${value};`;
      break;
    }
    default:
      transform = `throw Object.assign(new Error("Unknown builtin op: ${step.op}"), { step: ${index}, op: "${opLabel}" });`;
  }

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
