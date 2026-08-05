export const STAGING_LOAD_HOSTNAME = "staging-cloud-collab.spacescale.net";

const PRODUCTION_HOSTNAME = "spacescale.net";

export function validateLoadTarget(baseUrl: string, allowRemote: boolean): void {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The load target must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The load target may not contain credentials, a query, or a fragment.");
  }

  const local = isLocalHostname(url.hostname);
  if (!local && url.protocol !== "https:") {
    throw new Error("Remote load targets must use HTTPS.");
  }
  if (url.hostname === PRODUCTION_HOSTNAME) {
    throw new Error("The production spacescale.net host is never a valid load-test target.");
  }
  if (!local && url.hostname !== STAGING_LOAD_HOSTNAME) {
    throw new Error(
      `Remote load tests may target only the committed staging host ${STAGING_LOAD_HOSTNAME}.`,
    );
  }
  if (!local && !allowRemote) {
    throw new Error(
      "Remote load tests require --allow-remote/LOAD_ALLOW_REMOTE=1 to prevent accidental production traffic.",
    );
  }
}

export function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
