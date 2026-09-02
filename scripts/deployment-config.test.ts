import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeploymentConfigurationError,
  deploymentConfigurationFromEnvironment,
  generatedWranglerConfigPath,
  writeGeneratedWranglerConfig,
} from "./deployment-config";

const originalCwd = process.cwd();

afterEach(() => process.chdir(originalCwd));

describe("setup-time deployment configuration", () => {
  it("fails closed without exposing partial resource values", () => {
    const partial = "private-value-that-must-not-appear";
    expect(() =>
      deploymentConfigurationFromEnvironment("production", {
        DEPLOYMENT_NAME: "example",
        APP_HOSTNAME: partial,
      }),
    ).toThrow(DeploymentConfigurationError);
    try {
      deploymentConfigurationFromEnvironment("production", {
        DEPLOYMENT_NAME: "example",
        APP_HOSTNAME: partial,
      });
    } catch (error) {
      expect(String(error)).not.toContain(partial);
      expect(String(error)).toContain("Deployment initialization is incomplete");
    }
  });

  it("derives simple isolated resource names from deployment name and environment", () => {
    const configuration = deploymentConfigurationFromEnvironment("production", {
      DEPLOYMENT_NAME: "example-canvas",
      APP_HOSTNAME: "canvas.example.test",
      TURNSTILE_SITE_KEY: "configured-site-key",
    });

    expect(configuration.workerName).toBe("example-canvas-production");
    expect(configuration.bucketName).toBe("example-canvas-production-snapshots");
    expect(configuration.assetBucketName).toBe("example-canvas-production-assets");
  });

  it("rejects legacy manual resource mappings without exposing their values", () => {
    const legacyBucket = "legacy-private-bucket-value";
    try {
      deploymentConfigurationFromEnvironment("staging", {
        DEPLOYMENT_NAME: "example-canvas",
        APP_HOSTNAME: "staging.example.test",
        R2_BUCKET_NAME: legacyBucket,
        TURNSTILE_ENABLED: "false",
      });
      throw new Error("Expected legacy mapping rejection");
    } catch (error) {
      expect(String(error)).toContain("R2_BUCKET_NAME");
      expect(String(error)).not.toContain(legacyBucket);
    }
  });

  it("keeps staging and production resource mappings separate", () => {
    const shared = { DEPLOYMENT_NAME: "example-canvas", APP_HOSTNAME: "canvas.example.test" };
    const staging = deploymentConfigurationFromEnvironment("staging", {
      ...shared,
      TURNSTILE_ENABLED: "false",
    });
    const production = deploymentConfigurationFromEnvironment("production", {
      ...shared,
      TURNSTILE_SITE_KEY: "configured-site-key",
    });

    expect(staging.workerName).toBe("example-canvas-staging");
    expect(staging.bucketName).not.toBe(production.bucketName);
    expect(staging.assetBucketName).not.toBe(production.assetBucketName);
  });

  it("writes the resolved mapping only to the ignored generated config", () => {
    const directory = mkdtempSync(join(tmpdir(), "spacescale-config-"));
    chmodSync(directory, 0o700);
    process.chdir(directory);
    const configuration = deploymentConfigurationFromEnvironment("staging", {
      DEPLOYMENT_NAME: "example-canvas",
      APP_HOSTNAME: "staging.example.test",
      TURNSTILE_ENABLED: "false",
    });

    const path = writeGeneratedWranglerConfig(configuration);
    expect(path).toBe(generatedWranglerConfigPath("staging"));
    const written = readFileSync(path, "utf8");
    const parsed = JSON.parse(written) as { routes?: unknown; workers_dev?: unknown };
    expect(written).toContain("example-canvas-staging-snapshots");
    expect(written).toContain("example-canvas-staging-assets");
    expect(parsed.routes).toBeUndefined();
    expect(parsed.workers_dev).toBe(false);
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});
