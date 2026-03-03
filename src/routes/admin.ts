import { Hono } from "hono";
import type { AppEnv, FlowDefinition } from "../types";

type CreateTenantRequest = {
  name: string;
  pipeline: FlowDefinition;
};

export const adminRouter = new Hono<AppEnv>();

const generateTenantId = (): string => {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return (
    "t_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
};

adminRouter.post("/tenants", async (c) => {
  const body = await c.req.json<CreateTenantRequest>();

  if (!body.name) {
    return c.json({ error: "Missing tenant name" }, 400);
  }

  if (!body.pipeline?.steps?.length) {
    return c.json({ error: "Missing pipeline definition" }, 400);
  }

  const tenantId = generateTenantId();
  await c.env.TENANTS.put(
    tenantId,
    JSON.stringify({
      name: body.name,
      status: "active",
      pipelineVersion: "v1",
      pipeline: body.pipeline,
    }),
  );

  return c.json({ tenantId, name: body.name }, 201);
});
