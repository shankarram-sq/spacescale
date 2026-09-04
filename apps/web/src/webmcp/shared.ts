import type {
  RegisteredWebMcpTool,
  WebMcpHostExecutionOptions,
  WebMcpModelContext,
  WebMcpRegisterToolOptions,
  WebMcpToolDefinition,
} from "./types";

export type WebMcpRegistryState = {
  /** True when a WebMCP host exposed document.modelContext in this browser. */
  hostPresent: boolean;
  /** Tools this page has registered with that host and not yet withdrawn. */
  toolCount: number;
  /** Calls that have not settled yet. */
  activeCallCount: number;
  /** Every tool call made during this page session, newest first. */
  calls: readonly WebMcpCallRecord[];
};

export type WebMcpCallStatus = "active" | "succeeded" | "failed";

export type WebMcpCallRecord = {
  id: number;
  toolName: string;
  status: WebMcpCallStatus;
  startedAt: number;
  completedAt: number | null;
};

/**
 * The tools this build exposes to a WebMCP host, by name.
 *
 * `registerWebMcpTool` skips a definition whose name is absent here, so adding a tool means
 * listing it explicitly: no module can widen the surface a host sees on its own. A tool that
 * describes another reads this through `webMcpToolEnabled`, so a contract never names a tool
 * the host cannot call.
 */
export const ENABLED_WEBMCP_TOOLS: ReadonlySet<string> = new Set([
  // Reads: one reading of a scope
  "read_board",
  "read_selection",
  "read_user",
  "list_users",
  "read_live_class_vote",
  "read_templates",
  // Reads: told about changes as they are saved
  "watch_board",
  "watch_users",
  // Generic writes
  "insert_comment",
  "insert_sticky",
  "insert_image",
  "insert_video",
  "insert_text",
  "insert_section",
  "insert_filled_template",
  "move_stickies",
  "resize_sticky",
]);

export function webMcpToolEnabled(name: string): boolean {
  return ENABLED_WEBMCP_TOOLS.has(name);
}

const registeredToolNames = new Set<string>();
const definedTools = new Map<string, WebMcpToolDefinition>();
const registryListeners = new Set<(state: WebMcpRegistryState) => void>();
const webMcpCalls: WebMcpCallRecord[] = [];
export const MAX_WEBMCP_COMPLETED_CALLS = 100;
let nextWebMcpCallId = 1;

/** Watch polling is infrastructure noise rather than useful page-session activity. */
export function isVisibleWebMcpActivityCall(call: Pick<WebMcpCallRecord, "toolName">): boolean {
  return call.toolName !== "watch_board";
}

function hostPresent(): boolean {
  return (
    typeof document !== "undefined" && typeof document.modelContext?.registerTool === "function"
  );
}

/** Every tool this page has defined and not yet withdrawn, whether or not it is exposed. */
export function webMcpToolDefinitions(): ReadonlyMap<string, WebMcpToolDefinition> {
  return definedTools;
}

export function webMcpRegistryState(): WebMcpRegistryState {
  return {
    hostPresent: hostPresent(),
    toolCount: registeredToolNames.size,
    activeCallCount: webMcpCalls.filter((call) => call.status === "active").length,
    calls: webMcpCalls.map((call) => ({ ...call })),
  };
}

/** Subscribes to registry changes and returns an unsubscribe function. */
export function observeWebMcpRegistry(listener: (state: WebMcpRegistryState) => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function announceRegistryChange(): void {
  const state = webMcpRegistryState();
  for (const listener of [...registryListeners]) {
    try {
      listener(state);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function startToolCall(toolName: string): number {
  const id = nextWebMcpCallId++;
  webMcpCalls.unshift({
    id,
    toolName,
    status: "active",
    startedAt: Date.now(),
    completedAt: null,
  });
  announceRegistryChange();
  return id;
}

function finishToolCall(id: number, status: Exclude<WebMcpCallStatus, "active">): void {
  const index = webMcpCalls.findIndex((call) => call.id === id);
  if (index === -1) return;
  const call = webMcpCalls[index];
  if (!call) return;
  webMcpCalls[index] = { ...call, status, completedAt: Date.now() };
  trimCompletedCalls();
  announceRegistryChange();
}

/** Retains every active call plus a bounded newest-first history of visible completed calls. */
function trimCompletedCalls(): void {
  let completed = 0;
  for (let index = 0; index < webMcpCalls.length; index += 1) {
    const call = webMcpCalls[index];
    if (!call || call.status === "active") continue;
    if (!isVisibleWebMcpActivityCall(call)) {
      webMcpCalls.splice(index, 1);
      index -= 1;
      continue;
    }
    completed += 1;
    if (completed <= MAX_WEBMCP_COMPLETED_CALLS) continue;
    webMcpCalls.splice(index, 1);
    index -= 1;
  }
}

/**
 * Registers one tool and keeps a page-wide count of what is currently exposed, so the board can
 * show how many tools a visiting host can see. A tool missing from ENABLED_WEBMCP_TOOLS is
 * skipped here. Withdrawal is driven by the same abort signal the caller already passes, so a
 * destroyed module drops its tools from the count without extra bookkeeping.
 */
export async function registerWebMcpTool(
  modelContext: WebMcpModelContext,
  tool: WebMcpToolDefinition,
  options?: WebMcpRegisterToolOptions,
): Promise<void> {
  if (options?.signal?.aborted) return;
  definedTools.set(tool.name, tool);
  options?.signal?.addEventListener("abort", () => definedTools.delete(tool.name), { once: true });
  if (!webMcpToolEnabled(tool.name)) return;
  const trackedTool: WebMcpToolDefinition = {
    ...tool,
    execute: async (input, executionOptions) => {
      const callId = startToolCall(tool.name);
      try {
        const result = await tool.execute(input, executionOptions);
        finishToolCall(callId, "succeeded");
        return result;
      } catch (error) {
        finishToolCall(callId, "failed");
        throw error;
      }
    },
  };
  await modelContext.registerTool(withExecutionSignal(trackedTool), options);
  if (options?.signal?.aborted) return;
  registeredToolNames.add(tool.name);
  options?.signal?.addEventListener(
    "abort",
    () => {
      registeredToolNames.delete(tool.name);
      announceRegistryChange();
    },
    { once: true },
  );
  announceRegistryChange();
}

/**
 * Guarantees every tool an AbortSignal, whatever the host passes.
 *
 * The WebMCP execution contract is `execute(input, { signal })`, but hosts differ: one shim hands
 * over an options object carrying only `requestUserInteraction`, and calling `signal.throwIfAborted()`
 * on that throws a TypeError before the tool does any work. Substituting a signal that never
 * aborts keeps the tools written against one shape while staying usable on a host that omits it;
 * the cost is only that such a host cannot cancel a call it never offered to cancel. A fresh
 * controller per call keeps one call's abort listeners out of the next one.
 */
function withExecutionSignal(tool: WebMcpToolDefinition): RegisteredWebMcpTool {
  return {
    ...tool,
    execute: (input: unknown, options?: WebMcpHostExecutionOptions) =>
      tool.execute(input, {
        ...options,
        signal: options?.signal ?? new AbortController().signal,
      }),
  };
}

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
  "SpaceScale renders TeX with MathJax in canvas text, sticky notes, table cells, Section titles, and comments. Preserve or create math with \\(...\\) for inline expressions and $$...$$ or \\[...\\] for display expressions. A single $ is a dollar sign, never a delimiter, so prices stay prices: write \\(x\\), not $x$.";

export const WEBMCP_TEXT_RENDERING_CAPABILITY = {
  engine: "MathJax 4",
  syntax: "TeX",
  inlineDelimiters: ["\\(...\\)"],
  displayDelimiters: ["$$...$$", "\\[...\\]"],
  surfaces: ["canvas_text", "sticky_notes", "table_cells", "section_titles", "comments"],
} as const;
