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
