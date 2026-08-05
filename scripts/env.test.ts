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
