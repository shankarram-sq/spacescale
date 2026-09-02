export type WebMcpToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type WebMcpToolExecutionOptions = {
  signal: AbortSignal;
};

export type WebMcpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (input: unknown, options: WebMcpToolExecutionOptions) => Promise<unknown> | unknown;
};

export type WebMcpRegisterToolOptions = {
  exposedTo?: string[];
  signal?: AbortSignal;
};

export type WebMcpModelContext = {
  registerTool: (
    tool: WebMcpToolDefinition,
    options?: WebMcpRegisterToolOptions,
  ) => Promise<void> | void;
};

declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }
}
