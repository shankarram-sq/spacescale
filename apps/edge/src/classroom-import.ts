import type { BoardItem as ProtocolBoardItem } from "@collab/protocol";
import { base64UrlToBytes } from "./crypto";
import { BoardDomainError } from "./domain";
import { assertSafeJson } from "./http/body";
import { HttpError } from "./http/errors";
import { parseStoredSnapshot } from "./storage";
import type { BoardItem } from "./types";
import { ACTOR_ID_PATTERN, optionalTitle } from "./validation";

// Fragments do not travel over HTTP, so the browser copies this payload into
// the signed-launch exchange. Keep that exchange comfortably below practical
// browser/Worker request limits even though recovery snapshots allow 20 MiB.
export const MAX_CLASSROOM_IMPORT_BYTES = 1 * 1_024 * 1_024;
export const MAX_CLASSROOM_IMPORT_ITEMS = 1_000;
export const MAX_CLASSROOM_IMPORT_ENCODED_CHARS = Math.ceil((MAX_CLASSROOM_IMPORT_BYTES * 4) / 3);

export type ClassroomBoardImport = {
  title: string;
  items: BoardItem[];
};

export function decodeClassroomBoardImport(encodedSnapshot: unknown): ClassroomBoardImport {
  if (typeof encodedSnapshot !== "string" || encodedSnapshot.length === 0) {
    throw invalidImport("The classroom import must be a base64url-encoded canonical JSON export.");
  }
  if (encodedSnapshot.length > MAX_CLASSROOM_IMPORT_ENCODED_CHARS) {
    throw importTooLarge();
  }
  const bytes = base64UrlToBytes(encodedSnapshot);
  if (bytes === null) {
    throw invalidImport("The classroom import is not valid base64url data.");
  }
  if (bytes.byteLength > MAX_CLASSROOM_IMPORT_BYTES) throw importTooLarge();

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw invalidImport("The classroom import is not valid UTF-8 JSON.");
  }
  assertSafeJson(raw, 0);
  if (
    !isExactRecord(raw, ["format", "version", "boardId", "seq", "createdAt", "settings", "items"])
  ) {
    throw invalidImport("The classroom import is not a canonical whiteboard export.");
  }
  if (
    typeof raw.boardId !== "string" ||
    !/^b_[A-Za-z0-9_-]{22}$/u.test(raw.boardId) ||
    !Number.isSafeInteger(raw.seq) ||
    (raw.seq as number) < 0 ||
    !Number.isSafeInteger(raw.createdAt) ||
    (raw.createdAt as number) < 0 ||
    !Array.isArray(raw.items)
  ) {
    throw invalidImport("The classroom import metadata is invalid.");
  }
  if (raw.items.length > MAX_CLASSROOM_IMPORT_ITEMS) {
    throw new BoardDomainError(
      "BOARD_LIMIT_REACHED",
      `A classroom URL import may contain at most ${MAX_CLASSROOM_IMPORT_ITEMS} objects.`,
    );
  }
  if (!isExactRecord(raw.settings, ["title"])) {
    throw invalidImport("The classroom import settings are invalid.");
  }

  let snapshot: ReturnType<typeof parseStoredSnapshot>;
  try {
    snapshot = parseStoredSnapshot(raw, raw.boardId);
  } catch (error) {
    if (error instanceof BoardDomainError) {
      throw invalidImport(error.message);
    }
    throw error;
  }
  const title = optionalTitle(snapshot.settings.title);
  const items = snapshot.items.map((item, index) => {
    const protocolItem = item as unknown as ProtocolBoardItem;
    if (!ACTOR_ID_PATTERN.test(item.createdBy)) {
      throw invalidImport("Every imported object must have an opaque classroom creator ID.");
    }
    if (protocolItem.kind === "image") {
      throw invalidImport(
        "Image objects cannot be imported from canonical JSON because the export does not contain their private asset bytes.",
      );
    }
    if (item.version < 0) {
      throw invalidImport("An imported object version is invalid.");
    }
    // This is one synthetic initial-state revision, not copied action history.
    // Preserve paint order and stable object/creator IDs while making every
    // imported object immediately editable by normal versioned operations.
    return { ...structuredClone(item), z: index + 1, version: 1 } as BoardItem;
  });

  return { title, items };
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidImport(message: string): HttpError {
  return new HttpError(400, "BAD_REQUEST", message);
}

function importTooLarge(): HttpError {
  return new HttpError(
    413,
    "PAYLOAD_TOO_LARGE",
    `The classroom import must be at most ${MAX_CLASSROOM_IMPORT_BYTES} decoded bytes.`,
  );
}
