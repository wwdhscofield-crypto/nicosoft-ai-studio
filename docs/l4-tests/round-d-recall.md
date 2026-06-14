# 轮 D — collab lesson 召回机制验证(确定性,补 C3→C2 空白)

> 缺口 #5 内化闭环。C3→C2 判定 **NO-LESSON**:把内化闭环拆成 5 个串联子环节
> （A 跨轮共享 → B recall 管道 → C 失败产 collab lesson → D collab 被召回 → E 召回生效避坑），
> 两轮零 FAIL 致 **C/D/E 后三格一格没动**——轮2 recall 命中的全是 `shared/role` 记忆,
> **池子里从来没出现过 collab 行**,所以"collab lesson 被召回"这一格(D)**实证为零**。
>
> 轮 D 用 driver `e2e/dogfood-l4-d-recall.mjs` **确定性**点亮 D 格:不依赖任何 agent 自然失败,
> 直接 seed 一条 collab lesson → 跑一轮真实对话 → 用三重独立证据证明它被召回且**真正注入 LLM 请求**。

## 为什么 D 能确定性做(机制实证)

| 事实 | 来源 | 意义 |
|---|---|---|
| collab 只能由 `learnFromGateClosure` 写 | `src/main/services/memory.service.ts` | IPC `memory:add` 强制 `shared/role`,写不出 collab → seed 唯一路径=直连 sqlite `INSERT` |
| recall **不是向量检索** | `src/main/repos/memory.repo.ts`（`memories` 无 embedding 列） | `listForRole = layer IN ('shared','collab')`，纯 SQL 过滤,seed 一条纯文本行即可被召回 |
| collab 进池无 conv/role/project 过滤 | 同上 | 跨会话/专家可召回,只要同一 sqlite（同 `STUDIO_DATA_DIR`） |
| 池子 ≤15 全量注入,>15 才走小模型序号筛选 | `memory.service.ts`（`RECALL_LLM_THRESHOLD=15`） | 控池=1 → 必然全量注入,排除 LLM filter 干扰 |
| 直聊 engineer 走 `agent.service.ts` recall,同样注入 collab | `src/main/services/agent.service.ts` | 最短召回路径,一轮无工具任务即触发 |

## 实验设计

| 项 | 内容 |
|---|---|
| **seed** | 直连 `studio.db` `INSERT` 一条 `layer='collab', role_id=NULL, source='auto'` 的**原则层** lesson（非答案）,内嵌唯一 marker `STUDIOL4DRECALL7F3A9C`,`last_recalled_at=NULL` |
| **lesson 正文** | "When modifying protocol action-routing whitelists in a Go proxy adapter, exhaustively enumerate every upstream action suffix before shipping — omitting one silently degrades the request to the wrong upstream path and is invisible without a dedicated test." |
| **任务** | 直聊 engineer，无工具一问："改协议动作路由白名单最容易犯什么错、如何避免"（与 lesson 主题相关，确保召回命中；池子=1 本就必然注入） |
| **三重证据** | E1 `memory:recalled` 事件 ids ∋ seedId（召回选中）· **E2 `llm-wire.jsonl` 的 `system` 字段含 marker（真进了 prompt，最硬）** · E3 `last_recalled_at` NULL→非NULL（`touchRecalled` 生效） |
| **沙盒** | 隔离 world（`STUDIO_USER_DATA/STUDIO_DATA_DIR` 独立）+ `LLM_WIRE_LOG` 开 wire 留痕；cwd 为空目录（D 不碰文件） |

## 执行结果:DONE / 23s / 1 次 LLM 调用 / recall 在发任务后 0.07s 触发

```
SEED: pool 0→1; row={id:ZZL4DRECALLSEED…, layer:collab, source:auto, last_recalled_at:null}
tick=2 streaming=false deltas[direct:5] recalls=1   ← 发任务后立即 recall
terminal: done turns=0 inputTokens=14139 outputTokens=310
```

### 三重证据（**独立复核,非采信 driver `includes`**）

| 证据 | driver 自报 | 我独立复核 | 复核手段 |
|---|---|---|---|
| **E1** 召回选中 | true | ✅ `recalledIds=["ZZL4DRECALLSEED00000000000"]` | 读 `gate-d-result.json` / events |
| **E2** 进 system prompt | true（`wireText.includes`） | ✅ **marker 在 SYSTEM=true、MESSAGES=false、TOOLS=false** | `node` 解析 `llm-wire.jsonl` req 行，逐字段判定 |
| **E3** touchRecalled | true | ✅ `last_recalled_at: NULL → 2026-06-13T19:30:36.438Z` | 直连 `studio.db` `SELECT` |
| 池子全量注入 | total=1 | ✅ 只 1 条记忆 | 直连 `studio.db` |

> **E2 是决定性证据**:driver 的 `wireText.includes(MARKER)` 不区分字段,我独立解析后确认 marker **只在 `system`（7016 字符）、不在 `messages`（151 字符）/`tools`**——排除了"marker 出现在用户输入或回复里"造成假阳性的可能。system 上下文片段:
> `…silently degrades the request to the wrong upstream path and is invisible without a dedicated test. [recall-probe:STUDIOL4DRECALL7F3A9C]","messages":[…`（marker 紧接 `","messages"`,坐实在 system 字段尾部）

### 旁证（**非 E 归因**）:lesson 流入了 agent 输出

agent 回复几乎逐字复述了 seeded lesson：
> "最容易犯的错误是：枚举上游动作后缀（action suffix）时漏掉某一个，导致请求被静默降级路由到错误的上游路径，且没有专门测试根本发现不了。避免方法是：改白名单时穷尽列出每一个上游动作后缀，并为路由配一个专门的测试来兜底。"

这证明 lesson 不仅"进了 prompt"还"被 agent 采纳进输出"。**但这不构成 E 格归因**——本轮任务恰好就问 lesson 的主题、且无对照组,无法排除"agent 本来就会这么答"。严格的"lesson 让 agent 避坑"归因必须靠 E 的三臂对照（无 lesson / 安慰剂 lesson / 靶向 lesson）才能立。

## 监控全死角 + 三项补丁落地

case-plan §6 指出 c1/L4 driver 漏采 3 项,本 driver 全部补上并验证产物：

| 维度 | 产物 | 状态 |
|---|---|---|
| IPC 事件流 / 主进程日志 / LLM wire / transcript+run-stats / 截图 / errors | `events.jsonl` / `main.log` / `llm-wire.jsonl` / `sessions/` / `*.png` / `errors.json` | ✅ 照搬模板 |
| **补丁① git-diff 对账** | `git-status.txt` | ✅ 落地（D 的 cwd 非 git → 正确记 `N/A`；C/E 对真沙盒生效） |
| **补丁② verify:done 订阅** | events 流 | ✅ 已订阅（直聊无 Gate → 本轮无 verify 事件，C 群聊才触发） |
| **补丁③ project_tool_events 裸读** | `project_tool_events.json` | ✅ dump 路径打通（无工具轮 → `rows=0`） |
| memory 召回 ids / collab 快照 / analytics | `gate-d-result.json` / `memory-final.json` / `analytics.json` | ✅ |

## D 证明了什么 / 没证明什么（诚实界定）

- ✅ **证明**:collab lesson 一旦存在,**必然被召回并真正注入 LLM system prompt**（D 格召回链路通,带 system-字段级硬证据）。这补上了 C3→C2 "池子里从无 collab 行" 的精确空白。
- ✅ **旁证**:lesson 内容会流入 agent 输出（采纳,非仅注入）。
- ❌ **未证明 C 格**（失败→产生 collab lesson）：那是 C 实验（C5 群聊诱发 Gate B FAIL→fixed）。
- ❌ **未证明 E 格**（agent **因为**这条 lesson 而避坑）：D 只证"文本进了 prompt + 被复述"，归因需 E 三臂对照。

## L4 判定（内化闭环 5 格进度）

| 子环节 | C3→C2 后 | 轮 D 后 | 证据 |
|---|---|---|---|
| A 跨轮共享 | ✅ | ✅ | C3→C2 |
| B recall 管道（shared/role） | ✅ | ✅ | C3→C2 轮2 recall 13 |
| **D collab 被召回 + 注入** | ❌ 零实证 | ✅ **确定性 PASS** | 轮 D 三重证据 |
| C 失败产 collab lesson | ❌ | ❌ 待 C 实验 | — |
| E 召回生效避坑（归因） | ❌ | ❌ 待 E 实验 | — |

**结论:内化"管道"的召回格（D）已确定性闭环——collab lesson 不仅能进池、能被选中,还逐字进了发给模型的 system prompt 并被采纳。剩余 C（产生,概率性,撞强-agent-难自然失败墙）与 E（归因,需三臂对照）按阶梯式后续推进。**

---
*driver: `e2e/dogfood-l4-d-recall.mjs` · 终态 DONE 23s · 三重证据独立复核全绿 · 监控全死角 + 三项补丁落地*
