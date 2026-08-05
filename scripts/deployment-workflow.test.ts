import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");

describe("deployment workflow safety", () => {
  it("waits for the promoted staging version to converge before smoke testing", () => {
    expect(workflow).toContain("for attempt in $(seq 1 12)");
    expect(workflow).toContain(".versionId == $version");
    expect(workflow).toContain(
      "healthz?release=$" + "{GITHUB_RUN_ID}-$" + "{GITHUB_RUN_ATTEMPT}-$" + "{attempt}",
    );
  });

  it("verifies staging attestation provenance through immutable Actions records", () => {
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("repos/$GITHUB_REPOSITORY/actions/runs/$attested_run_id");
    expect(workflow).toContain("repos/$GITHUB_REPOSITORY/actions/runs/$attested_run_id/jobs");
    expect(workflow).toContain('.path == ".github/workflows/deploy.yml"');
    expect(workflow).toContain('.event == "workflow_run"');
    expect(workflow).toContain(".head_sha == $sha");
    expect(workflow).toContain('.name == "Staging deploy and 20-client smoke"');
    expect(workflow).not.toContain('.creator.login == "github-actions[bot]"');
  });
});
