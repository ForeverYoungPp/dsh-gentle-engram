# PI-PORT — pi 插件架构解剖 & DSH 侧对照设计

> 配套文档：`DESIGN.md`（DSH 侧全 HTTP 设计定稿）
> pi 源码：`~/.pi/agent/npm/node_modules/gentle-engram@0.1.12`（= Gentleman-Programming/engram `plugin/pi`）
> 本文件回答两件事：**pi 是怎么设计的**，**我们这边逐块怎么做**。
> 修订：经对抗式审核后修正 §4(a)/(d)、§5、§7.2、§7.4（见各节"审核修正"标记）。

---

## 0. 一句话

pi 那套是「**HTTP 单一真源 + 插件自持原生工具面 + 按身份严格 fail-closed**」。
我们照这个骨架做，但要把 pi 的**项目级全局状态**下沉到会话作用域——**注意：不是"pi 假设单会话"**，pi 作者明确检测会话身份歧义并 fail closed（见 §5）。

**与上游的关系（已纠正）**：pi 在 `cli.js:88-95` 与 `mcp-template.json:10` 里写了 `directTools: false`，但这是 **pi-mcp-adapter 的默认值，语义是 "Proxy only"（`README.md:654-658`）**——MCP 工具仍然可用，只是经单个 `mcp` proxy 工具暴露，**不是"上游主动关闭 MCP"**，代码里也没有任何"避免与 `mem_*` 重复"的注释。

可借鉴的真实点只有一条：**pi 不把 Engram 工具再注册成一套并列的一级工具面**。这不构成"上游支持全 HTTP"的论据——统一 HTTP 是本项目的产品决定（见 `DESIGN.md` §10 记录的审核异议）。

---

## 1. pi 的整体形状

一个 npm 包 `gentle-engram@0.1.12`：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `index.ts` | 1377 | 扩展本体：事件接线 + HTTP 客户端 + 服务器生命周期 + 19 个原生工具 |
| `compaction-recovery.js` | 106 | 压缩摘要抽取 + 4 结局恢复话术（纯函数） |
| `private-redaction.js` | 44 | `<private>` 递归脱敏（纯函数） |
| `memory-tool-chrome.js` | 155 | 工具调用的紧凑 UI 渲染（纯函数） |
| `cli.js` | 137 | `pi-engram init` 安装器 |

数据流：Pi 事件 + `mem_*` 工具 → gentle-engram → `ENGRAM_URL` (`engram serve`) → SQLite。
**持久化完全归 `engram serve` 所有**，插件自己不碰 SQLite。

---

## 2. pi 的八块设计

### 2.1 服务器生命周期 —— 最值得抄的一块

pi 不等外部服务，自己拉起 `engram serve`（`index.ts:460-676`）：

- `spawnDetached`：`{detached:true, stdio:'ignore'}`，`spawn` 事件后立刻 `unref()`。
- `spawnAndWaitForEngram`：一个 `AbortController` 从**所有**终止路径取消 readiness 轮询，`settle()` 保证只跑一次。
- **放弃的子进程要 kill，不能只 unref**（`:523-526`）："Unreffing alone only detaches it from our event loop: the process stays alive, detached, answering nothing — and because initialization is retried, every later attempt would add another one for the life of the session."
- `waitCancellable`（`:490-508`）：可被 abort 打断的 sleep，避免被遗弃的轮询用定时器**吊住整个宿主进程**。
- **共享启动预算**：deadline 是绝对值、传进去的，spawn 与随后的 fallback 等待共用同一个预算（`:510-511`）。
- **只有 `ready` 才算"有服务器"**（`:593-597`）：拒绝、超时、DNS 失败、无法识别的错误形状一律视为"没有"，去拉起一个。
- 不确定探测（`indeterminate`）时给另一个 Pi 实例一点宽限：spawn 失败后**共用剩余 deadline** 再等一次（`:598-615`）。确定被拒绝则不给宽限。
- `sharedInitialization`（`:630-655`）：**失败的启动保持可重试，但退避窗口内的调用者立刻拿到上次的失败**——"不让一个持续不健康的 provider 按工具调用次数反复收取完整的 readiness 预算"，同时限制失败会话能 spawn 出多少子进程。
- `recoverImplicitEngramServer`（`:657-676`）：初始化成功后若连接被拒，走**代（generation）级**的有界恢复，每个 generation 只重启一次，`recoveryFlight` 防止加入旧代。

### 2.2 HTTP 客户端（`index.ts:206-301`）

- 超时 3s、最多 3 次尝试、退避 250ms 起。
- **幂等感知重试**（`:125-129` `isSafeToReplay`）：只有 `GET` 和 `POST /sessions` 可重放。超时意味着请求**可能已经到达服务端**，而 `mem_save` 之类的写没有幂等键，重发就是重复写入。
- 超时不重试、直接返回 `{data:null, timedOutMethod}`，让调用方知道"写可能已生效"。
- 两种失败通道：`engramFetch`（严格，→ 模型可见的工具错误）与 `bestEffortEngramFetch`（`:294-301`，→ `warnEngramFailure` 打 stderr）。注释解释：静默丢弃会让"记忆停止工作"的用户**完全没有任何信号**。
- `scheduleEngramSelfHeal`：探测循环（5s × 6 次）恢复后清掉所有 session 的状态栏标签。

### 2.3 项目解析（`index.ts:303-341, 716-793`）

- `GET /project/current?cwd=` 最多重试 5 次（`:716-729`）。
- **404 降级**：老服务端没有该路由时回退到最近的 `.engram/config.json`，并附版本不匹配警告（`detectLocalConfigProject`，`:303-334`）。
- `isSafeDetectedProject`（`:731-742`）：拒绝 空 / `"unknown"` / 带 `error_hint` / 含路径分隔符或控制字符。
- **三态而不是二态**：`applyDetectedProject` 区分"已解析"、"待定（`projectDetectionPending`）"、"解析错误（`projectResolutionError`）"。
- **写入闸门**：`requireResolvedProject()`（`:775-778`）在待定或出错时**直接抛**。
- 兜底项目名 = 目录 basename 小写（`:439-441`），但**只用于显示**，不用于写入。

### 2.4 session 身份（`index.ts:822-865`）

- `requireRuntimeSessionID` 抛错而不是回退；且**不做 trim**——注释（`:826-828`）："Pi runtime session ID 是不透明的：空白校验但不归一化……在这里 trim 会劈开这个身份，并在关闭时留下孤立的缓存项。"
- `observeRuntimeSessionID` 记录所有见过的 ID；**一旦见过两个不同的 ID，就永久判定身份歧义**，压缩恢复直接失败关闭（`:837-838`）。
- `ensureSession`（`:690-714`）：按 `project:sessionId` 去重、**飞行中合并**（`sessionRegistrationsInFlight`）、`POST /sessions` 返回 `null` 视为无法确认注册而抛错。

### 2.5 工具面（`index.ts:871-973, 1249-1269`）

- 19 个原生工具，名字就是 `mem_*`（不带前缀）。
- Schema 用 typebox（`MEMORY_TOOL_SCHEMAS`）。
- `pi.registerTool({name, label, description, promptSnippet, parameters, renderShell:'self', execute, renderCall, renderResult})`。
- `execute` 里 `initOnce` **在受保护路径内**：被拒绝的启动必须以规范化的工具错误抵达 agent，而不是逃出工具边界的 rejection。
- 工具不接收模型传来的 `session_id` 作为权威——插件用 `runtimeSessionForWrite()` 自己注入。

### 2.6 系统提示协议（`index.ts:58-111, 1319-1346`）

- `MEMORY_INSTRUCTIONS` 是一大段 Markdown 协议（何时必须 `mem_save`、格式、何时搜索、会话关闭、压缩后怎么办）。
- 在 `before_agent_start` 里**每轮**拼到 systemPrompt 前面。这天然跨压缩存活。
- 关键句："Do not infer alternative Engram tool names from other integrations"。

### 2.7 压缩恢复（`index.ts:1289-1317` + `compaction-recovery.js`）

- `session_compact` → `extractCompactedSummary(event)` 沿 19 条字段路径找摘要（`compaction-recovery.js:1-23`）（`compactionEntry.summary` 优先）。
- **每个提前退出路径都先排好 fallback**：即便启动、项目解析或严格注册都够不到 Engram，**下一个 turn 也必须收到这个**。
- 归档：`POST /observations`，`type:"session_summary"`、`topic_key:"session/compaction-recovery"`。
- **4 种结局**（`compaction-recovery.js:25-105`）：`Confirmed` / `Failed` / `Unknown`（超时，**禁止盲目重试**，先 `mem_search`/`mem_doctor` 验证）/ `Unavailable`（session 或 project 无法确认，不尝试归档）。
- 通知存在 `pendingRecoveryNotice`（**带 sessionId**），在**下一次 `before_agent_start`** 消费一次后清空。
- 不认识的事件形状返回 `undefined` 而不是抛。

### 2.8 捕获、脱敏、UI

- **prompt 捕获**：`before_agent_start` 取真实 prompt，`stripPrivateTags(truncate(content, 2000))`，`POST /prompts`。仅当长度 > 10 且项目已解析。
- **passive 捕获**：`tool_execution_end` → 跳过 engram 工具 → 项目未解析则跳过 → `ensureSessionBestEffort` → 长度 ≤ 50 跳过 → 脱敏 → `POST /observations/passive`，`source: toolName`。**客户端不做"学习内容"判断**，交给服务端 parser。
- **脱敏**：`<private>…</private>` → `[REDACTED]`，递归作用于出站 JSON 每个字符串与 URL query 值。README 明说"这是便利约定，不是通用 secret 扫描器"。
- **UI chrome**：`🧠 search "auth model" …` / `↳ ✓ 4 results`。纯函数，便于测试。

---

## 3. 提炼：pi 的 12 条设计原则

1. **HTTP 是唯一真源**；Engram 的 MCP 工具不再注册成第二套**一级**工具（pi 用 adapter 默认的 `directTools:false` = Proxy only，工具仍可经 `mcp` proxy 访问）。
2. **身份 fail-closed**：session id 不自造、不归一化、不猜测。
3. **项目 fail-closed**：解析不出来就不写，且区分"待定"与"失败"两态。
4. **写闸门前置**：`requireResolvedProject()` 在每个写入工具的第一行。
5. **幂等感知重试**：只有 GET 和 `POST /sessions` 可重放；超时绝不盲目重发写。
6. **双失败通道**：面向模型的工具错误（严格）vs 后台捕获（best-effort + stderr 告警，**绝不静默**）。
7. **有界启动成本**：退避窗口内直接复用上次失败。
8. **代级恢复**：重启按 generation 限一次，防 spawn 风暴。
9. **绝不吊住宿主进程**：一切定时器 `unref`，sleep 可取消，放弃的子进程 kill 而非 unref。
10. **结局分类而非二值成败**：压缩归档 4 结局，Unknown 明确禁止盲目重试。
11. **指导话术本地化**：恢复话术是本地模板，不依赖服务端；形状不认识就优雅返回 undefined。
12. **脱敏是约定不是扫描器**：`<private>` 显式标记，不做正则猜测。

---

## 4. DSH 侧逐块对照

| pi 机制 | DSH 对应 | 差异/注意 |
| --- | --- | --- |
| `pi.on('session_start')` | `ctx.on('agent/session-start')` | **DSH 是 emit，不阻塞启动** → 注册与第一个 step 有竞态，读侧要容忍"未就绪" |
| `pi.on('session_compact')` | `ctx.on('session/event')` 过滤 `compaction/summary` | **DSH 监听器不被 await**（`session/src/index.ts:410-419`），归档必须自己兜错；`data.summary` 是 `ContentBlock[]` 而非 string |
| `pi.on('before_agent_start')` 返回增强 systemPrompt | `systemPrompt.context({name, order, text: (ctx) => string})` | 见下方 (a) |
| `pi.on('tool_execution_end')` | `ctx.on('tools/result')` | 同为观察型（emit、失败被吞），选它做 passive 捕获正确 |
| `pi.on('session_shutdown')` | `ctx.on('agent/disposed')` | **fire-and-forget**，且 `store.delete` 在 emit 之前 → 只清本地状态，不做必须落盘的写 |
| `pi.registerTool(...)` + typebox | `ctx.tools.register(defineTool({...}))` | DSH 的 `output` 是**运行时强制**的；18 个工具共用一个 `ENGRAM_OUTPUT`；任意 JSON 用 `{type:'json'}` 逃逸口 |
| `renderCall`/`renderResult` | `presentCall`/`presentResult` | 见下方 (d) |
| `ctx.ui.setStatus('engram', '🧠 …')` | `ctx.logger` + `presentResult` | DSH 没有全局状态栏 |
| `ENGRAM_URL`/`ENGRAM_BIN`/`ENGRAM_PORT` | 同 | 直接沿用上游环境变量约定 |
| `pi-engram init` 写 settings.json / mcp.json | `cordis.patch.yml`（插件自带） | DSH 用 bundle patch，不需要安装器 |

### 审核修正 (a)：`systemPrompt.context()` 到底走哪条投影 —— **两个投影都要说清**

**这是第一版文档的引用错误，也是两位 reviewer 分歧点，已独立复核（`agent.ts:245-254`）：**

```ts
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
const sections = renderContextSections(assembly)
const context = this.runtimeContext.project(joinContextSections(sections), sections)
```

所以 **`systemPrompt.context()` 的贡献变成一条 runtime-context 快照 user message**（不是 system prompt 文本），由 `RuntimeContextProjection` 管理：
- 去重：`agent-loop/src/runtime-context.ts:148`（`if (this.retained?.text === snapshot) return`）
- 压缩后重新出现：`:127-136` —— 监听到**替换该快照的 surface 事件**时把 `retained` 清空，下一次 `project()` 自然重建

而 **system prompt 文本本身**由 `SystemPromptProjection`（同文件 `:59-104`）管理：
- 去重：`:94`
- 重投影：`:88` 由 `startsSeries` 触发，其定义含 "**the surface was replaced since the last request**"（`:38-43`）

结论未变（两者都跨压缩存活），但**实现时别盯错对象**：往 `context()` 里放东西 → 看 `RuntimeContextProjection`；往 `section()` 里放 → 看 `SystemPromptProjection`。

**另一个坑**：`AssembleContext` 基础类型只有 `scope?`/`signal?`（`system-prompt/src/index.ts:42-50`），`agent?: Agent` 是**模块增强加的可选字段**（`agent/src/runtime-types.ts:17-23`），注释明写 "**absent on diagnostics**"。provider 里必须处理 `context.agent === undefined`。

### 审核修正 (d)：不是简单改名

pi 用 `renderShell:'self'` 让扩展**拥有整块 call/result 外壳**（返回完整 TUI 组件）。DSH 的 `presentCall`/`presentResult` 是**可选装饰**，返回 view descriptor；模型可见内容由 `output.render` 产出，另有 pi 没有的 `finalizeContent`。**DSH 的扩展点更窄，而且是三件套（`output.render` + `presentCall`/`presentResult` + `finalizeContent`）。**

---

## 5. 项目级全局 vs 会话作用域（**审核后重写**）

pi 的 `index.ts:678-688` 真实清单是 **6 项**，但其中只有 **4 项是真全局**：

| 变量 | 真实作用域 | 证据 |
| --- | --- | --- |
| `project` | **真全局** | `:678` |
| `directory` | **真全局** | `:679` |
| `projectResolutionError` | **真全局** | `:681` |
| `projectDetectionPending` | **真全局** | `:682` |
| `pendingRecoveryNotice` | 已带 `sessionId` 字段 | `:680` |
| `knownSessions` | **已按会话**：key = `${sessionProject}:${sessionId}` | `:686`、`:691-692` |
| `sessionRegistrationsInFlight` | **已按会话**：同一复合 key | `:687` |
| `toolCounts` | **已按会话**：key = sessionId | `:688`、`:1358` |
| `engramSelfHealContexts` | **已按会话**：key = sessionId | `:401` |

**修正第一版的错误**：不能把这些都说成"进程级全局"。真正需要下沉的是**那 4 个项目解析状态**，加上 `pendingRecoveryNotice`（它已经不得不带 sessionId，正是多会话压力的前兆）。

**也不能说"pi 假设单会话"**：pi 的作者是**主动检测并防御**——
`observeRuntimeSessionID`（`:839-855`）见到第二个不同 ID 就**永久**置 `runtimeSessionIdentityAmbiguous`，`soleActiveRuntimeSessionID`（`:857-861`）要求 `size === 1` 才返回值，压缩恢复随即 fail closed。

**DSH 侧结论（不变）**：那 4 项 + notice 下沉到 `ctx.sessionProjections`；`engram serve` 是进程级资源，其初始化状态**保持模块级**。DSH 用 `ToolRunContext.agent` 直接拿到发起调用的 agent，**`soleActiveRuntimeSessionID`/`runtimeSessionIdentityAmbiguous` 这一整类补丁不需要存在**。

**修辞修正**：这不是"唯一根本差异"，而是"pi 为单会话偏置打了防御补丁，DSH 用显式会话身份从根上避免"。

---

## 6. 不可移植项

| pi 的能力 | 为什么 DSH 没有 |
| --- | --- |
| `mem_list_projects` | 直接调 `store.ListProjectsWithStats()`，**HTTP 无路由**（`mcp.go:1029-1047`）→ 工具面 18 个而非 19 |
| `mem_pin` / `mem_unpin` | **pi 无先例**：pi 的 19 工具集不含这两个（pi 含 `mem_delete`/`mem_stats`/`mem_timeline`，本设计排除 `mem_delete`）。HTTP 路由存在（`PUT/DELETE /observations/{id}/pin`），但实现无参照 |
| `/review` 的 UI 化呈现 | DSH 没有 Pi 的 TUI 组件模型，降级为 `presentResult` 文本 |
| `pi-mcp-adapter` 集成 | DSH 有自己的 mcp-client；本方案不用 MCP |
| `sessionManager.getSessionId()` 的不透明语义 | DSH 用 `agent.id === session.header.id`，语义明确 |

---

## 7. 我们要多做的（pi 没有的）

1. **项目解析状态按会话隔离**（§5）。
2. **按 session 过滤压缩事件 + 重入保护**——**修正第一版**：压缩事件确实广播（`scope/src/index.ts:170-185` 无 scope tag 时 `return true`），但**广播 ≠ 重复**：一个监听器每个事件只跑一次，两次压缩是两个不同 `compactionId`、两次合法归档。而且 resume/replay **根本不重发**（`session/src/index.ts:474-486`："constructor seeds do not emit"）。所以真正必需的是 (i) 忽略未追踪 session 的事件，(ii) 防止第二次压缩在第一次归档**在飞时**重入；per-session `lastCompactionId` 作为廉价幂等守卫保留，但理由要写对。
3. **工具面缩减为 18 个**并显式记录 `mem_list_projects` 缺失。
4. **服务器生命周期主体移植 pi §2.1**（共享 deadline / 只有 ready 算有服务 / 宽限 re-probe / `sharedInitialization` 退避窗口 / 代级恢复），**只从 `mcp-client/src/connection.ts` 借纪律**：generation 所有权、指数退避、定时器 `.unref()`、`dispose()` 等静止。
   **修正第一版**：第一版说"照 connection.ts 做监督器"是**退步**——connection.ts 需要 reconnect 循环，是因为 stdio 是**有状态长连接**（进程死是可观测事件，且已注册工具在 re-sync 前全部失效）；而 HTTP + 独立 serve **没有可丢的长连接**，失败只能按请求逐个观测，服务还可能被外部拥有（pi 已经在跑同一个）。正确形态是**请求级重试 + 显式 readiness 探测 + refused 时的有界重启**。
5. **`.engram/config.json` 引导**——DSH 常见从多仓库父目录启动，歧义是高频路径而非边缘情况。

---

## 8. 实施映射（检查表）

| # | 交付物 | 对应 pi | 对应 DSH 机制 |
| --- | --- | --- | --- |
| 1 | `engram/client.ts` | `engramFetch`/`engramFetchResult` | `fetch` + `AbortSignal.any([exec.signal, timeout])` |
| 2 | `engram/server.ts` | **§2.1 全套** | + connection.ts 的四条纪律 |
| 3 | `engram/project.ts` | `detectServerProject`/`isSafeDetectedProject`/`requireResolvedProject` | 同，含 404 降级 |
| 4 | `redaction.ts` | `private-redaction.js` | 逐字移植（纯函数） |
| 5 | `capture/compaction.ts` | `session_compact` + `compaction-recovery.js` | `session/event` + 按 session 过滤 + 重入保护 |
| 6 | `capture/prompts.ts` / `passive.ts` | `before_agent_start` / `tool_execution_end` | prompt 谓词 `source.kind === 'user'`；passive 走 `tools/result` |
| 7 | `tools/*` | `registerMemoryTools` + `MEMORY_TOOL_SCHEMAS` | `ctx.tools.register(defineTool(...))` + 共享 `ENGRAM_OUTPUT` |
| 8 | `protocol.ts` | `MEMORY_INSTRUCTIONS` | `systemPrompt.context()`（注意 §4(a) 的两个投影） |
| 9 | session 状态 | 4 项真全局 + notice | `ctx.sessionProjections` |
