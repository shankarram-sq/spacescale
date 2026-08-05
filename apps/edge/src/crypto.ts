const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function randomActorId(): string {
  return `a_${randomToken(16)}`;
}

export function randomBoardId(): string {
  return `b_${randomToken(16)}`;
}

export function randomOpaqueId(prefix = ""): string {
  return `${prefix}${randomToken(16)}`;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmacSha256(secret: string, value: string | Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const input = typeof value === "string" ? utf8(value) : value;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
}

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof value === "string" ? utf8(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  return bytesToBase64Url(await sha256(value));
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const max = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < max; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}
