/** The inner bounds of one `$$…$$` formula in a text value. */
export type MathRegion = { start: number; end: number; closed: boolean };

const DELIMITER = "$$";

/** Every `$$` in the value, left to right, skipping escaped dollars. */
function delimiterOffsets(value: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index + 1 < value.length; index += 1) {
    if (value[index] !== "$" || value[index + 1] !== "$") continue;
    let backslashes = 0;
    for (let back = index - 1; back >= 0 && value[back] === "\\"; back -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    offsets.push(index);
    index += 1;
  }
  return offsets;
}

/**
 * The formula the caret sits inside, or null when it does not. Delimiters pair left to right, so
 * the odd one out is an opening the writer has not closed yet, which is exactly the moment the
 * math keyboard should appear.
 */
export function mathRegionAtCaret(value: string, caret: number): MathRegion | null {
  const offsets = delimiterOffsets(value);
  for (let index = 0; index < offsets.length; index += 2) {
    const opening = offsets[index];
    if (opening === undefined) break;
    const start = opening + DELIMITER.length;
    const closing = offsets[index + 1];
    if (closing === undefined) {
      return caret >= start ? { start, end: value.length, closed: false } : null;
    }
    if (caret >= start && caret <= closing) return { start, end: closing, closed: true };
  }
  return null;
}

/**
 * True when this input event just completed an opening `$$` that nothing closes, which is when
 * the editor should add the closing pair so the writer types the formula between them.
 */
export function shouldCloseDelimiter(value: string, caret: number): boolean {
  if (caret < DELIMITER.length) return false;
  if (value.slice(caret - DELIMITER.length, caret) !== DELIMITER) return false;
  const offsets = delimiterOffsets(value);
  const opening = caret - DELIMITER.length;
  const index = offsets.indexOf(opening);
  // Even index means this `$$` is an opening, and being last means nothing closes it.
  return index >= 0 && index % 2 === 0 && index === offsets.length - 1;
}
