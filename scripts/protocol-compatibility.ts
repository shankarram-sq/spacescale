import { PROTOCOL_VERSION, parseClientFrame } from "@collab/protocol";

const V1_REQUIRED_CASES = [
  "commit.item-create",
  "commit.item-update",
  "commit.item-delete",
  "commit.item-copy",
  "commit.items-batch",
  "commit.history-undo",
  "commit.history-redo",
  "commit.board-clear",
  "preview.pencil-start",
  "preview.pencil-segment",
  "preview.shape-geometry",
  "preview.selection-transform",
  "preview.gesture-cancel",
  "presence",
  "sync-check",
] as const;

type JsonRecord = Record<string, unknown>;

export type ProtocolCompatibilitySummary = {
  ok: true;
  currentProtocolVersion: number;
  fixtureProtocolVersion: number;
  fixtureRole: "initial-v1-baseline" | "prior-client";
  framesChecked: number;
};

export function checkProtocolCompatibility(value: unknown): ProtocolCompatibilitySummary {
  const fixture = record(value, "fixture");
  exactKeys(
    fixture,
    ["fixtureFormat", "fixtureFormatVersion", "role", "protocolVersion", "frames"],
    "fixture",
  );
  if (fixture.fixtureFormat !== "collab-canvas-client-protocol") {
    throw new Error("The frozen client fixture format is invalid.");
  }
  if (fixture.fixtureFormatVersion !== 1) {
    throw new Error("The frozen client fixture format version is unsupported.");
  }

  const currentProtocolVersion: number = PROTOCOL_VERSION;
  const expectedFixtureVersion = currentProtocolVersion === 1 ? 1 : currentProtocolVersion - 1;
  const expectedRole = currentProtocolVersion === 1 ? "initial-v1-baseline" : "prior-client";
  if (fixture.protocolVersion !== expectedFixtureVersion) {
    throw new Error(
      `Protocol ${currentProtocolVersion} requires frozen client fixture version ${expectedFixtureVersion}.`,
    );
  }
  if (fixture.role !== expectedRole) {
    throw new Error(
      `Protocol ${currentProtocolVersion} requires frozen fixture role ${JSON.stringify(expectedRole)}.`,
    );
  }

  if (!Array.isArray(fixture.frames))
    throw new Error("The frozen fixture frames must be an array.");
  const names = new Set<string>();
  for (const [index, entryValue] of fixture.frames.entries()) {
    const entry = record(entryValue, `fixture.frames[${index}]`);
    exactKeys(entry, ["name", "frame"], `fixture.frames[${index}]`);
    if (typeof entry.name !== "string" || entry.name.length === 0 || names.has(entry.name)) {
      throw new Error(`Frozen fixture case ${index} has an invalid or duplicate name.`);
    }
    names.add(entry.name);
    const frame = record(entry.frame, `fixture.frames[${index}].frame`);
    if (frame.v !== expectedFixtureVersion) {
      throw new Error(`Frozen fixture case ${entry.name} has the wrong wire version.`);
    }
    try {
      const parsed = parseClientFrame(JSON.stringify(frame));
      if (parsed.t !== frame.t) {
        throw new Error(`parsed as ${parsed.t} instead of ${String(frame.t)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Current server rejected frozen client case ${entry.name}: ${message}`, {
        cause: error,
      });
    }
  }

  if (expectedFixtureVersion === 1) {
    const missing = V1_REQUIRED_CASES.filter((name) => !names.has(name));
    const unexpected = [...names].filter(
      (name) => !V1_REQUIRED_CASES.includes(name as (typeof V1_REQUIRED_CASES)[number]),
    );
    if (missing.length > 0 || unexpected.length > 0 || names.size !== V1_REQUIRED_CASES.length) {
      throw new Error(
        `Frozen v1 case set drifted (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
      );
    }
  }

  return {
    ok: true,
    currentProtocolVersion,
    fixtureProtocolVersion: expectedFixtureVersion,
    fixtureRole: expectedRole,
    framesChecked: fixture.frames.length,
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} must contain exactly: ${required.join(", ")}.`);
  }
}
