import { describe, expect, it } from "vitest";
import { assertPublicConfiguration } from "./env";

describe("ALLOWED_ORIGINS public configuration", () => {
  it.each([
    {} as Record<string, string>,
    { ALLOWED_ORIGINS: "" },
    { ALLOWED_ORIGINS: "   " },
    { ALLOWED_ORIGINS: "*" },
    { ALLOWED_ORIGINS: "  *  " },
    { ALLOWED_ORIGINS: "https://classroom.example" },
    { ALLOWED_ORIGINS: "https://classroom.example, https://lms.example" },
    { ALLOWED_ORIGINS: "http://localhost:4173,http://127.0.0.1:8787" },
  ])("accepts deny-all, standalone '*', and exact comma-separated origins", (values) => {
    expect(() => assertPublicConfiguration(values)).not.toThrow();
  });

  it.each([
    "https://classroom.example https://lms.example",
    "https://classroom.example,",
    ",https://classroom.example",
    "*,https://classroom.example",
    "https://*.example.com",
    "http://classroom.example",
    "https://classroom.example/",
    "https://classroom.example/path",
    "https://user@classroom.example",
    "not-an-origin",
  ])("rejects unsafe or non-comma-separated value %s", (value) => {
    expect(() => assertPublicConfiguration({ ALLOWED_ORIGINS: value })).toThrow(/ALLOWED_ORIGINS/u);
  });

  it("limits the allowlist to 20 origins", () => {
    const origins = Array.from(
      { length: 21 },
      (_, index) => `https://classroom-${index}.example`,
    ).join(",");
    expect(() => assertPublicConfiguration({ ALLOWED_ORIGINS: origins })).toThrow(
      /1 to 20 comma-separated origins/u,
    );
  });
});

describe("ORGANISATION_SIGNING_KEYS private configuration", () => {
  const valid = {
    alpha: {
      derivation_key: Buffer.alloc(32, "d").toString("base64"),
      current: { kid: "2026-08", key: Buffer.alloc(32, "c").toString("base64") },
      previous: [{ kid: "2026-07", key: Buffer.alloc(32, "p").toString("base64") }],
    },
  };

  it("accepts stable derivation keys with current and previous launch keys", () => {
    expect(() =>
      assertPublicConfiguration({ ORGANISATION_SIGNING_KEYS: JSON.stringify(valid) }),
    ).not.toThrow();
  });

  it.each([
    "not-json",
    "{}",
    JSON.stringify({ alpha: { ...valid.alpha, derivation_key: "short" } }),
    JSON.stringify({ alpha: { ...valid.alpha, current: { kid: "bad kid", key: "c".repeat(32) } } }),
    JSON.stringify({
      alpha: {
        ...valid.alpha,
        previous: [{ kid: "2026-08", key: "p".repeat(32) }],
      },
    }),
  ])("rejects malformed or unsafe registries", (value) => {
    expect(() => assertPublicConfiguration({ ORGANISATION_SIGNING_KEYS: value })).toThrow(
      /ORGANISATION_SIGNING_KEYS/u,
    );
  });
});
