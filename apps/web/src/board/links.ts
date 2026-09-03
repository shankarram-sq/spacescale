export type SafeLinkToken =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

export type VideoEmbed = {
  provider: "youtube" | "vimeo";
  sourceUrl: string;
  embedUrl: string;
  title: string;
};

export { VIDEO_EMBED_HEIGHT, VIDEO_EMBED_WIDTH } from "@collab/geometry";

const HTTP_URL_CANDIDATE = /https?:\/\/[^\s<>"']+/giu;

const SENTENCE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "…", "。", "，", "！", "？"]);

const CLOSING_DELIMITERS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "\u2019": "\u2018",
  "\u201d": "\u201c",
  "\u00bb": "\u00ab",
};

function occurrences(value: string, character: string): number {
  let count = 0;
  for (const candidate of value) if (candidate === character) count += 1;
  return count;
}

function withoutTrailingSentencePunctuation(candidate: string): string {
  let value = candidate;
  while (value.length > 0) {
    const last = [...value].at(-1);
    if (last === undefined) break;
    if (SENTENCE_PUNCTUATION.has(last)) {
      value = value.slice(0, -last.length);
      continue;
    }
    const opening = CLOSING_DELIMITERS[last];
    if (opening !== undefined && occurrences(value, last) > occurrences(value, opening)) {
      value = value.slice(0, -last.length);
      continue;
    }
    break;
  }
  return value;
}

function safeHref(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.href;
}

function appendText(tokens: SafeLinkToken[], text: string): void {
  if (text.length === 0) return;
  const previous = tokens.at(-1);
  if (previous?.kind === "text") previous.text += text;
  else tokens.push({ kind: "text", text });
}

/**
 * Splits plain text into display-preserving text and safe, absolute HTTP(S) links.
 * Link destinations are normalized by URL parsing; unsafe or malformed candidates
 * remain ordinary text.
 */
export function tokenizeSafeLinks(value: string): SafeLinkToken[] {
  const tokens: SafeLinkToken[] = [];
  let offset = 0;

  for (const match of value.matchAll(HTTP_URL_CANDIDATE)) {
    const index = match.index;
    const matched = match[0];
    appendText(tokens, value.slice(offset, index));

    const displayText = withoutTrailingSentencePunctuation(matched);
    const trailingText = matched.slice(displayText.length);
    const href = displayText.length > 0 ? safeHref(displayText) : null;
    if (href === null) appendText(tokens, matched);
    else {
      tokens.push({ kind: "link", text: displayText, href });
      appendText(tokens, trailingText);
    }
    offset = index + matched.length;
  }

  appendText(tokens, value.slice(offset));
  return tokens;
}

/** Converts a complete YouTube or Vimeo URL into a privacy-conscious embed URL. */
export function videoEmbedFromText(value: string): VideoEmbed | null {
  const candidate = value.trim();
  if (!candidate || /\s/u.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    return youtubeEmbed(parsed.pathname.split("/").filter(Boolean)[0], parsed.href);
  }
  if (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "www.youtube-nocookie.com"
  ) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const id =
      parsed.pathname === "/watch"
        ? parsed.searchParams.get("v")
        : parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live"
          ? parts[1]
          : null;
    return youtubeEmbed(id, parsed.href);
  }
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const id = host === "player.vimeo.com" && parts[0] === "video" ? parts[1] : parts[0];
    if (!id || !/^\d{5,12}$/u.test(id)) return null;
    return {
      provider: "vimeo",
      sourceUrl: parsed.href,
      embedUrl: `https://player.vimeo.com/video/${id}`,
      title: "Vimeo video",
    };
  }
  return null;
}

function youtubeEmbed(id: string | null | undefined, sourceUrl: string): VideoEmbed | null {
  if (!id || !/^[A-Za-z0-9_-]{6,15}$/u.test(id)) return null;
  return {
    provider: "youtube",
    sourceUrl,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    title: "YouTube video",
  };
}
