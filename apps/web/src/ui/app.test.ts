import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../transport/api";
import type { BoardItem, BoardSnapshot, DurableOperation } from "../types";
import {
  actorFromAccessChanged,
  attributedDataDownloadAllowed,
  attributedDataFilename,
  boardIdFromPath,
  buildCreatorNameMap,
  buildElementColourOperations,
  buildTextStyleOperations,
  clampImageAlt,
  clampStickyText,
  imageUploadIssue,
  localSvg,
  MAX_IMAGE_UPLOAD_BYTES,
  managedInvitationStorageKey,
  operationAllowedForActor,
  organisationTemplateManagementForRole,
  STAMP_CHOICES,
  STICKY_COLORS,
  savedAuthoritativeItems,
  serializeAttributedData,
  tableCellDraftFromOperation,
  withAdaptiveTurnstile,
  zoneTitleDraftFromOperation,
} from "./app";

const boardId = "b_1234567890123456789012";

describe("SpaceScale browser storage", () => {
  it("uses the SpaceScale namespace for managed invitation metadata", () => {
    expect(managedInvitationStorageKey(boardId)).toBe(`spacescale:managed-invitations:${boardId}`);
  });
});

describe("adaptive Turnstile retry", () => {
  it("tries normal traffic without a token, then invisibly verifies and retries on demand", async () => {
    const container = {
      className: "",
      dataset: {} as Record<string, string>,
      setAttribute: vi.fn(),
      remove: vi.fn(),
    };
    const root = { append: vi.fn() };
    const removeWidget = vi.fn();
    const renderWidget = vi.fn(
      (
        _container: unknown,
        options: {
          callback(token: string): void;
        },
      ) => {
        options.callback("verified-token");
        return "widget-id";
      },
    );
    vi.stubGlobal("document", {
      createElement: () => container,
      querySelector: () => null,
    });
    vi.stubGlobal("window", {
      turnstile: {
        ready: (callback: () => void) => callback(),
        render: renderWidget,
        remove: removeWidget,
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    const turnstile = { enabled: true, required: false, siteKey: "public-site-key" };
    const tokens: Array<string | undefined> = [];
    try {
      const result = await withAdaptiveTurnstile(
        root as unknown as HTMLElement,
        turnstile,
        "board_create",
        async (token) => {
          tokens.push(token);
          if (tokens.length === 1) {
            throw new ApiError("TURNSTILE_REQUIRED", "Browser verification is required.", 428);
          }
          return "created";
        },
      );

      expect(result).toBe("created");
      expect(tokens).toEqual([undefined, "verified-token"]);
      expect(turnstile.required).toBe(true);
      expect(renderWidget).toHaveBeenCalledOnce();
      expect(removeWidget).toHaveBeenCalledWith("widget-id");
      expect(container.remove).toHaveBeenCalledOnce();
      expect(container.setAttribute).toHaveBeenCalledWith(
        "aria-label",
        "Checking browser security",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("creator display names", () => {
  it("combines bootstrap creators with the current participant and trims names", () => {
    const creators = [
      { id: "student-a", displayName: " Asha Patel " },
      { id: "coach", displayName: "Outdated coach name" },
      { id: "ignored", displayName: "   " },
    ];
    const self = { id: "coach", displayName: "Coach Mira" };

    expect([...buildCreatorNameMap(creators, self)]).toEqual([
      ["student-a", "Asha Patel"],
      ["coach", "Coach Mira"],
    ]);
  });

  it("accepts only a validated affected actor from access-change frames", () => {
    const actorId = `a_${"A".repeat(22)}`;
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: actorId,
        affectedActor: { id: actorId, displayName: "Asha Patel" },
      }),
    ).toEqual({ id: actorId, displayName: "Asha Patel" });
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: "asha@example.com",
        affectedActor: { id: "asha@example.com", displayName: "Asha Patel" },
      }),
    ).toBeNull();
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: actorId,
        affectedActor: { id: actorId, displayName: "Asha\nPatel" },
      }),
    ).toBeNull();
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: `a_${"B".repeat(22)}`,
        affectedActor: { id: actorId, displayName: "Asha Patel" },
      }),
    ).toBeNull();
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActor: { id: actorId, displayName: "Asha Patel" },
      }),
    ).toBeNull();
  });
});

describe("live Organisation-template management", () => {
  it("enables owners and disables editors or viewers after an access change", () => {
    expect(organisationTemplateManagementForRole("org-spacescale", "owner")).toBe(true);
    expect(organisationTemplateManagementForRole("org-spacescale", "editor")).toBe(false);
    expect(organisationTemplateManagementForRole("org-spacescale", "viewer")).toBe(false);
  });

  it("leaves non-Organisation Spaces outside live management synchronization", () => {
    expect(organisationTemplateManagementForRole(null, "owner")).toBeNull();
  });
});

describe("student item ownership preflight", () => {
  const studentId = "student-a";
  const otherStudentId = "student-b";
  const ownItem: BoardItem = {
    id: "sticky-own",
    kind: "sticky",
    z: 1,
    version: 2,
    createdBy: studentId,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#292524",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "Mine" },
  };
  const foreignItem: BoardItem = {
    ...ownItem,
    id: "sticky-foreign",
    createdBy: otherStudentId,
    geometry: { ...ownItem.geometry, x: 220, text: "Theirs" },
  };
  const items = new Map([
    [ownItem.id, ownItem],
    [foreignItem.id, foreignItem],
  ]);

  it("allows owners to change any item and editors to change only their own", () => {
    const foreignUpdate: DurableOperation = {
      kind: "item.update",
      itemId: foreignItem.id,
      expectedVersion: foreignItem.version,
      patch: { transform: [1, 0, 0, 1, 40, 20] },
    };
    const ownUpdate: DurableOperation = {
      ...foreignUpdate,
      itemId: ownItem.id,
    };

    expect(operationAllowedForActor(foreignUpdate, "owner", "coach", items)).toBe(true);
    expect(operationAllowedForActor(ownUpdate, "editor", studentId, items)).toBe(true);
    expect(operationAllowedForActor(foreignUpdate, "editor", studentId, items)).toBe(false);
    expect(
      operationAllowedForActor(
        {
          kind: "item.delete",
          itemId: foreignItem.id,
          expectedVersion: foreignItem.version,
        },
        "editor",
        studentId,
        items,
      ),
    ).toBe(false);
  });

  it("allows a foreign copy but rejects a batch containing any foreign mutation", () => {
    const copy: DurableOperation = {
      kind: "item.copy",
      sourceItemId: foreignItem.id,
      expectedVersion: foreignItem.version,
      newItemId: "sticky-copy",
      translate: { x: 20, y: 20 },
    };
    expect(operationAllowedForActor(copy, "editor", studentId, items)).toBe(true);
    expect(
      operationAllowedForActor(
        {
          kind: "items.batch",
          operations: [
            {
              kind: "item.update",
              itemId: ownItem.id,
              expectedVersion: ownItem.version,
              patch: { geometry: { ...ownItem.geometry, text: "Changed" } },
            },
            {
              kind: "item.delete",
              itemId: foreignItem.id,
              expectedVersion: foreignItem.version,
            },
          ],
        },
        "editor",
        studentId,
        items,
      ),
    ).toBe(false);
  });

  it("keeps editor history available while viewers cannot commit", () => {
    expect(
      operationAllowedForActor(
        { kind: "history.undo", expectedHistoryVersion: 3 },
        "editor",
        studentId,
        items,
      ),
    ).toBe(true);
    expect(
      operationAllowedForActor(
        {
          kind: "item.create",
          item: {
            id: "new-sticky",
            kind: "sticky",
            transform: [1, 0, 0, 1, 0, 0],
            style: ownItem.style,
            geometry: ownItem.geometry,
          },
        },
        "viewer",
        "observer",
        items,
      ),
    ).toBe(false);
  });
});

describe("board path routing", () => {
  it("accepts normal and embedded Space paths", () => {
    expect(boardIdFromPath(`/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/b/${boardId}/`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}/`)).toBe(boardId);
  });

  it("rejects launch and malformed paths", () => {
    expect(boardIdFromPath("/embed")).toBeNull();
    expect(boardIdFromPath(`/other/b/${boardId}`)).toBeNull();
    expect(boardIdFromPath("/embed/b/not-a-board")).toBeNull();
  });
});

describe("attributed data download", () => {
  it("is visible to every owner and hidden from editors and viewers", () => {
    expect(attributedDataDownloadAllowed("owner")).toBe(true);
    expect(attributedDataDownloadAllowed("editor")).toBe(false);
    expect(attributedDataDownloadAllowed("viewer")).toBe(false);
  });

  it("uses an attributed-data filename and preserves attributed text as formatted JSON", () => {
    const data = {
      format: "cf-whiteboard-attributed-json" as const,
      version: 1 as const,
      board: {
        id: boardId,
        title: "Peer Feedback: 7/B",
        seq: 12,
        stateCreatedAt: 1_900_000_000_000,
      },
      participants: [
        {
          id: "a_1234567890123456789012",
          displayName: "Asha Patel",
          participantHash: "a_1234567890123456789012",
          role: "editor" as const,
          status: "active" as const,
        },
        {
          id: "a_2345678901234567890123",
          displayName: "Ben Shah",
          participantHash: "a_2345678901234567890123",
          role: null,
          status: "referenced" as const,
        },
      ],
      objects: [
        {
          item: {
            id: "018f47a1-7a2b-7c3d-8e4f-123456789abd",
            kind: "sticky" as const,
            z: 1,
            version: 1,
            createdBy: "a_2345678901234567890123",
            transform: [1, 0, 0, 1, 0, 0] as const,
            style: {
              kind: "sticky" as const,
              fill: "#fde68a",
              textColor: "#292524",
              fontSize: 20,
              opacity: 1,
            },
            geometry: {
              x: 10,
              y: 20,
              width: 180,
              height: 140,
              text: "Could you explain the second step?",
            },
          },
          attribution: {
            createdBy: {
              id: "a_2345678901234567890123",
              displayName: "Coach Mira",
              participantHash: "a_2345678901234567890123",
            },
            lastModifiedBy: {
              id: "a_1234567890123456789012",
              displayName: "Asha Patel",
              participantHash: "a_1234567890123456789012",
            },
            updatedSeq: 12,
            updatedAt: 1_900_000_001_000,
          },
          content: [
            {
              kind: "sticky_text" as const,
              text: "Could you explain the second step?",
              responsibleUser: {
                id: "a_1234567890123456789012",
                displayName: "Asha Patel",
                participantHash: "a_1234567890123456789012",
              },
              lastChangedBy: {
                id: "a_1234567890123456789012",
                displayName: "Asha Patel",
                participantHash: "a_1234567890123456789012",
              },
              updatedSeq: 12,
              updatedAt: 1_900_000_001_000,
            },
          ],
        },
        {
          item: {
            id: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
            kind: "table" as const,
            z: 2,
            version: 1,
            createdBy: "a_2345678901234567890123",
            transform: [1, 0, 0, 1, 0, 0] as const,
            style: {
              kind: "table" as const,
              borderColor: "#a8a59d",
              fill: "#fffefa",
              headerFill: "#e8edff",
              textColor: "#20201e",
              fontSize: 16,
              opacity: 1,
            },
            geometry: {
              x: 220,
              y: 20,
              columnWidths: [120],
              rowHeights: [48],
              cells: [[""]],
            },
          },
          attribution: {
            createdBy: {
              id: "a_2345678901234567890123",
              displayName: "Coach Mira",
              participantHash: "a_2345678901234567890123",
            },
            lastModifiedBy: {
              id: "a_2345678901234567890123",
              displayName: "Coach Mira",
              participantHash: "a_2345678901234567890123",
            },
            updatedSeq: 11,
            updatedAt: 1_900_000_000_500,
          },
          content: [
            {
              kind: "table_cell" as const,
              row: 0,
              column: 0,
              text: "",
              responsibleUser: null,
              lastChangedBy: null,
              updatedSeq: null,
              updatedAt: null,
            },
          ],
        },
      ],
    };

    expect(attributedDataFilename(data.board.title)).toBe("peer-feedback-7-b-attributed-data.json");
    const serialized = serializeAttributedData(data);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(data);
    expect(serialized).toContain('"text": "Could you explain the second step?"');
    expect(serialized).toContain('"responsibleUser": null');
    expect(serialized).toContain('"displayName": "Asha Patel"');
    expect(serialized).toContain('"id": "a_1234567890123456789012"');
    expect(serialized).not.toContain("@example.com");
  });
});

describe("sticky note UI configuration", () => {
  it("offers the six classroom palette colours", () => {
    expect(STICKY_COLORS.map(({ name }) => name)).toEqual([
      "Yellow",
      "Coral",
      "Lavender",
      "Mint",
      "Sky",
      "Slate",
    ]);
    expect(STICKY_COLORS.every(({ value }) => /^#[0-9a-f]{6}$/.test(value))).toBe(true);
  });

  it("builds all-or-nothing versioned recolor updates without changing other style fields", () => {
    const first: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-a",
      kind: "sticky",
      z: 1,
      version: 4,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#fde68a",
        textColor: "#292524",
        fontSize: 20,
        opacity: 0.9,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "First" },
    };
    const second: Extract<BoardItem, { kind: "sticky" }> = {
      ...first,
      id: "sticky-b",
      z: 2,
      version: 6,
      style: { ...first.style, fill: "#bfdbfe" },
      geometry: { ...first.geometry, x: 220, text: "Second" },
    };

    expect(buildElementColourOperations([first, second], "#fecdd3")).toEqual([
      {
        kind: "item.update",
        itemId: "sticky-a",
        expectedVersion: 4,
        patch: { style: { ...first.style, fill: "#fecdd3" } },
      },
      {
        kind: "item.update",
        itemId: "sticky-b",
        expectedVersion: 6,
        patch: { style: { ...second.style, fill: "#fecdd3" } },
      },
    ]);
    expect(buildElementColourOperations([first, { ...second, version: 0 }], "#fecdd3")).toEqual([]);

    const authoritative = new Map<string, BoardItem>([
      [first.id, first],
      [second.id, second],
    ]);
    expect(savedAuthoritativeItems([first.id, second.id], authoritative, authoritative)).toEqual([
      first,
      second,
    ]);
    const renderedWithPending = new Map<string, BoardItem>([
      [first.id, first],
      [second.id, { ...second, version: 0 }],
    ]);
    expect(
      savedAuthoritativeItems([first.id, second.id], renderedWithPending, authoritative),
    ).toBeNull();
  });

  it("preserves unrelated text style while changing colour, family, and size", () => {
    const text: Extract<BoardItem, { kind: "text" }> = {
      id: "text-a",
      kind: "text",
      z: 1,
      version: 3,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "text",
        color: "#1e1e1e",
        fontSize: 28,
        fontFamily: "sans",
        opacity: 0.8,
      },
      geometry: { x: 10, y: 20, text: "Question" },
    };

    expect(buildElementColourOperations([text], "#874fff")).toEqual([
      {
        kind: "item.update",
        itemId: "text-a",
        expectedVersion: 3,
        patch: { style: { ...text.style, color: "#874fff" } },
      },
    ]);
    expect(buildTextStyleOperations([text], { fontFamily: "handwritten", fontSize: 52 })).toEqual([
      {
        kind: "item.update",
        itemId: "text-a",
        expectedVersion: 3,
        patch: {
          style: { ...text.style, fontFamily: "handwritten", fontSize: 52 },
        },
      },
    ]);
  });

  it("limits input by Unicode code point rather than UTF-16 length", () => {
    const value = `${"😀".repeat(1_000)}overflow`;
    const clamped = clampStickyText(value);
    expect([...clamped]).toHaveLength(1_000);
    expect(clamped).toBe("😀".repeat(1_000));
  });

  it("escapes the accessible title and wraps escaped sticky text in local SVG", () => {
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 4,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abd",
          kind: "sticky",
          z: 1,
          version: 4,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [1, 0, 0, 1, 0, 0],
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          geometry: {
            x: 10,
            y: 20,
            width: 180,
            height: 140,
            text: "one <tag> & two three four",
          },
        },
      ],
    };

    const svg = localSvg(snapshot, `Class "<ideas>" & 'notes'`);

    expect(svg).toContain('aria-label="Class &quot;&lt;ideas&gt;&quot; &amp; &apos;notes&apos;"');
    expect(svg).toContain('<tspan x="24" dy="0">one &lt;tag&gt; &amp;</tspan>');
    expect(svg).toContain('<tspan x="24" dy="24">two three</tspan>');
    expect(svg).not.toContain("<tag>");
  });

  it("frames a sticky using its complete affine transform", () => {
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 1,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
          kind: "sticky",
          z: 1,
          version: 1,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [0, 1, -1, 0, 200, 10],
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          geometry: { x: 0, y: 0, width: 100, height: 50, text: "Rotated" },
        },
      ],
    };

    expect(localSvg(snapshot, "Rotated sticky")).toContain('viewBox="118 -22 114 164"');
  });
});

describe("image card UI validation", () => {
  it("prechecks supported MIME types, empty files, and the classroom size limit", () => {
    expect(imageUploadIssue({ type: "image/png", size: 1_024 })).toBeNull();
    expect(imageUploadIssue({ type: "image/svg+xml", size: 1_024 })).toContain(
      "PNG, JPEG, WebP, or GIF",
    );
    expect(imageUploadIssue({ type: "image/png", size: 0 })).toContain("empty");
    expect(imageUploadIssue({ type: "image/png", size: MAX_IMAGE_UPLOAD_BYTES + 1 })).toContain(
      "5 MiB",
    );
  });

  it("limits alt text by Unicode code point", () => {
    expect(clampImageAlt(`${"😀".repeat(500)}overflow`)).toBe("😀".repeat(500));
  });
});

describe("table cell draft recovery", () => {
  it("recovers the exact single-cell text from a rejected whole-geometry update", () => {
    const item: Extract<BoardItem, { kind: "table" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac1",
      kind: "table",
      z: 1,
      version: 7,
      createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "table",
        borderColor: "#a8a59d",
        fill: "#fffefa",
        headerFill: "#e8edff",
        textColor: "#20201e",
        fontSize: 16,
        opacity: 1,
      },
      geometry: {
        x: 10,
        y: 20,
        columnWidths: [120, 120],
        rowHeights: [48, 48],
        cells: [
          ["Topic", "Evidence"],
          ["Before", ""],
        ],
      },
    };
    const geometry = structuredClone(item.geometry);
    const editedRow = geometry.cells[1];
    if (!editedRow) throw new Error("Expected the second table row.");
    editedRow[0] = "Student draft must survive exactly <&> 😀";
    const operation: DurableOperation = {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry },
    };

    expect(tableCellDraftFromOperation(operation, new Map([[item.id, item]]))).toEqual({
      itemId: item.id,
      row: 1,
      column: 0,
      text: "Student draft must survive exactly <&> 😀",
      selectionStart: 41,
      selectionEnd: 41,
    });

    geometry.columnWidths[0] = 180;
    expect(tableCellDraftFromOperation(operation, new Map([[item.id, item]]))).toBeUndefined();
  });
});

describe("zone title draft recovery", () => {
  it("recovers title-only updates and ignores rejected zone resizes", () => {
    const item: Extract<BoardItem, { kind: "zone" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac2",
      kind: "zone",
      z: 1,
      version: 4,
      createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
      geometry: { x: 10, y: 20, width: 520, height: 320, title: "Evidence" },
    };
    const titleOperation: DurableOperation = {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry: { ...item.geometry, title: "Questions" } },
    };
    expect(zoneTitleDraftFromOperation(titleOperation, new Map([[item.id, item]]))).toMatchObject({
      itemId: item.id,
      title: "Questions",
    });

    const resizeOperation: DurableOperation = {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry: { ...item.geometry, width: 680, height: 420 } },
    };
    expect(
      zoneTitleDraftFromOperation(resizeOperation, new Map([[item.id, item]])),
    ).toBeUndefined();
  });
});

describe("stamp UI configuration", () => {
  it("offers the six classroom stamp designs", () => {
    expect(STAMP_CHOICES.map(({ kind }) => kind)).toEqual([
      "star",
      "check",
      "heart",
      "question",
      "smile",
      "sparkle",
    ]);
    expect(new Set(STAMP_CHOICES.map(({ glyph }) => glyph)).size).toBe(6);
  });

  it("exports a centered stamp using the shared deterministic SVG path", () => {
    const itemId = "018f47a1-7a2b-7c3d-8e4f-123456789abf";
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 5,
      items: [
        {
          id: itemId,
          kind: "stamp",
          z: 1,
          version: 1,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [1, 0, 0, 1, 0, 0],
          style: { kind: "stamp", color: "#8e4ec6", opacity: 0.75 },
          geometry: { x: 100, y: 80, size: 72, stamp: "star" },
        },
      ],
    };

    const svg = localSvg(snapshot, "Stamp feedback");

    expect(svg).toContain('viewBox="32 12 136 136"');
    expect(svg).toContain(`data-item-id="${itemId}"`);
    expect(svg).toContain('transform="translate(64 44) scale(3)"');
    expect(svg).toContain('fill="#8e4ec6"');
    expect(svg).toContain('opacity="0.75"');
    expect(svg).not.toContain("<text");
  });
});
