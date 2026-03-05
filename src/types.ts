export type AppVariables = {
  tenantId: string;
  tenant: Tenant;
};

export type Env = Cloudflare.Env;

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

export type TenantStatus = "active" | "disabled";

export type Tenant = {
  name: string;
  status: TenantStatus;
  pipelineVersion: string;
  pipeline: FlowDefinition;
};

export type FlowDefinition = {
  steps: FlowStep[];
};

export type FlowStep = BuiltinStep | CustomStep;

export type BuiltinStep = {
  type: "builtin";
  op: BuiltinOp;
  config?: Record<string, unknown>;
};

export type CustomStep = {
  type: "custom";
  workerName: string;
};

export type BuiltinOp =
  | "uppercase"
  | "lowercase"
  | "trim"
  | "replace"
  | "prefix"
  | "suffix";

export type PipelineEnvelope = {
  data: string;
  history: HistoryEntry[];
  generatedCode?: string;
};

export type HistoryEntry = {
  step: number;
  type: string;
  op: string;
  input: string;
  output: string;
  durationMs?: number;
};

export type CustomWorkerRecord = {
  name: string;
  code: string;
  createdAt: string;
  updatedAt: string;
};

export class FlowError extends Error {
  constructor(
    public step: number,
    public op: string,
    public reason: string,
    public history: HistoryEntry[] = [],
  ) {
    super(`Pipeline failed at step ${step} (${op}): ${reason}`);
    this.name = "FlowError";
  }
}

/** Usage event emitted to the analytics pipeline for billing. */
export type UsageEvent = {
  tenantId: string;
  tenantName: string;
  stepType: "builtin" | "custom";
  opName: string;
  stepIndex: number;
  pipelineVersion: string;
  durationMs: number;
  success: boolean;
  timestamp: string;
};
