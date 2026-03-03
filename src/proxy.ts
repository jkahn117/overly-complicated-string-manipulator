import { WorkerEntrypoint } from "cloudflare:workers";

type CustomProxyProps = {
  workerName: string;
  allowedWorkers: string[];
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
 */
export class CustomProxy extends WorkerEntrypoint {
  async transform(input: string): Promise<string> {
    const { workerName, allowedWorkers } =
      this.ctx.props as CustomProxyProps;

    if (!allowedWorkers.includes(workerName)) {
      throw new Error(
        `Worker "${workerName}" is not authorized for this tenant`,
      );
    }

    const worker = this.env.DISPATCHER.get(workerName);
    const response = await worker.fetch("http://internal/", {
      method: "POST",
      body: input,
      headers: { "content-type": "text/plain" },
    });

    if (!response.ok) {
      throw new Error(
        `Custom worker "${workerName}" returned status ${response.status}`,
      );
    }

    return response.text();
  }
}
