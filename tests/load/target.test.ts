import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGING_LOAD_HOSTNAME, validateLoadTarget } from "./target.ts";

describe("load target validation", () => {
  it("keeps the remote allowlist aligned with committed staging configuration", () => {
    const environments = JSON.parse(readFileSync("config/environments.json", "utf8")) as {
      staging: { hostname: string };
    };
    expect(STAGING_LOAD_HOSTNAME).toBe(environments.staging.hostname);
  });

  it.each(["http://localhost:8787", "https://127.0.0.1:8787", "http://[::1]:8787"])(
    "allows the local target %s without remote opt-in",
    (target) => {
      expect(() => validateLoadTarget(target, false)).not.toThrow();
    },
  );

  it("allows only the committed staging host with explicit remote opt-in", () => {
    expect(() => validateLoadTarget(`https://${STAGING_LOAD_HOSTNAME}`, true)).not.toThrow();
    expect(() => validateLoadTarget("https://staging.example.test", true)).toThrow(
      "Remote load tests may target only the committed staging host",
    );
    expect(() => validateLoadTarget("https://preview.spacescale.net", true)).toThrow(
      "Remote load tests may target only the committed staging host",
    );
  });

  it("requires explicit opt-in and HTTPS for staging", () => {
    expect(() => validateLoadTarget(`https://${STAGING_LOAD_HOSTNAME}`, false)).toThrow(
      "Remote load tests require --allow-remote/LOAD_ALLOW_REMOTE=1",
    );
    expect(() => validateLoadTarget(`http://${STAGING_LOAD_HOSTNAME}`, true)).toThrow(
      "Remote load targets must use HTTPS",
    );
  });

  it("always blocks the production hostname", () => {
    expect(() => validateLoadTarget("https://spacescale.net", true)).toThrow(
      "The production spacescale.net host is never a valid load-test target",
    );
  });
});
