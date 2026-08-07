import { HttpError } from "./errors";

export async function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "BAD_REQUEST", "Content-Type must be application/json.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
  }
  const bytes = await readBoundedBytes(request, maximumBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The request body is not valid JSON.");
  }
  assertSafeJson(value, 0);
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_REQUEST", "The request body must be a JSON object.");
  }
  return value;
}

export async function readBoundedBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("request body limit exceeded");
        throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "BAD_REQUEST", "The request body could not be read.");
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new HttpError(400, "BAD_REQUEST", `Unknown field: ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new HttpError(400, "BAD_REQUEST", `Missing field: ${key}.`);
  }
}

export function assertSafeJson(value: unknown, depth: number, maximumDepth = 8): void {
  if (depth > maximumDepth) throw new HttpError(400, "BAD_REQUEST", "JSON nesting is too deep.");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new HttpError(400, "BAD_REQUEST", "JSON numbers must be finite.");
  }
  if (Array.isArray(value)) {
    for (const child of value) assertSafeJson(child, depth + 1, maximumDepth);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new HttpError(400, "BAD_REQUEST", "Unsafe JSON field name.");
      }
      assertSafeJson(child, depth + 1, maximumDepth);
    }
  }
}
