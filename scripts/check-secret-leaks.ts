import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalEnv } from "./env.ts";

const SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CLASSROOM_INTEGRATION_KEY",
  "ORGANISATION_SIGNING_KEYS",
  "TURNSTILE_SECRET_KEY",
  "SESSION_SIGNING_KEY_CURRENT",
  "SESSION_SIGNING_KEY_PREVIOUS",
] as const;
const BUILD_DIRECTORIES = ["apps/web/dist", "dist/worker"] as const;

loadLocalEnv();

const files = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);
for (const directory of BUILD_DIRECTORIES) addFilesRecursively(directory, files);

const configuredSecrets = SECRET_NAMES.flatMap((name) => {
  const value = process.env[name];
  return value !== undefined && value.length >= 12 ? [{ name, value }] : [];
});
const leaks: Array<{ secret: string; file: string }> = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  let contents: Buffer;
  try {
    contents = readFileSync(file);
  } catch {
    continue;
  }
  for (const secret of configuredSecrets) {
    if (contents.includes(Buffer.from(secret.value))) leaks.push({ secret: secret.name, file });
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: leaks.length === 0,
    scannedFiles: files.size,
    configuredSecretsChecked: configuredSecrets.map((secret) => secret.name),
    leaks,
  })}\n`,
);
if (leaks.length > 0) process.exitCode = 1;

function addFilesRecursively(path: string, files: Set<string>): void {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) addFilesRecursively(child, files);
    else if (entry.isFile()) files.add(child);
  }
}
