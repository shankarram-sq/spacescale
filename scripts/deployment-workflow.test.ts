import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");

function commandBlocks(source: string, marker: string): string[] {
  const sectionStart = source.indexOf(marker);
  if (sectionStart === -1) return [];
  const lines = source.slice(sectionStart).split("\n");
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.includes("npx --no-install wrangler")) continue;
    let command = line;
    while (command.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      command += `\n${lines[index] ?? ""}`;
    }
    commands.push(command);
  }
  return commands;
}

describe("deployment workflow safety", () => {
  it("waits for the promoted staging version to converge before smoke testing", () => {
    expect(workflow).toContain("for attempt in $(seq 1 12)");
    expect(workflow).toContain(".versionId == $version");
    expect(workflow).toContain(
      "healthz?release=$" + "{GITHUB_RUN_ID}-$" + "{GITHUB_RUN_ATTEMPT}-$" + "{attempt}",
    );
  });

  it("retries GitHub reads while preserving exact staging provenance checks", () => {
    const gateStart = workflow.indexOf("Require successful staging delivery for this exact commit");
    const gateEnd = workflow.indexOf("  production:", gateStart);
    const gate = workflow.slice(gateStart, gateEnd);

    expect(workflow).toContain("actions: read");
    expect(gate.match(/\bgithub_api_get\b/g)).toHaveLength(5);
    expect(gate).toContain("--fail --silent --show-error");
    expect(gate).toContain("--retry 5 --retry-all-errors");
    expect(gate).toContain("--retry-max-time 45");
    expect(gate).toContain('-H "Authorization: Bearer $GH_TOKEN"');
    expect(gate).toContain("commits/staging");
    expect(gate).toContain("commits/$VALIDATED_SHA/status?per_page=100");
    expect(gate).toContain("actions/runs/$attested_run_id");
    expect(gate).toContain("actions/runs/$attested_run_id/jobs?per_page=100");
    expect(gate).not.toContain("gh api");
    expect(gate).toContain('.path == ".github/workflows/deploy.yml"');
    expect(gate).toContain('.event == "workflow_run"');
    expect(gate).toContain(".head_sha == $sha");
    expect(gate).toContain('.name == "Staging deploy and 20-client smoke"');
    expect(gate).not.toContain('.creator.login == "github-actions[bot]"');
  });

  it("keeps staging strict while making the top-level production target explicit", () => {
    const stagingUploadStart = workflow.indexOf("Upload the isolated staging Worker version");
    const stagingUploadEnd = workflow.indexOf(
      "Promote the staging version without reconciling routes",
      stagingUploadStart,
    );
    const stagingUpload = workflow.slice(stagingUploadStart, stagingUploadEnd);
    expect(stagingUpload).toContain("--env staging");
    expect(stagingUpload).toContain("--strict");

    const productionStart = workflow.indexOf("  production:");
    const production = workflow.slice(productionStart);
    const commands = commandBlocks(production, "  production:");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toContain("--env=");

    const productionUploadStart = production.indexOf("Upload candidate without production traffic");
    const productionUploadEnd = production.indexOf(
      "Record the exact rollback target",
      productionUploadStart,
    );
    const productionUpload = production.slice(productionUploadStart, productionUploadEnd);
    expect(productionUpload).not.toContain("--strict");
  });

  it("verifies the uploaded production version before exposing it to traffic", () => {
    expect(workflow).toContain('wrangler versions view "$version" --env="" --json');
    expect(workflow).toContain('wrangler versions view "$PREVIOUS_VERSION" --env="" --json');
    expect(workflow).toContain("candidate must have exactly one");
    expect(workflow).toContain('--argjson retainedSecrets "$retained_secrets"');
    expect(workflow).toContain("$retainedSecrets -");
    expect(workflow).toContain('binding("BOARD_ROOMS").namespace_id == $namespace');
    expect(workflow).toContain(
      '$candidate.resources.script_runtime.compatibility_date == "2026-08-04"',
    );
    expect(workflow).toContain(
      '$candidate.resources.script_runtime.compatibility_flags == ["nodejs_compat"]',
    );

    const verification = workflow.indexOf("retained_namespace=");
    const emittedOutput = workflow.indexOf('echo "candidate_version=$version"');
    expect(verification).toBeGreaterThan(-1);
    expect(emittedOutput).toBeGreaterThan(verification);
  });

  it("waits for the promoted production version before repeated live probes", () => {
    const rolloutStart = workflow.indexOf(
      "Attach candidate at 0%, override-smoke it, then promote atomically",
    );
    const rolloutEnd = workflow.indexOf(
      "Automatically restore the retained version after a rollout failure",
      rolloutStart,
    );
    const rollout = workflow.slice(rolloutStart, rolloutEnd);
    const convergenceStart = rollout.indexOf("promotion_ready=false");
    const repeatedChecksStart = rollout.indexOf("for ordinal in $(seq 1 10)");

    expect(convergenceStart).toBeGreaterThan(-1);
    expect(repeatedChecksStart).toBeGreaterThan(convergenceStart);
    expect(rollout).toContain("for attempt in $(seq 1 12)");
    expect(rollout).toContain(
      "healthz?promotion-ready=$" + "{GITHUB_RUN_ID}-$" + "{GITHUB_RUN_ATTEMPT}-$" + "{attempt}",
    );
    expect(rollout).toContain(".versionId == $version");
    expect(rollout).toContain('test "$promotion_ready" = true');
    expect(rollout).toContain("Production did not converge to version $CANDIDATE_VERSION");
  });

  it("verifies rollback traffic and health converge to the retained version", () => {
    const rollbackStart = workflow.indexOf(
      "Automatically restore the retained version after a rollout failure",
    );
    const rollbackEnd = workflow.indexOf("Write deployment summary", rollbackStart);
    const rollback = workflow.slice(rollbackStart, rollbackEnd);
    expect(rollback).toContain("for attempt in $(seq 1 12)");
    expect(rollback).toContain("production-rollback-status-$" + "{attempt}.json");
    expect(rollback).toContain(".versions[0].version_id == $version");
    expect(rollback).toContain("healthz?rollback=$" + "{GITHUB_RUN_ID}-$" + "{attempt}");
    expect(rollback).toContain(".versionId == $version");
    expect(rollback).toContain('test "$rollback_ready" = true');
  });
});
