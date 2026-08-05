import type { CommitFrame } from "../types";

const DATABASE_NAME = "cf-collab-canvas";
const DATABASE_VERSION = 1;
const STORE_NAME = "outbox";
const MAX_COMMANDS = 500;
const MAX_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

export type OutboxEntry = {
  commandId: string;
  boardId: string;
  createdAt: number;
  byteLength: number;
  command: CommitFrame;
};

export type OutboxContents = {
  active: OutboxEntry[];
  expired: OutboxEntry[];
  byteLength: number;
};

export class OutboxLimitError extends Error {
  constructor(readonly reason: "commands" | "bytes") {
    super(
      reason === "commands"
        ? "The recovery queue contains 500 commands."
        : "The recovery queue reached 10 MiB.",
    );
    this.name = "OutboxLimitError";
  }
}

export class DurableOutbox {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async put(boardId: string, command: CommitFrame): Promise<OutboxEntry> {
    const commandBytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
    const existing = await this.listAll(boardId);
    const duplicate = existing.find((entry) => entry.commandId === command.commandId);
    if (duplicate) return duplicate;
    if (existing.length >= MAX_COMMANDS) throw new OutboxLimitError("commands");
    const totalBytes = existing.reduce((sum, entry) => sum + entry.byteLength, 0);
    if (totalBytes + commandBytes > MAX_BYTES) throw new OutboxLimitError("bytes");

    const entry: OutboxEntry = {
      commandId: command.commandId,
      boardId,
      createdAt: Date.now(),
      byteLength: commandBytes,
      command: structuredClone(command),
    };
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const committed = transactionDone(transaction);
    await requestDone(transaction.objectStore(STORE_NAME).put(entry));
    await committed;
    return entry;
  }

  async remove(commandId: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const committed = transactionDone(transaction);
    await requestDone(transaction.objectStore(STORE_NAME).delete(commandId));
    await committed;
  }

  async removeMany(commandIds: readonly string[]): Promise<void> {
    if (commandIds.length === 0) return;
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const commandId of commandIds) store.delete(commandId);
    await transactionDone(transaction);
  }

  async contents(boardId: string, now = Date.now()): Promise<OutboxContents> {
    const entries = await this.listAll(boardId);
    const active: OutboxEntry[] = [];
    const expired: OutboxEntry[] = [];
    for (const entry of entries) {
      if (now - entry.createdAt >= RETENTION_MS) expired.push(entry);
      else active.push(entry);
    }
    return {
      active,
      expired,
      byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
    };
  }

  async removeExpired(boardId: string, now = Date.now()): Promise<OutboxEntry[]> {
    const { expired } = await this.contents(boardId, now);
    if (expired.length === 0) return [];
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    for (const entry of expired) transaction.objectStore(STORE_NAME).delete(entry.commandId);
    await transactionDone(transaction);
    return expired;
  }

  private async listAll(boardId: string): Promise<OutboxEntry[]> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("boardId");
    const entries = (await requestDone(index.getAll(IDBKeyRange.only(boardId)))) as OutboxEntry[];
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (database.objectStoreNames.contains(STORE_NAME)) return;
        const store = database.createObjectStore(STORE_NAME, { keyPath: "commandId" });
        store.createIndex("boardId", "boardId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Could not open the recovery queue."));
      request.onblocked = () => reject(new Error("The recovery queue is blocked by another tab."));
    });
    return this.databasePromise;
  }
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}
