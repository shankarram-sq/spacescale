export function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters.`);
  }
  return text;
}

export function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maxLength);
}

export function textArray(
  value: unknown,
  field: string,
  min: number,
  max: number,
  maxTextLength: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${field} must contain ${min}-${max} entries.`);
  }
  return value.map((entry, index) => requiredText(entry, `${field}[${index}]`, maxTextLength));
}

export function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}.`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const WEBMCP_MATHJAX_GUIDANCE =
  "SpaceScale renders TeX with MathJax in canvas text, sticky notes, table cells, Section titles, and comments. Preserve or create math with $...$ or \\(...\\) for inline expressions and $$...$$ or \\[...\\] for display expressions.";

export const WEBMCP_TEXT_RENDERING_CAPABILITY = {
  engine: "MathJax 4",
  syntax: "TeX",
  inlineDelimiters: ["$...$", "\\(...\\)"],
  displayDelimiters: ["$$...$$", "\\[...\\]"],
  surfaces: ["canvas_text", "sticky_notes", "table_cells", "section_titles", "comments"],
} as const;

/** Drops the oldest entries (insertion order) until the map holds at most `limit`. */
export function trimSnapshots<T>(snapshots: Map<string, T>, limit: number): void {
  while (snapshots.size > limit) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    snapshots.delete(oldest);
  }
}

/**
 * Opens a preview dialog and resolves with whether the participant chose "apply".
 * Only one proposal may wait on a dialog at a time; `populate` runs after that
 * guard so a rejected proposal never overwrites the pending preview. Aborting the
 * signal closes the dialog and rejects with the abort reason.
 */
export function awaitDialogDecision(
  dialog: HTMLDialogElement,
  signal: AbortSignal,
  populate: () => void,
): Promise<boolean> {
  signal.throwIfAborted();
  if (dialog.open) {
    return Promise.reject(new Error("Another proposal is already waiting for review."));
  }
  populate();
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      dialog.removeEventListener("close", onClose);
    };
    const onClose = (): void => {
      cleanup();
      resolve(dialog.returnValue === "apply");
    };
    const onAbort = (): void => {
      cleanup();
      if (dialog.open) dialog.close("cancel");
      reject(signal.reason);
    };
    dialog.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
