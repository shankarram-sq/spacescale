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

const MATH_MARKUP =
  /\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$|(^|[^\\$])\$(?!\s)(?:\\.|[^$\\])+?\$/mu;

let mathJaxReady: Promise<MathJaxApi> | null = null;
let mathJaxWork: Promise<void> = Promise.resolve();

export function containsMathMarkup(value: string): boolean {
  return MATH_MARKUP.test(value);
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
        inlineMath: { "[+]": [["$", "$"]] },
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

function enqueueMathJax(operation: (mathJax: MathJaxApi) => void | Promise<void>): Promise<void> {
  const work = mathJaxWork.then(async () => operation(await loadMathJax()));
  mathJaxWork = work.catch(() => undefined);
  return work;
}

/** Lazily typesets one plain-text container and preserves the source on failure. */
export function typesetMath(container: HTMLElement, onReady?: () => void): void {
  const source = container.textContent ?? "";
  if (!containsMathMarkup(source)) return;
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
