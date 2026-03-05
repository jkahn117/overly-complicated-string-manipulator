import type Alpine from "alpinejs";

type UsageSummary = {
  totalEvents: number;
  totalBuiltin: number;
  totalCustom: number;
  uniqueTenants: number;
};

type TenantUsage = {
  tenantId: string;
  tenantName: string;
  builtinSteps: number;
  customSteps: number;
  totalSteps: number;
  successRate: number;
  avgDurationMs: number;
  lastSeen: string;
};

type UsageResponse = {
  summary: UsageSummary;
  tenants: TenantUsage[];
};

export function registerUsageData(alpine: typeof Alpine): void {
  alpine.data("usageData", () => ({
    loading: false,
    error: null as string | null,
    data: null as UsageResponse | null,

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const res = await fetch("/admin/usage");
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.error ?? `Failed to load usage data (${res.status})`,
          );
        }
        this.data = await res.json();
      } catch (err: unknown) {
        this.error =
          err instanceof Error ? err.message : "Failed to load usage data";
      } finally {
        this.loading = false;
      }
    },

    formatTime(iso: string): string {
      if (!iso) return "";
      const d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString();
    },
  }));
}
