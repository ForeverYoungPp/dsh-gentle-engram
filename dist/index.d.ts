//#region src/config.d.ts

/** Raw config as it appears in `cordis.patch.yml`. */
interface RawEngramConfig {
  readonly binary?: unknown;
  readonly url?: unknown;
  readonly port?: unknown;
  readonly contextLimit?: unknown;
  readonly captureToolResults?: unknown;
  readonly capturePrompts?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly startupTimeoutMs?: unknown;
  readonly fetchMaxAttempts?: unknown;
}
//#endregion
//#region src/engram/client.d.ts

/** Minimal logger seam; Cordis' logger satisfies it. */
interface Logger {
  warn(message: string): void;
  info(message: string): void;
}
//#endregion
//#region src/index.d.ts

declare const name = "dsh-gentle-engram";
declare const inject: string[];
/** Prompt-context provider input; `agent` is absent on diagnostics. */
interface AssembleContextLike {
  readonly agent?: {
    readonly id: string;
  };
}
interface SystemPromptService {
  context(entry: {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContextLike) => string);
  }): () => void;
}
/** The Cordis surface this plugin uses. */
interface PluginContext {
  readonly logger: Logger;
  readonly tools: {
    register(definition: unknown): () => void;
  };
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  inject(deps: readonly string[], callback: (scope: PluginContext & {
    readonly systemPrompt: SystemPromptService;
  }) => void): unknown;
}
declare function apply(ctx: PluginContext, rawConfig?: RawEngramConfig): void;
//#endregion
export { apply, inject, name };