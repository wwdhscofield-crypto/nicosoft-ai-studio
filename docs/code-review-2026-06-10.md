# NicoSoft AI Studio 代码审查（2026-06-10）

> 范围：`src/`（main 142 文件 18,180 行 + renderer 54 文件 9,287 行 + preload）、`styles/*.css` 2,880 行、5 个 locale JSON（各 530 key）、`e2e/` 135 个 driver 脚本。
> 方法：4 路并行深扫（死代码 / 隐藏 bug / 重复共享 / 规范违反），每条发现要求 file:line + 证据；死代码用 AST-lite import 解析 + 动态前缀排除 + 抽样复核；i18n 死键由两路独立扫描得出同一数字（165）互证；关键发现（e2e 泄漏、projects onError、primitives 死簇、media.handler 直 SQL、死键样本）已人工抽查坐实。
> 本文档**只列问题**，不含修复计划。

---

## 处理进度（2026-06-10 更新 · commits 4f67c7a / 51de4b6 / e06a389 / 5862aa4 / 5d44fa6 / 1d37abc / c520815 / 25975a9）

**表 4（重复代码/可抽取共享）三阶段完成（1d37abc=A main 进程 / c520815=B coordinator 拆分 / 25975a9=C renderer）**：

| 类 | 处理 | 状态 |
|---|---|---|
| 4.3#1 thinking 双镜像表 | **`src/shared/thinking.ts`**（新跨进程目录，双 tsconfig include + vite `@shared` alias）：表/probe/adaptive/clampDepth/ThinkingParam/protocolFamily 单源；main 留 resolveDepth、renderer 留 capability/UI 层 | ✅ A |
| 4.3#2 roster 双份 | `src/shared/roles.ts`：ROLE_DISPLAY_NAMES + displayName/roleIdFromName；renderer EXPERTS 名字引共享 | ✅ A |
| 4.3#3/4 Anthropic cache+thinking ×2 | `llm/anthropic-wire.ts`：version/headers/directive/applyAnthropicCacheControls；**两侧 max_tokens 抬升策略不同（chat 恒抬 / agent 按需）逐字保留在调用点** | ✅ A |
| 4.3#5/6 + 4.5 | `_shared.ts` 增 trimBase/geminiBase(11 处)/openai+gemini headers/DEFAULT_INSTRUCTIONS/stablePromptCacheKey(×2 逐字)/geminiThinkingConfig/asGeminiFunctionResponse；token-count 刻意保留无 UA headers 只共享 version 常量 | ✅ A |
| 4.3#7 repo 模板 | `repos/_sql.ts`：parseJson(×3 逐字)+buildUpdate+asJson/asBool；5 个 update() 重写，字段转换留调用点 | ✅ A |
| 4.3#8 credentials ×3 | `services/credentials.ts::requireApiKey`（chat/agent 逐字对）；endpoint.service.test 文案刻意更短**保留不动** | ✅ A |
| 4.3#9 llm-once ×5 | `services/llm-once.ts::endpointWithKey/chatOnce`（title/memory×2/router/Gate A/facilitate 接入；parse+fallback 留调用点；**Gate A 两条失败文案逐字保留**） | ✅ A |
| 4.3#10 protocol→family ×4 | shared `protocolFamily`；collab 排除 gemini 的语义显式保留 | ✅ A |
| 4.3#11 stream 脚手架 | `ipc/stream-lifecycle.ts::StreamRegistry`（agent+coordinator 同构对）；**chat 简化版刻意不并**（并入会新增 abort-on-renderer-gone 行为） | ✅ A |
| 4.3#12 dialog 样板 ×5 | `ipc/dialogs.ts::pickDirectory/saveToFile`；project:pick 顺带 win-scoped（C8 同款守卫） | ✅ A |
| C4(表3 deferred) | analytics SQL → `repos/analytics.repo.ts`，service 只留 shaping | ✅ A |
| **C13/C7(表3 deferred)** | coordinator.service 1497 → 9 文件（types/route/step/gate-b/gate-c/approvals/collab/prompts + 编排器 344）；RouteDecision discriminated union，**18 处 `decision.role!/roles!` 归零** | ✅ B |
| 4.1#4 Toggle ×2 | primitives.Switch（memory MemToggle + extensions Toggle；DOM/类不变） | ✅ C |
| 4.1#7 Segmented 8 处 | primitives.Segmented（profile 本地版 + 6 处手写 div；per-option disabled + className 扩展） | ✅ C |
| 4.2 工具函数 | lib/format.ts(fmtTokens studio/analytics 对) + lib/path.ts(basename workspace/tool-bubble 对) + lib/ipc-error.ts(×2 逐字) + studio-data.expertMeta(×2 逐字)；**conversation 的 fmtTokens/fmtElapsed 显示契约不同不并**；日期 ×4 各语义不同不并 | ✅ C |
| 4.4 CSS | cr-icon 子集冗余删 / .iv-nav 同文件两段合一 / **.model-tag 同名两定义实为双死 CSS 直接删**（表2 漏网补刀） | ✅ C |
| 4.6 e2e helper | `e2e/_helpers.mjs`（untracked）：launchStudio/seedState/seedKeys(keyState 契约)/sendAndWaitIdle/shot，自检通过；**135 个历史 one-off 不回填** | ✅ D |

**Deferred batch 1 已完成（a05fc60，24 文件 +1395/−1413）**：
- ✅ 4.1#1 modal 壳：`components/modal.tsx`（标准壳 + className/onDialogKeyDown）；9 dialog + projects NewProjectDialog 接入；EventDetailModal（head 带时间戳+裸 pre body）刻意保留手写
- ✅ C14 dialogs.tsx：1246 行 → `components/dialogs/<name>-dialog.tsx` ×9（消费者直 import 真实文件，无 barrel）；CommandPalette 随迁但保留 .cmdk 独立 DOM
- ✅ 4.1#5 scope-picker：`components/scope-picker.tsx`（Mcp/Skill 逐字块）+ locale `mcp.*/skill.*` 双份 scope 族 → `scope.*` 单族
- ✅ 4.5 locale common.*（部分）：Cancel ×5 / Save ×3 同值键 → `common.cancel/save`（5 locale 各 +7/−18，合并前校验 twins 同值）；dialogs 内剩余手写 segmented（protocol/transport/source）→ primitives.Segmented；endpoint cache 开关 → primitives.Switch
- 验证：typecheck+build+**运行时弹窗 smoke**（McpDialog 双 segmented + ScopePicker 9 pills + scope.*/common.cancel 解析 zh-Hans + SkillDialog/NewProject/RolePicker(Escape 关闭) 全开，零错误）+ 截图对版式

**Deferred batch 2 已完成（df7b722，24 文件 +1734/−1637）—— 表 4 全部收口**：
- ✅ 3.5 agent.service.ts：978 → 263（门面 run+readTranscript）+ agent-tools(79)/agent-system(109)/agent-dispatch(377)/agent-collab(219)；消费者改指真实模块（coordinator-step/route/gate-b → agent-dispatch、coordinator-collab → agent-collab、scheduler engine）；死引用 ToolCallDto 顺除
- ✅ 3.5 stores/chat.ts：1221 → 994 + chat-types(122)/chat-helpers(118)；store 导出面不变、消费者零改动；send 流水线/审批段经判定闭包捕获 set/get **不可外提**（如实保留）
- ✅ 3.5 views/conversation.tsx：851 → 210（仅 ChatView）+ composer(311)/chat-segment(353)；恒-K fmtTokens 随 Composer、m-s fmtElapsed 随 readout（显示契约不与 lib/format 合并）；App.tsx 零改动
- ✅ 4.5 'Add endpoint' ×3 同值键（5 locale 校验后）→ common.addEndpoint；expert.tsx 两处硬编码英文按钮一并接入
- 验证：typecheck+build；boot smoke + dialog smoke + **真实 coordinator turn**（composer 发送 → chat store → route → agent-dispatch → 持久化回读精确命中，零 page error）——三拆分全运行时实证；三个拆分均逐段 diff 比对 HEAD 证明 VERBATIM（唯一差异 = 跨模块所需 export 前缀）

**表 5（交叉关联）逐条收口（2026-06-10 终态）**：
- #1 e2e driver 启动身份 ×135：原建议"全改 `args:['.']`"**已被实锤证伪**——Playwright `_electron.launch` 强制 `--use-mock-keychain`，safeStorage 走空主密钥 mock，与启动 args 无关（两种 args 对同一密文实测均解不开）。实际解法已落地：userData pin（b906643）让多入口同 DB；新 driver 统一走 `e2e/_helpers.mjs::seedKeys()`（endpoints.update 现种 + `keyState==='ok'` 判定）。135 个历史 one-off 不回填（一次性验收工件）。
- #2 i18n 死键双路印证：随表 2 D4 删除收口 ✅
- #3 CodeBlock 死簇三发现同根：随表 2 D5 删簇收口 ✅
- #4 `hasKey` 契约漂移 ×97：**实测判定为安全降级，非坑**——全部 97 处分两类：守卫类 `!ep?.hasKey → return {ok:false} → SKIP 带原因`（DTO 删字段后 undefined→falsy→明确跳过，不是 review 担心的"静默全 true"）；种 key 类 `if (!ep.hasKey && key) → 重新种 key`（undefined 恒真→每次重种→mock-keychain 下恰是正确行为）。无一处假阳性方向。历史脚本不回填；新 driver 的 `_helpers.seedKeys` 用 keyState 且头注释明示 hasKey 已废。
- #5 chars/4 与 memory.handler 上浮同源：随表 3 C2+C15 收口 ✅

**终判不做（每项理由自洽，重开需推翻理由）**：
- 4.1#2 RowMenu ×6 / 4.1#3 select-menu ×7：共享壳已在 useAnchoredMenu 单源；七处 select 分属**三个 CSS 类族**（profile dropdown-* / composer rm-* / path-bar path-branch-*），check 位置/a11y/portal 策略/加载时机各异且多处注释自述原因——统一=把全部差异 props 化重造 JSX
- 4.1#6 test-connection ×2：两机成功路径不同（MCP 带 toolCount+toast）
- 4.1#8 memory 行 ×2 / 4.1#10 折叠头：两套类族 DOM 不同，强并=视觉风险
- 4.1#11 approval-dialog SVG：与 Icons.terminal/listChecks 坐标不同（视觉不等价），不盲替
- 4.2 with-toast ×23：各链含 reload/setState 差异
- 4.4 --fs-* token ×270：值命名 token（--fs-12）是伪抽象零收益；语义命名需逐处设计判断，机械绑定把不相关元素字号人为耦合（违反"不擅自合并档位"）

验证：A/B/C 每阶段 typecheck+build+boot smoke；**B 阶段额外跑真实 coordinator turn**（driver seedKeys → route→direct dispatch→持久化回读 "PHASE_B_OK"，零 page error）；C 阶段 smoke 实测 Extensions 四 tab（新 Segmented 驱动）+ Tools Switch 渲染。

---

## 旧进度（2026-06-10 早些 · commits 4f67c7a / 51de4b6 / e06a389 / 5862aa4 / 5d44fa6）

**表 3（规范违反）可处理项全部完成（待提交）**：

| §子节 | 处理 | 状态 |
|---|---|---|
| 3.1 分层违反 | **C1** `app:info` 下沉 `analyticsService.appInfo()`（media.handler 去掉 getDb，repo 各加 `count()`）；**C2** memory CRUD 全部业务规则上移 `memory.service`（handler 改薄壳纯透传，去 repo/SQL）；**C5** project.handler 的 git 分支逻辑抽 `services/git.service.ts`（currentBranch/listBranches/checkout，三 handler 变一行转发） | ✅ |
| 3.1 分层（缓） | **C4** analytics 聚合查询仍内联 handler——边缘只读、抽 repo 收益<风险 | ⏸ DEFERRED |
| 3.2 裸 ulid | **C6** chat/agent/coordinator.handler 改 `import { ulid } from '../db/id'`（单一源 db/id.ts） | ✅ |
| 3.3 TS 质量 | **C9** `?.name ?? roleId` 等空安全收口；**C10** e2e-request.ts / App.tsx 的 eslint-disable 补理由 | ✅ |
| 3.3 TS（缓） | **C7** `RouteDecision` 改 discriminated union 消除 12 处 `decision.role!`——消费点全在 coordinator dispatch 层（=3.5 待拆区域），与表 4 拆分同做避免动两次 | ⏸ DEFERRED→表4 |
| 3.4 console 残留 | **C12** coordinator.service:412 `console.log` → `console.warn` | ✅ |
| 3.5 超大文件 | **C13/C14** coordinator.service(1497)/其他>800 行按自然边界拆 | ⏸ DEFERRED→表4 |
| 3.6 硬编码 | **C11** 38 处硬编码英文 toast → `t()`（projects/scheduled/workspace/expert/extensions 5 视图）；新增 23 键 × 5 locale（projects./scheduled./mcp./skill./plugin./tools.），复用既有 mem./conv./mcp. 键 8 个；2 处 arrow 参数 `t`（memory text / TaskDto）与翻译函数 `t` 撞名 → 重命名 text/task | ✅ |
| 3.6 其他 | **C8** plugin/skill.handler 的 dialog 加 win-scoped 守卫；**C15** `chars/4` token 估算 5 处复制 → 单一源 `llm/estimate.ts`（estimateTextTokens） | ✅ |

验证：typecheck 0 错（node+web）、build OK、运行时 boot smoke——4 nav row 起来、Projects/Scheduled/Extensions（+MCP/Skills/Plugins/Tools 4 子页各自 `const t=useT()`）全渲染零 console/pageerror；新建项目触发 `t('projects.created')` → toast 实显 **"项目已创建"**（zh-Hans 命中，非原始 key），i18n 运行时解析端到端坐实。JSON.parse ×5 valid、23 键 ×5 locale 计数齐。

**表 2（死代码）全部完成（5862aa4，-1307 行）**：D1 primitives 死簇 + types.ts 连带 ✅ / D2 零引用导出 ✅ / D3 export 冗余 21 处 ✅ / D4 死键 164×5 locale（动态前缀保守保留 mem.* 零散 3 个，5 locale 同构 366 key）✅ / D5 死 CSS 92 类 95 规则（**复验抓住名单 3 个误报**：model-select/test-title/width-switch 在用已保留）✅ / D6 zod-to-json-schema 卸载 ✅ / D7 死常量 ✅。每项删除前全部经机器复验（全 token grep + 动态前缀白名单），非照单全收。验证：typecheck 0 错、build OK（renderer -46K）、12 视图 UI smoke 全渲染零 pageerror。

表 1（隐藏 bug）+ NEW-1 全部已修并验证：

| 项 | 修复 | 验证 |
|---|---|---|
| B1 e2e_browser 会话泄漏 | session 标 owner=ctx.runId；runAgentLoop finally `disposeE2ESessionsOwnedBy`；before-quit 兜底；**+launch 半途失败自清理（e06a389，见 NEW-2）** | ✅ **运行时全链路 PASS**：agent 真 launch（违令不 close）→ run 结束 → 主进程日志 `[agent] reclaimed 1 unclosed e2e browser session(s)` → 目标进程归零（driver e2e/bugfix-b1-b3） |
| B2 projects dock 只听 onDone | onDone+onError 都 settle；run 启动失败也解锁 | ✅ 错误路径逻辑，typecheck + review 自证 |
| B3 删会话不清 sessions 目录 | remove() 追加 `rm -rf ~/.nsai/sessions/<convId>` | ✅ **运行时 PASS**（真造目录→remove→目录消失） |
| B4 openExternal 无白名单 | 仅 http/https/mailto 放行 | ✅ 逻辑直白，review 自证 |
| B5 chat 首条失败不回滚 | 三路 send 共享 `failSend()` | ✅ 三路收口逻辑，typecheck + review 自证 |
| NEW-1 e2e_browser 完全不可用 | **已修（51de4b6）**：main 构建 externalize playwright/playwright-core——externalizeDepsPlugin 只管 dependencies，devDep 的 playwright 被 bundle 进 out/main，rollup 把 playwright-core 惰性 `require("chromium-bidi/…")` 提升为加载即执行 → 一调即炸。externalize 后 dev 从 node_modules 解析（惰性保持惰性），生产无 devDep 时走工具既有优雅降级 | ✅ **运行时 PASS**：launch 真拉起目标 app（修复前同 prompt 立即报错） |

### NEW-2 [中·验证过程发现并已修] launch 半途失败的半成品进程永久泄漏（e06a389）
- 现象（实锤复现）：Electron target 进程已启动但 `firstWindow()` 超时抛错（target 无页面）→ session **从未入 Map** → close 无 sessionId、run-end 回收查 Map 为空——这个进程谁都找不到，永久泄漏。两轮验证中泄漏的进程正是它（dispose 正确报告空 Map 的同时进程仍存活）。
- 修复：`launch()` 内任何后续步骤（newPage/goto / firstWindow）抛错时，先 close 已创建的 browser/electronApp 再 rethrow。
- 教训：资源"创建"与"注册"之间的窗口是回收体系的天然盲区——所有"创建即持有"的工具该按此模式自检。

---

## 一、隐藏 bug 与坑

### [高] e2e_browser 启动的浏览器/Electron 进程在 run 结束时泄漏
- 位置：`src/main/agent/tools/e2e-browser.ts:31`（模块级 `sessions` Map）；teardown 仅在 `close` action（:200-208）及其 catch（:239-248）
- 场景：`launch` 开 Chromium / Electron 后存入模块级 Map，只有模型显式调 `action:'close'` 才清理。agent 跑完 / 被 abort / 报错 / 模型忘了 close → 浏览器进程与 Map 条目永久泄漏。Gate C 后台验证（最多 3 轮、独立于用户 turn）大量用 e2e_browser，FAIL 轮或中断时最容易留孤儿进程。
- 证据：`runAgentLoop` 的 finally（agent.service.ts:455-460）dispose 了 `ServiceRegistry` / `AsyncSubAgentPool` / `LSPManager`，唯独没有 e2e sessions 的等价清理；`ctx.signal` 也没接 teardown。（已抽查坐实）

### [中] 项目工作台 dock 的 coordinator run 只听 onDone——错误时监听器泄漏 + 永久卡 running
- 位置：`src/renderer/src/views/projects.tsx:534-543`
- 场景：`setRunning(true)` 后仅注册 `coordinator.onDone`（按 streamId 过滤命中才 `off()` + `setRunning(false)`）。run 以 `coordinator:error` 收场时 onDone 永不触发 → 每次失败泄漏一个监听器，且 `running` 永远 true，dock 发送被永久禁用直到重开视图。
- 证据：全文件 `onError` 出现 0 次（已抽查坐实）；对比 chat.ts 的协调路径有 try/catch + finishWithError 兜底。

### [中] 删除会话不清理 `~/.nsai/sessions/<convId>/` → 磁盘无限堆积
- 位置：`src/main/services/conversation.service.ts:106-109`（`remove`）
- 场景：`remove` 只删 DB 行（FK CASCADE）+ media 目录。但 agent run 把 `transcript.jsonl` + `tool-results/` 写进 `~/.nsai/sessions/<convId>/`（agent.service.ts:349-351），e2e 截图也写这里（e2e-browser.ts:163）。删会话后该目录永不清理。
- 证据：`removeConversationMedia` 只覆盖 `dataDir()/media/<convId>`（media/storage.ts:104-110）；全仓无任何 `rmSync(.../sessions/<convId>)`。

### [低] `setWindowOpenHandler` 对任意 scheme 直接 `shell.openExternal`，无白名单
- 位置：`src/main/index.ts:74-77`
- 场景：handler 无 `new URL().protocol` 校验。现实可达的 URL 经 rehypeSanitize（http/https/mailto）或来自 web_search 结果，可利用性低，但缺 `http/https/mailto` 白名单是纵深防御缺口（异常 scheme 链接会被交给 OS 处理）。

### [低] 纯 chat 路径首条消息失败不回滚空会话（与 agent 路径不一致）
- 位置：`src/renderer/src/stores/chat.ts:1077-1088`（chat 路径）vs :1044-1057（agent 路径）
- 场景：agent 路径在新会话首条 run 抛错时 `conversations.remove(cid)` 回滚；chat 路径只 `finishWithError`，留下 user 气泡 + 无标题幽灵会话挂在 History。

### 已排除的常见嫌疑（核查为非问题，防止以后误报）
- keychain credentials.json 的 load-modify-save：全同步 fs 调用、主进程单线程 + IPC 同步入口，无并发交错
- agent/coordinator handler 的 pending permission/question Map：终端 `sweepStream` 全部 settle + 删除，无泄漏
- agent loop 反应式压缩/重试：先 `turnAbort.abort()` 再重试，工具不会二次执行
- chat deltas 按 `meta.convId` 路由：切换会话不会串写

---

## 二、死代码

### 2.1 全仓零引用的导出（可删声明）
- `src/main/agent/roles/prompts.ts:308` `BuiltinRoleId`（连带 :307 `BUILTIN_ROLE_IDS` 成对死）；:324 `isDispatchableRole`（连带 :312 `DispatchableRoleId`）
- `src/main/db/connection.ts:72` `closeDb`
- `src/main/ipc/contracts.ts:680` `PluginInstallResult`、:752 `ProjectTestInput`
- `src/main/mcp/types.ts:20` `McpTransportType`
- `src/renderer/src/lib/agent-mode.ts:13` `modeLabel`
- `src/renderer/src/lib/api.ts:7,8,18,20,24,26` 六个 type 别名（`RoleBindingDto`/`RoleStateDto`/`McpTestResult`/`McpScope`/`SkillScope`/`PluginBundleDto`）
- `src/renderer/src/lib/thinking.ts:162` `clampDepth`
- `src/renderer/src/stores/locale.ts:91` `translate`（"非 React 场景用"的入口从未被用）
- `src/renderer/src/types.ts:37` `Conversation`、:86 `RoleBinding`、:108 `Project`（连带 :95 `ProjectTask`、:103 `ProjectTest`）
- **primitives.tsx 死簇（约 160 行）**：`Segment`(:217) → `Block`(:186) → `CodeBlock`(:122) + `GeneratedPoster`(:145) → `highlight`(:78) 五个导出仅簇内互用、簇根零消费（全仓对 primitives 的 import 仅 `Avatar/AvatarStack/HealthDot/DispatchBadge/NameChip`，已抽查坐实）。连带 `types.ts:20 BlockType`、:21 `Block`、:28 `Segment` 死亡。注意 markdown.tsx:89 另有同名 `CodeBlock`，那个是活的。

### 2.2 export 关键字冗余（仅定义文件内自用，~30 处值类导出）
main：`compact.ts:198 CLEARED_MARKER`、`confine.ts:8 ConfinementError`/:17 `confinePath`、`execution.ts:64 runOne`/:97 `isToolSafe`、`llm-gemini.ts:57 toContents`/:102 `toGeminiTools`、`prompts.ts:17 ROLE_DISPLAY_NAMES`、`_shared.ts:8 codeForStatus`、`mcp/connection.ts:8 createMcpClient`、`mcp/strings.ts:5,9`、`token-count.service.ts:25 countAnthropic`、`skills/tool.ts:14 SKILL_TOOL_NAME`
renderer：`command-palette.tsx:21 SLASH_COMMANDS`、`icons.tsx:15 Icon`、`shell.tsx:118 RoleRow`、`image-models.ts:7,19`、`chat.ts:32 roleIsCoordinator`、`verify.ts:35 parseAssertPass`、`analytics.tsx:43,87,105`、`memory.tsx:28 LAYER_META`/:42 `MemoryItem`
（类型/接口因 TS 可见性必须 export 的 ~60 处已逐类排除，不在此列。）

### 2.3 i18n 死键：165 个 × 5 语言 ≈ 825 条死翻译
两路扫描独立得出同一结论；已排除动态前缀（`settings.nav.`、`mem.`、`tz.region.`、`labelKey` 数据字段）假阳性。模式：旧 key 家族整组被短前缀新家族取代。

| 死键家族（0 引用） | key 数 | 现行替代 |
|---|---|---|
| `settings.endpoints.*` | 17 | `epPage.*` |
| `settings.roles.*` | 15 | `rolesPage.*` |
| `memory.*`（含 vectorDb/documents/totalVectors 等原型期 RAG 概念）| 48 | `mem.*` |
| `conversation.*` | 18 | `conv.*` |
| `dialogs.endpoint.*` | 20 | `ep.*` |
| `dialogs.role.*` | 22 | `roleEditor.*` |
| `dialogs.command.*` | 13 | `cmdk.*`（注：command-palette.tsx 现为硬编码英文，连 cmdk 也未全用） |
| `dialogs.approval.*` + `dialogs.question.*` + `dialogs.confirm/prompt.cancel` | 10 | `ap.*` / `q.*` |
| 零散：`ep.slugPlaceholder`、`mem.sharedHint/roleHint/collabHint` | 4 | 无 |

反向检查（代码用了但 locale 缺失）：**0 个**。5 个 locale key 集合完全同构（同步性合格）。

### 2.4 死 CSS 类：95 个（高置信；已排除 toast-*/verify-*/mode-* 动态拼接与 .shiki 库类）
- 旧 composer 工具栏簇（screens.css）：`.composer-toolbar` `.model-select` `.m-id` `.send-btn` `.attach-chips` `.attach-chip` `.ac-x` `.msg-tokens` `.skel-line` `.cmp-model-menu` `.cmp-reasoning` `.cmp-reason-label` `.cmp-att-thumb` `.cmp-att-file` `.cmp-att-name`
- mention 弹层簇：`.mention-pop` `.mp-head` `.mention-row` `.mr-name` `.mr-spec`
- 旧 studio floor / workstation 簇：`.studio-floor-wrap` `.studio-floor` `.workstation` `.ws-top` `.ws-top-right` `.ws-dot` **`.ws-activity`(:657)** `.ws-name` `.ws-lead` `.ws-spec` `.ws-foot` `.ws-model` `.ws-status` `.ws-new-icon` `.ws-new-label`
- 旧项目详情簇（~34 个）：`.proj-detail-*` `.proj-section` `.ps-*` `.plan-*` `.exec-*` `.test-*`（projects.tsx 现用 wb-* 家族）
- 旧时间线 step 簇：`.tl-preview` `.tl-progress` `.tl-steps` `.tl-step` `.ts-*`
- 零散：`.tok-fn` `.w-1024` 等 7 处 `.lang-toggle` `.ext-foot` `.conv-rename` `.rb-model` `.wb-running` `.wb-test-note`；styles.css 的 `.width-switch`（electron-overrides.css:22 同名也死）`.health-cluster` `.health-pill` `.tl-close/.tl-min/.tl-zoom` `.hist-group-label` `.model-tags` `.mt-remove` `.mt-input`

### 2.5 依赖与其他
- `zod-to-json-schema`：全仓 0 import（实际用 zod v4 原生 `z.toJSONSchema`，loop.ts:87）；`agent/types.ts:87` 还有一条过时注释提到它
- `typescript-language-server` 无 import 但经 `lspRequire.resolve(...)` spawn（lsp/manager.ts:85）——**不是**死依赖
- 死常量：`dialogs.tsx:221-222 AGENT_SCOPE_NOTE`（已被 `t('mcp.agentScopeNote')` 取代）
- 孤儿文件：无；≥5 行注释代码块：无

---

## 三、规范违反（依据：代码注释自述的 12 条约定）

约定出处：keychain.ts:5-8（密钥仅 keychain 层）、各 service 头注释（不碰 IPC/SQL）、各 repo 头注释（纯 SQL）、各 handler 头注释（薄边界，"No SQL / repo / keychain here"）、contracts.ts:3-7（DTO 零密钥）、llm/types.ts:2-3（adapter 零 DB/keychain）、db/id.ts:6（"everywhere" 用统一 id 而非裸 ulid）、media/storage.ts:1-5（图片绝不 base64 入库）、confine.ts:1-3（文件工具必过 confineReal）、thinking.ts:4-5（main/renderer 镜像表保持同步）。

### 3.1 分层违反
1. **`ipc/media.handler.ts:6,52-58`**：handler 直接 `getDb()` + 两条内联 `SELECT COUNT(*)`——全 ipc/ 唯一摸 DB 的 handler（已抽查坐实）
2. **`ipc/memory.handler.ts:2,14-35`**：唯一运行时直 import repo 的 handler；四个 CRUD 绕过 service 直通 `memoryRepo`，且业务规则上浮到 handler（token 估算 `Math.ceil(len/4)` 写两遍 :26,:32、type/layer 归一化 :17-18、dedup 时 source 优先级语义 :24）。对照组：同域 `memory:onTurn` 走了 `memoryService.onTurn`
3. **`services/analytics.service.ts:9,39-81`**（边缘）：services/ 下唯一直接 SQL 的文件（~20 条内联 SELECT），头注释自我豁免（"single synchronous aggregation"），但兄弟 service 三处自述 "never writes SQL directly"，查询本可放 repo
4. **`agent/scheduler/engine.ts:21-23,151-152`**：agent 层直 import keychain + repos 与 service 混用；具体可指摘点——`:152` 仅做存在性检查却调用返回**明文 key** 的 `getApiKey`，keychain 已有专用 `keyStatus()`（endpoint.service.toDto 即正确示范），取明文超出所需权限
5. **`ipc/project.handler.ts:22-54`**（边缘）：git 部分（解析 `.git/HEAD`、execFile git、超时/降级逻辑）是业务操作无 service 层；头注释的 thin 承诺字面只给了 CRUD 部分

合规确认（查过无违反）：repos 零 keychain/ipc 运行时依赖（contracts 引用全部 type-only）；llm/ adapter 零 DB/keychain；DTO 输出向零密钥字段；chat.handler 不碰 DB；消息入库唯一闸门 `conversation.service.append` 全部图片转 `nsai-media://` 引用；全部文件工具过 `confineReal`；thinking/agent-mode/image-models 三组镜像表当前数值一致；renderer 零 node API、preload 暴露面最小。

### 3.2 裸 `ulid()` 违反单一源约定（db/id.ts:6 "everywhere"）
`ipc/chat.handler.ts:2,16`、`ipc/agent.handler.ts:2,41,127,149`、`ipc/coordinator.handler.ts:11,57,158`——streamId/permissionId/questionId 用裸包。影响低（不入库、不依赖单调），但违反约定字面且与同进程其余 16 个文件不一致。

### 3.3 TS 质量
- 全仓 **0 个真实 `as any`**、0 个 `@ts-nocheck` —— 干净
- `@ts-ignore` 1 处（preload/index.ts:351，有理由注释，且 contextIsolation 强制 true 使该分支不可达——可删分支）
- `eslint-disable` 6 处：4 处有理由注释正当；2 处缺理由（`agent/tools/e2e-request.ts:15`（e2e-browser 同款有注释、本文件漏了）、`App.tsx:90` exhaustive-deps）
- 非空断言高风险点：
  - **`coordinator.service.ts` 12+ 处 `decision.role!`/`decision.roles!`**（:176-320 区间）。根因：`RouteDecision` 未建成以 `mode` 为 discriminant 的 union，构造路径（parseRouteDecision :515）保证的不变量在类型上不可见，整个 dispatch 层靠 `!` 续命
  - `ipc/plugin.handler.ts:14`、`skill.handler.ts:15`：`dialog.showOpenDialog(win ?? undefined!, …)`——把 undefined 断言非空骗类型，Electron 本有无 window 重载
  - `agent.service.ts:688`：`roster.find(...)!.name` 落空即 TypeError，无守卫
  - `token-count.service.ts:68 input.smallModel!`、`skill.service.ts:86 input.body!`：调用方保证、本地不可见
  - 边缘（同函数已有显式守卫、TS 流分析跨不进闭包）：scheduled.tsx:166 三连断言、dialogs.tsx:809,849,855

### 3.4 console 残留
- `coordinator.service.ts:412` `console.log('[gate-c] …')`：info 级流水用 log，与同文件错误路径 warn/error 风格不一致（灰色）
- `event-bus.ts:44` 每个 agent 生命周期事件一行 stdout——自述豁免（audit line），量大但有意为之
- renderer 源码 0 个 console —— 干净

### 3.5 超大文件（>800 行）及其自然边界
| 文件 | 行数 | 自然边界（仅指出，不给迁移计划） |
|---|---|---|
| `coordinator.service.ts` | 1497 | 文件内 section 注释自证：Route(:436-614) / Dispatch+Gate B(:615-1036) / Gate C e2e(:1037-1190) / 审批(:1192-1270) / runCollaboration(:1271-1373) / Synthesis prompt builders(:1374-1476，8 个零状态纯函数最易剥离) |
| `dialogs.tsx` | 1253 | 9 个互不引用的独立 dialog 挤一个文件（Endpoint/Mcp/Skill/Plugin/RoleEditor/CommandPalette/Confirm/Prompt/RolePicker），每个组件即一个边界 |
| `stores/chat.ts` | 1216 | send 流水线(:945-1090) / 会话 CRUD / 审批响应(:1142-1187) / 纯类型+helper(:1-253) |
| `agent.service.ts` | 989 | 单 run(:126-343) / loop+dispatched(:344-580) / collab(:581-820) / system 构建(:821-989) |
| `conversation.tsx` | 851 | 7 个组件一文件；Composer(263 行) 与 ChatView(187 行) 两个独立边界 |
| `contracts.ts` | 839 | DTO 字典，性质不同，不建议拆 |

超长函数（main，>120 行）：`coordinator.run` **300 行**（direct/single/parallel/council/pipeline 五个 mode 分支即五个自然切点）、`runRoleStep` 206、`registerCoordinatorHandlers` 200（14 个回调转译，职责内）、`registerAgentHandlers` 165、`agent.run` 163、`runCollabSession` 131、`runAgentLoop` 128。

### 3.6 硬编码与杂项
- `Math.ceil(x/4)` token 估算散落 **7 个文件**（loop.ts:297、compact.ts:88、memory.handler.ts:26,32、compression.service.ts:205、memory.service.ts:94、token-count.service.ts:105-118、renderer conversation.tsx:95）——token-count.service 自述是官方估算器，其余 6 处内联同一经验值
- 内联超时仅 3 处且量级合理（service-registry 2000ms、project.handler git 5s/10s）——边缘
- 文件命名全仓 kebab-case 一致（唯一例外 `llm/_shared.ts` 下划线前缀惯用法）；repo/service/handler 后缀全一致
- i18n 现行 key 风格不统一（`conv`/`mem`/`ep` 缩写 vs `rolePicker`/`epPage` 全称复合）——灰色，无自述约定
- 渲染端 **14 处硬编码英文 toast 绕过 i18n**（extensions.tsx:135-144、scheduled.tsx:287-302、projects.tsx:143-146 等 6 文件）

---

## 四、重复代码与可抽取共享

### 4.1 React 组件级
| # | 模式 | 重复处 | 可抽 |
|---|---|---|---|
| 1 | overlay+dialog 弹窗壳（head/body/foot/stopPropagation）| ×11：dialogs.tsx 9 个 dialog + projects.tsx:153,245 | `components/modal.tsx` 壳组件 |
| 2 | row-menu 三点菜单（portal+backdrop+rm-item）| ×6：shell.tsx ×3、settings.tsx、expert.tsx、extensions.tsx（后者已是 items 泛化版但私有）| 提升 extensions 版为 `components/row-menu.tsx` |
| 3 | Dropdown 家族（trigger+backdrop+check 选中行）| ×7：profile.tsx Dropdown+TimezoneSelect、composer-controls 4 个 picker、path-bar 分支菜单 | `components/select-menu.tsx`（options/value/icon/searchable/placement）|
| 4 | Toggle 开关 | ×3：extensions.tsx、memory.tsx、dialogs.tsx 内联 | `components/switch.tsx` |
| 5 | 作用域选择块（All/Specific+角色 pill）| ×2：McpDialog vs SkillDialog 逐字相同（连 locale mcp.*/skill.* 文案双份）| `components/scope-picker.tsx` + locale 合并 scope.* |
| 6 | Test connection 状态机 | ×2：EndpointDialog vs McpDialog | `useTestConnection` hook + `<TestStatus>` |
| 7 | Segmented 已有组件但 8 处手写 | dialogs ×5、memory、scheduled、extensions、studio | Segmented 移入 primitives 全量替换 |
| 8 | 可编辑 memory 行 | ×2：memory.tsx MemoryItem vs GlobalMemRow（toast 链 expert.tsx:201/memory.tsx:309 也同四段）| 合并 + toast 链下沉 store |
| 9 | CodeBlock 双实现 | primitives.tsx:124（自写正则高亮、copy 不写剪贴板）vs markdown.tsx:89（Shiki+真 clipboard）| 收敛 markdown 版；primitives 版在死簇内（见 2.1）|
| 10 | 折叠 section 头（chevron+count）| ×6：shell.tsx ×3、workspace.tsx ×3 | `components/collapsible-head.tsx` |
| 11 | 内联 SVG 重复 icons 集 | approval-dialog.tsx:24,32 vs Icons.terminal/listChecks | 直接用 Icons |

### 4.2 工具函数
- `fmtTokens` ×3（studio.tsx:23、analytics.tsx:34 完全相同、conversation.tsx:54 变体）+ `fmtReadoutTokens`；`fmtElapsed` ×2；`expertMeta` ×2 逐字；日期/相对时间 ×4 各写一套；**`basename` ×5**（workspace/markdown/path-bar/tool-bubble/collab-project.service）→ `lib/format.ts` / `lib/path.ts`
- IPC 错误剥壳 ×2（dialogs.tsx:566,712）→ `lib/ipc-error.ts`
- fire-and-forget toast 链 ×23 处 / 7 文件 → `lib/with-toast.ts`
- 思考档位 clamp ×3（main thinking.ts:47、renderer thinking.ts:162、use-role-binding.ts:95）

### 4.3 main 进程
| # | 重复 | 位置 | 可抽 |
|---|---|---|---|
| 1 | **thinking 能力表跨进程手工双镜像**（注释自承 "Keep these tables in sync"）| main/llm/thinking.ts vs renderer/lib/thinking.ts：预算表/深度函数/adaptive 正则逐字相同 | `src/shared/thinking.ts` 单源 |
| 2 | 角色 id→名字花名册双份 | prompts.ts:14-31 vs studio-data.ts:13-20 | `src/shared/roles.ts` |
| 3 | Anthropic cache_control 注入 ×2 | llm/anthropic.ts:83-111 vs agent/llm.ts:91-127 | `llm/anthropic-cache.ts` |
| 4 | Anthropic thinking 塑形 ×2 | llm/anthropic.ts:122-133 vs agent/llm.ts:144-154 | 同上合并 |
| 5 | `stablePromptCacheKey` ×2 逐字 | llm/openai.ts:76 vs agent/llm-openai.ts:125 | `llm/_shared.ts` |
| 6 | Gemini 小助手 ×2 + baseUrl 修剪 ×11 处（gemini 三连剪 ×4）| 见 llm/ 与 agent/llm-* | `llm/_shared.ts::trimBase/geminiBase/…` |
| 7 | repo CRUD 模板（parseJson ×3 逐字、字段 update 构造器 ×5）| mcp/skill/plugin/endpoint/role.repo | `repos/_sql.ts::parseJson/buildUpdate` |
| 8 | endpoint+keychain 凭据解析（unreadable 长文案 ×3 逐字）| chat.service:30、agent.service:145、endpoint.service:73（弱化版 compression/memory/title）| `services/credentials.ts::requireEndpointKey` |
| 9 | binding→endpoint→key 三连 + 一次性 LLM 调用 + 抠 JSON | coordinator ×3、title.service、memory.service | `services/llm-once.ts` |
| 10 | protocol→家族映射三元式 ×3（另 switch 版 ×3）| agent.service:135、coordinator:718,1289 | `domain.ts::agentProtocolOf` |
| 11 | 流式 IPC handler 脚手架 ×3（注释自承 "same pattern"）| chat/agent/coordinator.handler：streams Map+abort+destroyed 守卫+:stop | `ipc/stream-lifecycle.ts` |
| 12 | 目录/保存对话框样板 ×5 | skill/plugin/project/media/conversations.handler | `ipc/dialogs.ts::pickDirectory/pickSavePath` |
| 13 | 工具→标签 switch 三份 | tool-bubble.tsx:62 vs collab-project.service:110 vs projects.tsx:211 | `src/shared/tool-labels.ts` |

### 4.4 CSS
- backdrop 同体三类（dropdown-backdrop z-150 / menu-backdrop z-60 / path-menu-backdrop z-40）→ 一个基类 + z 修饰
- **同名不同义**：`.model-tag`（styles.css:391 Segment 灰字标签 vs :439 EndpointDialog chip，后者覆盖前者——与 `.ws-activity` 同款坑）；`.cmdk-row .cr-icon` 两处定义（:1289 是 :437 子集纯冗余）；`.iv-nav` 同文件拆两段；`.role-row .role-meta` 跨文件两处；`.window`/`#root` styles.css vs electron-overrides.css 覆盖关系未注明
- 两套 code-block 类族（markdown.css `.code-block/*` vs styles+screens `.codeblock/*`，后者随死簇）
- 字号字面值无 token：12px ×67、11px ×61、13px ×55、12.5px ×49、11.5px ×41…（可引入 --fs-* token 渐进替换）

### 4.5 常量/配置
- locale 重复值：'Add endpoint' ×5 键、'Cancel' ×10、'All experts' ×4、mcp.*/skill.* scope 文案整组 ×2（公共按钮文案无 common.* 归口）
- `'You are a helpful assistant.'` 兜底 ×2（llm/openai.ts:94 vs agent/llm-openai.ts:138）
- `anthropic-version '2023-06-01'` ×2（agent/llm.ts:23 常量 vs llm/anthropic.ts:159 内联）
- field-label 提示 span 内联样式 ×9（dialogs ×7、projects ×2）→ `.field-hint` 类
- localStorage key `'nicosoft-studio-state-v1'` 代码内单源（App.tsx:24）但 e2e 120 个脚本各自硬编码

### 4.6 e2e driver（135 个脚本，零共享 helper，互不 import）
| 样板 | 重复量 | 可抽 |
|---|---|---|
| 启动八连段（launch→firstWindow→错误收集→settle）| `_electron.launch` ×135、错误透传段 44 份逐字 | `e2e/_helpers.mjs::launchStudio()` |
| localStorage 种子 + reload + settle | ×120（waitForTimeout(1500) 出现于 106 文件）| `helpers::seedState(page, {expert})` |
| 流结束轮询（.cmp-stop 手写 for-poll）| ×81-83 | `helpers::sendAndWaitIdle()` |
| NS_KEY 种 key + setBinding | 逐字相同 ×13（touch hasKey ×77）| `helpers::ensureKeysAndBinding()` |
| /tmp 截图路径各自拼名 | ×39 | `helpers::shot(page, name)` |

---

## 五、交叉关联（多路发现互相印证/放大的点）

1. **e2e driver 启动方式 ×135 与 keychain 身份案直接冲突**：全部 driver 用 `args:['out/main/index.js']` 单文件入口 → 运行在 "Electron" app 身份（独立 userData + 独立 safeStorage 身份）。b906643 已把 userData pin 统一，但 safeStorage 身份仍随入口变化——按新铁律所有 driver 应改 `args:['.']`。抽共享 `launchStudio()` helper（4.6#1）时这 135 处可一次性收口。
2. **i18n 死键 165 个**由死代码、规范两路独立扫描得出同一数字（方法不同：AST+动态前缀 vs grep 引用计数），高置信。
3. **primitives.tsx CodeBlock 死簇**（2.1）同时解释了 4.4 的"两套 code-block 类族"与 4.1#9 的"CodeBlock 双实现"——三个发现同根，删簇即一并消除。
4. **`hasKey` 字段**：e2e 脚本 ×77 处还在 `ep.hasKey` 判断——DTO 已在 b906643 改为 `keyState`，这批脚本的 bootstrap 块（4.6#4）已对不上当前契约，下次使用会静默全 true/undefined。
5. **token 估算 chars/4 散落 7 处**（3.6）与 memory.handler 业务上浮（3.1#2）同源——handler 里那两处正是散落点中最不该存在的。

---

## 统计摘要

| 维度 | 数量 |
|---|---|
| 隐藏 bug | 1 高 + 2 中 + 2 低（另排除 4 个常见嫌疑） |
| 死导出/死簇 | ~20 个符号 + primitives 死簇 ~160 行 + ~30 处 export 冗余 |
| i18n 死键 | 165 × 5 语言 ≈ 825 条 |
| 死 CSS 类 | 95 个 |
| 死依赖 | 1（zod-to-json-schema） |
| 分层违反 | 3 确凿 + 2 边缘 |
| 裸 ulid() | 3 文件 8 处 |
| 非空断言风险点 | coordinator 12+ 处（类型设计缺陷）+ 4 处零散 |
| 可抽共享 | 组件 11 类 / 工具函数 9 类 / main 13 类 / CSS 4 类 / 常量 7 类 / e2e 5 类 |
| 超大文件 | 6 个 >800 行（自然边界已标注） |
