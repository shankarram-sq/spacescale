import { normalizeSingleDollarMath } from "@collab/geometry";

export { normalizeSingleDollarMath };

type MathJaxApi = {
  startup?: { promise?: Promise<void> };
  typesetClear?: (elements: HTMLElement[]) => void;
  typesetPromise?: (elements: HTMLElement[]) => Promise<void>;
};

declare global {
  interface Window {
    MathJax?: MathJaxApi | Record<string, unknown>;
  }
}

const UNAMBIGUOUS_MATH_MARKUP = /\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$/u;

let mathJaxReady: Promise<MathJaxApi> | null = null;
let mathJaxWork: Promise<void> = Promise.resolve();

export function containsMathMarkup(value: string): boolean {
  return UNAMBIGUOUS_MATH_MARKUP.test(value) || normalizeSingleDollarMath(value) !== value;
}

export function splitMathMarkup(value: string): Array<{ kind: "math" | "text"; text: string }> {
  const normalized = normalizeSingleDollarMath(value);
  const result: Array<{ kind: "math" | "text"; text: string }> = [];
  let cursor = 0;
  for (const match of normalized.matchAll(/\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$/gu)) {
    const index = match.index;
    if (index > cursor) result.push({ kind: "text", text: normalized.slice(cursor, index) });
    result.push({ kind: "math", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < normalized.length) result.push({ kind: "text", text: normalized.slice(cursor) });
  return result;
}

function mathExpressionSource(markup: string): string {
  if (
    (markup.startsWith("\\(") && markup.endsWith("\\)")) ||
    (markup.startsWith("\\[") && markup.endsWith("\\]"))
  ) {
    return markup.slice(2, -2);
  }
  if (markup.startsWith("$$") && markup.endsWith("$$")) return markup.slice(2, -2);
  return markup;
}

function labelRenderedMath(container: HTMLElement, source: string): void {
  const formulae = splitMathMarkup(source)
    .filter((segment) => segment.kind === "math")
    .map((segment) => mathExpressionSource(segment.text));
  container.querySelectorAll<HTMLElement>("mjx-container").forEach((rendered, index) => {
    const formula = formulae[index];
    if (formula === undefined) return;
    rendered.setAttribute("role", "math");
    rendered.setAttribute("aria-label", `Formula: ${formula}`);
  });
}

async function loadMathJax(): Promise<MathJaxApi> {
  if (mathJaxReady) return mathJaxReady;
  mathJaxReady = (async () => {
    window.MathJax = {
      options: {
        enableBraille: false,
        enableExplorer: false,
        enableMenu: false,
        enableSpeech: false,
        menuOptions: {
          settings: { assistiveMml: false, braille: false, enrich: false, speech: false },
        },
        renderActions: { attachSpeech: [], enrich: [], explorable: [] },
      },
      startup: { typeset: false },
      svg: { fontCache: "local" },
      tex: {
        processEscapes: true,
        packages: { "[-]": ["autoload", "require"] },
      },
    };
    await import("mathjax/tex-svg.js");
    const mathJax = window.MathJax as MathJaxApi | undefined;
    await mathJax?.startup?.promise;
    if (typeof mathJax?.typesetPromise !== "function") {
      throw new Error("MathJax did not expose its browser typesetting API.");
    }
    return mathJax;
  })();
  return mathJaxReady;
}

function normalizeSingleDollarTextNodes(root: Node): void {
  for (const child of root.childNodes) {
    if (child.nodeType === 3 && child.nodeValue !== null) {
      child.nodeValue = normalizeSingleDollarMath(child.nodeValue);
    } else if (child.nodeType === 1 && child.nodeName !== "A") {
      normalizeSingleDollarTextNodes(child);
    }
  }
}

function enqueueMathJax<T>(operation: (mathJax: MathJaxApi) => T | Promise<T>): Promise<T> {
  const work = mathJaxWork.then(async () => operation(await loadMathJax()));
  mathJaxWork = work.then(
    () => undefined,
    () => undefined,
  );
  return work;
}

export type TypesetMathOptions = {
  /** Runs once the container holds typeset math. Its failures never discard that math. */
  onReady?: () => void;
  /** Rebuilds the plain-text container when MathJax cannot render it. */
  restore?: (container: HTMLElement) => void;
};

/** Lazily typesets one plain-text container and preserves the source on failure. */
export function typesetMath(container: HTMLElement, options: TypesetMathOptions = {}): void {
  const source = container.textContent ?? "";
  if (!containsMathMarkup(source)) return;
  normalizeSingleDollarTextNodes(container);
  container.dataset.mathState = "loading";
  void enqueueMathJax(async (mathJax) => {
    if (!container.isConnected) return false;
    mathJax.typesetClear?.([container]);
    await mathJax.typesetPromise?.([container]);
    if (!container.isConnected) return false;
    labelRenderedMath(container, source);
    container.dataset.mathState = "ready";
    return true;
  })
    .catch(() => {
      if (!container.isConnected) return false;
      // Rebuilding from the caller keeps anchors and other markup that plain text would flatten.
      if (options.restore) options.restore(container);
      else container.textContent = source;
      container.title = "Math could not be rendered.";
      container.dataset.mathState = "error";
      return false;
    })
    // onReady runs outside the operation so a caller's failure cannot be mistaken for a
    // MathJax failure, which would replace correctly typeset math with its raw source and
    // swallow the real error.
    .then((typeset) => {
      if (typeset) reportMathReady(options.onReady);
    });
}

function reportMathReady(onReady?: () => void): void {
  if (!onReady) return;
  try {
    onReady();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/** Releases MathJax's references before rendered DOM is replaced or removed. */
export function clearTypesetMath(root: ParentNode): void {
  const element = root as ParentNode & {
    dataset?: DOMStringMap;
    querySelectorAll?: ParentNode["querySelectorAll"];
  };
  const containers: HTMLElement[] = [];
  if (element.dataset?.mathState !== undefined) containers.push(element as HTMLElement);
  if (typeof element.querySelectorAll === "function") {
    containers.push(...element.querySelectorAll<HTMLElement>("[data-math-state]"));
  }
  if (containers.length === 0) return;
  void enqueueMathJax((mathJax) => mathJax.typesetClear?.(containers)).catch(() => undefined);
}
