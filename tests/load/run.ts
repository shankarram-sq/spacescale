#!/usr/bin/env node

import assert from "node:assert/strict";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { loadLocalEnv } from "../../scripts/env.ts";
import {
  type CanonicalSnapshot,
  type ClientSummary,
  type CommitFrame,
  clientSnapshotDigest,
  clientSummary,
  commitAndWait,
  connectClient,
  disconnectClient,
  ensureClientConnected,
  fetchExportDigest,
  installBrowserClient,
  prepareClientGesture,
  probeClientResyncRecovery,
  requestClientSync,
  startClientTraffic,
  stopClientTraffic,
  waitForClientRole,
  waitForClientSequence,
} from "./browser-client.ts";
import { isLocalHostname, validateLoadTarget } from "./target.ts";

const CLIENT_COUNT = 20;
const NORMAL_EDITOR_COUNT = 5;
const NORMAL_VIEWER_COUNT = 15;

type Role = "editor" | "viewer";

type HarnessConfig = {
  baseUrl: string;
  allowRemote: boolean;
  ignoreHttpsErrors: boolean;
  headless: boolean;
  smoke: boolean;
  stress: boolean;
  seed: number;
  actionCount: number;
  durationMs: number;
  previewHz: number;
  presenceHz: number;
  syncIntervalMs: number;
  reconnectCount: number;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  finalTimeoutMs: number;
  maxConnectMs: number;
  maxP95AckMs: number;
  maxEstimatedRowsWritten: number;
  turnstileToken?: string;
  turnstileClaimTokens: string[];
  remoteClaimIntervalMs: number;
  evictionUrl?: string;
  evictionAuthorization?: string;
  requireEviction: boolean;
};

type BrowserIdentity = {
  index: number;
  role: Role | "owner";
  context: BrowserContext;
  page: Page;
  actorId: string;
  csrfToken: string;
  turnstileRequired: boolean;
};

type Participant = BrowserIdentity & {
  role: Role;
  bootstrap: BootstrapResponse;
};

type BootstrapResponse = {
  protocolVersion: number;
  board: {
    id: string;
    title: string;
    accessMode: string;
    drawingPolicy: "editors_enabled" | "owner_only" | "locked";
    aclVersion: number;
    latestSeq: number;
    snapshotSeq: number;
  };
  actor: { id: string; role: Role | "owner"; displayName: string };
  limits: { maxConnections: number; previewHz: number };
  snapshot: CanonicalSnapshot | { url: string; seq: number };
};

type ActionPlan = {
  ordinal: number;
  drawerIndex: number;
  commandId: string;
  actionId: string;
  itemId: string;
  frame: CommitFrame;
  nextForDrawer?: ActionPlan;
};

type ReconnectPlan = {
  targetIndex: number;
  disconnectAfter: number;
  reconnectBefore: number;
};

type HttpResult = {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
};

type JsonRecord = Record<string, unknown>;

loadLocalEnv();

const config = readConfig(process.argv.slice(2));
if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

await run(config).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${JSON.stringify({ event: "load.failed", message })}\n`);
  process.exitCode = 1;
});

async function run(options: HarnessConfig): Promise<void> {
  validateTarget(options);
  if (options.requireEviction && options.evictionUrl === undefined) {
    throw new Error(
      "A conformance run requires --eviction-url (or LOAD_EVICTION_URL) so the environment can force Durable Object eviction.",
    );
  }

  report({
    event: "load.start",
    mode: options.smoke ? "smoke" : options.stress ? "stress" : "normal",
    baseUrl: redactUrl(options.baseUrl),
    clients: CLIENT_COUNT,
    activeDrawers: options.stress ? CLIENT_COUNT : NORMAL_EDITOR_COUNT,
    viewers: options.stress ? 0 : NORMAL_VIEWER_COUNT,
    actions: options.actionCount,
    durationSeconds: options.durationMs / 1_000,
    seed: options.seed,
    forcedEvictionConfigured: options.evictionUrl !== undefined,
  });

  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  try {
    browser = await chromium.launch({ headless: options.headless });
    const owner = await createIdentity(browser, contexts, options, -1, "owner");
    const title = `Deterministic load ${options.seed}`;
    const board = await createBoard(owner, options, title);
    const boardId = requiredString(requiredRecord(board.board, "board").id, "board.id");
    report({ event: "load.board_created", boardId });

    const editorCount = options.stress ? CLIENT_COUNT : NORMAL_EDITOR_COUNT;
    const viewerCount = CLIENT_COUNT - editorCount;
    const invitations = await createInvitations(
      owner,
      boardId,
      editorCount,
      viewerCount,
      options.seed,
    );

    const identities = await Promise.all(
      Array.from({ length: CLIENT_COUNT }, (_, index) =>
        createIdentity(
          browser as Browser,
          contexts,
          options,
          index,
          index < editorCount ? "editor" : "viewer",
        ),
      ),
    );
    const participants = await provisionParticipants(
      identities,
      boardId,
      invitations,
      editorCount,
      options,
    );
    assert.equal(participants.length, CLIENT_COUNT, "The scenario must provision 20 participants.");
    assert.equal(
      participants.filter((participant) => participant.role === "editor").length,
      editorCount,
      "The editor invitation did not provision the requested role count.",
    );
    assert.equal(
      participants.filter((participant) => participant.role === "viewer").length,
      viewerCount,
      "The viewer invitation did not provision the requested role count.",
    );

    await Promise.all(
      participants.map(async (participant) => {
        const snapshot = await inlineSnapshot(participant, boardId);
        assert.equal(snapshot.seq, 0, "A new load-test board must start at sequence zero.");
        await installBrowserClient(participant.page, {
          boardId,
          title,
          clientIndex: participant.index,
          clientInstanceId: deterministicUuid(0x40000000, participant.index + 1),
          role: participant.role,
          drawingPolicy: participant.bootstrap.board.drawingPolicy,
          snapshot,
          connectionTimeoutMs: options.connectTimeoutMs,
        });
      }),
    );

    const connectStartedAt = performance.now();
    await Promise.all(participants.map((participant) => connectClient(participant.page)));
    const connectDurationMs = performance.now() - connectStartedAt;
    assert.ok(
      connectDurationMs <= options.maxConnectMs,
      `The 20 sockets took ${connectDurationMs.toFixed(1)} ms to become ready (limit ${options.maxConnectMs} ms).`,
    );

    const downgradeAfter = options.stress
      ? null
      : Math.max(
          NORMAL_EDITOR_COUNT,
          Math.floor((options.actionCount * 2) / 3 / NORMAL_EDITOR_COUNT) * NORMAL_EDITOR_COUNT,
        );
    const actionPlans = buildActionPlans(options, downgradeAfter);
    const plansByDrawer = groupPlansByDrawer(actionPlans, editorCount);
    const reconnectPlans = buildReconnectPlans(options, actionPlans, editorCount);
    let downgradedParticipant: Participant | null = null;
    if (!options.stress) {
      const candidate = participants[NORMAL_EDITOR_COUNT - 1];
      assert.ok(candidate, "The membership downgrade target was not provisioned.");
      downgradedParticipant = candidate;
    }

    await Promise.all(
      participants.map((participant) =>
        startClientTraffic(participant.page, options.previewHz, options.presenceHz, 0),
      ),
    );
    await Promise.all(
      plansByDrawer.flatMap((plans) => {
        const first = plans[0];
        return first === undefined
          ? []
          : [
              prepareClientGesture(
                requiredParticipant(participants, first.drawerIndex).page,
                first.actionId,
                first.itemId,
              ),
            ];
      }),
    );

    const commandOutcomes: Array<{ commandId: string; seq: number; rttMs: number }> = [];
    const expectedRejectionIds = new Set<string>();
    let evictionPerformed = false;
    const evictionAfter = Math.max(1, Math.floor(options.actionCount * 0.8));
    const workloadStartedAt = performance.now();
    let nextSyncDeadline = workloadStartedAt + options.syncIntervalMs;
    const intentionallyOffline = new Set<number>();

    for (const plan of actionPlans) {
      for (const reconnect of reconnectPlans) {
        if (reconnect.reconnectBefore !== plan.ordinal) continue;
        await connectClient(requiredParticipant(participants, reconnect.targetIndex).page);
        intentionallyOffline.delete(reconnect.targetIndex);
      }

      await paceUntil(
        workloadStartedAt + (options.durationMs * plan.ordinal) / options.actionCount,
      );
      const drawer = participants[plan.drawerIndex];
      assert.ok(drawer, `Drawer ${plan.drawerIndex} was not provisioned.`);
      const outcome = await commitAndWait(drawer.page, plan.frame, options.commandTimeoutMs);
      assert.equal(
        outcome.kind,
        "ack",
        outcome.kind === "rejected"
          ? `Command ${plan.commandId} was rejected with ${outcome.code}.`
          : undefined,
      );
      if (outcome.kind !== "ack") throw new Error("Unreachable rejected command branch.");
      assert.equal(
        outcome.seq,
        plan.ordinal,
        "Accepted commands did not receive contiguous order.",
      );
      commandOutcomes.push(outcome);

      if (plan.nextForDrawer !== undefined) {
        await prepareClientGesture(
          drawer.page,
          plan.nextForDrawer.actionId,
          plan.nextForDrawer.itemId,
        );
      }

      if (performance.now() >= nextSyncDeadline) {
        const connectedParticipants = participants.filter(
          (participant) => !intentionallyOffline.has(participant.index),
        );
        await Promise.all(
          connectedParticipants.map((participant) =>
            waitForClientSequence(participant.page, plan.ordinal, options.finalTimeoutMs),
          ),
        );
        await Promise.all(
          connectedParticipants.map((participant) =>
            requestClientSync(participant.page, options.commandTimeoutMs),
          ),
        );
        while (nextSyncDeadline <= performance.now()) {
          nextSyncDeadline += options.syncIntervalMs;
        }
      }

      if (downgradeAfter === plan.ordinal && downgradedParticipant !== null) {
        const forbiddenCommandId = await downgradeEditorAndProbe(
          owner,
          downgradedParticipant,
          boardId,
          plan.ordinal,
          options,
        );
        expectedRejectionIds.add(forbiddenCommandId);
      }

      if (plan.ordinal === evictionAfter && options.evictionUrl !== undefined) {
        await invokeEviction(options, boardId, plan.ordinal);
        evictionPerformed = true;
        await Promise.all(
          participants.map((participant) => ensureClientConnected(participant.page)),
        );
        await Promise.all(
          participants.map((participant) =>
            waitForClientSequence(participant.page, plan.ordinal, options.finalTimeoutMs),
          ),
        );
        await Promise.all(
          participants.map((participant) =>
            requestClientSync(participant.page, options.commandTimeoutMs),
          ),
        );
      }

      for (const reconnect of reconnectPlans) {
        if (reconnect.disconnectAfter !== plan.ordinal) continue;
        await disconnectClient(
          requiredParticipant(participants, reconnect.targetIndex).page,
          `deterministic replay ${plan.ordinal}`,
        );
        intentionallyOffline.add(reconnect.targetIndex);
      }
    }

    await Promise.all(participants.map((participant) => ensureClientConnected(participant.page)));
    await Promise.all(
      participants.map((participant) =>
        waitForClientSequence(participant.page, options.actionCount, options.finalTimeoutMs),
      ),
    );
    await Promise.all(
      participants.map((participant) =>
        requestClientSync(participant.page, options.commandTimeoutMs),
      ),
    );
    await Promise.all(participants.map((participant) => stopClientTraffic(participant.page)));
    const recoveryProbe = requiredParticipant(participants, CLIENT_COUNT - 1);
    await probeClientResyncRecovery(recoveryProbe.page, options.finalTimeoutMs);
    await waitForClientSequence(recoveryProbe.page, options.actionCount, options.finalTimeoutMs);

    const namedSnapshot = await createFinalSnapshot(owner, boardId, options.seed);
    const snapshotSha256 = requiredString(namedSnapshot.sha256, "snapshot.sha256");
    assert.equal(requiredNumber(namedSnapshot.seq, "snapshot.seq"), options.actionCount);
    assert.equal(
      requiredNumber(namedSnapshot.itemCount, "snapshot.itemCount"),
      options.actionCount,
    );

    const [summaries, localDigests, exportDigests, ownerExport] = await Promise.all([
      Promise.all(participants.map((participant) => clientSummary(participant.page))),
      Promise.all(participants.map((participant) => clientSnapshotDigest(participant.page))),
      Promise.all(participants.map((participant) => fetchExportDigest(participant.page, boardId))),
      fetchExportDigest(owner.page, boardId),
    ]);

    validateFinalState({
      options,
      participants,
      summaries,
      commandOutcomes,
      expectedRejectionIds,
      snapshotSha256,
      localDigests,
      exportDigests,
      ownerExport,
      downgradedParticipant,
      connectDurationMs,
      evictionPerformed,
    });

    const ackP95Ms = percentile(
      commandOutcomes.map((outcome) => outcome.rttMs),
      0.95,
    );
    const previewFrames = summaries.reduce(
      (total, summary) => total + summary.counters.previewsSent,
      0,
    );
    const presenceFrames = summaries.reduce(
      (total, summary) => total + summary.counters.presenceSent,
      0,
    );
    const estimatedRowsWritten = estimateRowsWritten(
      options.actionCount,
      CLIENT_COUNT,
      downgradedParticipant !== null,
      options.durationMs,
      options.stress,
    );
    report({
      event: "load.passed",
      boardId,
      clients: CLIENT_COUNT,
      actions: options.actionCount,
      finalSeq: options.actionCount,
      finalSnapshotSha256: snapshotSha256,
      connectDurationMs: round(connectDurationMs),
      ackRttP95Ms: round(ackP95Ms),
      ackRttMetric: "end_to_end_websocket_rtt",
      previewFramesSent: previewFrames,
      presenceFramesSent: presenceFrames,
      reconnectsPerformed: reconnectPlans.length,
      resyncRecoveryProbePerformed: true,
      membershipDowngradePerformed: downgradedParticipant !== null,
      forcedEvictionPerformed: evictionPerformed,
      estimatedRowsWritten,
      unexpectedRejections: 0,
    });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser?.close();
  }
}

async function createIdentity(
  browser: Browser,
  contexts: BrowserContext[],
  options: HarnessConfig,
  index: number,
  role: Role | "owner",
): Promise<BrowserIdentity> {
  const context = await browser.newContext({ ignoreHTTPSErrors: options.ignoreHttpsErrors });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL("/healthz", options.baseUrl).href, {
    waitUntil: "domcontentloaded",
    timeout: options.connectTimeoutMs,
  });
  const session = await requestJson(page, "/api/v1/session", { method: "POST" });
  const actor = requiredRecord(session.actor, "session.actor");
  const actorId = requiredString(actor.id, "session.actor.id");
  const csrfToken = requiredString(session.csrfToken, "session.csrfToken");
  const turnstile = requiredRecord(session.turnstile, "session.turnstile");
  const cookies = await context.cookies(options.baseUrl);
  assert.ok(
    cookies.some((cookie) => cookie.name === "__Host-wb_session"),
    "The browser did not retain __Host-wb_session. Use localhost/HTTPS and check cookie attributes.",
  );
  return {
    index,
    role,
    context,
    page,
    actorId,
    csrfToken,
    turnstileRequired: turnstile.enabled === true && turnstile.required === true,
  };
}

async function createBoard(
  owner: BrowserIdentity,
  options: HarnessConfig,
  title: string,
): Promise<JsonRecord> {
  if (owner.turnstileRequired && options.turnstileToken === undefined) {
    throw new Error(
      "This session requires Turnstile. Supply a fresh --turnstile-token/LOAD_TURNSTILE_TOKEN or use the development environment where Turnstile is disabled.",
    );
  }
  const response = await requestJson(owner.page, "/api/v1/boards", {
    method: "POST",
    csrfToken: owner.csrfToken,
    body: {
      title,
      accessMode: "private",
      displayName: "Load Owner",
      ...(options.turnstileToken === undefined ? {} : { turnstileToken: options.turnstileToken }),
    },
  });
  requiredString(response.ownerRecoveryToken, "ownerRecoveryToken");
  return response;
}

async function createInvitations(
  owner: BrowserIdentity,
  boardId: string,
  editorCount: number,
  viewerCount: number,
  seed: number,
): Promise<{ editorToken: string; viewerToken?: string }> {
  const expiresAtMs = Date.now() + 60 * 60_000;
  const editor = await requestJson(
    owner.page,
    `/api/v1/boards/${encodeURIComponent(boardId)}/invitations`,
    {
      method: "POST",
      csrfToken: owner.csrfToken,
      headers: { "Idempotency-Key": `load-editor-invite-${seed}` },
      body: {
        role: "editor",
        label: "Deterministic load editors",
        maxUses: editorCount,
        expiresAtMs,
      },
    },
  );
  const editorToken = requiredString(editor.token, "editor invitation token");
  if (viewerCount === 0) return { editorToken };
  const viewer = await requestJson(
    owner.page,
    `/api/v1/boards/${encodeURIComponent(boardId)}/invitations`,
    {
      method: "POST",
      csrfToken: owner.csrfToken,
      headers: { "Idempotency-Key": `load-viewer-invite-${seed}` },
      body: {
        role: "viewer",
        label: "Deterministic load viewers",
        maxUses: viewerCount,
        expiresAtMs,
      },
    },
  );
  return {
    editorToken,
    viewerToken: requiredString(viewer.token, "viewer invitation token"),
  };
}

async function provisionParticipants(
  identities: BrowserIdentity[],
  boardId: string,
  invitations: { editorToken: string; viewerToken?: string },
  editorCount: number,
  options: HarnessConfig,
): Promise<Participant[]> {
  const turnstileRequired = identities.some((identity) => identity.turnstileRequired);
  if (turnstileRequired && options.turnstileClaimTokens.length !== identities.length) {
    throw new Error(
      `The target requires one fresh invitation_claim Turnstile token per participant. LOAD_TURNSTILE_CLAIM_TOKENS must contain exactly ${identities.length} tokens.`,
    );
  }
  const claimIdentity = async (identity: BrowserIdentity): Promise<Participant> => {
    const expectedRole: Role = identity.index < editorCount ? "editor" : "viewer";
    const token =
      expectedRole === "editor"
        ? invitations.editorToken
        : requiredString(invitations.viewerToken, "viewer invitation token");
    const claim = await requestJson(
      identity.page,
      `/api/v1/boards/${encodeURIComponent(boardId)}/claims`,
      {
        method: "POST",
        csrfToken: identity.csrfToken,
        headers: isLocalHostname(new URL(identity.page.url()).hostname)
          ? { "CF-Connecting-IP": `198.18.0.${identity.index + 1}` }
          : undefined,
        body: {
          type: "invite",
          token,
          displayName: `Load ${expectedRole} ${identity.index + 1}`,
          ...(turnstileRequired
            ? { turnstileToken: options.turnstileClaimTokens[identity.index] }
            : {}),
        },
      },
    );
    const claimedActor = requiredRecord(claim.actor, "claim.actor");
    assert.equal(claimedActor.id, identity.actorId, "The invitation claimed the wrong actor.");
    assert.equal(claimedActor.role, expectedRole, "The invitation claimed the wrong role.");
    const bootstrap = (await requestJson(
      identity.page,
      `/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`,
    )) as BootstrapResponse;
    assert.equal(bootstrap.protocolVersion, 1);
    assert.equal(bootstrap.actor.id, identity.actorId);
    assert.equal(bootstrap.actor.role, expectedRole);
    assert.ok(bootstrap.limits.maxConnections >= CLIENT_COUNT);
    return { ...identity, role: expectedRole, bootstrap };
  };

  if (isLocalHostname(new URL(options.baseUrl).hostname) || options.remoteClaimIntervalMs === 0) {
    return Promise.all(identities.map(claimIdentity));
  }

  // The deployed gateway allows a burst of five claims per source IP, then
  // refills one token every 12 seconds. Preserve the initial burst and pace
  // the remaining identities so a single-host staging run is reproducible.
  const startedAt = performance.now();
  const participants = await Promise.all(identities.slice(0, 5).map(claimIdentity));
  for (const [offset, identity] of identities.slice(5).entries()) {
    await paceUntil(startedAt + (offset + 1) * options.remoteClaimIntervalMs);
    participants.push(await claimIdentity(identity));
  }
  return participants.sort((left, right) => left.index - right.index);
}

async function inlineSnapshot(
  participant: Participant,
  boardId: string,
): Promise<CanonicalSnapshot> {
  const descriptor = participant.bootstrap.snapshot;
  if ("items" in descriptor) return descriptor;
  const value = await requestJson(participant.page, descriptor.url);
  assert.equal(value.boardId, boardId);
  return value as CanonicalSnapshot;
}

function buildActionPlans(options: HarnessConfig, downgradeAfter: number | null): ActionPlan[] {
  const random = mulberry32(options.seed);
  const initialDrawers = Array.from(
    { length: options.stress ? CLIENT_COUNT : NORMAL_EDITOR_COUNT },
    (_, index) => index,
  );
  const postDowngradeDrawers = initialDrawers.filter((index) => index !== NORMAL_EDITOR_COUNT - 1);
  const colors = ["#3366cc", "#cc3344", "#228855", "#8844bb", "#cc7700"];
  const plans: ActionPlan[] = [];
  for (let ordinal = 1; ordinal <= options.actionCount; ordinal += 1) {
    const drawers =
      downgradeAfter !== null && ordinal > downgradeAfter ? postDowngradeDrawers : initialDrawers;
    const phaseOrdinal =
      downgradeAfter !== null && ordinal > downgradeAfter
        ? ordinal - downgradeAfter - 1
        : ordinal - 1;
    const drawerIndex = drawers[phaseOrdinal % drawers.length];
    assert.ok(drawerIndex !== undefined);
    const actionId = deterministicUuid(0x10000000, ordinal);
    const itemId = deterministicUuid(0x20000000, ordinal);
    const x = Math.round((ordinal * 17 + random() * 7) * 100) / 100;
    const y = Math.round((drawerIndex * 140 + random() * 11) * 100) / 100;
    const frame: CommitFrame = {
      v: 1,
      t: "client.commit",
      commandId: actionId,
      actionId,
      baseSeq: ordinal - 1,
      op: {
        kind: "item.create",
        item: {
          id: itemId,
          kind: "pencil",
          style: {
            kind: "stroke",
            color: colors[drawerIndex % colors.length],
            width: 2 + (ordinal % 4),
            opacity: 0.8,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            points: [
              [x, y],
              [x + 3.25, y + 2.5],
              [x + 7.5, y + 4.75],
              [x + 12, y + 6],
            ],
          },
        },
      },
    };
    plans.push({ ordinal, drawerIndex, commandId: actionId, actionId, itemId, frame });
  }
  const nextByDrawer = new Map<number, ActionPlan>();
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const plan = plans[index];
    if (plan === undefined) continue;
    plan.nextForDrawer = nextByDrawer.get(plan.drawerIndex);
    nextByDrawer.set(plan.drawerIndex, plan);
  }
  return plans;
}

function groupPlansByDrawer(plans: ActionPlan[], drawerCount: number): ActionPlan[][] {
  const result = Array.from({ length: drawerCount }, () => [] as ActionPlan[]);
  for (const plan of plans) result[plan.drawerIndex]?.push(plan);
  return result;
}

function buildReconnectPlans(
  options: HarnessConfig,
  actions: ActionPlan[],
  editorCount: number,
): ReconnectPlan[] {
  if (options.reconnectCount === 0) return [];
  const random = mulberry32(options.seed ^ 0x9e3779b9);
  const latestDisconnect = Math.max(1, options.actionCount - 4);
  const plans: ReconnectPlan[] = [];
  for (let index = 0; index < options.reconnectCount; index += 1) {
    const disconnectAfter = Math.max(
      1,
      Math.min(
        latestDisconnect,
        Math.round(((index + 1) * latestDisconnect) / (options.reconnectCount + 1)),
      ),
    );
    let targetIndex: number;
    if (index === 0) {
      targetIndex = actions[disconnectAfter - 1]?.drawerIndex ?? 0;
    } else if (editorCount < CLIENT_COUNT) {
      targetIndex = editorCount + Math.floor(random() * (CLIENT_COUNT - editorCount));
    } else {
      targetIndex = actions[disconnectAfter - 1]?.drawerIndex ?? index % CLIENT_COUNT;
    }
    plans.push({ targetIndex, disconnectAfter, reconnectBefore: disconnectAfter + 3 });
  }
  return plans;
}

async function downgradeEditorAndProbe(
  owner: BrowserIdentity,
  target: Participant,
  boardId: string,
  latestSeq: number,
  options: HarnessConfig,
): Promise<string> {
  const members = await requestJson(
    owner.page,
    `/api/v1/boards/${encodeURIComponent(boardId)}/members`,
  );
  const aclVersion = requiredNumber(members.aclVersion, "members.aclVersion");
  const memberList = requiredArray(members.members, "members.members");
  const targetMember = memberList.find(
    (value) => isRecord(value) && value.actorId === target.actorId,
  );
  assert.ok(isRecord(targetMember), "The downgrade target was absent from the member list.");
  assert.equal(targetMember.role, "editor", "The downgrade target was not an editor.");
  const patch = await requestJson(
    owner.page,
    `/api/v1/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(target.actorId)}`,
    {
      method: "PATCH",
      csrfToken: owner.csrfToken,
      body: { role: "viewer", expectedAclVersion: aclVersion },
    },
  );
  assert.equal(requiredNumber(patch.aclVersion, "membership aclVersion"), aclVersion + 1);
  await waitForClientRole(target.page, "viewer", options.commandTimeoutMs);

  const forbiddenCommandId = deterministicUuid(0x1fffffff, 1);
  const outcome = await commitAndWait(
    target.page,
    {
      v: 1,
      t: "client.commit",
      commandId: forbiddenCommandId,
      actionId: forbiddenCommandId,
      baseSeq: latestSeq,
      op: {
        kind: "item.create",
        item: {
          id: deterministicUuid(0x2fffffff, 1),
          kind: "line",
          style: {
            kind: "line",
            color: "#ff0000",
            width: 2,
            opacity: 1,
            arrowhead: "none",
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x1: 0, y1: 0, x2: 10, y2: 10 },
        },
      },
    },
    options.commandTimeoutMs,
  );
  assert.equal(outcome.kind, "rejected", "A downgraded live socket accepted a forged commit.");
  if (outcome.kind !== "rejected") throw new Error("Unreachable accepted downgrade probe.");
  assert.equal(outcome.code, "FORBIDDEN");
  assert.equal(outcome.latestSeq, latestSeq, "A rejected viewer command consumed a sequence.");
  return forbiddenCommandId;
}

async function invokeEviction(
  options: HarnessConfig,
  boardId: string,
  expectedSeq: number,
): Promise<void> {
  const url = new URL(requiredString(options.evictionUrl, "eviction URL"));
  if (url.protocol !== "https:" && !isLocalHostname(url.hostname)) {
    throw new Error("The eviction hook must use HTTPS unless it is on localhost.");
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.evictionAuthorization !== undefined) {
    headers.set("Authorization", options.evictionAuthorization);
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ boardId, expectedSeq }),
    signal: AbortSignal.timeout(options.commandTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`The Durable Object eviction hook failed with HTTP ${response.status}.`);
  }
  report({ event: "load.eviction_completed", seq: expectedSeq });
}

async function createFinalSnapshot(
  owner: BrowserIdentity,
  boardId: string,
  seed: number,
): Promise<JsonRecord> {
  const response = await requestJson(
    owner.page,
    `/api/v1/boards/${encodeURIComponent(boardId)}/snapshots`,
    {
      method: "POST",
      csrfToken: owner.csrfToken,
      headers: { "Idempotency-Key": `load-final-snapshot-${seed}` },
      body: { label: `Load final ${seed}` },
    },
  );
  return requiredRecord(response.snapshot, "snapshot response");
}

function validateFinalState(input: {
  options: HarnessConfig;
  participants: Participant[];
  summaries: ClientSummary[];
  commandOutcomes: Array<{ commandId: string; seq: number; rttMs: number }>;
  expectedRejectionIds: Set<string>;
  snapshotSha256: string;
  localDigests: Array<{ sha256: string; seq: number; itemCount: number; byteCount: number }>;
  exportDigests: Array<{
    status: number;
    sha256: string;
    seq: number;
    responseSeq: number | null;
    itemCount: number;
  }>;
  ownerExport: {
    status: number;
    sha256: string;
    seq: number;
    responseSeq: number | null;
    itemCount: number;
  };
  downgradedParticipant: Participant | null;
  connectDurationMs: number;
  evictionPerformed: boolean;
}): void {
  const {
    options,
    participants,
    summaries,
    commandOutcomes,
    expectedRejectionIds,
    snapshotSha256,
    localDigests,
    exportDigests,
    ownerExport,
    downgradedParticipant,
    connectDurationMs,
    evictionPerformed,
  } = input;
  assert.equal(connectDurationMs <= options.maxConnectMs, true);
  assert.equal(commandOutcomes.length, options.actionCount, "An action was not acknowledged.");
  assert.equal(
    new Set(commandOutcomes.map((outcome) => outcome.commandId)).size,
    options.actionCount,
    "A command was acknowledged more than once.",
  );
  assert.deepEqual(
    commandOutcomes.map((outcome) => outcome.seq),
    Array.from({ length: options.actionCount }, (_, index) => index + 1),
    "Acknowledgements were not in the authoritative total order.",
  );

  const expectedSequences = Array.from({ length: options.actionCount }, (_, index) => index + 1);
  for (const [index, summary] of summaries.entries()) {
    assert.equal(summary.ready, true, `Client ${index} was not ready at final verification.`);
    assert.equal(summary.baselineSeq, 0);
    assert.equal(summary.lastSeq, options.actionCount, `Client ${index} ended at the wrong seq.`);
    assert.equal(summary.itemCount, options.actionCount, `Client ${index} lost canonical items.`);
    assert.deepEqual(
      summary.receivedSeqs,
      expectedSequences,
      `Client ${index} did not apply every sequence exactly once.`,
    );
    assert.deepEqual(summary.duplicateSeqs, [], `Client ${index} observed duplicate sequences.`);
    assert.deepEqual(summary.sequenceGaps, [], `Client ${index} observed a sequence gap.`);
    assert.deepEqual(summary.protocolErrors, [], `Client ${index} observed protocol errors.`);
    assert.ok(summary.counters.presenceSent > 0, `Client ${index} sent no presence traffic.`);
    assert.ok(summary.counters.syncChecksSent > 0, `Client ${index} sent no sync checks.`);
    const recoveryCloses = summary.closeEvents.filter(
      (close) => !close.manual && close.code === 4009,
    );
    assert.equal(
      recoveryCloses.length,
      summary.counters.resyncRecoveries,
      `Client ${index} did not pair every authoritative resync with a 4009 recovery close.`,
    );
    if (summary.counters.resyncRecoveries > 0) {
      assert.ok(
        summary.counters.reconnects >= summary.counters.resyncRecoveries,
        `Client ${index} did not reconnect after authoritative resynchronization.`,
      );
    }
    for (const close of summary.closeEvents) {
      if (close.manual) continue;
      assert.ok(
        ![1002, 1008, 1013, 4003, 4008, 4010, 4011].includes(close.code),
        `Client ${index} received failure close code ${close.code}.`,
      );
    }

    const allowedRejections = summary.rejectionFrames.filter(
      (frame) => frame.commandId !== null && expectedRejectionIds.has(frame.commandId),
    );
    assert.equal(
      summary.rejectionFrames.length,
      allowedRejections.length,
      `Client ${index} received an unexpected command rejection.`,
    );
  }

  const initiallyActive = options.stress ? CLIENT_COUNT : NORMAL_EDITOR_COUNT;
  for (let index = 0; index < initiallyActive; index += 1) {
    const summary = summaries[index];
    assert.ok(summary, `Active drawer ${index} has no final summary.`);
    assert.ok(summary.counters.previewsSent > 0, `Active drawer ${index} sent no preview traffic.`);
  }
  if (!options.stress) {
    for (let index = NORMAL_EDITOR_COUNT; index < CLIENT_COUNT; index += 1) {
      const summary = summaries[index];
      assert.ok(summary, `Viewer ${index} has no final summary.`);
      assert.equal(summary.counters.previewsSent, 0, `Viewer ${index} sent drawing previews.`);
    }
  }
  assert.ok(
    summaries.some((summary) => summary.counters.previewsReceived > 0),
    "No peer received any preview traffic.",
  );
  assert.ok(
    summaries.some((summary) => summary.counters.presenceReceived > 0),
    "No peer received any presence traffic.",
  );
  if (downgradedParticipant !== null) {
    assert.equal(summaries[downgradedParticipant.index]?.role, "viewer");
    assert.equal(expectedRejectionIds.size, 1);
  }
  if (options.requireEviction) assert.equal(evictionPerformed, true);

  const ackP95Ms = percentile(
    commandOutcomes.map((outcome) => outcome.rttMs),
    0.95,
  );
  assert.ok(
    ackP95Ms <= options.maxP95AckMs,
    `End-to-end acknowledgement p95 ${ackP95Ms.toFixed(1)} ms exceeded ${options.maxP95AckMs} ms.`,
  );
  const estimatedRowsWritten = estimateRowsWritten(
    options.actionCount,
    CLIENT_COUNT,
    downgradedParticipant !== null,
    options.durationMs,
    options.stress,
  );
  assert.ok(
    estimatedRowsWritten <= options.maxEstimatedRowsWritten,
    `Estimated SQLite rows written ${estimatedRowsWritten} exceeded ${options.maxEstimatedRowsWritten}.`,
  );

  assert.equal(ownerExport.status, 200);
  assert.equal(ownerExport.seq, options.actionCount);
  assert.equal(ownerExport.responseSeq, options.actionCount);
  assert.equal(ownerExport.itemCount, options.actionCount);
  assert.equal(
    ownerExport.sha256,
    snapshotSha256,
    "The current authoritative export differs from the named R2 snapshot.",
  );
  for (const [index, digest] of localDigests.entries()) {
    assert.equal(digest.seq, options.actionCount);
    assert.equal(digest.itemCount, options.actionCount);
    assert.equal(
      digest.sha256,
      snapshotSha256,
      `Client ${index} canonical snapshot hash diverged from the server.`,
    );
  }
  for (const [index, digest] of exportDigests.entries()) {
    assert.equal(digest.status, 200, `Client ${index} could not fetch the canonical export.`);
    assert.equal(digest.seq, options.actionCount);
    assert.equal(digest.responseSeq, options.actionCount);
    assert.equal(digest.itemCount, options.actionCount);
    assert.equal(
      digest.sha256,
      snapshotSha256,
      `Client ${index} received a divergent canonical export.`,
    );
  }

  const allAcknowledged = new Set(summaries.flatMap((summary) => summary.acknowledgedCommandIds));
  assert.deepEqual(
    allAcknowledged,
    new Set(commandOutcomes.map((outcome) => outcome.commandId)),
    "At least one accepted command was never acknowledged to its sender.",
  );
  assert.equal(participants.length, CLIENT_COUNT);
}

async function browserRequest(
  page: Page,
  path: string,
  init: {
    method?: string;
    csrfToken?: string;
    headers?: Record<string, string>;
    body?: JsonRecord;
  } = {},
): Promise<HttpResult> {
  return page.evaluate(
    async ({ requestPath, method, csrfToken, extraHeaders, serializedBody }) => {
      const headers = new Headers(extraHeaders);
      headers.set("Accept", "application/json");
      if (csrfToken !== undefined) headers.set("X-CSRF-Token", csrfToken);
      if (serializedBody !== undefined) headers.set("Content-Type", "application/json");
      const response = await fetch(requestPath, {
        method,
        headers,
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        credentials: "same-origin",
        cache: "no-store",
      });
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
      };
    },
    {
      requestPath: path,
      method: init.method ?? "GET",
      csrfToken: init.csrfToken,
      extraHeaders: init.headers ?? {},
      serializedBody: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
  );
}

async function requestJson(
  page: Page,
  path: string,
  init: {
    method?: string;
    csrfToken?: string;
    headers?: Record<string, string>;
    body?: JsonRecord;
  } = {},
): Promise<JsonRecord> {
  const result = await browserRequest(page, path, init);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = null;
  }
  if (!result.ok) {
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
    const code = typeof error?.code === "string" ? error.code : `HTTP_${result.status}`;
    const message =
      typeof error?.message === "string" ? error.message : "The request did not return JSON.";
    throw new Error(
      `${init.method ?? "GET"} ${path} failed (${code}, HTTP ${result.status}): ${message}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${init.method ?? "GET"} ${path} returned invalid JSON.`);
  return parsed;
}

function readConfig(arguments_: string[]): HarnessConfig {
  const parsed = parseArguments(arguments_);
  const smoke = booleanOption(parsed, "smoke", "LOAD_SMOKE", false);
  const stress = booleanOption(parsed, "stress", "LOAD_STRESS", false);
  if (smoke && stress) throw new Error("--smoke and --stress are mutually exclusive.");
  const baseUrl = option(parsed, "base-url", "LOAD_BASE_URL") ?? "http://localhost:8787";
  const actionCount = integerOption(parsed, "actions", "LOAD_ACTIONS", smoke ? 20 : 300, 5, 10_000);
  const durationSeconds = numberOption(
    parsed,
    "duration-seconds",
    "LOAD_DURATION_SECONDS",
    smoke ? 10 : 600,
    1,
    86_400,
  );
  const reconnectCount = integerOption(
    parsed,
    "reconnects",
    "LOAD_RECONNECTS",
    smoke ? 1 : 8,
    0,
    Math.max(0, Math.floor((actionCount - 4) / 2)),
  );
  return {
    baseUrl: new URL(baseUrl).href.replace(/\/$/u, ""),
    allowRemote: booleanOption(parsed, "allow-remote", "LOAD_ALLOW_REMOTE", false),
    ignoreHttpsErrors: booleanOption(
      parsed,
      "ignore-https-errors",
      "LOAD_IGNORE_HTTPS_ERRORS",
      false,
    ),
    headless: !booleanOption(parsed, "headful", "LOAD_HEADFUL", false),
    smoke,
    stress,
    seed: integerOption(parsed, "seed", "LOAD_SEED", 424_242, 0, 0xffffffff),
    actionCount,
    durationMs: durationSeconds * 1_000,
    previewHz: numberOption(parsed, "preview-hz", "LOAD_PREVIEW_HZ", 12, 0, 15),
    presenceHz: numberOption(parsed, "presence-hz", "LOAD_PRESENCE_HZ", 2, 0.1, 5),
    syncIntervalMs:
      numberOption(parsed, "sync-seconds", "LOAD_SYNC_SECONDS", smoke ? 2 : 30, 0.25, 300) * 1_000,
    reconnectCount,
    connectTimeoutMs: integerOption(
      parsed,
      "connect-timeout-ms",
      "LOAD_CONNECT_TIMEOUT_MS",
      15_000,
      1_000,
      120_000,
    ),
    commandTimeoutMs: integerOption(
      parsed,
      "command-timeout-ms",
      "LOAD_COMMAND_TIMEOUT_MS",
      10_000,
      1_000,
      120_000,
    ),
    finalTimeoutMs: integerOption(
      parsed,
      "final-timeout-ms",
      "LOAD_FINAL_TIMEOUT_MS",
      30_000,
      1_000,
      300_000,
    ),
    maxConnectMs: integerOption(
      parsed,
      "max-connect-ms",
      "LOAD_MAX_CONNECT_MS",
      10_000,
      1_000,
      120_000,
    ),
    maxP95AckMs: numberOption(
      parsed,
      "max-p95-ack-ms",
      "LOAD_MAX_P95_ACK_MS",
      smoke ? 1_000 : 300,
      1,
      60_000,
    ),
    maxEstimatedRowsWritten: integerOption(
      parsed,
      "max-estimated-row-writes",
      "LOAD_MAX_ESTIMATED_ROW_WRITES",
      4_000,
      1,
      1_000_000,
    ),
    turnstileToken: option(parsed, "turnstile-token", "LOAD_TURNSTILE_TOKEN"),
    turnstileClaimTokens: stringListEnvironment("LOAD_TURNSTILE_CLAIM_TOKENS"),
    remoteClaimIntervalMs: numberOption(
      parsed,
      "remote-claim-interval-ms",
      "LOAD_REMOTE_CLAIM_INTERVAL_MS",
      12_250,
      0,
      60_000,
    ),
    evictionUrl: option(parsed, "eviction-url", "LOAD_EVICTION_URL"),
    evictionAuthorization: option(parsed, "eviction-authorization", "LOAD_EVICTION_AUTHORIZATION"),
    requireEviction: booleanOption(parsed, "require-eviction", "LOAD_REQUIRE_EVICTION", false),
  };
}

function parseArguments(arguments_: string[]): Map<string, string | true> {
  const booleanFlags = new Set([
    "smoke",
    "stress",
    "allow-remote",
    "ignore-https-errors",
    "headful",
    "require-eviction",
    "help",
  ]);
  const valueFlags = new Set([
    "base-url",
    "actions",
    "duration-seconds",
    "preview-hz",
    "presence-hz",
    "sync-seconds",
    "reconnects",
    "seed",
    "connect-timeout-ms",
    "command-timeout-ms",
    "final-timeout-ms",
    "max-connect-ms",
    "max-p95-ack-ms",
    "max-estimated-row-writes",
    "turnstile-token",
    "remote-claim-interval-ms",
    "eviction-url",
    "eviction-authorization",
  ]);
  const result = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument ${JSON.stringify(argument)}.`);
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (booleanFlags.has(name)) {
      if (equals >= 0) throw new Error(`--${name} does not take a value.`);
      result.set(name, true);
      continue;
    }
    if (!valueFlags.has(name)) throw new Error(`Unknown option --${name}.`);
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    result.set(name, value);
    if (equals < 0) index += 1;
  }
  return result;
}

function option(
  parsed: Map<string, string | true>,
  name: string,
  envName: string,
): string | undefined {
  const value = parsed.get(name) ?? process.env[envName];
  if (value === undefined || value === true || value.trim().length === 0) return undefined;
  return value.trim();
}

function booleanOption(
  parsed: Map<string, string | true>,
  name: string,
  envName: string,
  fallback: boolean,
): boolean {
  if (parsed.get(name) === true) return true;
  const value = process.env[envName]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no"].includes(value)) return false;
  throw new Error(`${envName} must be true/false or 1/0.`);
}

function stringListEnvironment(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return [];
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split(",").map((value) => value.trim());
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`${name} must be a JSON array or comma-separated list of non-empty tokens.`);
  }
  return values as string[];
}

function numberOption(
  parsed: Map<string, string | true>,
  name: string,
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = option(parsed, name, envName);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`--${name}/${envName} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function integerOption(
  parsed: Map<string, string | true>,
  name: string,
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = numberOption(parsed, name, envName, fallback, minimum, maximum);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name}/${envName} must be an integer.`);
  return value;
}

function validateTarget(options: HarnessConfig): void {
  validateLoadTarget(options.baseUrl, options.allowRemote);
  const drawers = options.stress ? CLIENT_COUNT : NORMAL_EDITOR_COUNT;
  const perDrawerCommitRate = options.actionCount / (options.durationMs / 1_000) / drawers;
  if (perDrawerCommitRate > 4.5) {
    throw new Error(
      `The configured action pace is ${perDrawerCommitRate.toFixed(2)} commits/s/drawer; keep it at or below 4.5 to stay under the 5/s server limit.`,
    );
  }
}

function deterministicUuid(namespace: number, ordinal: number): string {
  const prefix = namespace.toString(16).padStart(8, "0").slice(-8);
  const tail = ordinal.toString(16).padStart(12, "0").slice(-12);
  return `${prefix}-0000-4000-8000-${tail}`;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function paceUntil(deadline: number): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

function percentile(values: number[], quantile: number): number {
  assert.ok(values.length > 0, "A percentile requires at least one value.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function estimateRowsWritten(
  actions: number,
  participants: number,
  downgraded: boolean,
  durationMs: number,
  stress: boolean,
): number {
  // Cloudflare bills table rows and every affected index row. This is a
  // conservative upper model for the greenfield schema, not a logical-row
  // count: a normal action is 12 billed writes after the first dirty action.
  const boardInitialization = 4;
  const invitations = (stress ? 1 : 2) * 4;
  const invitationClaims = participants * 4;
  const durableActions = actions * 12;
  const membershipChange = downgraded ? 2 : 0;
  const namedSnapshot = 6;
  const timeCheckpoints = Math.floor(durationMs / 60_000);
  const actionThresholdCheckpoints = Math.floor(actions / 250);
  const automaticCheckpoints = timeCheckpoints + actionThresholdCheckpoints;
  const dirtyIntervals = Math.min(actions, automaticCheckpoints + (actions > 0 ? 1 : 0));
  const firstDirtyJobAndAlarm = dirtyIntervals * 2;
  const thresholdJobAndAlarmMoves = actionThresholdCheckpoints * 2;
  // Six includes the worst-case physical alarm rewrite when actions race the
  // R2 put and the logical snapshot job must remain scheduled.
  const automaticCheckpointMetadata = automaticCheckpoints * 6;
  return (
    boardInitialization +
    invitations +
    invitationClaims +
    durableActions +
    membershipChange +
    namedSnapshot +
    firstDirtyJobAndAlarm +
    thresholdJobAndAlarmMoves +
    automaticCheckpointMetadata
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is not a string.`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is not a safe integer.`);
  return value as number;
}

function requiredParticipant(participants: Participant[], index: number): Participant {
  const participant = participants[index];
  if (participant === undefined) throw new Error(`Participant ${index} was not provisioned.`);
  return participant;
}

function redactUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function report(value: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printUsage(): void {
  process.stdout.write(`Deterministic collaborative-canvas load harness

Usage:
  npx tsx tests/load/run.ts --smoke
  npx tsx tests/load/run.ts [options]

Core options:
  --base-url URL                 Local target (default http://localhost:8787)
  --allow-remote                 Required for any non-local target
  --smoke                        20 actions over 10 seconds
  --stress                       20 active drawers instead of 5 + 15 viewers
  --actions N                    Durable actions (default 300)
  --duration-seconds N           Wall-clock workload duration (default 600)
  --preview-hz N                 Preview rate per active drawer (default 12)
  --presence-hz N                Presence rate per participant (default 2)
  --sync-seconds N               Periodic sync interval (default 30)
  --reconnects N                 Deterministic replay interruptions (default 8)
  --seed N                       Deterministic scenario seed (default 424242)

Conformance controls:
  --eviction-url URL             Test-only hook that forces the board room eviction
  --eviction-authorization TEXT  Optional Authorization value for the hook
  --require-eviction             Fail before the run when no hook is configured
  --turnstile-token TOKEN        Fresh board_create token when Turnstile is enabled
  --remote-claim-interval-ms N   Staging claim pacing after the initial burst (default 12250)
  --max-p95-ack-ms N             End-to-end WebSocket ACK p95 limit (default 300)
  --max-estimated-row-writes N   Indexed storage-model ceiling (default 4000)

Every option also has the LOAD_* environment equivalent documented in tests/load/README.md.
`);
}
