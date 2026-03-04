import type { Env } from "./types";

/**
 * Client for the Cloudflare Workers for Platforms dispatch namespace REST API.
 *
 * Deploys and deletes user worker scripts in a dispatch namespace so they
 * can be invoked via `env.DISPATCHER.get(scriptName)` at runtime.
 *
 * API reference:
 * https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CfApiResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: unknown;
}

function scriptUrl(env: Env, scriptName: string): string {
  return `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.CF_DISPATCH_NAMESPACE}/scripts/${scriptName}`;
}

/**
 * Deploy a worker script to the dispatch namespace.
 *
 * Uses multipart form upload with ES module format.
 * The script must be a valid ES module with a default fetch handler.
 */
export async function deployToDispatchNamespace(
  env: Env,
  scriptName: string,
  code: string,
): Promise<void> {
  const metadata = JSON.stringify({
    main_module: `${scriptName}.mjs`,
    compatibility_date: "2026-02-27",
  });

  const formData = new FormData();
  formData.append(
    "metadata",
    new Blob([metadata], { type: "application/json" }),
  );
  formData.append(
    `${scriptName}.mjs`,
    new Blob([code], { type: "application/javascript+module" }),
  );

  const response = await fetch(scriptUrl(env, scriptName), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({
      errors: [{ message: `HTTP ${response.status}` }],
    }))) as CfApiResponse;
    const message = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${response.status}`;
    throw new Error(`Failed to deploy "${scriptName}" to dispatch namespace: ${message}`);
  }
}

/**
 * Delete a worker script from the dispatch namespace.
 */
export async function deleteFromDispatchNamespace(
  env: Env,
  scriptName: string,
): Promise<void> {
  const response = await fetch(scriptUrl(env, scriptName), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
  });

  // 404 is fine — script was already gone
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => ({
      errors: [{ message: `HTTP ${response.status}` }],
    }))) as CfApiResponse;
    const message = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${response.status}`;
    throw new Error(`Failed to delete "${scriptName}" from dispatch namespace: ${message}`);
  }
}

/**
 * Check whether the dispatch namespace deployment vars are configured.
 * If not, deploy/delete operations should be skipped gracefully.
 */
export function isDispatchConfigured(env: Env): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.CF_DISPATCH_NAMESPACE);
}
