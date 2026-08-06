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
    expect(gate).not.toContain(".head_sha == $sha");
    expect(workflow).toContain(
      "name: Staging deploy and 20-client smoke ($" + "{{ github.event.workflow_run.head_sha }})",
    );
    expect(gate).toContain(
      'staging_job_name="Staging deploy and 20-client smoke ($VALIDATED_SHA)"',
    );
    expect(gate).toContain('--arg job_name "$staging_job_name"');
    expect(gate).toContain(".name == $job_name");
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

  it("requires stable candidate observations before live static probes", () => {
    const rolloutStart = workflow.indexOf(
      "Attach candidate at 0%, override-smoke it, then promote atomically",
    );
    const rolloutEnd = workflow.indexOf(
      "Automatically restore the retained version after a rollout failure",
      rolloutStart,
    );
    const rollout = workflow.slice(rolloutStart, rolloutEnd);
    const convergenceStart = rollout.indexOf("promotion_ready=false");
    const liveStaticStart = rollout.indexOf("live_index=", convergenceStart);
    const convergence = rollout.slice(convergenceStart, liveStaticStart);
    const identityCheck = convergence.indexOf('.service == "cloudflare-collab-canvas-edge"');
    const versionSwitch = convergence.indexOf('case "$observed_version" in');

    expect(convergenceStart).toBeGreaterThan(-1);
    expect(liveStaticStart).toBeGreaterThan(convergenceStart);
    expect(convergence).toContain("required_candidate_streak=10");
    expect(convergence).toContain("max_semantic_attempts=30");
    expect(convergence).toContain('for attempt in $(seq 1 "$max_semantic_attempts")');
    expect(convergence).toContain("--connect-timeout 5 --max-time 10");
    expect(convergence).not.toContain("--retry");
    expect(convergence).toContain(
      "healthz?promotion-ready=$" + "{GITHUB_RUN_ID}-$" + "{GITHUB_RUN_ATTEMPT}-$" + "{attempt}",
    );
    expect(convergence.match(/candidate_streak=0/g)).toHaveLength(3);
    expect(convergence).toContain("candidate_streak=$((candidate_streak + 1))");
    expect(convergence).toContain('(.versionId | type == "string")');
    expect(identityCheck).toBeGreaterThan(-1);
    expect(versionSwitch).toBeGreaterThan(identityCheck);
    expect(convergence).toContain('"$CANDIDATE_VERSION")');
    expect(convergence).toContain('"$PREVIOUS_VERSION")');
    expect(convergence).toContain("Unsafe unknown production version");
    expect(convergence).toContain("if ((attempt < max_semantic_attempts)); then sleep 2; fi");
    expect(convergence).toContain('test "$promotion_ready" = true');
    expect(rollout).not.toContain("for ordinal in $(seq 1 10)");
  });

  it("waits for stable candidate override propagation before candidate static smoke", () => {
    const rolloutStart = workflow.indexOf(
      "Attach candidate at 0%, override-smoke it, then promote atomically",
    );
    const rolloutEnd = workflow.indexOf(
      "Automatically restore the retained version after a rollout failure",
      rolloutStart,
    );
    const rollout = workflow.slice(rolloutStart, rolloutEnd);
    const convergenceStart = rollout.indexOf("override_ready=false");
    const staticStart = rollout.indexOf("override_index=", convergenceStart);
    const convergence = rollout.slice(convergenceStart, staticStart);
    const identityCheck = convergence.indexOf('.service == "cloudflare-collab-canvas-edge"');
    const versionSwitch = convergence.indexOf('case "$observed_override_version" in');
    const readiness = rollout.indexOf('test "$override_ready" = true');
    const promotion = rollout.indexOf('"$' + '{CANDIDATE_VERSION}@100"');

    expect(rollout).toContain("timeout-minutes: 13");
    expect(convergenceStart).toBeGreaterThan(-1);
    expect(staticStart).toBeGreaterThan(convergenceStart);
    expect(convergence).toContain("required_override_streak=3");
    expect(convergence).toContain("max_override_attempts=12");
    expect(convergence).toContain('for attempt in $(seq 1 "$max_override_attempts")');
    expect(convergence).toContain("--connect-timeout 5 --max-time 10");
    expect(convergence).not.toContain("--retry");
    expect(convergence).toContain(
      "healthz?candidate-ready=$" + "{GITHUB_RUN_ID}-$" + "{GITHUB_RUN_ATTEMPT}-$" + "{attempt}",
    );
    expect(convergence.match(/override_streak=0/g)).toHaveLength(3);
    expect(convergence).toContain("override_streak=$((override_streak + 1))");
    expect(convergence).toContain('(.versionId | type == "string")');
    expect(identityCheck).toBeGreaterThan(-1);
    expect(versionSwitch).toBeGreaterThan(identityCheck);
    expect(convergence).toContain('"$CANDIDATE_VERSION")');
    expect(convergence).toContain('"$PREVIOUS_VERSION")');
    expect(convergence).toContain("Unsafe unknown production override version");
    expect(convergence).toContain("Candidate override response is missing nosniff");
    expect(convergence).toContain("Candidate override response is missing Content-Security-Policy");
    expect(convergence).toContain("if ((attempt < max_override_attempts)); then sleep 2; fi");
    expect(readiness).toBeGreaterThan(convergenceStart);
    expect(staticStart).toBeGreaterThan(readiness);
    expect(promotion).toBeGreaterThan(staticStart);
  });

  it("retries only safe predecessor traffic states before semantic health checks", () => {
    const rolloutStart = workflow.indexOf(
      "Attach candidate at 0%, override-smoke it, then promote atomically",
    );
    const rolloutEnd = workflow.indexOf(
      "Automatically restore the retained version after a rollout failure",
      rolloutStart,
    );
    const rollout = workflow.slice(rolloutStart, rolloutEnd);
    const verifierStart = rollout.indexOf("verify_traffic() {");
    const verifierEnd = rollout.indexOf("override_value=", verifierStart);
    const verifier = rollout.slice(verifierStart, verifierEnd);
    const initialAttach = rollout.indexOf(
      '"$' + '{PREVIOUS_VERSION}@100" "$' + '{CANDIDATE_VERSION}@0"',
    );
    const rollbackArmed = rollout.indexOf('echo "traffic_changed=true" >> "$GITHUB_OUTPUT"');
    const initialTrafficVerification = rollout.indexOf("verify_traffic 0", initialAttach);
    const promotion = rollout.indexOf('"$' + '{CANDIDATE_VERSION}@100"');
    const trafficVerification = rollout.indexOf("verify_traffic 100", promotion);
    const semanticHealth = rollout.indexOf("promotion_ready=false", trafficVerification);

    expect(verifier).toContain("for attempt in $(seq 1 12)");
    expect(verifier).toContain(
      "production-traffic-$" + "{candidate_percentage}-$" + "{attempt}.json",
    );
    expect(verifier).toContain("if jq -e \\");
    expect(verifier).toContain("def previous_only:");
    expect(verifier).toContain("def attached_zero:");
    expect(verifier).toContain("previous_only or attached_zero");
    expect(verifier).toContain("Unsafe production traffic state");
    expect(verifier).toContain("return 0");
    expect(verifier).toContain("if ((attempt < 12)); then sleep 5; fi");
    expect(verifier).toContain("Production traffic did not converge to candidate");
    expect(verifier).toContain("return 1");
    expect(verifier).toContain("($versions | length) == 1");
    expect(verifier).toContain("($versions | length) == 2");
    expect(initialAttach).toBeGreaterThan(-1);
    expect(rollbackArmed).toBeGreaterThan(verifierEnd);
    expect(initialAttach).toBeGreaterThan(rollbackArmed);
    expect(initialTrafficVerification).toBeGreaterThan(initialAttach);
    expect(trafficVerification).toBeGreaterThan(promotion);
    expect(semanticHealth).toBeGreaterThan(trafficVerification);
    expect(workflow).toContain(
      "if: $" + "{{ failure() && steps.rollout.outputs.traffic_changed == 'true' }}",
    );
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
