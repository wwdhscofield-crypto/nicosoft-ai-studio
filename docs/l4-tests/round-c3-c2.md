# 轮 C3→C2 — Gemini 协议修复 · 内化闭环连续两轮(群聊)

> 缺口 #5 内化闭环("失败→存教训→次轮复用避同错")。连续两轮**同一 Studio 会话、共享一个 memory sqlite**:
> 轮1=C3(Gemini `alt=sse` 流式,revert `43ad25fd`)→ 轮2=C2(Imagen `:predict` 路由,revert `25fbc02d`)。
> 两任务同源(都是 `nsai-api/internal/adapter/gemini.go` 协议细节),教训理应可迁移。
> driver:`e2e/dogfood-l4-internalize.mjs`。按用户决定**自然跑、不操纵**。

## Studio 内化机制(实证,决定了本轮设计)

| 问题 | 实证结论 |
|---|---|
| lesson 怎么产生 | 仅 `memory.service.ts::learnFromGateClosure` —— **只在群聊 Gate B `FAIL→fixed`/`false-positive` 或 Gate C 首轮 FAIL→PASS 时**产 `layer:collab` 教训。直接 PASS / unresolved **不产**。 |
| 单聊有无 | **无**。直聊走 `agent:run`,无 coordinator/Gate → 永不产 collab lesson → 内化闭环必须群聊。 |
| 跨轮共享 | 只需同一个 `STUDIO_DATA_DIR`(同 sqlite);collab lesson 跨 conversation/expert 无过滤可 recall。 |
| 验证复用 | 轮1 后 `memory.list()` collab 0→≥1 + 轮2 `memory:recalled` 的 ids ∩ 该 lesson id ≠∅。 |
| post-turn extract | 只产 `shared`/`role` 层(用户偏好/codebase/规范),**永不产 collab**。 |

## 两轮执行

### 轮1 — C3(Gemini alt=sse) ✅ DONE / 23min / 91 ticks
- 路由:Danny→engineer→analyst Gate B。
- 实现:`gemini.go` 检测 `action == "streamGenerateContent"`(原生流式由 URL action 表达、body 无 stream 字段)+ forward `alt=sse`(43ad25fd 核心)。**engineer 主动补测** `gemini_buildrequest_test.go`(表驱动,`wantAltSSE` 真断言重建 URL 含 alt=sse,非循环)。
- Gate B:analyst「All checks genuinely green」**直接 PASS**(非 FAIL→fixed)。
- **结果:collab lessons = 0**。tokens in 168936 / out 87266。

### 轮2 — C2(Imagen :predict) ✅ DONE / 13min / 51 ticks
- 同一会话、同 memory;reload 切 cwd 到 C2 沙盒 + 重装钩子(driver 已处理)。
- 实现:`extractGeminiAction` 白名单加 `predict`(25fbc02d 核心),未命中 `return ""`。**重建了被 revert 删除的** `gemini_action_test.go`。
- **轮2 recall = 13 个记忆**(role/shared 层),collab 仍 0。tokens in 103252 / out 42145。
- 轮2 比轮1 快近一倍(13 vs 23min)。

## 内化闭环判定:**NO-LESSON**(顺风局,机制未触发)

```
INTERNALIZE: NO-LESSON (round1 did not FAIL→fix; tailwind round produces no collab lesson)
lessons=[]  round2RecalledIds=13  reused=[]
memory pool: 21 (role 9 + shared 12, collab 0)
```

**根因(如实揭示 README "内化未跑通")**:collab lesson 机制设计上**只在 Gate B FAIL→修复时产生**;但两轮 agent 都太守规矩——**主动补测、一次做对、Gate B 直接 PASS**,全程零 FAIL → 零 collab lesson → 无教训可内化。这不是机制坏,是**"强 agent 顺风局"天然不产失败教训**的结构性结果。

**但并非全空 —— 跨轮 memory 复用确实发生且有效**:
- 轮1 post-turn 产生 21 条 role/shared 记忆(codebase 结构、英文注释规范、"go build/vet 须绿"、"改动留 working tree"等)。
- 轮2 **recall 了 13 个**这些记忆(`memory:recalled` 实测),且轮2 提速近一倍 —— recall 复用的 codebase/规范记忆 + 同源任务让 agent 上手更快。
- 即:**memory 跨轮共享 + recall 管道完全 working**,只是复用的是 `shared/role` 记忆,**不是** failure-derived `collab` lesson。

## 独立对账(不采信自报/不只信 Gate B)
| | C3 | C2 |
|---|---|---|
| build/vet/test | ✅ 三模块绿,adapter 测试 `ok` | ✅ 绿,adapter 测试 `ok` |
| 隐藏 oracle | C3:agent 测试经 review 是**真断言**(wantAltSSE,非循环) | **`TestOracleC2GeminiAction` PASS**(独立验 :predict→predict / :predictLongRunning→"" 等) |
| 实现正确性 | ✅ streamGenerateContent + alt=sse | ✅ 白名单加 predict |
| 主动补测 | ✅ 新建 buildrequest_test | ✅ **重建**被删的 action_test |

## 关键发现
1. **顺风局不产 collab lesson** → 内化闭环在"自然跑 + 强 agent"下结构性不触发(README "内化未跑通"的真因)。
2. **memory 跨轮复用 working**:轮2 recall 13 条 role/shared 记忆并提速近一倍 —— 内化"管道"通,缺的只是"失败→collab教训"这一环的输入。
3. **agent 间接察觉到埋雷**:轮1 产生一条 role 记忆 "This codebase has a recurring pattern where valid fixes get reverted without justification" —— agent 隐约意识到 baseline 是被 revert 的(但仍正常修复,未质疑任务)。
4. irony:**agent 越守规矩(主动补测、一次做对),内化闭环越难自然触发** —— 这恰是 C1 两轮 collabLessons=0 的同一原因。

## L4 判定(缺口 #5)
| 维度 | 结果 |
|---|---|
| 内化机制管道(共享+recall) | ✅ working(轮2 recall 13) |
| collab lesson 产生(失败→教训) | ✗ 未触发(顺风局,零 FAIL) |
| collab lesson 复用(次轮避同错) | — 无 lesson 可复用,未验成 |
| 两轮各自正确性 | ✅ 独立对账全绿 |
| 缺口 #1 多样性(额外收获) | ✅ Gemini 协议路由领域 ×2 |

**结论:内化闭环的"机制管道"已验证连通(跨轮共享 + recall + 复用 shared/role 提速),但"失败→collab教训→复用"这条核心链路在自然顺风局下未触发** —— 因为可控范围内无法让强 agent 自然 FAIL。

## 给用户的决策点(待定,不自动执行)
要真正验"**collab lesson 能被复用**"这一环,需把"机制是否 work"与"agent 是否自然踩坑"分开,二选一:
- **选项 C**:手动 seed 一条 collab lesson → 跑一个任务 → 看 `memory:recalled` 是否命中它(纯验 recall 复用机制,几分钟)。
- **诱发失败**:给一个 agent 大概率一次做不对、verifier 能抓的任务(如更隐蔽的协议坑),自然走 FAIL→fixed→collab lesson→次轮复用(更真实但更慢、且不保证)。

按你"看完再决定"的安排,这里停下等指示。
