import { WorkerEntrypoint } from "cloudflare:workers";
import type { UsageEvent } from "./types";

type CustomProxyProps = {
  tenantId: string;
  tenantName: string;
  workerName: string;
  allowedWorkers: string[];
  stepIndex: number;
  pipelineVersion: string;
};

/**
 * CustomProxy is a WorkerEntrypoint that wraps DISPATCHER.get() so that
 * a LOADER isolate can call tenant Workers via injected service bindings.
 *
 * Exposes an RPC method `transform(input)` instead of raw fetch().
 * The isolate calls `await env.CUSTOM_xyz.transform(data)` — no HTTP
 * serialization needed on the isolate<->proxy hop.
 *
 * The proxy->tenant hop still uses fetch() because tenant Workers are
 * dispatch namespace stubs (Fetcher-based).
 *
 * Cross-tenant isolation: validates that the requested workerName is in
 * the allowedWorkers list passed via ctx.props before dispatching.
 *
 * Analytics: emits a UsageEvent to the USAGE_PIPELINE binding for each
 * custom step execution (success or failure). The write is non-blocking
 * via waitUntil and is invisible to the customer's generated code.
 */
export class CustomProxy extends WorkerEntrypoint {
  async transform(input: string): Promise<string> {
    const {
      tenantId,
      tenantName,
      workerName,
      allowedWorkers,
      stepIndex,
      pipelineVersion,
    } = this.ctx.props as CustomProxyProps;

    if (!allowedWorkers.includes(workerName)) {
      throw new Error(
        `Worker "${workerName}" is not authorized for this tenant`,
      );
    }

    // Script names in the dispatch namespace are scoped per tenant
    // to avoid collisions (e.g. two tenants both naming a worker "reverse").
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
        throw new Error(
          `Custom worker "${workerName}" returned status ${response.status}`,
        );
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

      // Guard: USAGE_PIPELINE may not be available in local dev
      if (this.env.USAGE_PIPELINE) {
        this.ctx.waitUntil(
          this.env.USAGE_PIPELINE.send([{ value: event }]),
        );
      }
    }
  }
}
