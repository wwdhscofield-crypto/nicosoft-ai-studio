# Coordinator 质量改造（生产端 Track A/B + 验证端 Track C）

> **一句话**:nspay 的 slip 是 **salience(长 context 里"每模块都要测"的优先级被稀释)**,不是能力缺陷、也不是丢记忆(那轮 0 compact)。
> - **生产端**:治根因的是 **in-context per-module 验收(Track A,要做)**;**fresh-context 分批(Track B)是正交且未证的赌注,降级**,正当场景是会 compaction 的"丢记忆 regime",不是 nspay。
> - **验证端**:现有单 verifier **已经**对 over-reach/scope-creep 硬 FAIL(`prompts.ts:72/74`);**真缺口只有一维 —— "build 绿、过测、字面符合任务,但方向/核心假设错"(解错问题 / 重复造已有轮子)**。**Track C = 给单 verifier 补这一维(C-base,要做):具体可指的缺陷硬 FAIL,主观的留 NOTE。** 多 agent 面板**不预建**(四轮对抗审打穿:解错变量、不可建于现有单 verdict 数据结构、advisory 自主模式无处落),仅在 C-base 实测某维反复漏时按需补单维(§5.2,目前是休眠护栏)。

## 1. 根因(精确)

- nspay(18 表 / 11018 LOC / 2h52min,`docs/l4-tests/round-nspay.md`)那轮 **0 compact** → 没丢记忆;架构分层 **100% 干净**;唯一 slip 是**测试完整性/可测性**。
- E 格 p0=0(`docs/l4-tests/round-e-attribution.md`):强 agent 拿 nspay 那两个模块、**零 lesson**,自己就抽了纯核 + 两模块都测(54 test)。→ **小粒度上 agent 本来就不漏测**。
- 两个根因:slip = 长 context 里 per-module 测试优先级被稀释(**验收粒度**,Track A);Gate B 的盲区 = **"绿 build 上的方向/假设是否成立"**(verifier 已查 over-reach,但不审"字面满足却解错问题",Track C)。

## 2. 三条 Track 总览

| Track | 端 | 解决 | 规模 | 状态 |
|---|---|---|---|---|
| **A** per-module 验收 | 生产 | 验收粒度太粗 → 漏测不被点名 | 小(prompt + 三处 cap 改) | **要做** |
| **B** fresh-context 分批 | 生产 | 单 context 负载/丢记忆 | 大 | **降级**(未证;留给 compaction regime) |
| **C-base** 补 assumption/direction 维 | 验证 | 绿 build 但解错问题/重复造轮子 | **极小(一处 prompt)** | **要做** |
| 按需补单维 | 验证 | C-base 实测某维反复漏 | 数据驱动,单维单个 | **休眠护栏**(触发需先建 miss 追踪 + surface;非预建,见 §5.2) |
| ~~多 lens 面板~~ | 验证 | (menu/自动sizing/fan-out/合并)| — | **非目标**(四轮对抗审打穿) |

## 3. Track A — in-context per-module 验收（生产端,要做）

把"每个被点名模块都要有专门测试"(即 nspay collab-lesson #2)从隐性期望变成 **verifier 强制的 conjunctive 契约**,全程**同一个 context**。

**改动点(主路径:三处 cap 一起放开)**
- **`ACCEPTANCE_INSTRUCTION`([route.ts:160](../src/main/services/coordinator-route.ts))升级为 per-named-module conjunctive**,仍从 whole-task prompt 派生(同调用点 `gate-b.ts:35`)。
- **三处 cap 必须一起改**(只改一处会被另两处截断):(a) instruction 文案"a JSON array of 2-4 strings"(`route.ts:160`)、(b) `CRITERION_MAX_CHARS=240`(`route.ts:166`)、(c) `.slice(0,4)`(`route.ts:187`)。nspay 18 模块 > 4 条 → 三处一起按模块数 scale;同时给下游 map+join(三消费者 `gate-b.ts:37/196/245`,无 per-count guard)留意 prompt 体积。**第四个 bound**:`deriveAcceptanceCriteria` 把任务以 `task.slice(0,3000)` 喂 LLM(`route.ts:177`)——大任务整个模块列表可能在派生前就被截断,measure 时一并留意。
- **单独未证选项(非免费替代)**:把 criteria 收成"每个点名模块都有专门测"**一条**、让 `COORDINATOR_VERIFIER_PROMPT` **验证时逐模块枚举**——但这**放弃了 machine-checkable 的 conjunctive 列表保证**(verifier prompt 现不枚举模块),要自己 measure"它真逐模块查而非抽查",**不是**抬 cap 的等价省事做法。
- `acceptanceOverride` 参数**归 Track B**(Track A 无 caller 传它)。

**Measure**:dogfood 重跑 nspay 类任务 → per-module 验收使 slip 消失则根因已治。

## 4. Track B — fresh-context 分批（生产端,降级:未证赌注）

**正当场景**:任务大到触发 compaction、信息真被压缩丢失的"丢记忆 regime"(超 nspay 规模)。nspay 0 compact,**不能用 nspay 论证分批**。

**开建前置条件**:① Track A measure 显残余 slip 且归因单 context 负载/丢记忆;② A/B 对照证明分批补上残余 slip 且不带更多集成错;③ 下列缺陷全修完。

**若建,必须修的缺陷(对抗审确证)**
- decompose 改**带只读 kit 的 agent step**(`chatOnce` 无 tools/cwd),cwd 下枚举真实模块/依赖/已有 helper。
- **decomposition 必须有验证 gate**:依赖图 DAG(拒环)、`dependsOn` id 存在、scope/契约非空。
- **resume**:无 boot driver 读运行态 → 要么真写 resume driver,要么砍 resume claim、运行态标 observability-only。
- **运行态复用已有表**:`gate_outcomes` 表**已存在**(`schema.ts:269`,Gate B 每次 closure 已写,`gate-b.ts:41`)——**引用它**,**不要**给 `project_tasks` 加冗余列;run/task 用 `projects`+`project_tasks`(主键各自 ulid,`conv_id` 非唯一索引)。
- **acceptanceOverride**:给 `runGatedRoleStep` 加 `acceptanceOverride?: string[]` 短路 `gate-b.ts:35`,穿三消费者(`:37/:245/:196`,**三处已读 `gate.acceptance`,可建**)。
- per-module Gate B 成本如实(N+1 次独立全量 verifier loop,无共享 cache)→ 按 module diff scope。**fail handler pin 角色**(`gate-b.ts:168` 会重路由)。**别就地改共享串**(`agent-collab.ts:78`/`route.ts:89` 穿 `orchestrated` flag)。**真正重置负载存疑**(每批仍注入 summary/memory)。**collaborate 暂排除**(MVP 只 single-role)。**触发别只靠 `needsPlan`**(`route.ts:152` 等 fallback omit→falsy)。**依赖**环检测 + blocked 传递闭包且建议性。**耦合 gate**:低耦合才 batch。

**decompose 与 plan mode 分层（plan mode 不被砍）**:decompose 是 coordinator 的**宏观**分解(做哪些模块 / 什么顺序 / 什么接口,新增);plan mode + Gate A 是 expert 的**微观**(这个模块怎么实现,原有保留)。二者**嵌套不替代**:

```
decompose(宏观:做哪些模块 / 什么顺序 / 什么接口)   ← coordinator 拥有(新增)
  └─ 每个模块派发:
       plan mode + Gate A(微观:这个模块怎么实现)   ← expert 拥有(原有,保留)
       → 执行 → per-module Gate B
```

- 改造后 plan mode 在**模块粒度**跑(非 bypass),比对整任务规划更聚焦 —— 不仅没砍,反而更准。
- bypass 现本就 skip plan mode(`gate-b.ts:48` "skip the plan-review FRONT gate"),decompose 是给 bypass **补上缺失的宏观规划层**,不是拿掉 plan mode。
- 可选的 decompose 后"宏观计划确认"与微观 Gate A **分属两层,不得混为一谈**。

## 5. Track C — 验证端:给单 verifier 补 assumption/direction 维（要做）+ 按需补单维（休眠护栏)

### 5.1 C-base:补"绿 build 上方向/假设是否成立"一维（要做,一处 prompt,零 plumbing）
- **诊断(纠正)**:`COORDINATOR_VERIFIER_PROMPT`([prompts.ts:67](../src/main/agent/roles/prompts.ts))**已经**查 scope creep / "changes that don't match the task"(`:72`)并对 over-reach **硬 FAIL**(`:74`)。所以 over-engineering 的大半已覆盖。**真正缺的一维**:diff **build 绿、过测、字面符合任务,却解错问题 / 重复造已有轮子**——这类没有"broken contract"可抓,现有 persona 放过。
- **改动**:对 `gate-b.ts:266` 已加载的同一个常量加几句,**零 plumbing**;但这几句的措辞有实施要求(否则那条 FAIL 要么永不触发、要么 over-block):
  - **窄硬 FAIL ①「重复造已有轮子」必须配检测程序**:现有 persona 从不搜 prior art(`prompts.ts:72` 只看 diff 本身)→ 光命名 FAIL 条件它永不触发。step 1 要加一句**程序**:"新增 helper/util/function 时,`git grep` 按意图/相似名搜 repo 是否已有等效实现;命中且 diff 重复了它 → FAIL"。kit 已含 Grep+Bash(`gate-b.ts:265`),缺的只是指令。
  - **窄硬 FAIL ②「行为与任务字面不符」必须配 carve-out**(否则误判,重蹈 `gate-b.ts:280`):**只在 diff 确实做了任务没要求的 AND 没做任务要求的**才 FAIL;**满足 intent 但走不同有效路径 / 合理解读了歧义任务 / 形似但不同的 util** 一律**不** FAIL。且写成区别于现有 `:72`"changes that don't match the task"的**额外 lens**(真正新的是"字面满足却解错问题" + "重复造轮子"),别重述 :72。
  - **主观留 NOTE**:纯"感觉过度设计 / 路子可能不优"无具体可指缺陷 → evidence 里 **NOTE 不 FAIL**(防 taste-based over-block)。NOTE 必须**锚在 evidence prose 内**,不得产生独立的 `VERDICT:` 行(`gate-b.ts:283` last-match 正则会误读,重蹈 fail-open 那次回归)。
  - correctness(build/diff)+ 现有 over-reach 仍硬 FAIL,不动。
- **诚实标注(自主模式)**:NOTE 在 **PASS 路径 write-only**(进 `gate_outcomes.evidence` 500 字截断、渲染成计数、无文本呈现,`gate-b.ts:72`/`gate-outcome.repo.ts`/`analytics.service.ts`)→ **NOTE 只在交互模式(人读 verdict 文本)有用**,自主模式要可见需先建 §5.2 的 surface。**窄硬 FAIL 不受此限**(FAIL 走 closure,有呈现)——所以 C-base 的**真增量主要在那条窄硬 FAIL**,NOTE 是交互模式的附加。

### 5.2 按需补单维（休眠护栏,数据驱动,非预建面板）
多 agent verifier **不预建**。仅当 C-base 实测暴露具体缺口才按需补,三条写紧防口子膨胀:
1. **触发(可操作前提)**:C-base dogfood 真实产物**累计 ≥N 轮**,verifier 对**某一具体维度**(如 security)**反复漏报**且被独立复核坐实。
2. **才补(单维单个)**:只针对**那一维**加一个 advisory pass。**一次只为一个被实测证明的缺口补一个**;**禁止"既然补了 X 不如把 menu 补齐"**——那就是偷偷重建面板。
3. **前置(补之前必须先有)**:自主模式"它的发现落到哪"的**呈现通道**(一个 PASS 后的 advisory-notes coordinator beat,gate on `gateOutcome==='pass' && 有 advisory`,且不违反 closing-voice 不变量 `gate-b.ts:22`)。
- **休眠现状(诚实)**:§5.2 的触发"实测反复漏某维"需要**维度级 miss 追踪**(现 `gate_outcomes` 只存 pass/fail 计数,无维度字段)**和** PASS-path surface——**两样都没建**。所以 §5.2 **现在进不去,是防膨胀的护栏,不是活的演进路径**。真要激活,第一步是单独 justify 并建那两样(各自不小),不会自己冒出来。
- **明确删除(非目标)**:6-lens 固定菜单 / 自动选子集 / adjudicator / 并行 fan-out / 机械合并 / N→1 reduce(解错变量、不可建于现有单 `{passed,feedback}` verdict、并发同 roleId 撞流、自主模式无处落)。

## 6. 现状盘点(带 file:line)

| 能力 | 现状 |
|---|---|
| 验收标准 | `ACCEPTANCE_INSTRUCTION` 串 [route.ts:160](../src/main/services/coordinator-route.ts)("2-4 strings");另卡 `CRITERION_MAX_CHARS=240`(`:166`)+ `.slice(0,4)`(`:187`);唯一调用 [gate-b.ts:35](../src/main/services/coordinator-gate-b.ts)(无条件覆盖,喂三消费者 `:37/:245/:196`,各自 map+join 无 per-count guard) |
| 单 verifier | `COORDINATOR_VERIFIER_PROMPT` 查 diff+toolchain **+ scope-creep/over-reach 且对 over-reach 硬 FAIL**([prompts.ts:72/74](../src/main/agent/roles/prompts.ts));`systemPromptOverride` 加载([gate-b.ts:266](../src/main/services/coordinator-gate-b.ts));返回 `{passed, feedback}`(**无 findings/severity 结构**)。**缺的维 = green-diff 上 core-assumption/direction validity(可指缺陷硬 FAIL,主观留 NOTE)** |
| verifier 派发 | `runVerifierStep` **单身份**(`chooseVerifierRole` 一个角色;流/持久化/dispatch chain 按单 roleId,[gate-b.ts:230](../src/main/services/coordinator-gate-b.ts));persona 硬编码,无 focus 参数 |
| 闭环/呈现 | FAIL → `chooseFailHandler`(单 feedback,会 `route()` 重路由);**PASS 路径** feedback 只进 `gate_outcomes.evidence`(`gate-b.ts:72`,500 字截断,`analytics.service.ts` 渲染成计数);coordinator beat 仅 unresolved/false-positive/unverified 有文本([coordinator.service.ts:113](../src/main/services/coordinator.service.ts)),**PASS 无文本呈现通道**;误判 PASS→FAIL 有真实先例(`gate-b.ts:280`) |
| run/task + 结果 | `projects`+`project_tasks`([schema.ts:107](../src/main/db/schema.ts));`gate_outcomes` 表**已存在**(`schema.ts:269`) |

## 7. 非目标 / 后续

- **预建多 lens 面板**(menu / 自动 sizing / adjudicator / fan-out / 机械合并)——非目标;只在 C-base 实测某维反复漏时,按 §5.2 补那一维(且 §5.2 现为休眠护栏)。
- **维度级 miss 追踪 + PASS-path advisory surface** —— §5.2 的两个前置基建,未建;要激活 §5.2 须先单独 justify 建它们。
- collaborate-mode 分批 / 运行时动态再拆 / 自定义角色进编排。

---
*修订记录:v1 捆验收+分批 → v2/v3 把 Track C 做成无cap/8-lens/adjudicator/机械合并,被三轮对抗审打穿 → v4 advisory 多 agent,第四轮证自主模式无呈现通道、菜单 ②③ 被 base 覆盖、解错变量 → v5 收为 C-base 扩 persona(observational)+ 按需补单维。**v6(本版)**:第五轮纠正诊断——verifier **已** FAIL on over-reach,真缺口只有"green-diff 上方向/假设错"一维;C-base 改为 **具体可指缺陷硬 FAIL(重复造轮子/行为不符任务)+ 主观留 NOTE + 诚实标注 NOTE 自主模式 write-only**;§5.2 标为休眠护栏(触发需先建维度级 miss 追踪 + surface);Track A 三处 cap 主路径、per-module 枚举降为未证选项。*
