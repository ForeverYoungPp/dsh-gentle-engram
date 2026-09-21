import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/config.ts
const KNOWN_KEYS = new Set([
	"binary",
	"url",
	"port",
	"contextLimit",
	"captureToolResults",
	"capturePrompts",
	"requestTimeoutMs",
	"startupTimeoutMs",
	"fetchMaxAttempts"
]);
/** Defaults for every non-environment field. */
const DEFAULT_CONFIG = {
	binary: "engram",
	url: void 0,
	port: 7437,
	contextLimit: 8e3,
	captureToolResults: true,
	capturePrompts: true,
	requestTimeoutMs: 3e3,
	startupTimeoutMs: 1e4,
	fetchMaxAttempts: 3
};
/** Env override helper: first non-blank value wins. */
function envString(name$1) {
	const value = process.env[name$1]?.trim();
	return value !== void 0 && value.length > 0 ? value : void 0;
}
function envPort() {
	const raw = envString("ENGRAM_PORT");
	if (raw === void 0) return void 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : void 0;
}
/** Keep an override only when it is the right primitive and finite. */
function pickNumber(raw, fallback, min, max) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	const value = Math.trunc(raw);
	return value >= min && value <= max ? value : fallback;
}
function pickBoolean(raw, fallback) {
	return typeof raw === "boolean" ? raw : fallback;
}
function pickString(raw, fallback) {
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback;
}
/**
* Resolve raw plugin config plus environment into a complete configuration.
* Unknown keys are reported so a typo in `cordis.patch.yml` is visible rather
* than silently ignored.
*
* @param raw - the config object handed to the plugin.
* @param warn - diagnostic sink for unknown keys.
*/
function resolveConfig(raw, warn) {
	const source = raw ?? {};
	for (const key of Object.keys(source)) if (!KNOWN_KEYS.has(key)) warn(`unknown config key "${key}" was ignored`);
	const url = envString("ENGRAM_URL") ?? (typeof source.url === "string" && source.url.trim().length > 0 ? source.url.trim() : void 0);
	return {
		binary: envString("ENGRAM_BIN") ?? pickString(source.binary, DEFAULT_CONFIG.binary),
		url,
		port: envPort() ?? pickNumber(source.port, DEFAULT_CONFIG.port, 1, 65535),
		contextLimit: pickNumber(source.contextLimit, DEFAULT_CONFIG.contextLimit, 200, 2e5),
		captureToolResults: pickBoolean(source.captureToolResults, DEFAULT_CONFIG.captureToolResults),
		capturePrompts: pickBoolean(source.capturePrompts, DEFAULT_CONFIG.capturePrompts),
		requestTimeoutMs: pickNumber(source.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 100, 12e4),
		startupTimeoutMs: pickNumber(source.startupTimeoutMs, DEFAULT_CONFIG.startupTimeoutMs, 500, 3e5),
		fetchMaxAttempts: pickNumber(source.fetchMaxAttempts, DEFAULT_CONFIG.fetchMaxAttempts, 1, 8)
	};
}

//#endregion
//#region src/capture.ts
/** How one compaction archive ended. */
const ArchiveOutcome = {
	Confirmed: "confirmed",
	Failed: "failed",
	Unknown: "unknown",
	Unavailable: "unavailable"
};
/** Topic key that marks an observation as compaction-recovery state. */
const COMPACTION_TOPIC_KEY = "session/compaction-recovery";
/**
* Flatten content blocks to text. DSH's `compaction/summary` payload carries
* `data.summary` as `ContentBlock[]`, not as a string.
*/
function blocksToText(blocks) {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	return blocks.map((block) => {
		if (typeof block === "string") return block;
		if (block === null || typeof block !== "object") return "";
		const candidate = block;
		return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
	}).filter((part) => part.length > 0).join("\n").trim();
}
/** Archive a session summary as an observation. */
async function archiveSummary(client, state, project, content, topicKey) {
	return client.request("/observations", {
		method: "POST",
		body: {
			session_id: state.engramSessionId,
			project,
			type: "session_summary",
			title: "Session summary",
			content,
			scope: "project",
			...topicKey === void 0 ? {} : { topic_key: topicKey }
		}
	});
}
/**
* Archive one compacted summary, mapping the transport outcome onto the
* taxonomy the guidance depends on.
*/
async function archiveCompaction(client, state, project, summary) {
	try {
		return (await client.requestResult("/observations", {
			method: "POST",
			body: {
				session_id: state.engramSessionId,
				project,
				type: "session_summary",
				title: "Compaction recovery summary",
				content: summary,
				scope: "project",
				topic_key: COMPACTION_TOPIC_KEY
			}
		})).timedOutMethod === void 0 ? ArchiveOutcome.Confirmed : ArchiveOutcome.Unknown;
	} catch {
		return ArchiveOutcome.Failed;
	}
}
/** Ask Engram for session-scoped recovery guidance. */
async function loadCompactionContext(client, state) {
	try {
		const context = (await client.request(`/context/compaction?session_id=${encodeURIComponent(state.engramSessionId)}`))?.context;
		return typeof context === "string" && context.trim().length > 0 ? context.trim() : void 0;
	} catch {
		return;
	}
}
function manualFallback(project) {
	return `CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:
The agent has access to Engram persistent memory through the mem_* tools.
FIRST ACTION REQUIRED: call mem_session_summary with the content of this compacted summary. Use project '${project}'. This preserves what was accomplished before compaction. Do this BEFORE any other work.`;
}
function persistedAcknowledgement(project) {
	return `The compaction recovery summary was already saved to Engram (${project}) by dsh-gentle-engram. No manual mem_session_summary call is needed for this compaction. Call mem_context if you need additional recent project memory.`;
}
function unknownArchiveInstruction(project) {
	return `Compaction recovery could not confirm whether the summary was saved to Engram (${project}). Do NOT retry and do NOT call mem_session_summary yet, because that could duplicate the summary. First verify with mem_search or mem_doctor; save it once only if it is absent.`;
}
function unavailableRecoveryInstruction() {
	return "CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\ndsh-gentle-engram could not safely confirm the runtime session and project, so it did not archive the summary. Before saving manually, verify the active Engram session and project with mem_current_project or mem_doctor. Save the summary once only after that verification.";
}
/**
* Build the guidance injected into the turn after a compaction.
*
* @param project - resolved project key, for attribution in the text.
* @param context - session-scoped recovery context, when Engram provided any.
* @param outcome - how the archive ended.
*/
function buildRecoveryNotice(project, context, outcome) {
	const instruction = outcome === ArchiveOutcome.Confirmed ? persistedAcknowledgement(project) : outcome === ArchiveOutcome.Unknown ? unknownArchiveInstruction(project) : outcome === ArchiveOutcome.Unavailable ? unavailableRecoveryInstruction() : manualFallback(project);
	return `${context === void 0 ? "" : `${context}\n\n`}${instruction}`;
}
/** Log a background capture failure without surfacing it as a tool error. */
function warnCapture(logger, what, error) {
	logger.warn(`engram ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
}

//#endregion
//#region src/redaction.ts
/**
* Explicit-private-block redaction for everything this plugin sends to Engram.
*
* Ported from the upstream Pi adapter (`private-redaction.js`). Upstream is
* explicit that this is a convenience convention, **not** a secret scanner:
* it only removes content the user deliberately wrapped in `<private>` tags.
* We deliberately do NOT guess at credentials with regexes — the previous
* version of this plugin dropped any line matching /password|token|secret/i,
* which both missed real secrets and discarded useful code.
*
* @module dsh-gentle-engram/redaction
*/
const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi;
/** Replace every explicit private block with a marker. */
function redactPrivateTags(value) {
	return value.replace(PRIVATE_TAG_PATTERN, "[REDACTED]");
}
/**
* Redact a relative URL path, including decoded query values, so a private
* block cannot leak through a query string.
*/
function redactUrlPath(path) {
	const redacted = redactPrivateTags(path);
	try {
		const url = new URL(redacted, "http://engram.local");
		const params = new URLSearchParams();
		for (const [key, value] of url.searchParams.entries()) params.append(key, redactPrivateTags(value));
		const query = params.toString();
		return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
	} catch {
		return redacted;
	}
}
/**
* Recursively redact strings in an outgoing payload. Object and array shape is
* preserved; non-string primitives pass through unchanged.
*/
function redactValue(value) {
	if (typeof value === "string") return redactPrivateTags(value);
	if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(value)) out[key] = redactValue(entry);
		return out;
	}
	return value;
}
/** Redact and trim captured text before it becomes a payload field. */
function redactText(value) {
	return redactPrivateTags(value).trim();
}

//#endregion
//#region src/engram/errors.ts
/**
* Error shapes for the Engram HTTP transport, plus the classifiers the
* lifecycle logic needs to tell "nothing is listening" apart from "something
* answered but is unwell" and from "we do not know".
*
* @module dsh-gentle-engram/engram/errors
*/
/** A response arrived with a non-2xx status. */
var EngramHttpError = class extends Error {
	status;
	data;
	constructor(message, status, data) {
		super(message);
		this.name = "EngramHttpError";
		this.status = status;
		this.data = data;
	}
};
/** A request exceeded its timeout budget; the write may already have landed. */
var EngramTimeoutError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "EngramTimeoutError";
	}
};
/** Node reports an aborted or expired request through these names. */
function isTimeoutError(error) {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
/**
* Node reports a refused localhost connection through several shapes: a bare
* Error whose message is the refusal, a wrapper whose `cause` carries `code`,
* and — when the host resolves to both ::1 and 127.0.0.1 — an AggregateError
* whose per-address `errors` carry it while the aggregate itself carries none.
* Walk all of them, and read `code` through the prototype chain.
*/
function hasConnectionRefusedCode(value, depth = 0) {
	if (depth > 4 || value === null || typeof value !== "object") return false;
	const record = value;
	if (record.code === "ECONNREFUSED") return true;
	const errors = record.errors;
	if (Array.isArray(errors) && errors.some((entry) => hasConnectionRefusedCode(entry, depth + 1))) return true;
	return hasConnectionRefusedCode(record.cause, depth + 1);
}
/** Whether a transport failure proves nothing is listening. */
function isConnectionRefusedError(error) {
	return error instanceof Error && error.message === "connection refused" || hasConnectionRefusedCode(error);
}

//#endregion
//#region src/engram/client.ts
const HEALTH_TIMEOUT_MS = 500;
/**
* Whether replaying this request is safe. `POST /sessions` is included because
* Engram documents session creation as idempotent (INSERT OR IGNORE); every
* other write has no idempotency key.
*/
function isSafeToReplay(path, method) {
	return method === "GET" || method === "POST" && path === "/sessions";
}
function wait$1(ms) {
	return new Promise((resolve$1) => {
		setTimeout(resolve$1, ms).unref?.();
	});
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Build the transport for one resolved configuration.
*
* @param config - resolved plugin configuration.
* @param logger - diagnostic sink; every background failure is reported here.
*/
function createClient(config, logger) {
	const baseUrl = config.url ?? `http://127.0.0.1:${config.port}`;
	let recovery;
	async function attempt(path, options) {
		const method = options.method ?? "GET";
		const timeout = AbortSignal.timeout(config.requestTimeoutMs);
		const signal = options.signal === void 0 ? timeout : AbortSignal.any([options.signal, timeout]);
		try {
			return { response: await fetch(`${baseUrl}${redactUrlPath(path)}`, {
				method,
				headers: options.body === void 0 ? void 0 : { "Content-Type": "application/json" },
				body: options.body === void 0 ? void 0 : JSON.stringify(redactValue(options.body)),
				signal
			}) };
		} catch (error) {
			return { failure: error };
		}
	}
	/** Decode a completed response, preserving a JSON `null` as success. */
	async function decode(response) {
		let data = null;
		if (response.status !== 204) try {
			data = await response.json();
		} catch (error) {
			if (response.ok) throw error;
		}
		if (!response.ok) {
			const record = data !== null && typeof data === "object" ? data : void 0;
			throw new EngramHttpError(typeof record?.error === "string" ? record.error : `Engram request failed with HTTP ${response.status}`, response.status, data);
		}
		return data;
	}
	async function requestResult(path, options = {}) {
		const method = options.method ?? "GET";
		let recovered = false;
		for (let attemptIndex = 0; attemptIndex < config.fetchMaxAttempts; attemptIndex += 1) {
			const outcome = await attempt(path, options);
			if ("response" in outcome) return { data: await decode(outcome.response) };
			const error = outcome.failure;
			if (isTimeoutError(error)) return {
				data: null,
				timedOutMethod: method
			};
			if (isConnectionRefusedError(error) && !recovered && await recoverOnce()) {
				recovered = true;
				attemptIndex -= 1;
				continue;
			}
			if (!isSafeToReplay(path, method) || attemptIndex === config.fetchMaxAttempts - 1) throw error;
			await wait$1(250 * 2 ** attemptIndex);
		}
		throw new EngramTimeoutError(`Engram request to ${redactUrlPath(path)} exhausted its attempts`);
	}
	let recoveryInFlight;
	async function recoverOnce() {
		if (recovery === void 0) return false;
		recoveryInFlight ??= recovery().finally(() => {
			recoveryInFlight = void 0;
		});
		return recoveryInFlight;
	}
	return {
		baseUrl,
		async request(path, options) {
			const result = await requestResult(path, options);
			if (result.timedOutMethod !== void 0) throw new EngramTimeoutError(`Engram ${result.timedOutMethod} ${redactUrlPath(path)} timed out after ${config.requestTimeoutMs}ms`);
			return result.data;
		},
		requestResult,
		async bestEffort(path, options) {
			try {
				return await this.request(path, options);
			} catch (error) {
				logger.warn(`engram background capture to ${redactUrlPath(path)} failed: ${messageOf(error)}`);
				return null;
			}
		},
		async probeHealth() {
			try {
				return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok ? "ready" : "indeterminate";
			} catch (error) {
				if (isTimeoutError(error)) return "indeterminate";
				if (isConnectionRefusedError(error) || hasConnectionRefusedCode(error)) return "refused";
				return "indeterminate";
			}
		},
		setRecovery(next) {
			recovery = next;
		}
	};
}

//#endregion
//#region src/engram/project.ts
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function asStringList(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
/** Sources the first-party clients accept as proof of a real detection. */
const TRUSTED_SOURCES = new Set([
	"config",
	"git_remote",
	"git_root",
	"git_child",
	"dir_basename",
	"process_override"
]);
/**
* Accept a detected project only when Engram reports no hint of trouble. A soft
* 200 carrying `error_hint` is a failure: the first-party clients reject it too.
*/
function isSafeDetectedProject(envelope) {
	const candidate = asString(envelope.project);
	if (candidate === void 0) return void 0;
	if (candidate.toLowerCase() === "unknown") return void 0;
	if (asString(envelope.error_hint) !== void 0) return void 0;
	if (/[\\/\u0000-\u001F\u007F]/.test(candidate)) return void 0;
	const source = asString(envelope.project_source);
	if (source !== void 0 && !TRUSTED_SOURCES.has(source)) return void 0;
	return candidate;
}
/**
* Fallback used when a running server predates `GET /project/current`. Walks up
* from `cwd` looking for `.engram/config.json`, mirroring upstream's graceful
* degradation for version skew.
*/
function detectLocalConfigProject(cwd) {
	let current = resolve(cwd || ".");
	for (;;) {
		const configPath = `${current}/.engram/config.json`;
		if (existsSync(configPath)) try {
			const project = asString(JSON.parse(readFileSync(configPath, "utf8")).project_name);
			if (project !== void 0) return {
				project,
				path: configPath
			};
		} catch {
			return;
		}
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
/** Human-actionable guidance for an unresolvable workspace. */
function ambiguityGuidance(available) {
	return "Engram could not determine which project this workspace belongs to. Add .engram/config.json with {\"project_name\": \"...\"} at the repository root, or start DeepSeek Harness inside a single repository." + (available.length > 0 ? ` Known projects: ${available.join(", ")}.` : "");
}
/**
* Resolve the project for one session workspace.
*
* @param client - transport.
* @param cwd - the session's absolute working directory.
*/
async function resolveProject(client, cwd) {
	const query = `?cwd=${encodeURIComponent(cwd)}`;
	let envelope;
	try {
		envelope = await client.request(`/project/current${query}`) ?? {};
	} catch (error) {
		if (error instanceof EngramHttpError && error.status === 404) {
			const local = detectLocalConfigProject(cwd);
			if (local !== void 0) return {
				kind: "resolved",
				project: local.project,
				source: "config"
			};
			return {
				kind: "pending",
				reason: "the running Engram server does not expose /project/current",
				available: []
			};
		}
		return {
			kind: "failed",
			reason: error instanceof Error ? error.message : String(error),
			available: []
		};
	}
	const project = isSafeDetectedProject(envelope);
	if (project !== void 0) return {
		kind: "resolved",
		project,
		source: asString(envelope.project_source) ?? "unknown"
	};
	const available = asStringList(envelope.available_projects);
	const hint = asString(envelope.error_hint) ?? asString(envelope.warning);
	if (hint !== void 0 || asString(envelope.project) !== void 0) return {
		kind: "failed",
		reason: hint ?? "Engram reported an unusable project",
		available
	};
	return {
		kind: "pending",
		reason: "Engram did not report a project for this directory",
		available
	};
}

//#endregion
//#region src/engram/server.ts
const STARTUP_POLL_MS = 100;
const STARTUP_RETRY_BASE_MS = 1e3;
const STARTUP_RETRY_MAX_MS = 6e4;
/** A sleep an abandoned readiness wait can cut short. */
function waitCancellable(ms, signal) {
	return new Promise((resolve$1) => {
		if (signal.aborted) {
			resolve$1();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve$1();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve$1();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* A child we gave up on is terminated, not merely released. Unref'ing alone
* only detaches it from our event loop: the process stays alive, detached,
* answering nothing — and because startup is retried, every later attempt
* would add another one for the life of the host.
*/
function stopAbandonedChild(child) {
	if (child === void 0) return;
	try {
		child.kill("SIGTERM");
	} catch {}
	child.unref();
}
/**
* Create the startup owner for one resolved configuration.
*
* @param config - resolved plugin configuration.
* @param client - transport used for health probes.
* @param logger - diagnostic sink.
*/
function createServerManager(config, client, logger) {
	let initialization;
	let startupFailures = 0;
	let startupRetryAt = 0;
	let startupFailure;
	let initializationGeneration = 0;
	let recoveredGeneration = 0;
	let recoveryFlight;
	let disposed = false;
	function startupBackoffMs(failures) {
		return Math.min(STARTUP_RETRY_MAX_MS, STARTUP_RETRY_BASE_MS * 2 ** (failures - 1));
	}
	async function waitForReadiness(signal, deadline) {
		while (Date.now() < deadline) {
			if (signal.aborted) throw new Error(`Engram readiness wait for ${client.baseUrl} was cancelled`);
			if (await client.probeHealth() === "ready") return;
			if (signal.aborted) throw new Error(`Engram readiness wait for ${client.baseUrl} was cancelled`);
			await waitCancellable(STARTUP_POLL_MS, signal);
		}
		throw new Error(`Engram server at ${client.baseUrl} did not become ready before the startup timeout`);
	}
	function spawnAndWait(deadline) {
		return new Promise((resolvePromise, rejectPromise) => {
			let child;
			let settled = false;
			const readiness = new AbortController();
			const settle = (error) => {
				if (settled) return;
				settled = true;
				readiness.abort();
				child?.removeListener("error", onError);
				child?.removeListener("exit", onExit);
				if (error !== void 0) {
					stopAbandonedChild(child);
					rejectPromise(error);
					return;
				}
				child?.unref();
				resolvePromise();
			};
			const onError = (error) => settle(/* @__PURE__ */ new Error(`Engram server failed before readiness: ${error.message}`));
			const onExit = (code, signal) => settle(/* @__PURE__ */ new Error(`Engram server exited before readiness (code ${code ?? "unknown"}, signal ${signal ?? "none"})`));
			try {
				child = spawn(config.binary, ["serve"], {
					windowsHide: true,
					detached: true,
					stdio: "ignore"
				});
			} catch (error) {
				settle(error instanceof Error ? error : /* @__PURE__ */ new Error("Engram server could not start"));
				return;
			}
			child.once("error", onError);
			child.once("exit", onExit);
			child.once("spawn", () => {
				waitForReadiness(readiness.signal, deadline).then(() => settle(), (error) => settle(error instanceof Error ? error : new Error(String(error))));
			});
		});
	}
	async function initialize() {
		if (config.url !== void 0) return;
		const deadline = Date.now() + config.startupTimeoutMs;
		const health = await client.probeHealth();
		if (health === "ready") return;
		try {
			await spawnAndWait(deadline);
		} catch (error) {
			if (health !== "indeterminate") throw error;
			const readiness = new AbortController();
			try {
				await waitForReadiness(readiness.signal, deadline);
			} catch {
				throw error;
			} finally {
				readiness.abort();
			}
		}
	}
	/**
	* A failed startup stays retryable, but inside the backoff window the last
	* failure is replayed immediately: an unhealthy provider then costs one
	* backoff window rather than one full readiness budget per tool call, and a
	* failing session cannot spawn children without bound.
	*/
	function sharedInitialization() {
		if (initialization !== void 0) return initialization;
		if (startupFailure !== void 0 && Date.now() < startupRetryAt) return Promise.reject(startupFailure);
		initialization = initialize().then(() => {
			startupFailures = 0;
			startupRetryAt = 0;
			startupFailure = void 0;
			initializationGeneration += 1;
		}, (error) => {
			initialization = void 0;
			startupFailures += 1;
			startupFailure = error instanceof Error ? error : new Error(String(error));
			startupRetryAt = Date.now() + startupBackoffMs(startupFailures);
			throw startupFailure;
		});
		return initialization;
	}
	function recover() {
		const generation = initializationGeneration;
		if (config.url !== void 0 || generation === 0 || disposed) return Promise.resolve(false);
		const active = recoveryFlight;
		if (active?.generation === generation) return active.promise;
		if (recoveredGeneration === generation) return Promise.resolve(false);
		recoveredGeneration = generation;
		const promise = initialize().then(() => true, () => false).finally(() => {
			if (recoveryFlight?.generation === generation) recoveryFlight = void 0;
		});
		recoveryFlight = {
			generation,
			promise
		};
		return promise;
	}
	client.setRecovery(recover);
	return {
		async ensure() {
			if (disposed) return;
			try {
				await sharedInitialization();
			} catch (error) {
				logger.warn(`engram server unavailable at ${client.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
		},
		dispose() {
			disposed = true;
			recoveryFlight = void 0;
			client.setRecovery(void 0);
		}
	};
}

//#endregion
//#region src/protocol.ts
/**
* The Engram memory protocol injected into every model request.
*
* Adapted from the upstream Pi adapter's `MEMORY_INSTRUCTIONS`. It is delivered
* through `systemPrompt.context()`, which DSH re-projects after a surface
* replacement, so the protocol survives compaction without per-turn splicing.
*
* @module dsh-gentle-engram/protocol
*/
/** Ordered context-provider name. */
const PROTOCOL_CONTEXT_NAME = "engram:protocol";
/** Provider order: after tool guidance, before volatile runtime context. */
const PROTOCOL_CONTEXT_ORDER = 40;
const PROTOCOL_TEXT = `## Engram Persistent Memory — Protocol

You have access to Engram, a persistent memory system that survives across sessions and compactions. These instructions are injected by dsh-gentle-engram, the DeepSeek Harness memory provider. Use the memory tools named in this section as the authoritative memory contract; do not infer alternative tool names from other integrations.

### WHEN TO SAVE (mandatory — not optional)

Call \`mem_save\` IMMEDIATELY after any of these:
- Bug fix completed
- Architecture or design decision made
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

Format for \`mem_save\`:
- **title**: Verb + what — short, searchable
- **type**: bugfix | decision | architecture | discovery | pattern | config | preference
- **scope**: \`project\` (default) | \`personal\` | \`global\`
- **topic_key**: stable key for evolving decisions when relevant
- **content**:
  **What**: One sentence — what was done
  **Why**: What motivated it
  **Where**: Files or paths affected
  **Learned**: Gotchas, edge cases, things that surprised you

### DELIVERY GUARANTEE

Memory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.

### WHEN TO SEARCH MEMORY

When the user asks to recall past work:
1. Start with \`mem_context\`, then search with 1–2 distinctive keywords.
2. Ordinary \`mem_search\` is scoped to the detected active project; its default \`match_mode:"all"\` means AND. For broad recall, use \`match_mode:"any"\` with \`all_projects:true\`. If a scoped search is empty, retry once this way before concluding no memory exists.
3. After hits, narrow follow-up searches by project, type, or \`match_mode:"all"\`, then use \`mem_get_observation\` for full content.

### SESSION CLOSE PROTOCOL

Before ending a session or saying "done", call \`mem_session_summary\` with Goal, Instructions, Discoveries, Accomplished, Next Steps, and Relevant Files. If \`mem_session_summary\` fails because Engram cannot detect a project, ask the user which project should receive the summary, then retry with \`project: "<name>"\`.

### MULTI-REPOSITORY WORKSPACES

If memory tools report an ambiguous project, the working directory contains more than one repository. Ask the user which project should receive the memory, or add \`.engram/config.json\` with \`{"project_name": "..."}\` at the workspace root. Do not guess.

### AFTER COMPACTION

When outcome-specific compaction recovery guidance is present, follow it. If a compacted summary appears without that guidance, save it immediately with \`mem_session_summary\`, then call \`mem_context\` before continuing.`;
/** The static protocol text contributed to every assembly. */
function protocolText() {
	return PROTOCOL_TEXT;
}

//#endregion
//#region src/session.ts
/** Default bound for draining a session's writes at a turn boundary. */
const DRAIN_TIMEOUT_MS = 5e3;
/** Sleep for at most `ms`, unref'd so a pending drain never holds the process open. */
function wait(ms) {
	return new Promise((resolve$1) => {
		setTimeout(resolve$1, ms).unref?.();
	});
}
/**
* Create the registry.
*
* @param logger - diagnostic sink for dropped state.
*/
function createSessionRegistry(logger) {
	const states = /* @__PURE__ */ new Map();
	return {
		get(id) {
			return id === void 0 ? void 0 : states.get(id);
		},
		ensure(agent) {
			const existing = states.get(agent.id);
			if (existing !== void 0) return existing;
			const state = {
				id: agent.id,
				cwd: agent.session.header.cwd ?? process.cwd(),
				engramSessionId: agent.id,
				project: void 0,
				projectCheckedAt: 0,
				contextText: void 0,
				pendingNotice: void 0,
				registered: false,
				registeredAt: 0,
				ended: false,
				registration: void 0,
				startup: void 0,
				tail: Promise.resolve(),
				pending: 0,
				archivedCompactions: /* @__PURE__ */ new Set()
			};
			states.set(agent.id, state);
			return state;
		},
		forget(id) {
			if (states.delete(id)) logger.info(`engram: released session state for ${id}`);
		},
		enqueue(state, operation) {
			state.pending += 1;
			const run = state.tail.then(operation);
			state.tail = run.then(() => {
				state.pending -= 1;
			}, () => {
				state.pending -= 1;
			});
			return run;
		},
		async drain(state, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			while (state.pending > 0) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) return;
				await Promise.race([state.tail, wait(remaining)]);
			}
		}
	};
}

//#endregion
//#region src/tools.ts
/**
* One output declaration shared by every tool. `defineTool` rebuilds its
* wrapper per call, so sharing the object carries no identity requirement.
*/
const ENGRAM_OUTPUT = {
	schema: { type: "json" },
	render: (_args, value) => [{
		type: "text",
		text: renderValue(value)
	}]
};
function renderValue(value) {
	if (typeof value === "string") return value;
	if (value === null || value === void 0) return "(empty)";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
function queryString(params) {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === void 0 || value === null || value === "") continue;
		query.set(key, String(value));
	}
	const encoded = query.toString();
	return encoded.length > 0 ? `?${encoded}` : "";
}
/**
* Resolve the calling agent's session state and wait for its read-only warm-up
* (project resolution, context cache).
*
* This deliberately does NOT create the Engram session row. Reading memory is
* not a reason to leave a row behind, and an agent that never writes anything
* should not show up in Engram at all. Write paths use {@link sessionForWrite}.
*
* Lazily re-initialising matters in two cases: a tool call can win the race
* against the non-awaited `agent/session-start` notification, and a hot reload
* gives the plugin a fresh empty registry while the agent is still running.
*/
/**
* Fetch one Engram session row.
*
* @param client - the transport to use.
* @param sessionId - the Engram session key.
* @returns the row, `null` for an empty body, or `undefined` when Engram has no
* such session.
*/
async function fetchSessionRow(client, sessionId) {
	try {
		return await client.request(`/sessions/${encodeURIComponent(sessionId)}`);
	} catch (error) {
		if (error instanceof EngramHttpError && error.status === 404) return void 0;
		throw error;
	}
}
/** The row's `ended_at`, or `null` when the response carries none. */
function endedAtOf(row) {
	if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
	return row.ended_at ?? null;
}
async function sessionFor(exec, deps) {
	const agent = exec.agent;
	if (agent === void 0) throw new Error("Engram memory tools require an agent session");
	const state = deps.sessions.ensure(agent);
	await deps.startSession(agent);
	return state;
}
/**
* Resolve the session state and guarantee the Engram row exists.
*
* Engram enforces `FOREIGN KEY (session_id) REFERENCES sessions(id)` on both
* `observations` and `user_prompts`, so a write attributed to an unregistered
* session is rejected by the store. Failing here instead keeps the error
* legible, and a failed attempt is retried on the next call rather than being
* remembered as a success.
*/
async function sessionForWrite(exec, deps) {
	const state = await sessionFor(exec, deps);
	if (!await deps.ensureRegistered(state)) throw new Error("Engram memory is not available for this session yet: the session row could not be registered. Run mem_doctor to check the Engram server.");
	return state;
}
/** Fail-closed gate: no write without a resolved project. */
function requireProject(state) {
	const project = state.project;
	if (project === void 0) throw new Error("Engram project resolution has not completed for this workspace yet");
	if (project.kind === "resolved") return project.project;
	if (project.kind === "failed") throw new Error(`Engram cannot resolve this workspace's project: ${project.reason}. ${ambiguityGuidance(project.available)}`);
	throw new Error(`Engram project resolution is pending: ${project.reason}. ${ambiguityGuidance([])}`);
}
const optionalString = (description) => ({
	type: "string",
	description
});
const optionalNumber = (description) => ({
	type: "number",
	description
});
const optionalBoolean = (description) => ({
	type: "boolean",
	description
});
const requiredString = (description) => ({
	type: "string",
	required: true,
	description
});
const requiredNumber = (description) => ({
	type: "number",
	required: true,
	description
});
const SCOPE = "Scope: project (default), personal, or global.";
const MATCH_MODE = "Match mode: all (default, AND) or any (broader recall).";
/**
* Register every Engram tool in the calling scope.
*
* @param register - the tools registry's `register`.
* @param deps - resolved collaborators.
* @returns disposers for every registration.
*/
function registerTools(register, deps) {
	const { client, sessions } = deps;
	const disposers = [];
	const add = (definition) => {
		disposers.push(register(definition));
	};
	add(defineTool({
		name: "mem_save",
		description: "Save a durable memory to Engram. Call this proactively after a bug fix, an architecture or design decision, a non-obvious discovery, a configuration change, an established pattern, or a learned user preference — do not wait to be asked. Use the **What**/**Why**/**Where**/**Learned** structure in content.",
		parameters: {
			title: requiredString("Short, searchable title, e.g. \"Fixed FTS5 query sanitization\""),
			content: requiredString("Structured memory content"),
			type: optionalString("Category: bugfix, decision, architecture, discovery, pattern, config, preference"),
			scope: optionalString(SCOPE),
			topic_key: optionalString("Stable topic key so an evolving decision upserts instead of duplicating")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionForWrite(exec, deps);
			const project = requireProject(state);
			return deps.client.request("/observations", {
				method: "POST",
				signal: exec.signal,
				body: {
					session_id: state.engramSessionId,
					project,
					title: args.title,
					content: redactText(args.content),
					type: args.type ?? "manual",
					scope: args.scope ?? "project",
					...args.topic_key === void 0 ? {} : { topic_key: args.topic_key }
				}
			});
		}
	}));
	add(defineTool({
		name: "mem_search",
		description: "Search persistent Engram memory for past work, decisions, or context. Scoped to the active project unless all_projects is true. If a scoped search returns nothing, retry once with match_mode \"any\" and all_projects true before concluding no memory exists.",
		parameters: {
			query: requiredString("Search query — natural language or keywords"),
			type: optionalString("Filter by observation type"),
			scope: optionalString(SCOPE),
			limit: optionalNumber("Maximum results"),
			match_mode: optionalString(MATCH_MODE),
			all_projects: optionalBoolean("Search across every project; when true the project filter is ignored")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionFor(exec, deps);
			const project = args.all_projects === true ? void 0 : requireProject(state);
			return deps.client.request(`/search${queryString({
				q: args.query,
				type: args.type,
				scope: args.scope,
				limit: args.limit,
				match_mode: args.match_mode,
				project,
				all_projects: args.all_projects
			})}`, { signal: exec.signal });
		}
	}));
	add(defineTool({
		name: "mem_context",
		description: "Read recent memory context from previous sessions in the active project. Call this at session start or after a compaction.",
		parameters: { scope: optionalString(SCOPE) },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionFor(exec, deps);
			return deps.client.request(`/context${queryString({
				project: requireProject(state),
				scope: args.scope
			})}`, { signal: exec.signal });
		}
	}));
	add(defineTool({
		name: "mem_session_summary",
		description: "Save an end-of-session summary. Call this before ending a session or saying \"done\", using the Goal / Instructions / Discoveries / Accomplished / Next Steps / Relevant Files structure. Discoveries is the most valuable section.",
		parameters: { content: requiredString("Full session summary in the documented structure") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionForWrite(exec, deps);
			return deps.summarize(state, args.content);
		}
	}));
	add(defineTool({
		name: "mem_session_start",
		description: "Report and ensure the Engram session binding for this session. The plugin owns session identity, so no identifier is accepted.",
		parameters: {},
		output: ENGRAM_OUTPUT,
		execute: async (_args, exec) => {
			const state = await sessionForWrite(exec, deps);
			const project = requireProject(state);
			return {
				session_id: state.engramSessionId,
				project,
				directory: state.cwd,
				registered: state.registered
			};
		}
	}));
	add(defineTool({
		name: "mem_session_end",
		description: "Mark this Engram session as completed, with an optional summary. The plugin closes sessions on its own; call this only when the user explicitly ends the work. A later memory write starts a new Engram session instead of reopening this one.",
		parameters: { summary: optionalString("Summary of what was accomplished") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionFor(exec, deps);
			const sessionId = state.engramSessionId;
			const row = await fetchSessionRow(deps.client, sessionId);
			if (row === void 0 || row === null) {
				state.registered = false;
				state.ended = false;
				return {
					ended: false,
					session_id: sessionId,
					note: "No Engram session existed for this session yet, so there was nothing to end."
				};
			}
			if (endedAtOf(row) !== null) {
				state.ended = true;
				state.registered = false;
				return {
					ended: false,
					session_id: sessionId,
					note: "This Engram session had already ended; its summary and end time were left untouched."
				};
			}
			const ended = await deps.sessions.enqueue(state, async () => deps.client.request(`/sessions/${encodeURIComponent(sessionId)}/end`, {
				method: "POST",
				signal: exec.signal,
				body: { summary: args.summary === void 0 ? "" : redactText(args.summary) }
			}));
			state.ended = true;
			state.registered = false;
			return ended;
		}
	}));
	add(defineTool({
		name: "mem_get_observation",
		description: "Fetch the full, untruncated content of one memory by id, after a search returned a truncated preview.",
		parameters: { id: requiredNumber("Observation id to retrieve") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request(`/observations/${encodeURIComponent(String(args.id))}`, { signal: exec.signal })
	}));
	add(defineTool({
		name: "mem_suggest_topic_key",
		description: "Suggest a stable topic key for an observation, so later saves on the same subject upsert instead of accumulating duplicates.",
		parameters: {
			title: optionalString("Observation title"),
			type: optionalString("Observation type/category"),
			content: optionalString("Observation content")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request("/topic-keys/suggest", {
			method: "POST",
			signal: exec.signal,
			body: {
				title: args.title,
				type: args.type,
				content: args.content
			}
		})
	}));
	add(defineTool({
		name: "mem_capture_passive",
		description: "Send text to Engram for passive extraction of structured learnings. Engram decides what is worth persisting; raw output is not stored as an observation by itself.",
		parameters: {
			content: requiredString("Text that may contain learnings, ideally with a \"## Key Learnings\" section"),
			source: optionalString("Source identifier, e.g. the originating tool name")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionForWrite(exec, deps);
			const project = requireProject(state);
			return deps.client.request("/observations/passive", {
				method: "POST",
				signal: exec.signal,
				body: {
					session_id: state.engramSessionId,
					project,
					content: redactText(args.content),
					source: args.source ?? "dsh-tool"
				}
			});
		}
	}));
	add(defineTool({
		name: "mem_save_prompt",
		description: "Record what the user asked for, so a future session understands their intent. The plugin already captures prompts automatically; call this only to preserve something the automatic capture missed.",
		parameters: { content: requiredString("The user's prompt text") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionForWrite(exec, deps);
			const project = requireProject(state);
			return deps.client.request("/prompts", {
				method: "POST",
				signal: exec.signal,
				body: {
					session_id: state.engramSessionId,
					project,
					content: redactText(args.content).slice(0, 2e3)
				}
			});
		}
	}));
	add(defineTool({
		name: "mem_update",
		description: "Correct an existing memory in place by id. Only the fields you provide change.",
		parameters: {
			id: requiredNumber("Observation id to update"),
			title: optionalString("New title"),
			content: optionalString("New content"),
			type: optionalString("New type/category"),
			scope: optionalString(SCOPE),
			topic_key: optionalString("New topic key")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request(`/observations/${encodeURIComponent(String(args.id))}`, {
			method: "PATCH",
			signal: exec.signal,
			body: {
				title: args.title,
				content: args.content,
				type: args.type,
				scope: args.scope,
				topic_key: args.topic_key
			}
		})
	}));
	add(defineTool({
		name: "mem_current_project",
		description: "Detect which Engram project this workspace resolves to, and list the known alternatives when it is ambiguous. Call this before saving when the workspace contains several repositories.",
		parameters: { cwd: optionalString("Directory to inspect; defaults to this session's working directory") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionFor(exec, deps);
			const cwd = args.cwd ?? state.cwd;
			return deps.client.request(`/project/current${queryString({ cwd })}`, { signal: exec.signal });
		}
	}));
	add(defineTool({
		name: "mem_judge",
		description: "Record a verdict on a pending memory conflict that Engram flagged.",
		parameters: {
			judgment_id: requiredString("The relation judgment_id returned with a save response"),
			relation: requiredString("Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict"),
			reason: optionalString("Free-text explanation of the verdict"),
			evidence: optionalString("Supporting evidence"),
			confidence: optionalNumber("Confidence score 0.0..1.0")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request("/conflicts/judge", {
			method: "POST",
			signal: exec.signal,
			body: {
				judgment_id: args.judgment_id,
				relation: args.relation,
				reason: args.reason,
				evidence: args.evidence,
				confidence: args.confidence
			}
		})
	}));
	add(defineTool({
		name: "mem_compare",
		description: "Persist a semantic verdict you have already reached about how two memories relate.",
		parameters: {
			memory_id_a: requiredNumber("Id of the first observation"),
			memory_id_b: requiredNumber("Id of the second observation"),
			relation: requiredString("Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict"),
			confidence: requiredNumber("Confidence score 0.0..1.0"),
			reasoning: requiredString("Brief explanation of the verdict"),
			model: optionalString("Model identifier for provenance")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request("/conflicts/compare", {
			method: "POST",
			signal: exec.signal,
			body: {
				memory_id_a: args.memory_id_a,
				memory_id_b: args.memory_id_b,
				relation: args.relation,
				confidence: args.confidence,
				reasoning: args.reasoning,
				model: args.model
			}
		})
	}));
	add(defineTool({
		name: "mem_doctor",
		description: "Run Engram operational diagnostics for the active project. Use this when memory operations fail or return nothing unexpectedly.",
		parameters: { check: optionalString("Optional diagnostic check code to run") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionFor(exec, deps);
			const project = state.project?.kind === "resolved" ? state.project.project : void 0;
			return deps.client.request(`/doctor${queryString({
				project,
				check: args.check
			})}`, { signal: exec.signal });
		}
	}));
	add(defineTool({
		name: "mem_review",
		description: "List memories whose review interval has elapsed, or mark one as reviewed to reset its clock.",
		parameters: {
			action: requiredString("Action: list | mark_reviewed"),
			observation_id: optionalNumber("Observation id, for action=mark_reviewed"),
			limit: optionalNumber("Maximum results, for action=list")
		},
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => {
			const state = await sessionFor(exec, deps);
			const project = state.project?.kind === "resolved" ? state.project.project : void 0;
			if (args.action === "list") return deps.client.request(`/review${queryString({
				project,
				limit: args.limit
			})}`, { signal: exec.signal });
			if (args.action === "mark_reviewed") {
				if (args.observation_id === void 0) throw new Error("observation_id is required for action=mark_reviewed");
				return deps.client.request(`/review/mark_reviewed${queryString({ project: requireProject(state) })}`, {
					method: "POST",
					signal: exec.signal,
					body: { observation_id: args.observation_id }
				});
			}
			throw new Error("action must be one of: list, mark_reviewed");
		}
	}));
	add(defineTool({
		name: "mem_pin",
		description: "Pin a memory so it appears before recent observations in memory context. Pin state is local to this machine.",
		parameters: { id: requiredNumber("Observation id to pin") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request(`/observations/${encodeURIComponent(String(args.id))}/pin`, {
			method: "PUT",
			signal: exec.signal
		})
	}));
	add(defineTool({
		name: "mem_unpin",
		description: "Unpin a memory so it returns to normal recency order.",
		parameters: { id: requiredNumber("Observation id to unpin") },
		output: ENGRAM_OUTPUT,
		execute: async (args, exec) => deps.client.request(`/observations/${encodeURIComponent(String(args.id))}/pin`, {
			method: "DELETE",
			signal: exec.signal
		})
	}));
	return disposers;
}

//#endregion
//#region src/index.ts
const name = "dsh-gentle-engram";
const inject = ["tools"];
/** Tool names owned by this plugin; excluded from passive capture. */
const OWN_TOOL_NAMES = new Set([
	"mem_save",
	"mem_search",
	"mem_context",
	"mem_session_summary",
	"mem_session_start",
	"mem_session_end",
	"mem_get_observation",
	"mem_suggest_topic_key",
	"mem_capture_passive",
	"mem_save_prompt",
	"mem_update",
	"mem_current_project",
	"mem_judge",
	"mem_compare",
	"mem_doctor",
	"mem_review",
	"mem_pin",
	"mem_unpin"
]);
/**
* How long a *failed* project resolution is trusted before it is retried.
*
* A resolved project is final for the session; a failure is not. Adding
* `.engram/config.json` to an ambiguous workspace mid-session has to take
* effect without a restart, so a failure expires instead of being cached for
* the session's life.
*/
const PROJECT_RETRY_MS = 3e4;
/**
* How long Engram's confirmation of the session row is trusted before it is
* checked again.
*
* `registered` used to be cached for the life of the process, so a row removed
* behind the plugin's back (`engram delete session`, a CLI end) left the
* session 404ing every write until a reload. One re-check per minute per session
* closes that, and the same check re-creates a row that was deleted.
*/
const REGISTRATION_TTL_MS = 6e4;
/** Upper bound for one passively captured tool result, mirroring the prompt cap. */
const PASSIVE_CAPTURE_LIMIT = 2e4;
/**
* Engram's passive extractor only reads items from a `## Key Learnings`
* section (`## Learnings` and `## Aprendizajes Clave` also count); anything
* else is parsed, discarded, and still costs a request, a queue slot and — since
* capture registers first — an Engram session row. Mirrors
* `learningHeaderPattern` in Engram's `internal/store/store.go`.
*/
const LEARNING_SECTION = /^#{2,3}\s+(?:Aprendizajes(?:\s+Clave)?|Key\s+Learnings?|Learnings?):?\s*$/im;
/** Extract plain text from a user message's content blocks. */
function messageText(content) {
	if (!Array.isArray(content)) return "";
	return content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "").filter((part) => part.length > 0).join("\n").trim();
}
/** Extract text from a tool result, which may be blocks or a bare string. */
function resultText(result) {
	if (typeof result === "string") return result;
	if (result === null || typeof result !== "object") return "";
	return blocksToText(result.content);
}
/**
* Bound one injected block. Engram returns whole-session context with no size
* contract, and this text is contributed to every assembly, so an unbounded
* block would tax every request.
*/
function boundContext(text, limit) {
	if (text === void 0) return void 0;
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 60))}\n...[truncated by dsh-gentle-engram]`;
}
/** Read the context text Engram returns, which may be a string or a wrapper. */
function contextTextOf(response) {
	if (typeof response === "string") return response.trim() || void 0;
	if (response === null || typeof response !== "object") return void 0;
	const value = response.context;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig, (message) => ctx.logger.warn(`engram config: ${message}`));
	const client = createClient(config, ctx.logger);
	const server = createServerManager(config, client, ctx.logger);
	const sessions = createSessionRegistry(ctx.logger);
	const summarize = async (state, content) => {
		const project = state.project?.kind === "resolved" ? state.project.project : void 0;
		if (project === void 0) throw new Error(`Engram cannot resolve this workspace's project. ${ambiguityGuidance([])}`);
		return archiveSummary(client, state, project, redactText(content), void 0);
	};
	registerTools((definition) => ctx.tools.register(definition), {
		client,
		sessions,
		logger: ctx.logger,
		config,
		summarize,
		startSession,
		ensureRegistered
	});
	/**
	* Warm one session's read-only state: spawn/reuse the server, resolve the
	* project, then cache the context block.
	*
	* This writes nothing to Engram. It is driven by an `emit` lifecycle event
	* that the harness does not await, so it races the first model step by
	* design; the prompt provider tolerates an unwarmed cache and simply
	* contributes the protocol until the context arrives.
	*
	* `state.project` doubles as the warmed marker — the resolution is cached for
	* the session's life, exactly once, and a failed server ensure leaves it
	* unset so the next caller retries instead of remembering the failure.
	*/
	async function startState(state) {
		if (state.project?.kind === "resolved") return;
		if (state.project !== void 0 && Date.now() - state.projectCheckedAt < PROJECT_RETRY_MS) return;
		state.startup ??= (async () => {
			try {
				await server.ensure();
			} catch {
				return;
			}
			const resolution = await resolveProject(client, state.cwd);
			state.project = resolution;
			state.projectCheckedAt = Date.now();
			if (resolution.kind !== "resolved") {
				const available = resolution.kind === "failed" ? resolution.available : [];
				ctx.logger.warn(`engram: ${ambiguityGuidance(available)}`);
				return;
			}
			state.contextText = boundContext(contextTextOf(await client.bestEffort(`/context?project=${encodeURIComponent(resolution.project)}`)), config.contextLimit);
		})().finally(() => {
			state.startup = void 0;
		});
		return state.startup;
	}
	/** Warm the session state for one agent. */
	async function startSession(agent) {
		return startState(sessions.ensure(agent));
	}
	/**
	* Create the Engram session row on first use.
	*
	* Registration is deferred to the first write on purpose. This plugin used
	* to register every agent the harness publishes, whenever it publishes it,
	* which left an empty Engram session behind for every workspace the GUI had
	* merely reopened — and those empty rows compete with real sessions for the
	* fixed-size recent-sessions block that Engram injects. An agent that never
	* produces memory should not appear in Engram at all.
	*
	* A failed attempt is not remembered: `registered` only becomes true after
	* Engram acknowledges the row, so the next write retries.
	*
	* @param state - the calling agent's session state.
	* @returns whether the row exists.
	*/
	async function ensureRegistered(state) {
		const confirmed = state.registered;
		if (confirmed && Date.now() - state.registeredAt < REGISTRATION_TTL_MS) return true;
		if (state.project?.kind !== "resolved") return false;
		try {
			await registerSession(state, state.project.project);
		} catch (error) {
			warnCapture(ctx.logger, "session registration", error);
			return confirmed;
		}
		return state.registered;
	}
	/**
	* Register the Engram session row.
	*
	* The agent id doubles as the session key so a resumed session keeps its
	* binding. Engram's HTTP create path returns 201 for an id that has already
	* ended without clearing `ended_at`, which would strand the session as a
	* zombie, so an ended row is detected up front and replaced with a fresh key.
	*
	* The row can already be over in two ways: `mem_session_end` closed it
	* (`state.ended`), or something outside this plugin did, which only the row
	* itself can report. Both rotate the key.
	*/
	async function registerSession(state, project) {
		state.registration ??= (async () => {
			if (state.ended || await rowHasEnded(state.engramSessionId)) {
				ctx.logger.warn(`engram: session ${state.engramSessionId} had already ended; starting a fresh Engram session`);
				state.engramSessionId = randomUUID();
			}
			state.ended = false;
			await client.request("/sessions", {
				method: "POST",
				body: {
					id: state.engramSessionId,
					project,
					directory: state.cwd
				}
			});
			state.registered = true;
			state.registeredAt = Date.now();
		})().finally(() => {
			state.registration = void 0;
		});
		return state.registration;
	}
	/**
	* Whether Engram already closed this session row.
	*
	* Only a 404 is read as "no such row"; every other failure propagates. Swallow
	* a transport error here and the caller concludes "still open", reuses the
	* key, and Engram answers 201 without clearing `ended_at` — so the session
	* would file memories for the rest of the process's life while looking closed,
	* and nothing would say so.
	*/
	async function rowHasEnded(sessionId) {
		let existing;
		try {
			existing = await client.request(`/sessions/${encodeURIComponent(sessionId)}`);
		} catch (error) {
			if (error instanceof EngramHttpError && error.status === 404) return false;
			throw error;
		}
		return existing !== null && existing.ended_at !== null && existing.ended_at !== void 0;
	}
	/** Archive one compacted summary and queue its recovery guidance. */
	async function handleCompaction(sessionId, event) {
		const state = sessions.get(sessionId);
		if (state === void 0) return;
		const data = event.data ?? {};
		const compactionId = typeof data.compactionId === "string" ? data.compactionId : void 0;
		if (compactionId !== void 0 && state.archivedCompactions.has(compactionId)) return;
		if (compactionId !== void 0) state.archivedCompactions.add(compactionId);
		await startState(state);
		const summary = blocksToText(data.summary);
		const project = state.project?.kind === "resolved" ? state.project.project : void 0;
		let ready = false;
		if (project !== void 0 && summary.length > 0) ready = await ensureRegistered(state);
		if (project === void 0 || summary.length === 0 || !ready) {
			state.pendingNotice = buildRecoveryNotice(project ?? "unknown", void 0, ArchiveOutcome.Unavailable);
			return;
		}
		const outcome = await sessions.enqueue(state, async () => {
			if (!state.registered) await ensureRegistered(state);
			return {
				result: await archiveCompaction(client, state, project, summary),
				context: await loadCompactionContext(client, state)
			};
		});
		state.pendingNotice = buildRecoveryNotice(project, boundContext(outcome.context, config.contextLimit), outcome.result);
	}
	ctx.on("agent/session-start", ((payload) => {
		startSession(payload.agent).catch((error) => {
			warnCapture(ctx.logger, "session start", error);
		});
	}));
	ctx.on("session/event", ((session, event) => {
		if (event.type !== "compaction/summary") return;
		const sessionId = session.id;
		if (sessionId === void 0) return;
		if (sessions.get(sessionId) === void 0) {
			const cwd = session.header.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) {
				ctx.logger.warn(`engram: compaction for ${sessionId} arrived with no warm state and no recorded cwd; skipping the archive rather than guessing which project it belongs to`);
				return;
			}
			sessions.ensure({
				id: sessionId,
				session
			});
		}
		handleCompaction(sessionId, event).catch((error) => {
			warnCapture(ctx.logger, "compaction archive", error);
		});
	}));
	/**
	* Capture one user prompt, waiting for warm-up and registration first.
	*
	* Awaiting the gate is the whole point. A prompt arrives within microseconds
	* of the session being published — long before `GET /project/current` has
	* returned — so the previous synchronous `state.project` check silently
	* dropped the first prompt of every fast-starting agent, subagents above all.
	*
	* The whole gate runs as one queued unit, warm-up included. `drain` can only
	* see queued work, so a capture that was still spawning the server when the
	* turn ended used to look like no work at all — and the turn boundary is
	* exactly where the first capture of a session is most likely to still be
	* warming up.
	*/
	async function capturePrompt(state, text) {
		await sessions.enqueue(state, async () => {
			await startState(state);
			if (!await ensureRegistered(state)) return;
			const project = state.project?.kind === "resolved" ? state.project.project : void 0;
			await client.bestEffort("/prompts", {
				method: "POST",
				body: {
					session_id: state.engramSessionId,
					project,
					content: redactText(text).slice(0, 2e3)
				}
			});
		});
	}
	ctx.on("agent/inbox/inserted", ((payload) => {
		if (!config.capturePrompts) return;
		const agent = payload.agent;
		const message = payload.message;
		if (agent === void 0 || message === void 0) return;
		if (message.source?.kind !== "user") return;
		const text = messageText(message.content);
		if (text.length <= 10) return;
		capturePrompt(sessions.ensure(agent), text).catch((error) => warnCapture(ctx.logger, "prompt capture", error));
	}));
	/** Send one tool result to Engram's passive extractor, once it can be attributed. */
	async function captureResult(state, text, toolName) {
		await sessions.enqueue(state, async () => {
			await startState(state);
			if (!await ensureRegistered(state)) return;
			const project = state.project?.kind === "resolved" ? state.project.project : void 0;
			await client.bestEffort("/observations/passive", {
				method: "POST",
				body: {
					session_id: state.engramSessionId,
					project,
					content: redactText(text).slice(0, PASSIVE_CAPTURE_LIMIT),
					source: toolName
				}
			});
		});
	}
	ctx.on("tools/result", ((exec, result) => {
		if (!config.captureToolResults) return;
		const agent = exec.agent;
		const toolName = exec.name ?? "";
		if (agent === void 0 || OWN_TOOL_NAMES.has(toolName)) return;
		if (result !== null && typeof result === "object" && result.isError === true) return;
		const text = resultText(result);
		if (text.length <= 50) return;
		if (!LEARNING_SECTION.test(text)) return;
		captureResult(sessions.ensure(agent), text, toolName).catch((error) => warnCapture(ctx.logger, "passive capture", error));
	}));
	ctx.on("agent/turn-stopping", (async (payload) => {
		const state = sessions.get(payload.agent?.id);
		if (state === void 0) return;
		await sessions.drain(state, DRAIN_TIMEOUT_MS);
	}));
	ctx.on("agent/disposed", ((payload) => {
		const id = payload.agent?.id;
		if (id !== void 0) sessions.forget(id);
	}));
	ctx.inject(["systemPrompt"], (scope) => {
		scope.systemPrompt.context({
			name: PROTOCOL_CONTEXT_NAME,
			order: PROTOCOL_CONTEXT_ORDER,
			text: (context) => {
				const parts = [protocolText()];
				const state = context.agent === void 0 ? void 0 : sessions.get(context.agent.id);
				if (state !== void 0 && state.contextText !== void 0) parts.push(`### Recovered Engram memory for this project\n\n${state.contextText}`);
				if (state?.pendingNotice !== void 0) {
					parts.push(state.pendingNotice);
					state.pendingNotice = void 0;
				}
				return parts.join("\n\n");
			}
		});
	});
}

//#endregion
export { apply, inject, name };