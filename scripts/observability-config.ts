import { readFileSync } from "node:fs";

export type FieldType = "string" | "number" | "boolean";

export type QueryFilter = {
  kind: "filter";
  key: string;
  operation: string;
  type: FieldType;
  value?: string | number | boolean;
};

export type QueryCalculation = {
  operator: string;
  alias?: string;
  key?: string;
  keyType?: FieldType;
};

export type SaveQueryRequest = {
  name: string;
  description: string;
  parameters: {
    datasets?: string[];
    filterCombination?: "and" | "or";
    filters?: QueryFilter[];
    calculations?: QueryCalculation[];
    groupBys?: Array<{ type: FieldType; value: string }>;
    havings?: Array<{ key: string; operation: string; value: number }>;
    limit?: number;
    needle?: { value: string | number | boolean; isRegex?: boolean; matchCase?: boolean };
    orderBy?: { value: string; order?: "asc" | "desc" };
  };
};

export type SavedQuery = {
  id: string;
  metricIds: string[];
  saveRequest: SaveQueryRequest;
  chart: {
    type: string;
    unit: string;
    calculations: string[];
    splitBy: string[];
    prominent: boolean;
  };
};

export type AlertContract = {
  id: string;
  queryId: string;
  severity: "warn" | "page";
  window: string;
  holdFor: string;
  groupBy: string[];
  condition: Record<string, unknown>;
  runbook: string;
};

export type ObservabilityConfig = {
  schemaVersion: number;
  status: string;
  sourceSpec: {
    file: string;
    metricsSection: string;
    alertsSection: string;
  };
  api: {
    baseUrl: string;
    saveQuery: { method: string; path: string; permission: string };
    dataset: string;
  };
  dashboard: Record<string, unknown>;
  coverage: {
    specMetricIds: string[];
    platformMetricIds: string[];
    alertIds: string[];
  };
  runtimeContract: {
    structuredPayload: string;
    commonFields: Record<string, FieldType>;
    builtInFields: Record<string, FieldType>;
    events: Array<{
      event: string;
      cadence: string;
      requiredFields: Record<string, FieldType>;
    }>;
    privacy: { boardIdentity: string; forbiddenFields: string[] };
  };
  savedQueries: SavedQuery[];
  alerts: AlertContract[];
  delivery: {
    provisioned: boolean;
    savedQueriesScheduleAlerts: boolean;
    evaluatorRequired: boolean;
    minimumEvaluationInterval: string;
    destinationKinds: string[];
    prerequisites: string[];
    optionalCloudflareNotificationPermission: string;
  };
};

export type ValidationSummary = {
  ok: true;
  schemaVersion: number;
  savedQueries: number;
  specMetricsCovered: number;
  platformMetricsCovered: number;
  alerts: number;
  runtimeEvents: number;
  remoteMutationsExecuted: false;
};

export type DryRunRequest = {
  localId: string;
  metricIds: string[];
  chart: SavedQuery["chart"];
  method: "POST";
  path: string;
  headers: {
    Authorization: "Bearer <redacted>";
    "Content-Type": "application/json";
  };
  body: SaveQueryRequest;
};

export type DryRunPlan = {
  mode: "dry-run";
  remoteMutationsExecuted: false;
  accountId: "{account_id}";
  permissionRequired: "Workers Observability Write";
  notes: string[];
  requests: DryRunRequest[];
  alerts: Array<{
    id: string;
    queryId: string;
    provisioned: false;
    evaluatorRequired: true;
    condition: Record<string, unknown>;
  }>;
};

const SPEC_METRIC_IDS = [
  "active_sockets_per_board",
  "preview_and_commit_frames",
  "accepted_rejected_commands_by_code",
  "commit_latency",
  "broadcast_fanout_and_send_failures",
  "replay_size_and_resync_rate",
  "sqlite_transaction_duration",
  "snapshot_lag_actions_and_time",
  "r2_snapshot_duration_and_failure",
  "undo_redo_success_and_conflict_rate",
  "board_item_count",
  "quota_estimates",
] as const;

const PLATFORM_METRIC_IDS = ["worker_do_cpu_time", "handler_internal_error_rate"] as const;

const ALERT_EXPECTATIONS = {
  rejected_commands_5pct_5m: {
    queryId: "commands_by_result_code",
    kind: "ratio",
    threshold: 0.05,
    window: "5m",
    holdFor: "5m",
  },
  internal_errors_1pct: {
    queryId: "handler_internal_error_rate",
    kind: "ratio",
    threshold: 0.01,
    window: "5m",
    holdFor: "0m",
  },
  snapshot_lag_1000_actions_or_30m: {
    queryId: "snapshot_lag",
    kind: "any",
    signals: {
      max_lag_actions: 1000,
      max_lag_ms: 1_800_000,
    },
  },
  board_item_or_storage_80pct: {
    queryId: "board_item_and_storage",
    kind: "any",
    signals: {
      item_utilization: 0.8,
      storage_utilization: 0.8,
    },
  },
  daily_request_or_row_write_70pct: {
    queryId: "quota_estimates",
    kind: "any",
    signalSource: "cloudflare_platform_analytics",
    signals: {
      account_request_utilization: 0.7,
      account_row_write_utilization: 0.7,
    },
  },
  replay_resync_2pct: {
    queryId: "replay_size_and_resync",
    kind: "ratio",
    threshold: 0.02,
  },
  commit_p95_25ms: {
    queryId: "commit_latency",
    kind: "scalar",
    calculation: "p95_ms",
    threshold: 25,
  },
} as const;

const ROOT_KEYS = [
  "schemaVersion",
  "status",
  "sourceSpec",
  "api",
  "dashboard",
  "coverage",
  "runtimeContract",
  "savedQueries",
  "alerts",
  "delivery",
] as const;

const SAVE_REQUEST_KEYS = ["name", "description", "parameters"] as const;
const PARAMETER_KEYS = [
  "datasets",
  "filterCombination",
  "filters",
  "calculations",
  "groupBys",
  "havings",
  "limit",
  "needle",
  "orderBy",
] as const;
const FILTER_KEYS = ["kind", "key", "operation", "type", "value"] as const;
const CALCULATION_KEYS = ["operator", "alias", "key", "keyType"] as const;
const ALLOWED_OPERATORS = new Set([
  "uniq",
  "count",
  "max",
  "min",
  "sum",
  "avg",
  "median",
  "p001",
  "p01",
  "p05",
  "p10",
  "p25",
  "p75",
  "p90",
  "p95",
  "p99",
  "p999",
  "stddev",
  "variance",
]);
const ALLOWED_FILTER_OPERATIONS = new Set([
  "includes",
  "not_includes",
  "starts_with",
  "ends_with",
  "regex",
  "exists",
  "is_null",
  "in",
  "not_in",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);
const FIELD_TYPES = new Set<FieldType>(["string", "number", "boolean"]);

const QUOTA_DAILY_FIELDS = [
  "environment",
  "boardIdHash",
  "quotaDayUtc",
  "incomingFrames",
  "durableObjectRequestUnitsEstimate",
  "sqliteRowsRead",
  "sqliteRowsWritten",
  "r2Reads",
  "r2Writes",
  "r2BytesWritten",
  "actions",
  "snapshots",
] as const;

const FABRICATED_QUOTA_FIELDS = [
  "scope",
  "workerRequestsEstimate",
  "activeDurationMsEstimate",
  "r2BytesRead",
  "requestQuotaUtilization",
  "rowWriteQuotaUtilization",
] as const;

export const DEFAULT_OBSERVABILITY_CONFIG_URL = new URL(
  "../config/observability.json",
  import.meta.url,
);

export function loadObservabilityConfig(
  url: URL = DEFAULT_OBSERVABILITY_CONFIG_URL,
): ObservabilityConfig {
  const raw: unknown = JSON.parse(readFileSync(url, "utf8"));
  return parseObservabilityConfig(raw);
}

export function parseObservabilityConfig(raw: unknown): ObservabilityConfig {
  assertRecord(raw, "observability config");
  assertExactKeys(raw, ROOT_KEYS, "observability config");
  const config = raw as ObservabilityConfig;

  assert(config.schemaVersion === 1, "schemaVersion must be 1");
  assert(config.status === "dry-run-only", "status must remain dry-run-only");
  assert(config.sourceSpec?.file === "cloudflare-collab-canvas.md", "source spec file drifted");
  assert(config.sourceSpec.metricsSection === "20.2", "metrics source must be section 20.2");
  assert(config.sourceSpec.alertsSection === "20.3", "alerts source must be section 20.3");
  assert(config.api?.baseUrl === "https://api.cloudflare.com/client/v4", "API base URL drifted");
  assert(config.api.saveQuery.method === "POST", "saved-query method must be POST");
  assert(
    config.api.saveQuery.path === "/accounts/{account_id}/workers/observability/queries",
    "saved-query API path drifted",
  );
  assert(
    config.api.saveQuery.permission === "Workers Observability Write",
    "saved-query permission drifted",
  );
  assert(config.api.dataset === "cloudflare-workers", "Workers dataset drifted");

  assertStringSet(config.coverage?.specMetricIds, SPEC_METRIC_IDS, "coverage.specMetricIds");
  assertStringSet(
    config.coverage.platformMetricIds,
    PLATFORM_METRIC_IDS,
    "coverage.platformMetricIds",
  );
  assertStringSet(config.coverage.alertIds, Object.keys(ALERT_EXPECTATIONS), "coverage.alertIds");

  const fieldTypes = validateRuntimeContract(config.runtimeContract);
  const queryIds = validateSavedQueries(config, fieldTypes);
  validateMetricCoverage(config);
  validateAlerts(config, queryIds);
  validateDelivery(config.delivery);

  return config;
}

export function validateObservabilityConfig(config: ObservabilityConfig): ValidationSummary {
  const parsed = parseObservabilityConfig(config);
  return {
    ok: true,
    schemaVersion: parsed.schemaVersion,
    savedQueries: parsed.savedQueries.length,
    specMetricsCovered: parsed.coverage.specMetricIds.length,
    platformMetricsCovered: parsed.coverage.platformMetricIds.length,
    alerts: parsed.alerts.length,
    runtimeEvents: parsed.runtimeContract.events.length,
    remoteMutationsExecuted: false,
  };
}

export function buildDryRunPlan(config: ObservabilityConfig): DryRunPlan {
  const parsed = parseObservabilityConfig(config);
  const path = parsed.api.saveQuery.path;
  return {
    mode: "dry-run",
    remoteMutationsExecuted: false,
    accountId: "{account_id}",
    permissionRequired: "Workers Observability Write",
    notes: [
      "No network request is made by this command.",
      "Request bodies use the official Workers Observability save-query shape.",
      "Chart metadata is repository guidance and is not part of the save-query request body.",
      "Alert thresholds require a separately configured evaluator and delivery destination.",
      "The daily quota alert reads account usage from Cloudflare platform analytics; its quota_estimates query is per-board drilldown only.",
    ],
    requests: parsed.savedQueries.map((query) => ({
      localId: query.id,
      metricIds: [...query.metricIds],
      chart: structuredClone(query.chart),
      method: "POST",
      path,
      headers: {
        Authorization: "Bearer <redacted>",
        "Content-Type": "application/json",
      },
      body: structuredClone(query.saveRequest),
    })),
    alerts: parsed.alerts.map((alert) => ({
      id: alert.id,
      queryId: alert.queryId,
      provisioned: false,
      evaluatorRequired: true,
      condition: structuredClone(alert.condition),
    })),
  };
}

function validateRuntimeContract(
  contract: ObservabilityConfig["runtimeContract"],
): Map<string, FieldType> {
  assertRecord(contract, "runtimeContract");
  assert(
    contract.structuredPayload === "object",
    "runtimeContract.structuredPayload must be object so Workers Logs indexes fields",
  );
  const fieldTypes = new Map<string, FieldType>();
  addFieldMap(fieldTypes, contract.commonFields, "runtimeContract.commonFields");
  addFieldMap(fieldTypes, contract.builtInFields, "runtimeContract.builtInFields");

  assert(
    Array.isArray(contract.events) && contract.events.length > 0,
    "runtime events are required",
  );
  const eventNames = new Set<string>();
  for (const [index, event] of contract.events.entries()) {
    assertRecord(event, `runtimeContract.events[${index}]`);
    assertNonEmptyString(event.event, `runtimeContract.events[${index}].event`);
    assert(!eventNames.has(event.event), `duplicate runtime event ${event.event}`);
    eventNames.add(event.event);
    assertNonEmptyString(event.cadence, `runtime event ${event.event} cadence`);
    addFieldMap(fieldTypes, event.requiredFields, `runtime event ${event.event} fields`);
  }

  const requiredEvents = [
    "board.metrics",
    "traffic.metrics",
    "command.accepted",
    "command.rejected",
    "broadcast.completed",
    "replay.completed",
    "replay.unavailable",
    "storage.transaction_completed",
    "snapshot.completed",
    "snapshot.failed",
    "quota.daily",
    "http.request_completed",
    "room.http_completed",
    "board.created",
    "socket.connected",
    "socket.disconnected",
    "membership.changed",
    "rate_limit.triggered",
    "room.overloaded",
    "schema.migrated",
  ];
  assertStringSet([...eventNames], requiredEvents, "runtime event names");

  const quotaEvent = contract.events.find((event) => event.event === "quota.daily");
  assert(quotaEvent !== undefined, "quota.daily runtime event is required");
  assertStringSet(Object.keys(quotaEvent.requiredFields), QUOTA_DAILY_FIELDS, "quota.daily fields");
  for (const field of FABRICATED_QUOTA_FIELDS) {
    assert(
      !fieldTypes.has(field),
      `quota field ${field} must not fabricate account totals or unmeasured platform usage`,
    );
  }

  assertRecord(contract.privacy, "runtimeContract.privacy");
  assertNonEmptyString(contract.privacy.boardIdentity, "privacy board identity rule");
  const forbidden = contract.privacy.forbiddenFields;
  assert(Array.isArray(forbidden) && forbidden.length > 0, "privacy forbiddenFields are required");
  for (const field of forbidden) {
    assertNonEmptyString(field, "privacy forbidden field");
    assert(!fieldTypes.has(field), `forbidden field ${field} is declared as telemetry`);
  }
  for (const required of ["operationJson", "text", "cookie", "authorization", "rawBoardId"]) {
    assert(forbidden.includes(required), `privacy contract must forbid ${required}`);
  }

  for (const requiredBuiltIn of [
    "$workers.cpuTimeMs",
    "$workers.wallTimeMs",
    "$workers.executionModel",
    "$workers.durableObjectId",
  ]) {
    assert(fieldTypes.has(requiredBuiltIn), `missing built-in field ${requiredBuiltIn}`);
  }
  return fieldTypes;
}

function validateSavedQueries(
  config: ObservabilityConfig,
  fieldTypes: Map<string, FieldType>,
): Set<string> {
  assert(
    Array.isArray(config.savedQueries) && config.savedQueries.length > 0,
    "savedQueries must be non-empty",
  );
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, query] of config.savedQueries.entries()) {
    const label = `savedQueries[${index}]`;
    assertRecord(query, label);
    assertNonEmptyString(query.id, `${label}.id`);
    assert(/^[a-z][a-z0-9_]*$/u.test(query.id), `${label}.id must be snake_case`);
    assert(!ids.has(query.id), `duplicate saved query id ${query.id}`);
    ids.add(query.id);
    assert(Array.isArray(query.metricIds), `${query.id}.metricIds must be an array`);
    for (const metricId of query.metricIds) assertNonEmptyString(metricId, `${query.id} metric ID`);

    validateSaveRequest(query.id, query.saveRequest, names, fieldTypes, config.api.dataset);
    validateChart(query);
  }

  const cpuQuery = config.savedQueries.find((query) => query.id === "worker_do_cpu_time");
  assert(cpuQuery !== undefined, "worker_do_cpu_time query is required");
  const cpuKeys = new Set(
    cpuQuery.saveRequest.parameters.calculations?.map((calculation) => calculation.key) ?? [],
  );
  assert(cpuKeys.has("$workers.cpuTimeMs"), "CPU query must use built-in $workers.cpuTimeMs");
  assert(cpuKeys.has("$workers.wallTimeMs"), "CPU query must use built-in $workers.wallTimeMs");
  const cpuGroups = new Set(
    cpuQuery.saveRequest.parameters.groupBys?.map((groupBy) => groupBy.value) ?? [],
  );
  assert(
    cpuGroups.has("$workers.executionModel") && cpuGroups.has("$workers.entrypoint"),
    "CPU query must split stateless Worker and Durable Object entrypoints",
  );
  return ids;
}

function validateSaveRequest(
  queryId: string,
  request: SaveQueryRequest,
  names: Set<string>,
  fieldTypes: Map<string, FieldType>,
  dataset: string,
): void {
  assertRecord(request, `${queryId}.saveRequest`);
  assertExactKeys(request, SAVE_REQUEST_KEYS, `${queryId}.saveRequest`);
  assertNonEmptyString(request.name, `${queryId}.saveRequest.name`);
  assert(request.name.length <= 250, `${queryId} query name exceeds 250 characters`);
  assert(!names.has(request.name), `duplicate saved query name ${request.name}`);
  names.add(request.name);
  assertNonEmptyString(request.description, `${queryId}.saveRequest.description`);
  assert(request.description.length <= 1000, `${queryId} description exceeds 1000 characters`);
  assertRecord(request.parameters, `${queryId}.saveRequest.parameters`);
  assertOnlyKeys(request.parameters, PARAMETER_KEYS, `${queryId}.parameters`);
  assert(
    request.parameters.datasets?.length === 1 && request.parameters.datasets[0] === dataset,
    `${queryId} must query only ${dataset}`,
  );
  assert(
    request.parameters.filterCombination === "and" || request.parameters.filterCombination === "or",
    `${queryId} must declare filterCombination`,
  );

  const filters = request.parameters.filters;
  assert(Array.isArray(filters) && filters.length > 0, `${queryId} must declare filters`);
  assert(
    filters.some(
      (filter) =>
        filter.key === "$metadata.service" &&
        filter.operation === "starts_with" &&
        filter.value === "cloudflare-collab-canvas",
    ),
    `${queryId} must scope telemetry to the collab-canvas services`,
  );
  for (const [index, filter] of filters.entries()) {
    assertRecord(filter, `${queryId}.filters[${index}]`);
    assertOnlyKeys(filter, FILTER_KEYS, `${queryId}.filters[${index}]`);
    assert(filter.kind === "filter", `${queryId} supports only official leaf filters`);
    validateFieldReference(queryId, filter.key, filter.type, fieldTypes);
    assert(
      ALLOWED_FILTER_OPERATIONS.has(filter.operation),
      `${queryId} has unsupported filter operation ${filter.operation}`,
    );
    if (filter.operation !== "exists" && filter.operation !== "is_null") {
      assert(filter.value !== undefined, `${queryId} filter ${filter.key} requires a value`);
      assert(
        typeof filter.value === filter.type,
        `${queryId} filter ${filter.key} value must be ${filter.type}`,
      );
    }
  }

  const calculations = request.parameters.calculations;
  assert(
    Array.isArray(calculations) && calculations.length > 0,
    `${queryId} must declare calculations`,
  );
  const aliases = new Set<string>();
  for (const [index, calculation] of calculations.entries()) {
    assertRecord(calculation, `${queryId}.calculations[${index}]`);
    assertOnlyKeys(calculation, CALCULATION_KEYS, `${queryId}.calculations[${index}]`);
    assert(
      ALLOWED_OPERATORS.has(calculation.operator),
      `${queryId} has unsupported calculation operator ${calculation.operator}`,
    );
    assertNonEmptyString(calculation.alias, `${queryId} calculation alias`);
    assert(!aliases.has(calculation.alias), `${queryId} has duplicate alias ${calculation.alias}`);
    aliases.add(calculation.alias);
    if (calculation.operator === "count") {
      assert(
        calculation.key === undefined && calculation.keyType === undefined,
        `${queryId} count calculation must omit key and keyType`,
      );
    } else {
      assertNonEmptyString(calculation.key, `${queryId} calculation key`);
      assert(
        calculation.keyType !== undefined,
        `${queryId} calculation ${calculation.alias} requires keyType`,
      );
      validateFieldReference(queryId, calculation.key, calculation.keyType, fieldTypes);
    }
  }

  for (const [index, groupBy] of (request.parameters.groupBys ?? []).entries()) {
    assertRecord(groupBy, `${queryId}.groupBys[${index}]`);
    assertExactKeys(groupBy, ["type", "value"], `${queryId}.groupBys[${index}]`);
    validateFieldReference(queryId, groupBy.value, groupBy.type, fieldTypes);
  }
  assert(
    request.parameters.limit === undefined ||
      (Number.isInteger(request.parameters.limit) &&
        request.parameters.limit >= 0 &&
        request.parameters.limit <= 100),
    `${queryId} limit must be an integer from 0 to 100`,
  );
}

function validateChart(query: SavedQuery): void {
  assertRecord(query.chart, `${query.id}.chart`);
  assertExactKeys(
    query.chart,
    ["type", "unit", "calculations", "splitBy", "prominent"],
    `${query.id}.chart`,
  );
  assert(
    ["time_series", "stacked_time_series", "table"].includes(query.chart.type),
    `${query.id} has unsupported chart type`,
  );
  assertNonEmptyString(query.chart.unit, `${query.id}.chart.unit`);
  assert(typeof query.chart.prominent === "boolean", `${query.id}.chart.prominent must be boolean`);
  const aliases = new Set(
    query.saveRequest.parameters.calculations?.map((calculation) => calculation.alias) ?? [],
  );
  assert(
    Array.isArray(query.chart.calculations) && query.chart.calculations.length > 0,
    `${query.id} chart must select calculations`,
  );
  for (const calculation of query.chart.calculations) {
    assert(aliases.has(calculation), `${query.id} chart references unknown alias ${calculation}`);
  }
  const groups = new Set(
    query.saveRequest.parameters.groupBys?.map((groupBy) => groupBy.value) ?? [],
  );
  assert(Array.isArray(query.chart.splitBy), `${query.id}.chart.splitBy must be an array`);
  for (const field of query.chart.splitBy) {
    assert(groups.has(field), `${query.id} chart splitBy ${field} is not a query groupBy`);
  }
}

function validateMetricCoverage(config: ObservabilityConfig): void {
  const actual = config.savedQueries.flatMap((query) => query.metricIds);
  const expected = [...SPEC_METRIC_IDS, ...PLATFORM_METRIC_IDS];
  assertStringSet(actual, expected, "saved query metric coverage");
  assert(
    new Set(actual).size === actual.length,
    "each required metric must have exactly one owning saved query",
  );
}

function validateAlerts(config: ObservabilityConfig, queryIds: Set<string>): void {
  assert(Array.isArray(config.alerts), "alerts must be an array");
  assertStringSet(
    config.alerts.map((alert) => alert.id),
    Object.keys(ALERT_EXPECTATIONS),
    "alert contracts",
  );
  for (const alert of config.alerts) {
    assertRecord(alert, `alert ${alert.id}`);
    const expected = ALERT_EXPECTATIONS[alert.id as keyof typeof ALERT_EXPECTATIONS];
    assert(expected !== undefined, `unexpected alert ${alert.id}`);
    assert(queryIds.has(alert.queryId), `${alert.id} references missing query ${alert.queryId}`);
    assert(alert.queryId === expected.queryId, `${alert.id} query reference drifted`);
    assert(alert.severity === "warn" || alert.severity === "page", `${alert.id} severity invalid`);
    assertNonEmptyString(alert.window, `${alert.id}.window`);
    assertNonEmptyString(alert.holdFor, `${alert.id}.holdFor`);
    assert(Array.isArray(alert.groupBy), `${alert.id}.groupBy must be an array`);
    assertNonEmptyString(alert.runbook, `${alert.id}.runbook`);
    assertRecord(alert.condition, `${alert.id}.condition`);
    assert(alert.condition.kind === expected.kind, `${alert.id} condition kind drifted`);
    assert(
      alert.condition.operator === "gt",
      `${alert.id} must trigger only when value exceeds threshold`,
    );
    if ("threshold" in expected) {
      assert(alert.condition.threshold === expected.threshold, `${alert.id} threshold drifted`);
    }
    if ("calculation" in expected) {
      assert(
        alert.condition.calculation === expected.calculation,
        `${alert.id} calculation drifted`,
      );
    }
    if ("window" in expected) {
      assert(alert.window === expected.window, `${alert.id} window drifted`);
    }
    if ("holdFor" in expected) {
      assert(alert.holdFor === expected.holdFor, `${alert.id} holdFor drifted`);
    }
    if ("signals" in expected) {
      assert(Array.isArray(alert.condition.signals), `${alert.id} signals must be an array`);
      const actualSignals = new Map<string, number>();
      for (const signal of alert.condition.signals) {
        assertRecord(signal, `${alert.id} signal`);
        assertNonEmptyString(signal.calculation, `${alert.id} signal calculation`);
        assert(
          typeof signal.threshold === "number",
          `${alert.id} signal threshold must be numeric`,
        );
        actualSignals.set(signal.calculation, signal.threshold);
        if ("signalSource" in expected) {
          assert(signal.source === expected.signalSource, `${alert.id} signal source drifted`);
          assertNonEmptyString(signal.definition, `${alert.id} platform signal definition`);
        }
      }
      const expectedSignals = expected.signals as Record<string, number>;
      assertStringSet(
        [...actualSignals.keys()],
        Object.keys(expectedSignals),
        `${alert.id} signals`,
      );
      for (const [calculation, threshold] of Object.entries(expectedSignals)) {
        assert(actualSignals.get(calculation) === threshold, `${alert.id} ${calculation} drifted`);
      }
    }
  }
}

function validateDelivery(delivery: ObservabilityConfig["delivery"]): void {
  assertRecord(delivery, "delivery");
  assert(delivery.provisioned === false, "repository must not claim alert delivery is provisioned");
  assert(
    delivery.savedQueriesScheduleAlerts === false,
    "saved queries must not be represented as scheduled alerts",
  );
  assert(delivery.evaluatorRequired === true, "alert evaluator prerequisite must be explicit");
  assert(
    delivery.optionalCloudflareNotificationPermission === "Notifications Write",
    "optional Cloudflare notification permission drifted",
  );
  assertStringSet(delivery.destinationKinds, ["email", "pagerduty", "webhook"], "destinations");
  assert(
    Array.isArray(delivery.prerequisites) && delivery.prerequisites.length >= 5,
    "alert delivery prerequisites are incomplete",
  );
}

function validateFieldReference(
  queryId: string,
  field: string,
  declaredType: FieldType,
  fieldTypes: Map<string, FieldType>,
): void {
  assertNonEmptyString(field, `${queryId} field reference`);
  assert(
    FIELD_TYPES.has(declaredType),
    `${queryId} field ${field} has invalid type ${declaredType}`,
  );
  const actualType = fieldTypes.get(field);
  assert(actualType !== undefined, `${queryId} references undeclared telemetry field ${field}`);
  assert(actualType === declaredType, `${queryId} field ${field} must use type ${actualType}`);
}

function addFieldMap(
  target: Map<string, FieldType>,
  fields: Record<string, FieldType>,
  label: string,
): void {
  assertRecord(fields, label);
  for (const [field, type] of Object.entries(fields)) {
    assertNonEmptyString(field, `${label} key`);
    assert(FIELD_TYPES.has(type), `${label}.${field} has invalid type ${type}`);
    const previous = target.get(field);
    assert(
      previous === undefined || previous === type,
      `${label}.${field} conflicts with previously declared ${previous} type`,
    );
    target.set(field, type);
  }
}

function assertStringSet(
  actual: readonly string[] | undefined,
  expected: readonly string[],
  label: string,
): void {
  assert(Array.isArray(actual), `${label} must be an array`);
  for (const item of actual) assertNonEmptyString(item, `${label} item`);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assert(
    JSON.stringify(actualSorted) === JSON.stringify(expectedSorted),
    `${label} drifted (expected ${expectedSorted.join(", ")}; received ${actualSorted.join(", ")})`,
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(sortedExpected),
    `${label} keys drifted (expected ${sortedExpected.join(", ")}; received ${actual.join(", ")})`,
  );
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extras = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  assert(extras.length === 0, `${label} has unsupported keys: ${extras.join(", ")}`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${label} must be a non-empty string`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid observability configuration: ${message}.`);
}
