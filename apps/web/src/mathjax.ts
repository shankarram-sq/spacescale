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

/** Lazily typesets one plain-text container and preserves the source on failure. */
export function typesetMath(container: HTMLElement): void {
  const source = container.textContent ?? "";
  if (!containsMathMarkup(source)) return;
  container.dataset.mathState = "loading";
  void loadMathJax()
    .then(async (mathJax) => {
      if (!container.isConnected) return;
      mathJax.typesetClear?.([container]);
      await mathJax.typesetPromise?.([container]);
      if (container.isConnected) container.dataset.mathState = "ready";
    })
    .catch(() => {
      if (!container.isConnected) return;
      container.textContent = source;
      container.title = "Math could not be rendered.";
      container.dataset.mathState = "error";
    });
}
