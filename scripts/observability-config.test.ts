import { describe, expect, it, vi } from "vitest";
import { SAFE_LOG_FIELDS } from "../apps/edge/src/logging";

import {
  buildDryRunPlan,
  loadObservabilityConfig,
  parseObservabilityConfig,
  validateObservabilityConfig,
} from "./observability-config";

describe("observability contract", () => {
  it("covers every specification metric, platform metric, and exact alert threshold", () => {
    const config = loadObservabilityConfig();

    expect(validateObservabilityConfig(config)).toEqual({
      ok: true,
      schemaVersion: 1,
      savedQueries: 14,
      specMetricsCovered: 12,
      platformMetricsCovered: 2,
      alerts: 7,
      runtimeEvents: 20,
      remoteMutationsExecuted: false,
    });
  });

  it("builds only redacted dry-run POST requests in the official saved-query body shape", () => {
    const config = loadObservabilityConfig();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const plan = buildDryRunPlan(config);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(plan.remoteMutationsExecuted).toBe(false);
    expect(plan.requests).toHaveLength(14);
    expect(plan.alerts).toHaveLength(7);
    for (const request of plan.requests) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/accounts/{account_id}/workers/observability/queries");
      expect(request.headers.Authorization).toBe("Bearer <redacted>");
      expect(Object.keys(request.body).sort()).toEqual(["description", "name", "parameters"]);
      expect(request.body).not.toHaveProperty("chart");
      expect(request.body).not.toHaveProperty("timeframe");
    }
    fetchSpy.mockRestore();
  });

  it("rejects threshold drift and undeclared telemetry fields", () => {
    const thresholdDrift = structuredClone(loadObservabilityConfig());
    const commitAlert = thresholdDrift.alerts.find((alert) => alert.id === "commit_p95_25ms");
    if (commitAlert === undefined) throw new Error("fixture alert missing");
    commitAlert.condition.threshold = 30;
    expect(() => parseObservabilityConfig(thresholdDrift)).toThrow(/threshold drifted/);

    const fieldDrift = structuredClone(loadObservabilityConfig());
    const commitQuery = fieldDrift.savedQueries.find((query) => query.id === "commit_latency");
    if (commitQuery === undefined) throw new Error("fixture query missing");
    const calculation = commitQuery.saveRequest.parameters.calculations?.[0];
    if (calculation === undefined) throw new Error("fixture calculation missing");
    calculation.key = "uncontractedLatency";
    expect(() => parseObservabilityConfig(fieldDrift)).toThrow(/undeclared telemetry field/);
  });

  it("keeps the runtime scalar allowlist exactly aligned with the declared contract", () => {
    const config = loadObservabilityConfig();
    const declared = new Set(Object.keys(config.runtimeContract.commonFields));
    for (const event of config.runtimeContract.events) {
      for (const field of Object.keys(event.requiredFields)) declared.add(field);
    }
    for (const generatedField of ["event", "level", "at"]) declared.delete(generatedField);

    expect([...SAFE_LOG_FIELDS].sort()).toEqual([...declared].sort());
    for (const forbidden of config.runtimeContract.privacy.forbiddenFields) {
      expect(SAFE_LOG_FIELDS).not.toContain(forbidden);
    }
  });

  it("keeps custom quota telemetry board-scoped and account quota signals platform-owned", () => {
    const config = loadObservabilityConfig();
    const quotaEvent = config.runtimeContract.events.find((event) => event.event === "quota.daily");
    if (quotaEvent === undefined) throw new Error("quota.daily contract missing");

    for (const fabricated of [
      "scope",
      "workerRequestsEstimate",
      "activeDurationMsEstimate",
      "r2BytesRead",
      "requestQuotaUtilization",
      "rowWriteQuotaUtilization",
    ]) {
      expect(quotaEvent.requiredFields).not.toHaveProperty(fabricated);
      expect(SAFE_LOG_FIELDS).not.toContain(fabricated);
    }

    const alert = config.alerts.find(
      (candidate) => candidate.id === "daily_request_or_row_write_70pct",
    );
    if (alert === undefined) throw new Error("daily quota alert missing");
    expect(alert.condition.signals).toEqual([
      expect.objectContaining({
        source: "cloudflare_platform_analytics",
        calculation: "account_request_utilization",
        definition: expect.any(String),
        threshold: 0.7,
      }),
      expect.objectContaining({
        source: "cloudflare_platform_analytics",
        calculation: "account_row_write_utilization",
        definition: expect.any(String),
        threshold: 0.7,
      }),
    ]);
  });
});
