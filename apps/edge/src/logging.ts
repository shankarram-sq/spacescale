type LogLevel = "info" | "warn" | "error";

export const SAFE_LOG_FIELDS = [
  "requestId",
  "boardIdHash",
  "workerVersionId",
  "durableObjectVersion",
  "protocolVersion",
  "actionKind",
  "result",
  "code",
  "seq",
  "durationMs",
  "itemCount",
  "actionCount",
  "frameBytes",
  "fanout",
  "sendFailures",
  "attempt",
  "environment",
  "executionComponent",
  "status",
  "internalError",
  "activeSockets",
  "snapshotLagActions",
  "snapshotLagMs",
  "storageBytesEstimate",
  "itemLimitUtilization",
  "storageLimitUtilization",
  "previewFrames",
  "commitFrames",
  "sampleWindowMs",
  "replayActions",
  "replayBytes",
  "resyncRequired",
  "sqliteRowsRead",
  "sqliteRowsWritten",
  "r2BytesWritten",
  "quotaDayUtc",
  "incomingFrames",
  "durableObjectRequestUnitsEstimate",
  "r2Reads",
  "r2Writes",
  "actions",
  "snapshots",
  "closeCode",
] as const;

const SAFE_FIELDS: ReadonlySet<string> = new Set(SAFE_LOG_FIELDS);

export function safeLog(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const safe: Record<string, unknown> = { event, level, at: Date.now() };
  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_FIELDS.has(key) && isSafeScalar(value)) safe[key] = value;
  }
  // Pass an object rather than a pre-serialized string so Workers Logs indexes
  // each approved field for queries, dashboards, and alert calculations.
  if (level === "error") console.error(safe);
  else if (level === "warn") console.warn(safe);
  else console.log(safe);
}

function isSafeScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}
