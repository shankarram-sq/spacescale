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

export function normalizeSingleDollarMath(value: string): string {
  let result = "";
  let copiedThrough = 0;
  for (let opening = 0; opening < value.length; opening += 1) {
    if (
      value[opening] !== "$" ||
      dollarIsEscaped(value, opening) ||
      value[opening - 1] === "$" ||
      value[opening + 1] === "$"
    ) {
      continue;
    }
    const first = value[opening + 1];
    if (first === undefined || /\s/u.test(first)) continue;
    for (let closing = opening + 2; closing < value.length; closing += 1) {
      if (value[closing] !== "$" || dollarIsEscaped(value, closing)) continue;
      if (value[closing - 1] === "$" || value[closing + 1] === "$") break;
      const previous = value[closing - 1];
      const next = value[closing + 1];
      const expression = value.slice(opening + 1, closing);
      if (
        previous !== undefined &&
        !/\s/u.test(previous) &&
        (next === undefined || !/\d/u.test(next)) &&
        singleDollarExpressionIsMath(expression)
      ) {
        result += `${value.slice(copiedThrough, opening)}\\(${expression}\\)`;
        copiedThrough = closing + 1;
        opening = closing;
      }
      break;
    }
  }
  return copiedThrough === 0 ? value : result + value.slice(copiedThrough);
}

function singleDollarExpressionIsMath(value: string): boolean {
  const first = value[0];
  return first === undefined || !/\d/u.test(first) || /[+\-*/=^_<>\\]/u.test(value);
}

function dollarIsEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
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

function enqueueMathJax(operation: (mathJax: MathJaxApi) => void | Promise<void>): Promise<void> {
  const work = mathJaxWork.then(async () => operation(await loadMathJax()));
  mathJaxWork = work.catch(() => undefined);
  return work;
}

/** Lazily typesets one plain-text container and preserves the source on failure. */
export function typesetMath(container: HTMLElement, onReady?: () => void): void {
  const source = container.textContent ?? "";
  if (!containsMathMarkup(source)) return;
  normalizeSingleDollarTextNodes(container);
  container.dataset.mathState = "loading";
  void enqueueMathJax(async (mathJax) => {
    if (!container.isConnected) return;
    mathJax.typesetClear?.([container]);
    await mathJax.typesetPromise?.([container]);
    if (!container.isConnected) return;
    container.dataset.mathState = "ready";
    onReady?.();
  }).catch(() => {
    if (!container.isConnected) return;
    container.textContent = source;
    container.title = "Math could not be rendered.";
    container.dataset.mathState = "error";
  });
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
