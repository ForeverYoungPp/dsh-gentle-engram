# dsh-gentle-engram v0.2.0 — 全 HTTP 设计

> 状态：**已实施**（v0.2.0），并已通过运行时实测：真实压缩恢复、真实重启、Cordis 热重载、端到端读写往返
> 目标版本：0.2.0（就地重写 `src/index.ts`）
> 参考实现：`gentle-engram@0.1.12`（pi 插件）——见 `PI-PORT.md`
> Engram：源码 HEAD `fd2c8007511d` ≡ 已装二进制 `2.0.0-rc.9.0.20260910073915-fd2c8007511d`
> 产品决定：**统一走 HTTP**（用户明确选择）。审核对此有反对意见，记录于 §10。

---

## 0. 结论

删掉 bundle 里的 MCP row，插件直连 `engram serve`，自己用 `ctx.tools.register(defineTool(...))` 注册原生 `mem_*` 工具。

MCP 工具面**结构性地做不到**三件事：

| 能力 | 为什么 MCP 不行 |
| --- | --- |
| 按**会话 cwd** 解析项目 | `mem_current_project` 用 MCP 子进程的 `os.Getwd()`，不收 cwd 参数（`mcp.go:1054`）。DSH 是多会话宿主 |
| 会话级压缩恢复上下文 | `GET /context/compaction?session_id=` 无 MCP 对应（`server.go:1223` 是全仓唯一调用点） |
| 按会话 cwd 探测项目歧义 | `GET /project/current?cwd=`（`server.go:434`）。且 9 个 agent 工具带 `WithDeferLoading` |

**与上游的关系（已纠正）**：pi 的 `directTools: false`（`cli.js:93`、`mcp-template.json:10`）是 pi-mcp-adapter 的**默认值**，语义为 **Proxy only**——MCP 工具仍可经单个 `mcp` proxy 工具访问，**不是"上游主动关闭 MCP"**。可借鉴的是 pi 不让 Engram 出现两套并列的**一级**工具面。**统一 HTTP 是本项目的产品决定，不是上游论据**（审核异议见 §10）。

---

## 1. 现有 v0.1.1 的缺陷（本次修掉）

| # | 缺陷 | 证据 |
| --- | --- | --- |
| 1 | `directoryOf()` 是死代码：读 `session.requestHeader().cwd`，但 `EpochHeader` 没有 cwd | `session/src/types.ts:232-239`；正解 `Session.header.cwd`（`session/src/index.ts:464`、`types.ts:104`） |
| 2 | 失败判据反了：`if (!result) return`，但 `tools.execute` 对工具错误 resolve `isError` 结果、不抛 | `core/tools/src/index.ts:1536-1549` |
| 3 | 把错误文本当记忆注入模型上下文 | 同上，`ambiguous_project` 会进 prompt |
| 4 | 读侧只注入一次，压缩后失效 | 唯一注入点是 `agent.inject` |
| 5 | 写侧无可学习内容，只有 4000 字符原始工具输出 | `mem_capture_passive` 塞原文 |
| 6 | 每个 session 写死同一段假 summary | `src/index.ts:165` |
| 7 | 项目维度全缺 | 不传 project，session_start 无 directory |
| 8 | secret 过滤是整条丢弃的粗筛 | `/password\|token\|secret/i` |
| 9 | dispose fire-and-forget | `core/agent/src/index.ts:511-524`，且 emit 前已 `store.delete`（`:502` vs `:506`） |
| 10 | `tails` 清理永不触发 | `src/index.ts:107-111` |
| 11 | turn-stopping 返回值命中 serial 的 bail 语义，截断后续监听器 | `vendor/cordis/src/events.ts:205-208` |
| 12 | **prompt 捕获没有指定事件**（v0.1.1 用 `agent/inbox/inserted`，对插件注入的消息同样触发） | 见 §5.6 |

---

## 2. 架构总览

```
DSH Host
 ├─ dsh-gentle-engram (host-plane)
 │   ├─ engram/server.ts  ── engram serve 生命周期
 │   ├─ engram/client.ts  ── HTTP 客户端
 │   ├─ engram/project.ts ── 项目解析 + fail-closed 闸门
 │   ├─ tools/            ── 18 个原生 mem_* 工具
 │   ├─ capture/          ── prompts / passive / compaction
 │   └─ protocol.ts       ── systemPrompt.context() provider
 └─ engram serve (子进程, 127.0.0.1:7437)
     └─ ~/.engram/engram.db (SQLite, WAL)
```

**单一写者路径**：所有读写经 HTTP → 只有 `engram serve` 一个进程碰 DB。删掉 MCP row 后不存在第二条解析路径。

### 2.1 进程生命周期（**审核后重写**）

- 模块级单例，一个 DSH 进程一份，所有 session 共享。
- **主体移植 pi 的 `initializeEngramServer`**（`PI-PORT.md` §2.1），只从 `mcp-client/src/connection.ts` 借纪律：
  - **共享启动预算**：deadline 是绝对值并传进去，spawn 与 fallback 等待共用同一个（pi `index.ts:510-511`）。
  - **只有 `ready` 才算"有服务"**：拒绝 / 超时 / DNS 失败 / 不认识的错误形状一律视为没有，去拉起一个（pi `:593-597`）。
  - **不确定探测给一次宽限 re-probe**：`indeterminate` 时 spawn 失败后共用剩余 deadline 再等一次；确定被拒绝不给宽限（pi `:598-615`）。
  - **`sharedInitialization` 退避窗口必须实现**（pi `:630-655`）：失败保持可重试，但窗口内直接复用上次失败。**没有它，故障期间每次工具调用都重付完整 readiness 预算并可能再 spawn 子进程**——这是净回归。
  - **代级恢复**：每个 generation 只重启一次，`recoveryFlight` 防止加入旧代（pi `:657-676`）。
  - 从 connection.ts 借的四条纪律：generation 所有权、指数退避、定时器 `.unref()`、`dispose()` 等静止。
  - 防重叠：旧进程未在超时内退出就放弃重启，绝不出现第二个 serve 抢端口。
  - **不要照搬 reconnect 循环**：stdio 是有状态长连接才需要它；HTTP 没有可丢的连接，失败按请求逐个观测，且服务可能被外部拥有。
- `ENGRAM_URL` 显式设置 → 外部管理，**不 spawn、不自愈**。
- 传输：默认 TCP 7437；`ENGRAM_PORT` 覆盖；`ENGRAM_SOCKET`/`--socket` 可换 unix socket（与显式端口互斥，`main.go:889-891`）。TCP 只绑 127.0.0.1。v0.2.0 只做 TCP。
- **服务不可用时工具仍然注册**，调用返回结构化错误。

---

## 3. 模块结构

```
src/
  index.ts        入口：name / inject / Config / apply
  config.ts       schemastery Config
  protocol.ts     Memory Protocol 文本
  redaction.ts    <private> 递归脱敏
  engram/
    client.ts     fetch 封装：超时/退避/错误分类/脱敏/幂等重放
    server.ts     生命周期（pi §2.1 + connection.ts 纪律）
    errors.ts     EngramHttpError + 错误码分类
    project.ts    /project/current + isSafeDetectedProject + fail-closed
    session.ts    每 session 状态（sessionProjections）
  capture/
    prompts.ts    POST /prompts
    passive.ts    POST /observations/passive
    compaction.ts compaction/summary → 归档 + 4 结局通知
  tools/
    schemas.ts    18 个工具 JSON Schema
    output.ts     共享 ENGRAM_OUTPUT
    register.ts   ctx.tools.register(defineTool(...))
    impl.ts       工具名 → HTTP 调用
```

---

## 4. 工具面

原生工具名不带前缀。MCP agent profile 的 19 个里 **18 个可移植**：

| 工具 | HTTP |
| --- | --- |
| `mem_save` | `POST /observations` |
| `mem_search` | `GET /search` |
| `mem_context` | `GET /context` |
| `mem_session_summary` | `POST /observations`（`type: session_summary`） |
| `mem_session_start` | `POST /sessions` |
| `mem_session_end` | `POST /sessions/{id}/end` |
| `mem_get_observation` | `GET /observations/{id}` |
| `mem_suggest_topic_key` | `POST /topic-keys/suggest` |
| `mem_capture_passive` | `POST /observations/passive` |
| `mem_save_prompt` | `POST /prompts` |
| `mem_update` | `PATCH /observations/{id}` |
| `mem_current_project` | `GET /project/current?cwd=` |
| `mem_judge` | `POST /conflicts/judge` |
| `mem_compare` | `POST /conflicts/compare` |
| `mem_doctor` | `GET /doctor` |
| `mem_review` | `GET /review` / `POST /review/mark_reviewed` |
| `mem_pin` | `PUT /observations/{id}/pin` |
| `mem_unpin` | `DELETE /observations/{id}/pin` |
| ~~`mem_list_projects`~~ | **无 HTTP 路由**（`mcp.go:1029-1047` 直接调 store） |

**与 pi 工具集的差异**：pi 的 19 个不含 `mem_pin`/`mem_unpin`（本设计含），而 pi 含 `mem_delete`/`mem_stats`/`mem_timeline`（本设计不暴露 delete）。所以 `mem_pin`/`mem_unpin` **没有 pi 实现可参照**，尽管 HTTP 路由存在。

需要项目枚举时用 `mem_stats`（`GET /stats`）。**不暴露 `mem_delete`**（路由被 `requireAuth` 包着，`server.go:400`）。

### 4.1 DSH 工具契约

- `output` 是**运行时强制**的（`core/tools/src/index.ts:1027-1040` 缺 output 抛 TypeError）。
- 18 个工具共用一个 `ENGRAM_OUTPUT`（`defineTool` 每次重建包装，无 identity 约束，`schema.ts:545-583`）。
- 任意 JSON 用 `{type:'json'}`（`schema.ts:74-77`）；object spec 的 `additionalProperties` 必填（`:68-72`）。
- `exec.signal` 必须转发给 `fetch`。
- **呈现是三件套**：`output.render`（模型可见内容）+ `presentCall`/`presentResult`（可选装饰）+ `finalizeContent`（pi 没有）。不是 pi `renderShell:'self'` 的简单对应。

### 4.2 bundle patch

```yaml
- insert:
    - id: engram-memory
      name: dsh-gentle-engram
      config:
        binary: engram
        contextLimit: 8000
        captureToolResults: true
```

`src/index.ts` 硬编码了 3 处 `mcp__` 前缀（`:96,145,178`），工具面必须同步重写。

---

## 5. 生命周期协议

### 5.1 session 身份（**审核后重写**）

**用 `agent.id`（=== `agent.session.header.id`），并且从不自动 end session。**

理由：
- `agent.id` 在 resume/replay 后**保持稳定**（session header id 就是会话身份）。
- 本设计 §0 把 `GET /context/compaction?session_id=` 列为换 HTTP 的三大理由之一。**每次生成全新 UUID 会在每次 resume 时切断这个绑定——设计会亲手废掉自己最想要的能力。**
- 僵尸风险（`createSessionTx` `store.go:7287-7299`，ON CONFLICT 起于 7292，不重置 `ended_at`；对比 MCP 走的 `startSessionTx` 7301-7309 带 `WHERE sessions.ended_at IS NULL`）只在 id **已经 ended** 时才触发。
- pi 也从不自动 end：`session_shutdown` 只清本地状态（`index.ts:1281-1287`）。

特殊路径：**第一次写入注册之前**才 `GET /sessions/{id}`（`server.go:533-545`，返回完整记录含 `ended_at`），不是 session-start（§5.1.1）。**仅当确实已结束**才生成新 UUID；除 404 外的探测失败一律抛出，绝不读成「未结束」（§5.1.2）。常见路径保持连续，罕见路径无僵尸。

不自动 end 会让活跃 session 累积，但**无害**：每个写入都显式带 `session_id`，engram 的 `resolveFallbackSessionID` 歧义回退（`mcp.go:3256-3271`）永远不会被咨询。

注册要**飞行中合并**（pi 的 `sessionRegistrationsInFlight`，`index.ts:687,694-695`）：同一 session 并发触发不重复注册。

### 5.1.1 注册时机 = 第一次写入（**修复**）

注册**不发生在 `agent/session-start`**，而是推迟到第一次真正产生记忆的写入：`mem_save` / `mem_session_summary` / `mem_capture_passive` / `mem_save_prompt` / `mem_session_start` / `mem_session_end`、prompt 捕获、passive 捕获、压缩归档。`agent/session-start` 只做只读预热（`server.ensure` → `GET /project/current` → `GET /context`），**零 Engram 写入**。

理由：DSH 的 web profile 会给 GUI 里每个打开的工作区各发布一个 agent（`session.create` → `agents.resume`），而"被 resume 但没人使用"的 agent 原来会留下一条空 Engram session（实测：ouroboros 工作区被恢复即留行）。这不只是观感问题——Engram 注入的 RecentSessions 是**固定 5 槽**且按 `MAX(obs.created_at, started_at)` 排序，空行会把真实会话挤出注入块。

参照实现本就如此：pi 的 `session_start` 处理器（`index.ts:1273-1280`）只做 `observeRuntimeSessionID` / `initOnceForHook` / `setStatus`，**从不调用 `ensureSession`**；`ensureSession` 只出现在写入路径（`session_compact:1307`、`before_agent_start:~1333` 且要求 prompt 长度 >10、`mem_*` 处理器 `:1069/1101/1111/1152`、`tool_execution_end:1354`）。急切注册是移植时多出来的一步，不是 pi 的行为。

**硬约束**：Engram 的 SQLite 连接以 `_pragma=foreign_keys(1)` 打开（`store.go:805-820`；`startup_gate_test.go:537-541` 断言替换连接同样为 1），`observations.session_id` 与 `user_prompts.session_id` 都 FK 到 `sessions(id)` 且无级联。**行必须先存在**，否则写入被 store 拒绝（`FOREIGN KEY constraint failed`）。所以闸门必须在写入**之前** await，且失败**不被记住**：`registered` 只在 Engram 确认后置位，下一次写入重试。

闸门**不得**放进 `sessions.enqueue`：压缩归档已经持有该队列，嵌套 await 会等自己直到 drain 超时。所以 `handleCompaction` 在 `enqueue` 之外先 `ensureRegistered`，失败则按 `Unavailable` 出通知（**绝不**误报 `Confirmed`）。

读路径（`mem_search`/`mem_context`/`mem_doctor`/…）只 `await` 预热，**不注册**：读记忆不该留下行。

`agent/disposed`：只清本地状态。**不写 summary、不 end**（对齐 pi）。

### 5.1.2 会话结束与轮换（**审核后新增，含 5 处修复**）

`mem_session_end` 是**唯一**会主动 end 的路径（模型显式要求时）。Engram 的 end 路由**不幂等**：`UPDATE sessions SET ended_at = datetime('now'), summary = ?`（`store.go:2615-2633`）不检查行状态，`server.go:496-510` 一律 200；未传 summary 时 `nullableString('')` → NULL（`store.go:9392-9397`）。所以重复 end 会**抹掉上一次写入的 summary 并前移 ended_at**。实现因此先 GET 一次：行不存在 → 报「无可结束」（**不为 end 而建行**，空行正是惰性注册要避免的噪声）；行已 ended → 报「早已结束」且不再调用。

**结束后的写入必须轮换（实测缺陷）**：`mem_session_end` 之后本地 `registered=false` + `ended=true`，下一次写入走 `registerSession`，检测到 ended 就生成新 UUID。修复前 `registered` 仍为 true，`mem_save` 直接把 observation 写进已结束的行——实测 `END-FIRST-PROBE`：行 16:45:50 建、16:45:54 ended，observation 仍落该行；Engram 不拒绝（`validateSessionProject` 只比 project，`server.go:1979-2003`）。修复后实测：`b1411c28…`（1 prompt、0 obs、ended 12:38:28）与 `533e6ebf…`（0 prompt、1 obs，即 `POST-END-ROTATION-PROBE`）——旧行保持结束，新记忆进新行。

**恢复后必须重发，不能谎报成功（`client.ts` 修复）**：被拥有服务死亡、`recoverOnce()` 成功时，旧实现 `return { data: null }`（无 `timedOutMethod`），调用方只能读成「成功」——压缩归档因此对模型谎报 `Confirmed`，而摘要**从未发出**。现在：连接被拒**证明请求未到达服务端**，故任何方法（含无幂等键的写）都可安全重发，在同一次尝试槽位 `continue`；不可重发时**抛出**，绝不返回空成功。

**已结束探测不得吞错（修复）**：`rowHasEnded` 只有 404 读作「无此行」，其余错误一律抛出。把瞬时错误读成「未结束」→ 复用 key → Engram 返回 201 且**不重置 `ended_at`**（`store.go:7291-7298`）→ 此后整个进程生命周期都在往已结束的行里写，且没有任何信号。

**注册确认会过期（第二轮审核 F1 修复）**：`registered` 原来缓存整个进程生命周期，于是外部 `engram delete session` / CLI end 之后本地仍以为行存在——写入 404、`mem_session_start` 谎报 `registered:true`、`mem_session_end` 报「无可结束」，直到插件重载。现在每次写入前检查 `registeredAt`，超过 `REGISTRATION_TTL_MS`（60s）重新探测一次：行被删 → 用同一个 key 重建；行已结束 → 轮换。复查失败（传输错误）保留上一次结论——否则 TTL 边界上的一次网络抖动会把本来能成功的写入变成错误；只有首次注册失败才报失败。`mem_session_end` 探测到行不存在时也会立即清掉 `registered`。

**压缩归档在队列内复查存活性（第二轮审核 F4 修复）**：若 `mem_session_end` 在归档排队期间关闭了该行，归档会在队列内重新 `ensureRegistered`（这会轮换到新行），而不是把摘要写进刚结束的会话。

**项目解析失败会过期（修复）**：`state.project` 只对 `resolved` 永久缓存；`failed`/`pending` 30 秒后可重试（`PROJECT_RETRY_MS`）。否则用户中途补 `.engram/config.json` 必须重启才生效。

**passive 捕获有前置门槛（修复）**：Engram 的抽取器只认 `^#{2,3}\s+(Aprendizajes Clave|Key Learnings?|Learnings?):?\s*$`（`store.go:9659-9676`），没有该标题的文本解析后直接丢弃（`store.go:9736-9741`）。原实现把每个 >50 字符的工具结果都 POST 一次并**先注册会话行**；实测全库 578 条 observation 里 0 条 passive。现在客户端先做同样的标题匹配，不匹配就不发、不注册。

### 5.2 项目解析（fail closed）

```
cwd = agent.session.header.cwd          // SessionHeader.cwd，绝对路径
res = GET /project/current?cwd=<cwd>
```

判定有效项目（照抄 pi `index.ts:731-742`）：拒绝 空 / `"unknown"` / 含 `error_hint` / 含路径分隔符或控制字符。

**`/project/current` 不是"永不报错"**：会硬报 400（`ENGRAM_PROJECT` 形如路径）和 500（`config.json` 损坏 / repo binding 失败 / `Getwd` 失败）。而且歧义时即使返回 200 + `error_hint`，第一方客户端也当失败（`plugin/claude-code/scripts/_helpers.sh:115-123`）。**只要 `error_hint` 存在就按失败处理。**

**404 降级（审核补充）**：pi 在老服务端 404 时回退到最近的 `.engram/config.json` 并附版本不匹配警告（`index.ts:303-341`）。本设计必须实现同样的降级，否则版本偏斜时直接 fail closed，而 pi 是优雅降级。

解析失败时：不注册 session、不注入、不写任何 observation；不把错误文本注入模型上下文；把 `available_projects` 提炼成可操作引导（`.engram/config.json`），经 `ctx.logger.warn` + 一次性用户可见提示呈现。**本机默认从 `/home/fy/Projects/code` 这类多仓库父目录启动，这是高频路径而非边缘情况。**

### 5.3 读侧：`systemPrompt.context()`（**审核后修正引用**）

用 `systemPrompt.context({name, order, text: (context) => string})`。

**机制（已独立复核 `agent.ts:245-254`）**：`context()` 的贡献经 `renderContextSections(assembly)` → `RuntimeContextProjection.project()` → 变成一条 **runtime-context 快照 user message**（不是 system prompt 文本）。因此它由 `RuntimeContextProjection`（`agent-loop/src/runtime-context.ts:107-157`）管理：
- 去重：`:148`
- 压缩后重新出现：`:127-136`（监听到替换该快照的 surface 事件时清空 `retained`，下次 `project()` 重建）

对照：**system prompt 文本**（`systemPrompt.section()`）由 `SystemPromptProjection`（同文件 `:59-104`）管理，去重 `:94`、重投影 `:88` 由含 "the surface was replaced since the last request" 的 `startsSeries`（`:38-43`）触发。**实现时别盯错对象。**

为什么不用 `agent/pre-step` 追加：`step === 1` 不能当守卫（每轮重置，`agent.ts:204/288/348`）；且 `context()` 自带去重与压缩后重建，正是 pi 每轮重拼想要的效果。

**坑**：`AssembleContext` 基础类型只有 `scope?`/`signal?`（`system-prompt/src/index.ts:42-50`），`agent?: Agent` 是模块增强加的可选字段（`agent/src/runtime-types.ts:17-23`），注释明写 "absent on diagnostics"。**必须处理 `context.agent === undefined`。**

**约束**：provider 同步，HTTP 结果必须预先缓存。

**冷缓存行为（审核补充）**：压缩归档 + `/context/compaction` + `/context` 是三次 HTTP，provider 可能在任一落地前渲染。规定：
- 缓存未就绪时 provider **只返回协议段**（不返回空串，也不阻塞）。
- 会话上下文就绪后由下一次 assemble 自然纳入（去重机制保证不会重复注入）。
- pending notice 同理：就绪即在下一次渲染出现，消费一次后清空。

### 5.4 per-session 状态（**实现期修正**）

**实现用的是按 `agent.id` 键控的 `Map`，不是 `sessionProjections`。**

修正理由：`ProjectionDefinition.apply(state, event)` 的契约是**对 session log 的纯 fold** —— 状态必须能从已提交事件推导出来。而这里持有的是**HTTP 派生的运行时缓存**：解析出的项目键、抓回来的上下文文本、归档结局、在飞的注册。没有任何一项能靠 replay 事件重算，也没有任何一项应该被持久化进日志。把 HTTP 缓存塞进投影既违反纯度契约，又会在 replay 时产生一个 schema 无法表达的状态。

多会话正确性——绝不把某个会话的项目或缓冲串给另一个——由按 agent id 键控同等保证（`src/session.ts` 里写明了这段理由）。

字段：`engramSessionId`、`cwd`、`project`（resolved/pending/failed）、`projectCheckedAt`、`contextText`、`pendingNotice`、`registered`/`registration`、`ended`、`startup`、`tail`/`pending`、`archivedCompactions`。

生效于 pi 的 4 项真全局 + notice（见 `PI-PORT.md` §5）。

### 5.5 压缩恢复（**审核后修正理由**）

真值：`ctx.on('session/event')` → `event.type === 'compaction/summary'` → `event.data.summary` 是 `ContentBlock[]`（`compaction/src/types.ts:34-37`），log-only；紧随的 `user/message` 才是 surface 替换（`compaction-basic/src/region.ts:475-493`）。

流程：
1. 抽取 `data.summary` 文本（ContentBlock[] → string）。
2. **按 session 过滤**（忽略未追踪 session 的事件）。
3. **重入保护**：第二次压缩可能在第一次归档在飞时到达。
4. 归档：`POST /observations`，`{session_id, project, type:"session_summary", title:"Compaction recovery summary", content, scope:"project", topic_key:"session/compaction-recovery"}`。
5. `GET /context/compaction?session_id=` 取恢复上下文。
6. 写 `pendingNotice`，按 4 结局分支（pi `compaction-recovery.js:25-105`）：`Confirmed` / `Failed`（手动兜底指令）/ `Unknown`（超时，**禁止盲目重试**，先 `mem_search`/`mem_doctor` 验证）/ `Unavailable`（会话身份不确定；project 失败在归档前就 early-return，这里只作兜底）。
7. 由 `systemPrompt.context()` provider 消费并清空。

**修正**：per-session `lastCompactionId` 作为廉价幂等守卫保留，但**理由不是"广播导致重复"**——广播 ≠ 重复（一个监听器每事件只跑一次，两次压缩是两个不同 `compactionId`、两次合法归档），且 resume/replay **根本不重发**（`session/src/index.ts:474-486`："constructor seeds do not emit"）。真正需要的是**按 session 过滤**和**重入保护**。

**注意**：`session/event` 监听器**不被 await**（`session/src/index.ts:410-419`）。归档必须自己兜全部错误。

### 5.6 写入与捕获

**捕获监听器必须能自建 state（修复）**：`agent/inbox/inserted` 的 payload 是 `{ agent: Agent; message: UserMessage }`（`agent/src/runtime-types.ts:285`），`tools/result` 的 `exec.agent` 也是完整 `Agent`（`core/tools/src/index.ts:189`）。两者原本被窄化成 `{ id }` 并写成 `sessions.get(agent.id)` + `undefined` 就 return——热重载后注册表是空的、且**不会再触发 session-start**，于是**所有记忆捕获静默停摆**，直到模型碰巧调用某个 `mem_*` 工具重建 state（实测：重载后 30 秒内零写入，调用 `mem_context` 后 2 秒恢复）。现改为 `sessions.ensure(agent)`，event 自带完整 agent，state 永远可重建。


**prompt 捕获（审核补充——原设计的实现阻塞级遗漏）**：
- 事件：`ctx.on('agent/inbox/inserted')`。它是 `@mode emit`、agent-scoped（`runtime-types.ts:280-285`），但它**对插件注入的消息同样触发**（正是 v0.1.1 的原始 bug）。
- **正确谓词：`message.source.kind === 'user'`**。`MessageSourceMap` 只有 `user`/`plugin`/`model`/`tool`，**根本没有 `'human'` 这个 kind**（`llm/llm/src/message.ts:102-106`）；且该 map 是 merge-extensible，未知 kind 必须 fall through 到"不采集"。
- 内容：脱敏 + 截断 2000（照 pi `index.ts:1339`），`POST /prompts` `{session_id, content, project}`。
- **竞态（修复）**：事件到达时 `state.project` 往往仍为 undefined（`GET /project/current` 尚未返回），原来的同步判据会静默丢掉**每个快速启动的 agent 的首条 prompt**——subagent 几乎必丢（实测修复前 subagent `prompts=0`，修复后 `prompts=1`）。现改为在捕获前 `await` 预热 + 注册闸门。

**passive 捕获**：`tools/result`（emit、观察型，失败被吞 → 选它正确）→ 跳过 engram 自己的工具 → 长度门槛（>50）→ **`## Key Learnings` 标题门槛**（§5.1.2：没有标题的文本服务端必然丢弃，却已付出一次请求与一条会话行）→ 脱敏 → `POST /observations/passive` `{session_id, project, content, source: toolName}`。

**失败可见性（审核补充）**：后台捕获走 best-effort，但**绝不静默**——必须 `ctx.logger.warn`，理由同 pi（`index.ts:281-292`）：静默丢弃会让"记忆停止工作"的用户完全没有信号。

**写入串行化**：每 session 一个 promise 队列（保留 v0.1.1 设计，修掉 `tails` 清理 bug：存 `next.catch(()=>undefined)` 就要拿同一个对象比较）。

**捕获链整体入队（审核后修复）**：`capturePrompt`/`captureResult` 把**预热 + 注册 + 写入**作为一个队列单元执行。此前预热与注册在 `enqueue` 之外，而 `pending` 只在入队那一刻自增，于是 `agent/turn-stopping` → `drain` 在会话的**第一个写**上看到的"无工作"是假的——那次捕获可能仍在 spawn server / 解析项目。`drain` 同时改为**循环等待 `pending` 归零**（而不是 race 一次 tail 快照），因为等待期间仍可能有新捕获入队；上限仍是 `DRAIN_TIMEOUT_MS`，服务卡死不会拖住回合。

**代价（第二轮审核 F3，接受）**：单元里现在包含 `server.ensure`（冷启动最长 10s），所以同一回合的 `mem_session_end` 可能要排在一次卡住的捕获之后（队列里此前只有一次 HTTP 写）。影响仅限「服务不可用的极端情形 + 同回合调用 end」——end 是唯一使用该队列的工具——不涉及数据丢失，故不为此再拆队列。

**`agent/turn-stopping`**：serial 语义，**await 后必须显式返回 void**。返回工具结果对象会命中 bail 并**跳过后续 turn-stopping 监听器**。

### 5.7 脱敏

`<private>…</private>` → `[REDACTED]`，递归作用于出站 JSON 每个字符串与 URL query 值（`private-redaction.js:1-44`）。不做正则 secret 扫描（上游 README 明说不是 secret scanner）。

---

## 6. 硬约束与雷区

1. **用 `agent.id`，从不自动 end**（唯一例外是模型显式调用 `mem_session_end`）；注册前用 `GET /sessions/{id}` 探测，已 ended（本地 `state.ended` 或服务端 `ended_at`）就换新 UUID（§5.1、§5.1.2）。探测失败除 404 外一律抛出——把瞬时错误读成「未结束」会把新记忆永久写进已结束的行。
2. **`/project/current` 会硬报错**，200+`error_hint` 也算失败；404 要降级到 `.engram/config.json`。
3. **ambiguous_project 无自动降级**：MCP 写/读工具都失败并要求 recovery_token 流程（`mcp.go:2566-2617`）；HTTP project 作用域路由 409（`server.go:1375-1384`）。正解是 `.engram/config.json`。
4. **`agent/session-start` 是 emit、不阻塞启动** → 预热与第一个 step 有竞态。读路径容忍未预热（只降级为贡献协议文本），写路径在闸门里 await 预热，不再丢首条 prompt。
5. **零配置下 HTTP 修不了 ownership**：`POST /projects/rescue-ownership` 无 token 直接 503（`server.go:212-220`），只能走 CLI。
6. **11 条路由免认证**；破坏性路由要 token（`DELETE /observations/{id}`、`DELETE /sessions/{id}`、`DELETE /prompts/{id}`、`GET /export`、`POST /import`，`server.go:389/400/419/426/427`）。
7. **重复 serverName 会 fail at load**：DSH 仓自带 `serverName: engram` 的示例（`apps/cli/config/examples/mcp-memory/engram.cordis.yml`）。删掉 bundle 的 MCP row 后，这个雷只在用户手动启用示例时存在——README 要写明。
8. **WAL 争用**：`busy_timeout=5000` + WAL（`store.go:808-822`）。极端争用下个别写 5xx。对**幂等路径**（GET + `POST /sessions`）做有界重放，非幂等写**绝不盲目重试**（pi `isSafeToReplay`）。**唯一例外（§5.1.2）**：`ECONNREFUSED` 证明请求从未到达服务端，此时非幂等写也会在同一次尝试槽位重发一次。

---

## 7. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `engram serve` 起不来 / 端口被占 / 安装不含 serve | 记忆能力整体降级 | 工具仍注册、结构化错误；`mem_doctor` 引导；stderr 告警；"只有 ready 才算有服务" + 宽限 re-probe |
| `/project/current` 或 config 异常 | 整条链路 fail closed | 404 降级 + 显式告警 + `.engram/config.json` 引导；绝不猜项目 |
| 压缩归档重复/重入 | 检索污染 | 按 session 过滤 + 重入保护 + `topic_key` upsert |
| 第二个 serve 抢端口 | 数据目录混乱 | 防重叠关闭超时；探测优先复用 |
| 活跃 session 累积 | 无（显式 session_id 已规避回退解析） | 不自动 end，接受累积 |

**最脆弱假设**：
1. `engram serve` 在这台机器可用且可 spawn（含安装带 serve、端口空闲）。
2. **`/project/current` 能解析会话 cwd**——而从多仓库父目录启动在本机是**默认情形**，此时每个会话都 fail closed，只能靠 `.engram/config.json` 救。
3. 同步 provider 读异步缓存是自洽的（§5.3 冷缓存行为已规定）。

---

## 8. 非目标

不自动写死 summary · 不做正则 secret 粗筛 · 不做 MCP + HTTP 双传输 · v0.2.0 不做 unix socket · 不暴露 `mem_delete`。

---

## 9. 实施顺序（**审核后调整：工具面最后做**）

1. `engram/client.ts` + `engram/errors.ts`（脱敏、超时、幂等重放）。
2. `engram/server.ts`（pi §2.1 全套 + connection.ts 四条纪律）。
3. `engram/project.ts`（含 404 降级与 fail-closed 闸门）。
4. `capture/prompts.ts`、`capture/passive.ts`、`capture/compaction.ts`。
5. `protocol.ts` + `systemPrompt.context()` provider（注意两个投影的区别）。
6. 事件接线：`agent/session-start`、`session/event`、`agent/inbox/inserted`、`tools/result`、`agent/turn-stopping`、`agent/disposed`。
7. **工具面（18 个）放最后**——它工作量最大、最不承重，且正是它拖进 serve 生命周期依赖。
8. `cordis.patch.yml` 删 MCP row；README 更新（`.engram/config.json` 与重复 serverName 警告）。
9. `pnpm run typecheck && pnpm run build`。

---

## 10. 审核异议记录（供决策参考）

对抗式审核给出的"保留一条 / 砍掉一条"意见：

- **保留**：**身份与项目的 fail-closed 闸门**。它是唯一防止记忆被写坏/写错项目的性质，其余都是质量问题。
- **砍掉**：**18 个原生 HTTP 工具面的重写**。审核认为它工作量最大、最不承重，而且正是它拖进了 serve 生命周期依赖；建议"用 HTTP 做生命周期与读侧、保留现有 MCP 工具面"，并明确标注**这是对已定决策（用户明确选了全 HTTP）的反对意见，不是文档缺陷**——若统一 HTTP 是硬性产品要求，则降级为"阶段化交付、工具面最后做"。

本设计采纳"工具面最后做"（§9），但保留全 HTTP 的最终目标。

---

## 附录 A：证据索引

DSH（`/home/fy/Projects/code/deepseek-harness`）：
- `packages/core/session/src/index.ts:464`、`types.ts:104` — `Session.header.cwd`
- `packages/core/tools/src/index.ts:1027-1040` — `register()` 强制 output；`:1536-1549` — 工具错误 resolve 成 isError
- `packages/core/tools/src/schema.ts:68-77,545-583` — `defineTool` / `{type:'json'}`
- `packages/core/agent-loop/src/agent.ts:245-254` — context() 贡献 → RuntimeContextProjection
- `packages/core/agent-loop/src/runtime-context.ts:59-104`（SystemPromptProjection）/ `:107-157`（RuntimeContextProjection）
- `packages/core/agent/src/runtime-types.ts:17-23`(`agent?` 增强)、`:280-285`(inbox/inserted)、`:313-316`(session-start emit)
- `packages/core/agent/src/index.ts:502,506,511-524` — disposed
- `packages/llm/llm/src/message.ts:102-106` — MessageSourceMap 无 'human'
- `packages/core/session/src/index.ts:410-419`(session/event 不 await)、`:474-486`(seeds 不 emit)
- `packages/compaction/compaction/src/types.ts:26-37`、`compaction-basic/src/region.ts:475-493`
- `packages/mcp/mcp-client/src/connection.ts` — 借纪律的参考

Engram（`/home/fy/Projects/code/engram`）：
- `internal/server/server.go:382-450`(路由)、`463-494`(POST /sessions)、`533-545`(GET /sessions/{id})、`1216-1234`(context/compaction)、`1283-1315`(project/current)
- `internal/mcp/mcp.go:118-138`(ProfileAgent 19)、`1029-1047`(list_projects 无 HTTP)、`2159-2168`(session-start 项目解析)
- `cmd/engram/main.go:855-893`(serve 传输)
- `internal/store/store.go:774-822`(WAL/busy_timeout)、`7291-7309`(ended 不对称)
- pi 参考：`~/.pi/agent/npm/node_modules/gentle-engram/`

## 附录 B：验证边界

- 三轮审核（2 轮设计 + 本文件）原为**静态源码核验**，此后已补运行时实测：跨会话召回、跨重启绑定、写读往返、磁盘持久化、真实压缩恢复（Confirmed）、prompt 与 passive 捕获、惰性注册（3 次启动 0 写入）、Cordis 热重载，以及 §5.1.2 的结束轮换。
- Engram 源码 HEAD `fd2c8007511d` 与已装二进制伪版本一致、工作树 clean，契约证据可采信。
- 未端到端验证：`engram serve` 在本机的启动/端口；`/project/current` 在本机多仓库父目录下的真实返回；压缩恢复在真实压缩事件下的表现。
- 建议实施后冒烟：临时 `ENGRAM_DATA_DIR` 下 `/health` → `/project/current?cwd=` → `POST /sessions` → `POST /observations` → `GET /context`。
