import {
  getWebSearchCacheCounts,
  getWebSearchMaintenanceState,
} from "@/db/web-search";
import { listWebSearchConnections } from "@/db/web-search-connections";
import {
  getWebSearchMetrics,
  type WebSearchMetricsReport,
} from "@/db/web-search-metrics";

export interface WebSearchHealth {
  status: "healthy" | "degraded";
  checkedAt: string;
  providers: Array<{
    providerId: string;
    configured: boolean;
    enabled: boolean;
    lastTestStatus?: "success" | "failed";
    lastTestedAt?: string;
  }>;
  cache: ReturnType<typeof getWebSearchCacheCounts>;
  maintenance: ReturnType<typeof getWebSearchMaintenanceState>;
  lastSevenDays: {
    searches: number;
    providerFailureRate: number;
    estimatedCredits: number;
  };
}

export function getWebSearchMetricsForRange(
  from?: string,
  to?: string,
): WebSearchMetricsReport {
  const end = to ? parseDate(to, "to") : new Date();
  const start = from
    ? parseDate(from, "from")
    : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (start.getTime() > end.getTime()) throw new Error("from must not be after to.");
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new Error("Metrics range must not exceed 366 days.");
  }
  return getWebSearchMetrics(start.toISOString(), end.toISOString());
}

export function getWebSearchHealth(): WebSearchHealth {
  const metrics = getWebSearchMetricsForRange();
  const connections = listWebSearchConnections();
  const providers = ["arxiv", "openalex", "tavily", "brave", "mcp"].map((providerId) => {
    if (providerId === "arxiv") {
      return { providerId, configured: true, enabled: true };
    }
    const connection = connections.find((item) => item.provider === providerId);
    return {
      providerId,
      configured: Boolean(connection),
      enabled: connection?.enabled ?? false,
      lastTestStatus: connection?.lastTestStatus,
      lastTestedAt: connection?.lastTestedAt,
    };
  });
  const providerCalls = metrics.providers.reduce((sum, provider) => sum + provider.calls, 0);
  const successfulCalls = metrics.providers.reduce(
    (sum, provider) => sum + provider.calls * provider.successRate,
    0,
  );
  const providerFailureRate =
    providerCalls > 0 ? 1 - successfulCalls / providerCalls : 0;
  return {
    status:
      providers.some((provider) => provider.enabled && provider.lastTestStatus === "failed") ||
      providerFailureRate > 0.5
        ? "degraded"
        : "healthy",
    checkedAt: new Date().toISOString(),
    providers,
    cache: getWebSearchCacheCounts(),
    maintenance: getWebSearchMaintenanceState(),
    lastSevenDays: {
      searches: metrics.usage.searches,
      providerFailureRate,
      estimatedCredits: metrics.providers.reduce(
        (sum, provider) => sum + provider.estimatedCredits,
        0,
      ),
    },
  };
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid date.`);
  return parsed;
}
