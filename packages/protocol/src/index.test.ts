import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canonicalRequestHashInput,
  canonicalStringify,
  ProtocolValidationError,
  parseClientFrame,
  validateDurableOperation,
  validatePlainText,
} from "./index.js";

const ID_1 = "018f0000-0000-7000-8000-000000000001";
const ID_2 = "018f0000-0000-7000-8000-000000000002";
const ID_3 = "018f0000-0000-7000-8000-000000000003";

function rectangle(id = ID_1) {
  return {
    id,
    kind: "rectangle",
    style: { kind: "stroke", color: "#abcdef", width: 2.125, opacity: 0.555 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 5.129, y: 7.555, width: -2, height: 4 },
  };
}

function sticky(id = ID_1) {
  return {
    id,
    kind: "sticky",
    style: {
      kind: "sticky",
      fill: "#ffeb3b",
      textColor: "#212121",
      fontSize: 16.125,
      opacity: 0.555,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 15.129, y: 17.555, width: -10, height: 14, text: "" },
  };
}

function stamp(id = ID_1, stampKind = "star") {
  return {
    id,
    kind: "stamp",
    style: { kind: "stamp", color: "#e11d48", opacity: 0.555 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 12.345, y: -7.555, size: 71.999, stamp: stampKind },
  };
}

describe("durable operation validation", () => {
  it("normalizes a valid create and rejects server-owned fields", () => {
    expect(validateDurableOperation({ kind: "item.create", item: rectangle() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "rectangle",
        style: { kind: "stroke", color: "#abcdef", width: 2.13, opacity: 0.56 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 3.13, y: 7.56, width: 2, height: 4 },
      },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...rectangle(), z: 10 },
      }),
    ).toThrow(/Unknown field/);
  });

  it("normalizes sticky creates and permits empty sticky text", () => {
    expect(validateDurableOperation({ kind: "item.create", item: sticky() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#ffeb3b",
          textColor: "#212121",
          fontSize: 16.13,
          opacity: 0.56,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 5.13, y: 17.56, width: 10, height: 14, text: "" },
      },
    });
  });

  it("validates sticky dimensions, styles, text, and patch inference", () => {
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...sticky(), geometry: { x: 0, y: 0, width: 0, height: 10, text: "" } },
      }),
    ).toThrow(/greater than 0/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...sticky(), style: { ...sticky().style, fill: "#FFEB3B" } },
      }),
    ).toThrow(/lowercase/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...sticky(), geometry: { ...sticky().geometry, text: "x".repeat(1_001) } },
      }),
    ).toThrow(/at most 1000/);
    for (const text of ["hidden\u007fcontrol", "hidden\u0085control"]) {
      expect(() =>
        validateDurableOperation({
          kind: "item.create",
          item: { ...sticky(), geometry: { ...sticky().geometry, text } },
        }),
      ).toThrow(/control character/);
    }
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...sticky(), geometry: { ...sticky().geometry, text: "unpaired\ud800" } },
      }),
    ).toThrow(/unpaired surrogate/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...sticky(),
          transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
        },
      }),
    ).toThrow(/Transform component/);
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { geometry: { x: 1, y: 2, width: 180, height: 140, text: "" } },
      }),
    ).toMatchObject({
      patch: { geometry: { x: 1, y: 2, width: 180, height: 140, text: "" } },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          id: ID_1,
          kind: "text",
          style: { kind: "text", color: "#123456", fontSize: 16, opacity: 1 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 0, y: 0, text: "" },
        },
      }),
    ).toThrow(/must not be empty/);
  });

  it("normalizes every durable stamp and rejects unsafe geometry and styles", () => {
    for (const stampKind of ["star", "check", "heart", "question", "smile", "sparkle"]) {
      expect(
        validateDurableOperation({ kind: "item.create", item: stamp(ID_1, stampKind) }),
      ).toEqual({
        kind: "item.create",
        item: {
          id: ID_1,
          kind: "stamp",
          style: { kind: "stamp", color: "#e11d48", opacity: 0.56 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 12.35, y: -7.56, size: 72, stamp: stampKind },
        },
      });
    }
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...stamp(), geometry: { x: 0, y: 0, size: 0, stamp: "star" } },
      }),
    ).toThrow(/greater than 0/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...stamp(), geometry: { x: 0, y: 0, size: 72, stamp: "award" } },
      }),
    ).toThrow(/Stamp must be one of/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...stamp(), style: { kind: "stamp", color: "#E11D48", opacity: 1 } },
      }),
    ).toThrow(/lowercase/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...stamp(), style: { kind: "stamp", color: "#e11d48", opacity: 0 } },
      }),
    ).toThrow(/between 0.1 and 1/);
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { geometry: { x: 20, y: 30, size: 80, stamp: "check" } },
      }),
    ).toMatchObject({
      patch: { geometry: { x: 20, y: 30, size: 80, stamp: "check" } },
    });
  });

  it("rejects nested batches, unknown patch fields, and duplicate affected IDs", () => {
    expect(() =>
      validateDurableOperation({
        kind: "items.batch",
        operations: [{ kind: "items.batch", operations: [] }],
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { z: 9 },
      }),
    ).toThrow(/Unknown field/);
    expect(() =>
      validateDurableOperation({
        kind: "items.batch",
        operations: [
          { kind: "item.delete", itemId: ID_1, expectedVersion: 1 },
          {
            kind: "item.update",
            itemId: ID_1,
            expectedVersion: 1,
            patch: { transform: [1, 0, 0, 1, 2, 2] },
          },
        ],
      }),
    ).toThrow(/only once/);
  });

  it("rejects mismatched styles, non-finite numbers, and invalid IDs", () => {
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...rectangle(),
          style: { kind: "text", color: "#abcdef", fontSize: 16, opacity: 1 },
        },
      }),
    ).toThrow(/stroke/);
    expect(() =>
      validateDurableOperation({
        kind: "item.copy",
        sourceItemId: ID_1,
        expectedVersion: 1,
        newItemId: ID_2,
        translate: { x: Number.POSITIVE_INFINITY, y: 0 },
      }),
    ).toThrow(/finite/);
    expect(() =>
      validateDurableOperation({ kind: "item.delete", itemId: "../bad", expectedVersion: 1 }),
    ).toThrow(/canonical UUID/);
  });
});

describe("hostile frame parsing", () => {
  it("parses and normalizes a commit frame", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: ID_2,
        actionId: ID_3,
        baseSeq: 0,
        op: { kind: "item.create", item: rectangle() },
      }),
    );
    expect(frame.t).toBe("client.commit");
    expect(frame.t === "client.commit" && frame.op.kind).toBe("item.create");
  });

  it("rejects binary, unsupported, unknown, deep, and non-finite frames with typed errors", () => {
    expect(() => parseClientFrame(new Uint8Array([1, 2]))).toThrow(ProtocolValidationError);
    expect(() => parseClientFrame('{"v":2,"t":"client.sync_check","latestSeq":0}')).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_VERSION",
        details: { reloadRequired: true },
      }),
    );
    expect(() => parseClientFrame('{"v":1,"t":"unknown"}')).toThrow(/Unknown frame type/);
    expect(() =>
      parseClientFrame(
        JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0, nested: [[[[[[[[1]]]]]]]] }),
      ),
    ).toThrow(/nesting/);
    expect(() =>
      // validateClientFrame accepts programmatic hostile values too; JSON itself
      // cannot encode Infinity.
      validateDurableOperation({ kind: "board.clear", expectedBoardSeq: Number.NaN }),
    ).toThrow(/safe integer/);
  });

  it("enforces the ordinary frame byte limit", () => {
    const payload = JSON.stringify({
      v: 1,
      t: "client.presence",
      cursor: { x: 0, y: 0 },
      activeTool: "pencil",
      padding: "x".repeat(70_000),
    });
    expect(() => parseClientFrame(payload)).toThrowError(
      expect.objectContaining({ code: "MESSAGE_TOO_LARGE" }),
    );
  });

  it("always returns a typed rejection for arbitrary hostile JSON operations", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 12 }), (candidate) => {
        try {
          validateDurableOperation(candidate);
        } catch (error) {
          expect(error).toBeInstanceOf(ProtocolValidationError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("rejects randomly deep JSON without overflowing the call stack", () => {
    fc.assert(
      fc.property(fc.integer({ min: 9, max: 100 }), (depth) => {
        let nested: unknown = 0;
        for (let index = 0; index < depth; index += 1) nested = [nested];
        expect(() =>
          parseClientFrame(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0, nested })),
        ).toThrow(ProtocolValidationError);
      }),
      { numRuns: 50 },
    );
  });
});

describe("canonical and Unicode handling", () => {
  it("sorts keys recursively and creates identical hash bytes", () => {
    expect(canonicalStringify({ z: 1, a: { y: -0, x: "ok" } })).toBe(
      '{"a":{"x":"ok","y":0},"z":1}',
    );
    expect(canonicalRequestHashInput({ kind: "board.clear", expectedBoardSeq: 2 })).toEqual(
      new TextEncoder().encode('{"expectedBoardSeq":2,"kind":"board.clear"}'),
    );
  });

  it("counts Unicode code points and rejects XML-invalid or unpaired input", () => {
    expect(validatePlainText("hello 🌍")).toBe("hello 🌍");
    expect(() => validatePlainText("bad\u0000text")).toThrow(/control/);
    expect(() => validatePlainText("\ud800")).toThrow(/surrogate/);
  });
});
