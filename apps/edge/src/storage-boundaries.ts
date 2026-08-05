import { HttpError } from "./http/errors";

const R2_UNAVAILABLE_MESSAGE = "Snapshot storage is temporarily unavailable.";
const R2_CONFLICT_MESSAGE = "Immutable snapshot storage conflict.";
const SQLITE_FULL_MESSAGE = "Board storage is temporarily unavailable.";
const SQLITE_FULL_MARKER = "SQLITE_FULL";

export const SQLITE_FULL_CAUSE_CHAIN_LIMIT = 8;

export type ImmutableR2PutDisposition = "created" | "preexisting" | "lost-race";

export interface ImmutableR2PutOptions {
  sha256: string;
  httpMetadata?: R2HTTPMetadata | Headers;
}

export interface ImmutableR2PutResult {
  disposition: ImmutableR2PutDisposition;
  object: R2Object;
}

export type R2PutValue = Parameters<R2Bucket["put"]>[1];

function r2UnavailableError(): HttpError {
  return new HttpError(503, "TEMPORARILY_UNAVAILABLE", R2_UNAVAILABLE_MESSAGE);
}

function r2ConflictError(): HttpError {
  return new HttpError(503, "TEMPORARILY_UNAVAILABLE", R2_CONFLICT_MESSAGE);
}

async function callR2<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // R2 binding errors can contain provider details and unstable error codes.
    // Keep the response contract fixed and avoid reflecting those details.
    throw r2UnavailableError();
  }
}

function verifySha256Metadata(object: R2Object, expectedSha256: string): void {
  if (object.customMetadata?.sha256 !== expectedSha256) {
    throw r2ConflictError();
  }
}

/**
 * Stores an object at a deterministic key without ever overwriting an existing
 * value. A conditional loser is reconciled with R2's strongly consistent HEAD
 * result and succeeds only when the winner stored the exact expected SHA-256.
 */
export async function putImmutableR2Object(
  bucket: R2Bucket,
  key: string,
  value: R2PutValue,
  options: ImmutableR2PutOptions,
): Promise<ImmutableR2PutResult> {
  const existing = await callR2(() => bucket.head(key));
  if (existing !== null) {
    verifySha256Metadata(existing, options.sha256);
    return { disposition: "preexisting", object: existing };
  }

  const putOptions: R2PutOptions & { onlyIf: Headers } = {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    customMetadata: { sha256: options.sha256 },
    ...(options.httpMetadata === undefined ? {} : { httpMetadata: options.httpMetadata }),
  };
  const written = await callR2(() => bucket.put(key, value, putOptions));
  if (written !== null) {
    verifySha256Metadata(written, options.sha256);
    return { disposition: "created", object: written };
  }

  const winner = await callR2(() => bucket.head(key));
  if (winner === null) {
    throw r2UnavailableError();
  }
  verifySha256Metadata(winner, options.sha256);
  return { disposition: "lost-race", object: winner };
}

/** Reads an R2 object while keeping provider-specific failures out of HTTP responses. */
export async function getR2Object(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return callR2(() => bucket.get(key));
}

/** Materializes an R2 response body under the same stable failure contract. */
export async function readR2ObjectBytes(object: R2ObjectBody): Promise<Uint8Array> {
  const buffer = await callR2(() => object.arrayBuffer());
  return new Uint8Array(buffer);
}

function isReference(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function readProperty(value: object, property: "message" | "cause"): unknown {
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

/** Detects Cloudflare's documented `database or disk is full: SQLITE_FULL`. */
export function isSqliteFullError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < SQLITE_FULL_CAUSE_CHAIN_LIMIT; depth += 1) {
    if (!isReference(current) || seen.has(current)) return false;
    seen.add(current);

    const message = readProperty(current, "message");
    if (typeof message === "string" && message.includes(SQLITE_FULL_MARKER)) return true;
    current = readProperty(current, "cause");
  }

  return false;
}

/** Returns a stable client-safe error for SQLITE_FULL and null otherwise. */
export function mapSqliteFullError(error: unknown): HttpError | null {
  if (!isSqliteFullError(error)) return null;
  return new HttpError(503, "TEMPORARILY_UNAVAILABLE", SQLITE_FULL_MESSAGE);
}
