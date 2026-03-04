import type Alpine from "alpinejs";

export type BuiltinOp =
  | "uppercase"
  | "lowercase"
  | "trim"
  | "replace"
  | "prefix"
  | "suffix";

export interface BuiltinStep {
  id: string;
  type: "builtin";
  op: BuiltinOp;
  config: Record<string, string>;
}

export interface CustomStepEntry {
  id: string;
  type: "custom";
  workerName: string;
}

export type Step = BuiltinStep | CustomStepEntry;

export interface HistoryEntry {
  step: number;
  type: string;
  op: string;
  input: string;
  output: string;
}

export interface PipelineResult {
  data: string;
  history: HistoryEntry[];
  generatedCode?: string;
}

export interface PipelineError {
  error: string;
  step: number;
  op: string;
  history: HistoryEntry[];
}

export interface CustomWorker {
  name: string;
  code: string;
  createdAt: string;
  updatedAt: string;
}

/** Operations and their required config fields */
const configFields: Partial<Record<BuiltinOp, string[]>> = {
  replace: ["find", "replace"],
  prefix: ["value"],
  suffix: ["value"],
};

export function needsConfig(op: BuiltinOp): boolean {
  return op in configFields;
}

export function getConfigFields(op: BuiltinOp): string[] {
  return configFields[op] ?? [];
}

export const allOps: BuiltinOp[] = [
  "uppercase",
  "lowercase",
  "trim",
  "replace",
  "prefix",
  "suffix",
];

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const DEFAULT_TENANT_ID = "playground";

/** Read tenant ID from ?tenant= URL param, falling back to default. */
function getTenantFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("tenant") || DEFAULT_TENANT_ID;
}

/** Sync tenant ID to ?tenant= URL param without a page reload. */
function syncTenantToUrl(tenantId: string): void {
  const url = new URL(window.location.href);
  if (tenantId && tenantId !== DEFAULT_TENANT_ID) {
    url.searchParams.set("tenant", tenantId);
  } else {
    url.searchParams.delete("tenant");
  }
  window.history.replaceState({}, "", url.toString());
}

// ── Helpers for API calls with tenant header ────────────────────────

function tenantHeaders(tenantId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "x-tenant-id": tenantId, ...extra };
}

function jsonTenantHeaders(tenantId: string): Record<string, string> {
  return tenantHeaders(tenantId, { "Content-Type": "application/json" });
}

/**
 * Ensure the tenant exists by creating it if a test request returns 404.
 * Returns true if the tenant is available, false if creation failed.
 */
async function ensureTenant(tenantId: string): Promise<boolean> {
  // Quick probe — use a lightweight GET to check if the tenant exists.
  const probe = await fetch("/workers", {
    headers: tenantHeaders(tenantId),
  });
  if (probe.ok) return true;
  if (probe.status !== 404) return true; // non-404 means tenant exists but something else is wrong

  // Tenant doesn't exist — create it with a minimal pipeline
  const createRes = await fetch("/admin/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId,
      name: tenantId,
      pipeline: { steps: [{ type: "builtin", op: "uppercase" }] },
    }),
  });
  return createRes.ok;
}

// ── Store interface ─────────────────────────────────────────────────

type StepPayload =
  | { type: "builtin"; op: string; config?: Record<string, string> }
  | { type: "custom"; workerName: string };

export interface PipelineStore {
  input: string;
  steps: Step[];
  result: PipelineResult | null;
  error: PipelineError | null;
  loading: boolean;
  tenantId: string;

  // Custom workers
  customWorkers: CustomWorker[];
  workersLoading: boolean;
  editingWorker: CustomWorker | null;
  workerCreating: boolean;
  workerSaving: boolean;
  workerSaveSuccess: boolean;
  workerDeleting: string | null; // name of worker being deleted, or null
  workerError: string | null;

  readonly canRun: boolean;
  setTenantId(id: string): void;

  // Builtin steps
  addStep(op: BuiltinOp): void;
  // Custom steps
  addCustomStep(workerName: string): void;

  removeStep(id: string): void;
  moveStep(index: number, direction: -1 | 1): void;
  buildPayload(): { steps: StepPayload[] };
  run(): Promise<void>;

  // Tenant management
  ensureTenant(): Promise<boolean>;

  // Custom worker CRUD
  loadWorkers(): Promise<void>;
  createWorker(name: string): Promise<void>;
  editWorker(name: string): Promise<void>;
  saveWorker(): Promise<void>;
  deleteWorker(name: string): Promise<void>;
  closeEditor(): void;
}

export function registerStore(alpine: typeof Alpine): void {
  alpine.store("pipeline", {
    input: "  Hello, World!  ",
    steps: [] as Step[],
    result: null as PipelineResult | null,
    error: null as PipelineError | null,
    loading: false,
    tenantId: getTenantFromUrl(),

    // Custom workers state
    customWorkers: [] as CustomWorker[],
    workersLoading: false,
    editingWorker: null as CustomWorker | null,
    workerCreating: false,
    workerSaving: false,
    workerSaveSuccess: false,
    workerDeleting: null as string | null,
    workerError: null as string | null,

    get canRun(): boolean {
      return (this as unknown as PipelineStore).input.trim().length > 0
        && (this as unknown as PipelineStore).steps.length > 0
        && !(this as unknown as PipelineStore).loading;
    },

    setTenantId(this: PipelineStore, id: string): void {
      this.tenantId = id;
      syncTenantToUrl(id);
      // Reload custom workers for the new tenant
      this.loadWorkers();
    },

    addStep(this: PipelineStore, op: BuiltinOp): void {
      const config: Record<string, string> = {};
      for (const field of getConfigFields(op)) {
        config[field] = "";
      }
      this.steps.push({ id: generateId(), type: "builtin", op, config });
    },

    addCustomStep(this: PipelineStore, workerName: string): void {
      this.steps.push({ id: generateId(), type: "custom", workerName });
    },

    removeStep(this: PipelineStore, id: string): void {
      this.steps = this.steps.filter((s) => s.id !== id);
    },

    moveStep(this: PipelineStore, index: number, direction: -1 | 1): void {
      const target = index + direction;
      if (target < 0 || target >= this.steps.length) return;
      const temp = this.steps[index];
      this.steps[index] = this.steps[target];
      this.steps[target] = temp;
    },

    buildPayload(this: PipelineStore) {
      return {
        steps: this.steps.map((s): StepPayload => {
          if (s.type === "custom") {
            return { type: "custom", workerName: s.workerName };
          }
          const step: StepPayload = { type: "builtin", op: s.op };
          if (needsConfig(s.op)) {
            (step as { config?: Record<string, string> }).config = { ...s.config };
          }
          return step;
        }),
      };
    },

    // ── Tenant management ────────────────────────────────────────

    async ensureTenant(this: PipelineStore): Promise<boolean> {
      return ensureTenant(this.tenantId);
    },

    // ── Custom worker CRUD ────────────────────────────────────────

    async loadWorkers(this: PipelineStore): Promise<void> {
      this.workersLoading = true;
      try {
        // Ensure the tenant exists before listing workers
        await this.ensureTenant();

        const res = await fetch("/workers", {
          headers: tenantHeaders(this.tenantId),
        });
        if (res.ok) {
          const data = (await res.json()) as { workers: Array<{ name: string; updatedAt: string }> };
          // Map list entries to partial CustomWorker objects (code loaded on edit)
          this.customWorkers = data.workers.map((w) => ({
            name: w.name,
            code: "",
            createdAt: "",
            updatedAt: w.updatedAt,
          }));
        }
      } catch {
        // Silently fail — workers list is non-critical
      } finally {
        this.workersLoading = false;
      }
    },

    async createWorker(this: PipelineStore, name: string): Promise<void> {
      this.workerError = null;
      this.workerCreating = true;
      try {
        const res = await fetch("/workers", {
          method: "POST",
          headers: jsonTenantHeaders(this.tenantId),
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: "Failed to create" }))) as Record<string, unknown>;
          this.workerError = (err.error as string) ?? "Failed to create worker";
          return;
        }
        const record = (await res.json()) as CustomWorker & { warning?: string };
        if (record.warning) {
          this.workerError = record.warning;
        }
        // Optimistically add to the list — KV.list() is eventually consistent
        // and may not return the new key immediately after KV.put().
        if (!this.customWorkers.some((w) => w.name === record.name)) {
          this.customWorkers.push({
            name: record.name,
            code: record.code,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
        }
        // Open the editor immediately for the new worker
        this.editingWorker = record;
      } catch {
        this.workerError = "Network error creating worker";
      } finally {
        this.workerCreating = false;
      }
    },

    async editWorker(this: PipelineStore, name: string): Promise<void> {
      this.workerError = null;
      try {
        const res = await fetch(`/workers/${encodeURIComponent(name)}`, {
          headers: tenantHeaders(this.tenantId),
        });
        if (!res.ok) {
          this.workerError = "Failed to load worker";
          return;
        }
        this.editingWorker = (await res.json()) as CustomWorker;
      } catch {
        this.workerError = "Network error loading worker";
      }
    },

    async saveWorker(this: PipelineStore): Promise<void> {
      if (!this.editingWorker) return;
      this.workerSaving = true;
      this.workerSaveSuccess = false;
      this.workerError = null;
      try {
        const res = await fetch(`/workers/${encodeURIComponent(this.editingWorker.name)}`, {
          method: "PUT",
          headers: jsonTenantHeaders(this.tenantId),
          body: JSON.stringify({ code: this.editingWorker.code }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: "Failed to save" }))) as Record<string, unknown>;
          this.workerError = (err.error as string) ?? "Failed to save worker";
          return;
        }
        const body = (await res.json()) as CustomWorker & { warning?: string };
        this.editingWorker = body;
        // Optimistically update the list entry's updatedAt
        const idx = this.customWorkers.findIndex((w) => w.name === body.name);
        if (idx !== -1) {
          this.customWorkers[idx] = {
            name: body.name,
            code: body.code,
            createdAt: body.createdAt,
            updatedAt: body.updatedAt,
          };
        }
        if (body.warning) {
          this.workerError = body.warning;
        } else {
          // Flash success indicator, auto-clear after 2s
          this.workerSaveSuccess = true;
          setTimeout(() => { this.workerSaveSuccess = false; }, 2000);
        }
      } catch {
        this.workerError = "Network error saving worker";
      } finally {
        this.workerSaving = false;
      }
    },

    async deleteWorker(this: PipelineStore, name: string): Promise<void> {
      this.workerError = null;
      this.workerDeleting = name;
      try {
        const res = await fetch(`/workers/${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: tenantHeaders(this.tenantId),
        });
        if (!res.ok) {
          this.workerError = "Failed to delete worker";
          return;
        }
        // Close editor if deleting the currently edited worker
        if (this.editingWorker?.name === name) {
          this.editingWorker = null;
        }
        // Remove any pipeline steps using this worker
        this.steps = this.steps.filter(
          (s) => !(s.type === "custom" && s.workerName === name),
        );
        // Optimistically remove from the list
        this.customWorkers = this.customWorkers.filter((w) => w.name !== name);
      } catch {
        this.workerError = "Network error deleting worker";
      } finally {
        this.workerDeleting = null;
      }
    },

    closeEditor(this: PipelineStore): void {
      this.editingWorker = null;
      this.workerError = null;
    },

    // ── Pipeline execution ────────────────────────────────────────

    async run(this: PipelineStore): Promise<void> {
      this.loading = true;
      this.result = null;
      this.error = null;

      try {
        const pipeline = this.buildPayload();

        // Ensure the tenant exists before saving the pipeline
        const tenantReady = await this.ensureTenant();
        if (!tenantReady) {
          this.error = {
            error: "Failed to create tenant",
            step: -1,
            op: "create",
            history: [],
          };
          return;
        }

        // Save current pipeline to the tenant
        const saveRes = await fetch("/pipeline", {
          method: "PUT",
          headers: jsonTenantHeaders(this.tenantId),
          body: JSON.stringify({ pipeline }),
        });

        if (!saveRes.ok) {
          const err = (await saveRes.json().catch(() => ({ error: "Failed to save pipeline" }))) as Record<
            string,
            unknown
          >;
          this.error = {
            error: (err.error as string) ?? `Save failed (${saveRes.status})`,
            step: -1,
            op: "save",
            history: [],
          };
          return;
        }

        // Execute the pipeline
        const execRes = await fetch("/?include=code", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "x-tenant-id": this.tenantId,
          },
          body: this.input,
        });

        const body = await execRes.json();

        if (execRes.ok) {
          this.result = body as PipelineResult;
        } else {
          this.error = body as PipelineError;
        }
      } catch (e) {
        this.error = {
          error: e instanceof Error ? e.message : "Unknown error",
          step: -1,
          op: "network",
          history: [],
        };
      } finally {
        this.loading = false;
      }
    },
  });
}
