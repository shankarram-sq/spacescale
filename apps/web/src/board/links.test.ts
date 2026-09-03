import { describe, expect, it } from "vitest";
import { tokenizeSafeLinks } from "./links";

describe("tokenizeSafeLinks", () => {
  it("preserves ordinary and empty text", () => {
    expect(tokenizeSafeLinks("")).toEqual([]);
    expect(tokenizeSafeLinks("No links here.")).toEqual([{ kind: "text", text: "No links here." }]);
  });

  it("detects explicit HTTP and HTTPS substrings while preserving display text", () => {
    expect(
      tokenizeSafeLinks("See HTTP://Example.COM/a and https://example.net/b?q=one#two"),
    ).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "HTTP://Example.COM/a", href: "http://example.com/a" },
      { kind: "text", text: " and " },
      {
        kind: "link",
        text: "https://example.net/b?q=one#two",
        href: "https://example.net/b?q=one#two",
      },
    ]);
  });

  it("leaves surrounding sentence punctuation and unmatched closing delimiters as text", () => {
    expect(
      tokenizeSafeLinks("Open (https://example.com/path), then https://example.net/end…"),
    ).toEqual([
      { kind: "text", text: "Open (" },
      { kind: "link", text: "https://example.com/path", href: "https://example.com/path" },
      { kind: "text", text: "), then " },
      { kind: "link", text: "https://example.net/end", href: "https://example.net/end" },
      { kind: "text", text: "…" },
    ]);
  });

  it("keeps balanced delimiters that are part of the URL", () => {
    const url = "https://example.com/wiki/Function_(mathematics)";
    expect(tokenizeSafeLinks(url)).toEqual([{ kind: "link", text: url, href: url }]);
  });

  it("handles angle brackets and typographic quotes without putting them in the link", () => {
    expect(tokenizeSafeLinks("<https://example.com/a> and “https://example.com/b”")).toEqual([
      { kind: "text", text: "<" },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: "> and “" },
      { kind: "link", text: "https://example.com/b", href: "https://example.com/b" },
      { kind: "text", text: "”" },
    ]);
  });

  it("rejects credentials and malformed HTTP candidates without losing text", () => {
    expect(
      tokenizeSafeLinks("Keep https://user:secret@example.com/private and http://[broken] here"),
    ).toEqual([
      {
        kind: "text",
        text: "Keep https://user:secret@example.com/private and http://[broken] here",
      },
    ]);
  });

  it("does not recognize bare domains, protocol-relative URLs, or non-HTTP schemes", () => {
    const value =
      "example.com //example.com javascript:alert(1) data:text/plain,x mailto:a@example.com";
    expect(tokenizeSafeLinks(value)).toEqual([{ kind: "text", text: value }]);
  });
});
