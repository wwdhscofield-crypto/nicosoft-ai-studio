# 轮 nspay — 大项目从零实现 · 突破强-agent 墙(C 格首次点亮)

> 缺口 #5 内化闭环 + 强-agent 墙的总攻。C1/C2/C3/C5 + C4-p0 都证明:**强 agent 在小 case 上一次做对**(p0≈0),
> 所以失败/内化测不到。本轮反其道——让 Studio coordinator **从零完整实现整个 nspay 后端**(支付网关,~18 表、
> 订单状态机、幂等、事务原子性、webhook、鉴权/2FA、admin API、链交互 mock 注入),唯一依据是一份 SPEC.md。
> 假设:**项目大到强 agent 难一次做全/做对,会在两个维度暴露破绽——功能完整性 / 架构纪律**。
> driver:`e2e/dogfood-l4-nspay.mjs`(群聊 coordinator);cwd `/tmp/nspay-impl`(干净目录,只有 SPEC.md,无现有代码)。

## Case 设计

| 项 | 内容 |
|---|---|
| **载体** | 从零实现 nspay 后端,SPEC.md(`nspay/docs/rebuild-spec.md`,基于对原 nspay 6 子系统 1.18M token 勘察整理)为唯一来源 |
| **隔离** | 干净目录只放 SPEC.md(git baseline),不依赖/不阅读现有代码 |
| **链交互** | SPEC §10 抽象成 `ChainClient`/`SweeperClient` 接口 + fake;dev-only `/api/test/*` 注入端点驱动状态机,**沙盒不碰真实链** |
| **基础设施** | 真实树莓派 PG `192.168.1.110:5432 nspay_dev` + Redis(实测连通) |
| **双维度验收** | ① 功能完整性(端到端 + build/vet + 我独立对账)② 架构纪律(机判跨层 grep) |

## 中途事故:reload 中断 + 修复(重要插曲)

**首跑 70min 被外部中断**:小孩按了刷新快捷键(macOS `Cmd+R`)→ 渲染端 reload → Studio 把 reload 当"渲染端没了"**abort 了正在跑的 agent run**,70min 进度(6539 LOC,无 service 层)中断丢失。

**根因 + 三层修复**(`src/main/ipc/stream-lifecycle.ts` + `src/main/index.ts`):
1. **run 耐 reload**:`stream-lifecycle.ts` 原把 `did-start-loading`(reload)与关窗/崩溃同等 abort run。改为**只在真关窗/崩溃(`destroyed`/`render-process-gone`)才 abort**;reload 是临时的 → run 在主进程继续跑完落库,工作不丢。
2. **拦截误触快捷键**:`index.ts` 加 `before-input-event` 挡掉 `Cmd/Ctrl+R`、`Cmd+Shift+R`、`F5`;只挡键盘,不影响 Playwright `page.reload()`(测试 harness 仍可用)。
3. **e2e 验证 PASS**(`e2e/verify-reload-resilience.mjs`):起多步 run → 写到第 2 个文件时 `page.reload()` → run **继续**写 3..8 → 8/8 完成,main.log 持续增长。证明修复前会冻结在 2 个、修复后跑完。

> 这是 dogfood 的 meta 价值:测 nspay,反而抓到并修复了 Studio 自己一个真实健壮性 bug(刷新丢 run)。

## 重跑结果:DONE / 2h52min / 11018 LOC

- token in 172648 / **out 622798**;coordinator→engineer;**0 EVAL-ERROR / 0 STALL / 0 compact**(reload 修复后完整跑通、未被干扰)。
- 产出:101 go 文件 / 11018 LOC,完整分层 handler 17 / service 25 / model 18 / chain 8 + 测试 7 + DDL。

### 维度一 · 功能完整性 ✅

- **build / vet 独立复跑全绿**(`go build ./... && go vet ./...` 无 error)。
- **18 张表 DDL**(SPEC 要求 18,全建)。
- 订单状态机(4 个 order service 文件)+ **链 mock 注入端点 `/api/test/*`(2 处,实现了 SPEC §10 接缝)**。
- 强 agent 大项目**能完整实现**且编译通过。

### 维度二 · 架构纪律 ✅ 全绿(独立精确复核)

| 检查 | driver | 我精确复核 |
|---|---|---|
| handler 跨层 import chain/ethtx | 报 1 | **实为 0** —— 那 1 处是 `test.go:14` **注释**(`// implementation lives in internal/chain`),非 import |
| handler 打 DB/Transaction | 0 | ✅ 0 |
| service 收 gin.Context | 0 | ✅ 0 |
| model 跨层 import | — | ✅ 0 |
| handler `err.Error()` 泄漏 | 0 | ✅ 0 |
| 包命名 | — | ✅ 全 snake_case |

→ 强 agent 在 11018 LOC / 2h52min 大项目里**完整守住了架构分层,没腐化**。"大项目压力下架构腐化"这次**没发生**。

## 重大突破:内化闭环 C 格(产生)首次点亮

- Gate B **FAIL→fixed**(`gate_outcomes.json` 实证:`outcome=fixed gate=B`,verification.gateB `fixed v=1`)。
- 产生 **2 个真实 collab lesson**(`memory.list` layer=collab):
  1. *"Critical decision logic inlined inside a DB transaction or handler is effectively untestable; extract the pure branching core into a standalone function so its every branch can be unit-tested without a live database."*
  2. *"When acceptance criteria explicitly enumerate which core modules need unit tests (e.g. 'order state machine AND webhook signing'), treat the list as conjunctive—verify each named module has dedicated tests, not just some of them."*
- **C1/C2/C3/C5 小 case 全没触发**(都是顺风局零 FAIL)。**项目规模**让强 agent 在**测试完整性/可测性**上出疏漏 → analyst Gate B 抓到 → FAIL→fixed → 内化成 collab lesson。

## L4 判定

| 维度 | 结果 |
|---|---|
| 功能完整性 | ✅ DONE + build/vet 绿 + 18 表 + 完整分层 + 链 mock + 测试 |
| 架构纪律(机判) | ✅ 全绿(独立精确复核,driver 的 1 处是注释假阳性) |
| **内化 C 格(失败→产 collab)** | ✅ **首次点亮**(Gate B FAIL→fixed → 2 collab lesson,gate_outcomes 实证) |
| 突破点 | **测试完整性/可测性**(非架构)—— 揭示强 agent 大项目的薄弱点 |
| 属性 A 诚实 | ✅ 自报 build/vet 绿 = 独立复跑实际 |

## 结论

1. **强-agent 墙被大项目突破**:内化闭环 C 格(产生)首次点亮——2h52min 这一轮做到了之前 5 轮小 case 做不到的(自然 FAIL→fixed→collab lesson)。
2. **突破在测试质量,不在架构**:架构分层强 agent 守住了(全绿),薄弱点暴露在"测试覆盖全不全 + 逻辑可测性"。这是个有价值的发现——强 agent 的盲区在测试完整性而非分层。
3. **reload 修复直接促成**:没有它,这次又会被刷新中断在半路。修复本身是 dogfood 抓到的真实 Studio bug。
4. 剩 E 格(归因:agent 是否**因为** collab lesson 而避同错)仍待——需三臂对照。

### 留档
- 首跑中断的 70min 产出快照:`/tmp/nspay-impl-70min-snapshot`(74 go 文件,无 service 层,可作中断对照)。
- 完整产出:`/tmp/nspay-impl`(101 go / 11018 LOC)。

---
*driver: `e2e/dogfood-l4-nspay.mjs` · DONE 2h52min · 双维度独立对账(功能完整 + 架构全绿)· C 格首次点亮(2 collab lesson)*
