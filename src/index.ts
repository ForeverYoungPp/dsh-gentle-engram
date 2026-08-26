import { randomUUID } from 'node:crypto'

type JsonRecord = Record<string, unknown>
type Agent = {
  id?: string
  session?: { requestHeader?: () => { cwd?: string } }
  inject: (message: UserMessage) => void
}
type UserMessage = {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'plugin'; plugin: string }
}
type ToolResult = JsonRecord & { content?: unknown }
type ToolExecution = { agent?: Agent; name: string }
type ToolRegistry = {
  get: (name: string, agent?: Agent) => unknown
  execute: (input: JsonRecord) => Promise<ToolResult>
}
type PromptRegistry = {
  section: (section: { name: string; order: number; text: string }) => unknown
}
type CordisContext = {
  tools: ToolRegistry
  logger?: { warn: (message: string) => void }
  get: (name: string) => unknown
  on: (event: string, listener: (...args: any[]) => unknown) => unknown
  provide: (name: string, value: unknown) => unknown
}
type Config = {
  serverName?: string
  contextLimit?: number
  captureToolResults?: boolean
}

export const name = 'dsh-gentle-engram'
export const inject = ['tools']

const DEFAULTS: Required<Config> = {
  serverName: 'engram',
  contextLimit: 8000,
  captureToolResults: true,
}

function createInjectedMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  }
}

function sessionIdOf(agent: Agent | undefined): string | undefined {
  return typeof agent?.id === 'string' ? agent.id : undefined
}

function directoryOf(agent: Agent | undefined): string | undefined {
  try {
    return agent?.session?.requestHeader?.()?.cwd || undefined
  } catch {
    return undefined
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as JsonRecord
  if (typeof record.text === 'string') return record.text
  if (Array.isArray(record.content)) {
    return record.content
      .filter((item): item is JsonRecord => !!item && typeof item === 'object' && (item as JsonRecord).type === 'text')
      .map((item) => typeof item.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 120))}\n...[truncated by dsh-gentle-engram]`
}

export function apply(ctx: CordisContext, rawConfig: Config = {}): void {
  const config = { ...DEFAULTS, ...rawConfig }
  const tools = ctx.tools
  const active = new Set<string>()
  const tails = new Map<string, Promise<unknown>>()

  const call = (agent: Agent | undefined, rawName: string, args: JsonRecord): Promise<ToolResult | undefined> => {
    const id = sessionIdOf(agent)
    if (!id || !agent) return Promise.resolve(undefined)
    const publicName = `mcp__${config.serverName}__${rawName}`
    if (!tools.get(publicName, agent)) return Promise.resolve(undefined)
    const operation = async (): Promise<ToolResult> => tools.execute({
      callId: `engram-${randomUUID()}`,
      name: publicName,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    const previous = tails.get(id) || Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    tails.set(id, next.finally(() => {
      if (tails.get(id) === next) tails.delete(id)
    }))
    return next.catch((error: unknown) => {
      ctx.logger?.warn(`engram ${rawName} failed for ${id}: ${String(error)}`)
      return undefined
    })
  }

  const contextText = async (agent: Agent): Promise<string> => {
    const result = await call(agent, 'mem_context', {})
    return bounded(textOf(result), config.contextLimit)
  }

  ctx.on('agent/session-start', (payload: { agent: Agent }) => {
    const { agent } = payload
    const id = sessionIdOf(agent)
    if (!id || active.has(id)) return
    active.add(id)
    const directory = directoryOf(agent)
    void call(agent, 'mem_session_start', { id, ...(directory ? { directory } : {}) }).then(async () => {
      const context = await contextText(agent)
      if (context) agent.inject(createInjectedMessage(`Relevant persistent Engram context for this session:\n\n${context}`))
    })
  })

  ctx.on('agent/inbox/inserted', (payload: { agent: Agent; message: unknown }) => {
    const content = textOf(payload.message)
    if (content.length <= 10 || content.includes('Relevant persistent Engram context')) return
    void call(payload.agent, 'mem_save_prompt', { content, session_id: sessionIdOf(payload.agent) })
  })

  ctx.on('tools/result', (exec: ToolExecution, result: unknown) => {
    if (!config.captureToolResults || !exec.agent || exec.name.startsWith(`mcp__${config.serverName}__`)) return
    const output = bounded(textOf(result), 4000)
    if (!output || /password|token|secret/i.test(output)) return
    void call(exec.agent, 'mem_capture_passive', {
      content: `## Key Learnings:\n- Tool ${exec.name} returned:\n\n${output}`,
      session_id: sessionIdOf(exec.agent),
      source: 'dsh-tools-result',
    })
  })

  ctx.on('agent/turn-stopping', (payload: { agent: Agent }) => tails.get(sessionIdOf(payload.agent) || '') || undefined)

  ctx.on('agent/disposed', (payload: { agent: Agent }) => {
    const id = sessionIdOf(payload.agent)
    if (!id) return
    void call(payload.agent, 'mem_session_summary', {
      content: `## Goal\nPreserve the completed DeepSeek Harness session in Engram.\n\n## Accomplished\n- Session lifecycle and relevant tool activity were captured automatically.\n\n## Next Steps\n- Review the session memories when continuing work.\n\n## Relevant Files\n- Session ${id}`,
      session_id: id,
    }).finally(() => call(payload.agent, 'mem_session_end', { id, summary: 'DeepSeek Harness session ended.' }))
    active.delete(id)
  })

  const systemPrompt = ctx.get('systemPrompt') as PromptRegistry | undefined
  systemPrompt?.section({
    name: 'engram:protocol',
    order: 40,
    text: 'Engram memory is available through the mcp__engram__mem_* tools. At session start use the recovered context; save concise structured observations after meaningful decisions, fixes, and discoveries; use progressive disclosure (search, timeline, full observation); never store secrets or entire noisy tool outputs.',
  })

  ctx.provide('engramMemory', {
    sessionIdOf,
    search: (agent: Agent, query: string) => call(agent, 'mem_search', { query }),
    save: (agent: Agent, args: JsonRecord) => call(agent, 'mem_save', { ...args, session_id: sessionIdOf(agent) }),
  })
}
