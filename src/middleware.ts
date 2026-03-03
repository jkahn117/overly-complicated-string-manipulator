import { createMiddleware } from "hono/factory";
import type { AppEnv, Tenant } from "./types";

const getTenant = createMiddleware<AppEnv>(async (c, next) => {
	const tenantId = c.req.header("x-tenant-id");
	if (!tenantId) {
		return c.text("Missing tenant id", 400);
	}

	const tenantJson = await c.env.TENANTS.get(tenantId);
	if (!tenantJson) {
		return c.text("Unknown tenant", 404);
	}

	let tenant: Tenant;
	try {
		tenant = JSON.parse(tenantJson) as Tenant;
	} catch {
		return c.text("Invalid tenant configuration", 500);
	}

	if (tenant.status !== "active") {
		return c.text("Tenant disabled", 403);
	}

	c.set("tenantId", tenantId);
	c.set("tenant", tenant);

	await next();
});

export { getTenant };
