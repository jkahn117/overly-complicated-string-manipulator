import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
		// DISPATCHER bindings don't support local dev — miniflare's internal proxy
		// worker throws an unhandled rejection we can't catch from user code.
		// Our tests still validate the error is surfaced correctly via the response.
		// This prevents the unhandled rejection from causing a non-zero exit code.
		dangerouslyIgnoreUnhandledErrors: true,
	} as any,
});
