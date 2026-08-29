import { randomUUID } from "node:crypto";

//#region src/index.ts
const name = "dsh-gentle-engram";
const inject = ["tools"];
const DEFAULTS = {
	serverName: "engram",
	contextLimit: 8e3,
	captureToolResults: true
};
function createInjectedMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: name
		}
	};
}
function sessionIdOf(agent) {
	return typeof agent?.id === "string" ? agent.id : void 0;
}
function directoryOf(agent) {
	try {
		return agent?.session?.requestHeader?.()?.cwd || void 0;
	} catch {
		return;
	}
}
function textOf(value) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const record = value;
	if (typeof record.text === "string") return record.text;
	if (Array.isArray(record.content)) return record.content.filter((item) => !!item && typeof item === "object" && item.type === "text").map((item) => typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
	return "";
}
function bounded(text, limit) {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 120))}\n...[truncated by dsh-gentle-engram]`;
}
function apply(ctx, rawConfig = {}) {
	const config = {
		...DEFAULTS,
		...rawConfig
	};
	const tools = ctx.tools;
	const active = /* @__PURE__ */ new Set();
	const started = /* @__PURE__ */ new Set();
	const tails = /* @__PURE__ */ new Map();
	const call = (agent, rawName, args) => {
		const id = sessionIdOf(agent);
		if (!id || !agent) return Promise.resolve(void 0);
		const publicName = `mcp__${config.serverName}__${rawName}`;
		if (!tools.get(publicName, agent)) return Promise.resolve(void 0);
		const operation = async () => tools.execute({
			callId: `engram-${randomUUID()}`,
			name: publicName,
			arguments: args,
			agent,
			signal: new AbortController().signal
		});
		const next = (tails.get(id) || Promise.resolve()).catch(() => void 0).then(operation);
		const tail = next.finally(() => {
			if (tails.get(id) === tail) tails.delete(id);
		});
		tails.set(id, tail.catch(() => void 0));
		return next.catch((error) => {
			ctx.logger?.warn(`engram ${rawName} failed for ${id}: ${String(error)}`);
		});
	};
	const contextText = async (agent) => {
		return bounded(textOf(await call(agent, "mem_context", {})), config.contextLimit);
	};
	ctx.on("agent/session-start", (payload) => {
		const { agent } = payload;
		const id = sessionIdOf(agent);
		if (!id || active.has(id)) return;
		active.add(id);
		const directory = directoryOf(agent);
		call(agent, "mem_session_start", {
			id,
			...directory ? { directory } : {}
		}).then(async (result) => {
			if (!result) return;
			started.add(id);
			const context = await contextText(agent);
			if (context) agent.inject(createInjectedMessage(`Relevant persistent Engram context for this session:\n\n${context}`));
		});
	});
	ctx.on("agent/inbox/inserted", (payload) => {
		const content = textOf(payload.message);
		if (content.length <= 10 || content.includes("Relevant persistent Engram context")) return;
		call(payload.agent, "mem_save_prompt", {
			content,
			session_id: sessionIdOf(payload.agent)
		});
	});
	ctx.on("tools/result", (exec, result) => {
		if (!config.captureToolResults || !exec.agent || exec.name.startsWith(`mcp__${config.serverName}__`)) return;
		const output = bounded(textOf(result), 4e3);
		if (!output || /password|token|secret/i.test(output)) return;
		call(exec.agent, "mem_capture_passive", {
			content: `## Key Learnings:\n- Tool ${exec.name} returned:\n\n${output}`,
			session_id: sessionIdOf(exec.agent),
			source: "dsh-tools-result"
		});
	});
	ctx.on("agent/turn-stopping", (payload) => tails.get(sessionIdOf(payload.agent) || "") || void 0);
	ctx.on("agent/disposed", (payload) => {
		const id = sessionIdOf(payload.agent);
		if (!id) return;
		if (!started.has(id)) {
			active.delete(id);
			return;
		}
		call(payload.agent, "mem_session_summary", {
			content: `## Goal\nPreserve the completed DeepSeek Harness session in Engram.\n\n## Accomplished\n- Session lifecycle and relevant tool activity were captured automatically.\n\n## Next Steps\n- Review the session memories when continuing work.\n\n## Relevant Files\n- Session ${id}`,
			session_id: id
		}).finally(() => {
			started.delete(id);
			active.delete(id);
			return call(payload.agent, "mem_session_end", {
				id,
				summary: "DeepSeek Harness session ended."
			});
		});
	});
	ctx.get("systemPrompt")?.section({
		name: "engram:protocol",
		order: 40,
		text: "Engram memory is available through the mcp__engram__mem_* tools. At session start use the recovered context; save concise structured observations after meaningful decisions, fixes, and discoveries; use progressive disclosure (search, timeline, full observation); never store secrets or entire noisy tool outputs."
	});
	ctx.provide("engramMemory", {
		sessionIdOf,
		search: (agent, query) => call(agent, "mem_search", { query }),
		save: (agent, args) => call(agent, "mem_save", {
			...args,
			session_id: sessionIdOf(agent)
		})
	});
}

//#endregion
export { apply, inject, name };