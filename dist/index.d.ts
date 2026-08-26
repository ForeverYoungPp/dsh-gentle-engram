//#region src/index.d.ts
type JsonRecord = Record<string, unknown>;
type Agent = {
  id?: string;
  session?: {
    requestHeader?: () => {
      cwd?: string;
    };
  };
  inject: (message: UserMessage) => void;
};
type UserMessage = {
  id: string;
  role: 'user';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  source: {
    kind: 'plugin';
    plugin: string;
  };
};
type ToolResult = JsonRecord & {
  content?: unknown;
};
type ToolRegistry = {
  get: (name: string, agent?: Agent) => unknown;
  execute: (input: JsonRecord) => Promise<ToolResult>;
};
type CordisContext = {
  tools: ToolRegistry;
  logger?: {
    warn: (message: string) => void;
  };
  get: (name: string) => unknown;
  on: (event: string, listener: (...args: any[]) => unknown) => unknown;
  provide: (name: string, value: unknown) => unknown;
};
type Config = {
  serverName?: string;
  contextLimit?: number;
  captureToolResults?: boolean;
};
declare const name = "dsh-gentle-engram";
declare const inject: string[];
declare function apply(ctx: CordisContext, rawConfig?: Config): void;
//#endregion
export { apply, inject, name };