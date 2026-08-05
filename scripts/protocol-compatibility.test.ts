import { describe, expect, it } from "vitest";

import frozenClient from "../tests/protocol-fixtures/frozen-client.json";
import { checkProtocolCompatibility } from "./protocol-compatibility";

describe("frozen client compatibility", () => {
  it("accepts every frozen v1 client frame at the current server boundary", () => {
    expect(checkProtocolCompatibility(frozenClient)).toEqual({
      ok: true,
      currentProtocolVersion: 1,
      fixtureProtocolVersion: 1,
      fixtureRole: "initial-v1-baseline",
      framesChecked: 15,
    });
  });

  it("rejects a fabricated v0 baseline and a thinned case set", () => {
    expect(() =>
      checkProtocolCompatibility({
        ...frozenClient,
        protocolVersion: 0,
      }),
    ).toThrow(/requires frozen client fixture version 1/);

    expect(() =>
      checkProtocolCompatibility({
        ...frozenClient,
        frames: frozenClient.frames.slice(1),
      }),
    ).toThrow(/case set drifted/);
  });
});
