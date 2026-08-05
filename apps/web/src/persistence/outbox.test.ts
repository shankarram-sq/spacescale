import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommitFrame } from "../types";
import { PROTOCOL_VERSION } from "../types";
import { DurableOutbox, type OutboxEntry } from "./outbox";

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  private pending = 0;

  constructor(private readonly records: Map<string, OutboxEntry>) {
    queueMicrotask(() => this.maybeComplete());
  }

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(this, this.records) as unknown as IDBObjectStore;
  }

  request<T>(result: T, operation?: () => void): IDBRequest<T> {
    this.pending += 1;
    const request = {
      result,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => {
      operation?.();
      request.onsuccess?.();
      this.pending -= 1;
      queueMicrotask(() => this.maybeComplete());
    });
    return request as unknown as IDBRequest<T>;
  }

  private maybeComplete(): void {
    if (this.pending === 0) this.oncomplete?.();
  }
}

class FakeObjectStore {
  readonly indexNames = { contains: () => true };

  constructor(
    private readonly transaction: FakeTransaction,
    private readonly records: Map<string, OutboxEntry>,
  ) {}

  put(value: OutboxEntry): IDBRequest<IDBValidKey> {
    return this.transaction.request<IDBValidKey>(
      [value.boardId, value.actorId, value.commandId],
      () => this.records.set(entryKey(value.boardId, value.actorId, value.commandId), value),
    );
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.transaction.request(undefined, () => {
      this.records.delete(entryKeyFromValue(key));
    });
  }

  index(): IDBIndex {
    const index = {
      getAll: (query: IDBValidKey | IDBKeyRange) => {
        const [boardId, actorId] = query as unknown as [string, string];
        const values = [...this.records.values()].filter(
          (entry) => entry.boardId === boardId && entry.actorId === actorId,
        );
        return this.transaction.request(values);
      },
    };
    return index as unknown as IDBIndex;
  }
}

class FakeDatabase {
  onversionchange: (() => void) | null = null;
  readonly objectStoreNames = { contains: () => true };
  readonly records = new Map<string, OutboxEntry>();

  transaction(): IDBTransaction {
    return new FakeTransaction(this.records) as unknown as IDBTransaction;
  }

  close(): void {}
}

function installIndexedDb(): void {
  const database = new FakeDatabase();
  vi.stubGlobal("IDBKeyRange", { only: (value: IDBValidKey) => value });
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = {
        result: database,
        transaction: null,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request as unknown as IDBOpenDBRequest;
    },
  });
}

function command(commandId: string): CommitFrame {
  return {
    v: PROTOCOL_VERSION,
    t: "client.commit",
    commandId,
    actionId: `action-${commandId}`,
    baseSeq: 0,
    op: { kind: "board.clear", expectedBoardSeq: 0 },
  };
}

function entryKey(boardId: string, actorId: string, commandId: string): string {
  return JSON.stringify([boardId, actorId, commandId]);
}

function entryKeyFromValue(value: IDBValidKey): string {
  return JSON.stringify(value);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable outbox identity scoping", () => {
  it("isolates identical command IDs by board and actor, including removal", async () => {
    installIndexedDb();
    const outbox = new DurableOutbox();
    const boardId = "b_1234567890123456789012";
    const firstActor = "a_1111111111111111111111";
    const secondActor = "a_2222222222222222222222";

    await outbox.put(boardId, firstActor, command("same-command"));
    await outbox.put(boardId, secondActor, command("same-command"));

    expect((await outbox.contents(boardId, firstActor)).active).toHaveLength(1);
    expect((await outbox.contents(boardId, secondActor)).active).toHaveLength(1);

    await outbox.remove(boardId, firstActor, "same-command");

    expect((await outbox.contents(boardId, firstActor)).active).toHaveLength(0);
    expect((await outbox.contents(boardId, secondActor)).active).toHaveLength(1);
  });
});
