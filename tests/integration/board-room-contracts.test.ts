/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../apps/edge/src/types";

const boardId = "b_AAAAAAAAAAAAAAAAAAAAAA";
const ownerId = "a_AAAAAAAAAAAAAAAAAAAAAA";
const editorId = "a_BBBBBBBBBBBBBBBBBBBBBA";
const r2CleanupKeys = new Set<string>();

function internalRequest(actorId: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-whiteboard-internal-actor", actorId);
  headers.set("x-whiteboard-internal-session-expiry", String(Date.now() + 60_000));
  headers.set("x-whiteboard-internal-request-id", crypto.randomUUID());
  return new Request(`https://board.test${path}`, { ...init, headers });
}

async function initializeBoard(
  stub: DurableObjectStub,
  accessMode: "private" | "link_view" = "link_view",
): Promise<void> {
  const response = await stub.fetch(
    internalRequest(ownerId, "/__internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicId: boardId,
        title: "Integration board",
        accessMode,
        ownerActorId: ownerId,
        ownerDisplayName: "Owner",
        ownerRecoveryHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    }),
  );
  expect(response.status).toBe(201);
  await response.arrayBuffer();
}

async function addEditor(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    state.storage.transactionSync(() => {
      state.storage.sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'editor', 'Editor', ?, ?)`,
        editorId,
        now,
        now,
      );
      state.storage.sql.exec(
        "UPDATE board SET acl_version = 2, updated_at_ms = ? WHERE singleton = 1",
        now,
      );
    });
  });
}

interface TestSocket {
  socket: WebSocket;
  received: Record<string, unknown>[];
  closed: Promise<CloseEvent>;
  next(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

async function connect(stub: DurableObjectStub, actorId: string): Promise<TestSocket> {
  const response = await stub.fetch(
    internalRequest(
      actorId,
      `/api/v1/boards/${boardId}/socket?since=0&client=${crypto.randomUUID()}`,
      { method: "GET", headers: { Upgrade: "websocket" } },
    ),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Upgrade did not return a WebSocket.");

  const received: Record<string, unknown>[] = [];
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    received.push(frame);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex < 0) queued.push(frame);
    else waiters.splice(waiterIndex, 1)[0]?.resolve(frame);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  socket.accept();

  const next = async (
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex >= 0) return queued.splice(queuedIndex, 1)[0] ?? {};
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a WebSocket frame."));
        }
      }, 3_000);
    });
  };

  const connected = { socket, received, closed, next };
  await connected.next((frame) => frame.t === "server.ready");
  return connected;
}

function createCommit(commandId: string, actionId: string, itemId: string, baseSeq = 0) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "rectangle",
        style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 1, y: 2, width: 3, height: 4 },
      },
    },
  };
}

function undoCommit(commandId: string, actionId: string, targetActionId: string) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 1,
    op: {
      kind: "history.undo",
      expectedHistoryVersion: 1,
      targetActionId,
    },
  };
}

function clearCommit(commandId: string, actionId: string, expectedBoardSeq: number) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: expectedBoardSeq,
    op: { kind: "board.clear", expectedBoardSeq },
  };
}

async function seedR2Conflict(key: string): Promise<void> {
  r2CleanupKeys.add(key);
  await (env as unknown as Env).BOARD_SNAPSHOTS.put(key, "conflicting snapshot", {
    customMetadata: { sha256: "intentionally-wrong-digest" },
  });
}

describe("BoardRoom cross-boundary contracts", () => {
  afterEach(async () => {
    const bucket = (env as unknown as Env).BOARD_SNAPSHOTS;
    await Promise.all([...r2CleanupKeys].map((key) => bucket.delete(key)));
    r2CleanupKeys.clear();
    await reset();
  });

  it("serializes same-actor two-tab undo races with one STALE_HISTORY loser", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const first = await connect(stub, ownerId);
    const second = await connect(stub, ownerId);
    const originalActionId = "018f0000-0000-7000-8000-000000001001";
    const createCommandId = "018f0000-0000-7000-8000-000000001000";
    first.socket.send(
      JSON.stringify(
        createCommit(createCommandId, originalActionId, "018f0000-0000-7000-8000-000000001002"),
      ),
    );
    await Promise.all([
      first.next((frame) => frame.t === "server.action" && frame.commandId === createCommandId),
      second.next((frame) => frame.t === "server.action" && frame.commandId === createCommandId),
    ]);

    const firstCommandId = "018f0000-0000-7000-8000-000000001010";
    const secondCommandId = "018f0000-0000-7000-8000-000000001020";
    first.socket.send(
      JSON.stringify(
        undoCommit(firstCommandId, "018f0000-0000-7000-8000-000000001011", originalActionId),
      ),
    );
    second.socket.send(
      JSON.stringify(
        undoCommit(secondCommandId, "018f0000-0000-7000-8000-000000001021", originalActionId),
      ),
    );

    const outcomes = await Promise.all([
      first.next(
        (frame) =>
          frame.commandId === firstCommandId &&
          (frame.t === "server.action" || frame.t === "server.rejected"),
      ),
      second.next(
        (frame) =>
          frame.commandId === secondCommandId &&
          (frame.t === "server.action" || frame.t === "server.rejected"),
      ),
    ]);
    const accepted = outcomes.filter((frame) => frame.t === "server.action");
    const rejected = outcomes.filter((frame) => frame.t === "server.rejected");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ seq: 2, op: { kind: "history.undo" } });
    expect(rejected).toEqual([
      expect.objectContaining({
        code: "STALE_HISTORY",
        latestSeq: 2,
        historyVersion: 2,
        canUndo: false,
        canRedo: true,
      }),
    ]);

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board WHERE singleton = 1")
        .one().latest_seq,
      actionCount: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      history: durableState.storage.sql
        .exec<{ state: string; last_transition_seq: number }>(
          "SELECT state, last_transition_seq FROM history_entries WHERE action_id = ?",
          originalActionId,
        )
        .one(),
    }));
    expect(state).toEqual({
      latestSeq: 2,
      actionCount: 2,
      history: { state: "undone", last_transition_seq: 2 },
    });
    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("has committed the action and item by the first peer-visible server.action", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const sender = await connect(stub, ownerId);
    const observer = await connect(stub, ownerId);
    const commandId = "018f0000-0000-7000-8000-000000002000";
    const actionId = "018f0000-0000-7000-8000-000000002001";
    const itemId = "018f0000-0000-7000-8000-000000002002";

    const stateAtObservation = new Promise<{
      latestSeq: number;
      action: { seq: number; action_id: string; command_id: string };
      item: { version_seq: number; deleted: number };
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out observing the authoritative action.")),
        3_000,
      );
      observer.socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.t !== "server.action" || frame.commandId !== commandId) return;
        void runInDurableObject(stub, (_instance, durableState) => ({
          latestSeq: durableState.storage.sql
            .exec<{ latest_seq: number }>("SELECT latest_seq FROM board WHERE singleton = 1")
            .one().latest_seq,
          action: durableState.storage.sql
            .exec<{ seq: number; action_id: string; command_id: string }>(
              "SELECT seq, action_id, command_id FROM actions WHERE command_id = ?",
              commandId,
            )
            .one(),
          item: durableState.storage.sql
            .exec<{ version_seq: number; deleted: number }>(
              "SELECT version_seq, deleted FROM items WHERE item_id = ?",
              itemId,
            )
            .one(),
        })).then((state) => {
          clearTimeout(timeout);
          resolve(state);
        }, reject);
      });
    });

    sender.socket.send(JSON.stringify(createCommit(commandId, actionId, itemId)));
    expect(await stateAtObservation).toEqual({
      latestSeq: 1,
      action: { seq: 1, action_id: actionId, command_id: commandId },
      item: { version_seq: 1, deleted: 0 },
    });
    sender.socket.close(1000, "done");
    observer.socket.close(1000, "done");
  });

  it("closes an already-connected private-board member with 4010 on revocation", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub, "private");
    await addEditor(stub);
    const editor = await connect(stub, editorId);

    const response = await stub.fetch(
      internalRequest(ownerId, `/api/v1/boards/${boardId}/members/${editorId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedAclVersion: 2 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actorId: editorId, revoked: true, aclVersion: 3 });
    const close = await editor.closed;
    expect(close.code).toBe(4010);
    expect(close.reason).toBe("Membership revoked");

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      aclVersion: durableState.storage.sql
        .exec<{ acl_version: number }>("SELECT acl_version FROM board WHERE singleton = 1")
        .one().acl_version,
      revoked: durableState.storage.sql
        .exec<{ revoked_at_ms: number | null }>(
          "SELECT revoked_at_ms FROM members WHERE actor_id = ?",
          editorId,
        )
        .one().revoked_at_ms,
      sockets: durableState.getWebSockets(`actor:${editorId}`).length,
    }));
    expect(state.aclVersion).toBe(3);
    expect(state.revoked).not.toBeNull();
    expect(state.sockets).toBe(0);
  });

  it("does not clear or advance SQLite when immutable pre-clear storage conflicts", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, ownerId);
    const conflictKey = `boards/${boardId}/snapshots/0.json`;
    await seedR2Conflict(conflictKey);
    const commandId = "018f0000-0000-7000-8000-000000004000";

    owner.socket.send(
      JSON.stringify(clearCommit(commandId, "018f0000-0000-7000-8000-000000004001", 0)),
    );
    expect(
      await owner.next((frame) => frame.t === "server.rejected" && frame.commandId === commandId),
    ).toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      latestSeq: 0,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board WHERE singleton = 1")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      snapshots: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
        .one().count,
      jobs: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_jobs")
        .one().count,
    }));
    expect(state).toEqual({ latestSeq: 0, actions: 0, snapshots: 0, jobs: 0 });
    owner.socket.close(1000, "done");
  });

  it("backs off a conflicting snapshot alarm, then retries exactly once and becomes idempotent", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, ownerId);
    const commandId = "018f0000-0000-7000-8000-000000005000";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          commandId,
          "018f0000-0000-7000-8000-000000005001",
          "018f0000-0000-7000-8000-000000005002",
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.commandId === commandId);

    const snapshotKey = `boards/${boardId}/snapshots/1.json`;
    await seedR2Conflict(snapshotKey);
    await runInDurableObject(stub, async (instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE scheduled_jobs SET due_at_ms = ? WHERE job_name = 'snapshot'",
        Date.now() - 1,
      );
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const failedAttempt = await runInDurableObject(stub, (_instance, durableState) => ({
      board: durableState.storage.sql
        .exec<{ latest_seq: number; latest_snapshot_seq: number }>(
          "SELECT latest_seq, latest_snapshot_seq FROM board WHERE singleton = 1",
        )
        .one(),
      job: durableState.storage.sql
        .exec<{ attempt: number; due_at_ms: number }>(
          "SELECT attempt, due_at_ms FROM scheduled_jobs WHERE job_name = 'snapshot'",
        )
        .one(),
      snapshots: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
        .one().count,
    }));
    expect(failedAttempt.board).toEqual({ latest_seq: 1, latest_snapshot_seq: 0 });
    expect(failedAttempt.job.attempt).toBe(1);
    expect(failedAttempt.job.due_at_ms).toBeGreaterThan(Date.now());
    expect(failedAttempt.snapshots).toBe(0);

    await typedEnv.BOARD_SNAPSHOTS.delete(snapshotKey);
    await runInDurableObject(stub, async (instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE scheduled_jobs SET due_at_ms = ? WHERE job_name = 'snapshot'",
        Date.now() - 1,
      );
      const room = instance as unknown as { alarm(): Promise<void> };
      await room.alarm();
      await room.alarm();
    });

    const recovered = await runInDurableObject(stub, (_instance, durableState) => ({
      board: durableState.storage.sql
        .exec<{ latest_seq: number; latest_snapshot_seq: number }>(
          "SELECT latest_seq, latest_snapshot_seq FROM board WHERE singleton = 1",
        )
        .one(),
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      jobs: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_jobs")
        .one().count,
      snapshot: durableState.storage.sql
        .exec<{ seq: number; sha256: string }>("SELECT seq, sha256 FROM snapshots WHERE seq = 1")
        .one(),
    }));
    expect(recovered).toMatchObject({
      board: { latest_seq: 1, latest_snapshot_seq: 1 },
      actions: 1,
      jobs: 0,
      snapshot: { seq: 1 },
    });
    const object = await typedEnv.BOARD_SNAPSHOTS.head(snapshotKey);
    expect(object?.customMetadata?.sha256).toBe(recovered.snapshot.sha256);
    owner.socket.close(1000, "done");
  });
});
