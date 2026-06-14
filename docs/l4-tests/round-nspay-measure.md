# 轮 nspay-measure — Track A / C-base / Bash 超时三项改造的实战验证(C 格再点亮 · N=2)

> 这是 nspay 大项目的**第二次**跑(首跑见 [round-nspay.md](round-nspay.md),C 格首次点亮 N=1)。
> 目的不是再造一个绿地项目,而是**验证三项已落地改造在真实大项目里实际生效**:
> 生产端 Track A(per-module 验收放开 cap,`1a8d0ac`)、验证端 C-base(给单 verifier 补
> "绿 build 上方向/假设是否成立"一维,`51897c2`)、工具端 Bash 超时进程组 kill(`2d74f28`)。
> driver:`e2e/dogfood-l4-nspay-measure.mjs`(全死角监控:动态订阅 42 路 window.api on* + tool-ledger
> 抓 Bash 命令 + hang 检测 + project_tool_events dump)。完整设计与结果记录见
> [coordinator-heavy-task-orchestration.md](../coordinator-heavy-task-orchestration.md) §6b/§6c。

## 结果总览

- **DONE / build 绿 / 0 hang**(reload 修复 + Bash 超时修复后完整跑通)。
- 全程 wall / token 总量未由 measure 脚本单列(脚本聚焦三项改造的生效信号,非总量统计)→ 本表记 `—`,不估算。

## Track A ✅ — per-module 验收 cap 放开生效

- criteria 单次派 **24 条**(破旧 4 上限),`warns=0`;verifier 据此查 per-module 测试覆盖。
- 内容是否每条精确对应一模块未逐条核(criteria 偏 build/test 命令型),但**放开 cap 的机制确认生效**——nspay 18 模块不再被截断到 4 条。

## C-base ✅ — verifier 查得更深 + C 格再点亮(N=2)

- Gate B verifier evidence **明显更深**:查到 SSRF 多层防御具体到行号(`sender.go:69/:42`)、并核「测试是否 vacuous / SKIP」。
- **Gate B FAIL→fixed(rounds 2)**,产 **2 条 collab lesson**(测试质量维度,比首跑更具体):
  1. *"tests exist ≠ done:枚举 mandated test cases vs 真实 inventory,确认默认运行(非 skip / vacuous)"*
  2. *"spec 要求模块单测 → 写 hermetic 测试(miniredis / sqlite / 纯函数)默认 `go test` 能跑,别 DB-gated silently SKIP"*
- 这是 Track A(per-module 验收)+ C-base(查测试真跑吗)**合力的产物**。
- **意义**:C 格(失败→产 collab)在**第二个独立大项目**里再次自然触发 → 内化闭环 C 格 **N=2**(首跑 + 本轮),不是一次性偶发。

## Bash 超时进程组 kill ✅ — 已修,但本轮非实战触发

- 首个 measure 尝试中 engineer 跑 `find / -name go.mod -path *nspay*`(全盘 find)**卡死整个 build 17min**,暴露 Bash 工具缺口 → 修复(`detached` 进程组 + `process.kill(-pid)` tree-kill,借 CCB 120s/600s + Codex killpg,单测验证,见 §6b)。
- 本轮重跑 **0 hang**:engineer 改用 `start_service` 起后台进程、未再跑全盘 find → **超时 fix 处于待命而非被实战触发**(如实标注;修复本身由单测验证,不靠本轮的活体 hang 复现)。

## 转出待办(measure 发现)

- bypass 下 engineer 又 `brew install postgresql@16 redis`,装本地 PG/Redis 自起、**绕过 SPEC 指定的树莓派**(清空的 db 这次没被用到)→ 转成 bypass 系统安装拦截待办(已实现:`isSystemSoftwareInstall` + execution/approval 双闸 + CODING_DISCIPLINE 引导临时实现)。
- segment token 显示口径不一致(截图 ↑119.3k ↓474.2k)→ 转成 token 结算口径待办(已实现:`sent_tokens` 列 + 段末结算总发送/总接收)。

## L4 判定

| 维度 | 结果 |
|---|---|
| Track A(验收 cap) | ✅ 生效(criteria 24 破上限,warns=0) |
| C-base(方向/假设维) | ✅ 生效(verifier 查深到行号 + 核测试真跑) |
| **内化 C 格(失败→产 collab)** | ✅ **再点亮 N=2**(Gate B FAIL→fixed rounds 2 → 2 collab lesson) |
| Bash 超时 fix | ✅ 已修 + 单测验证(本轮 0 hang,非实战触发) |
| 属性 A 诚实 | ✅ 0 hang / build 绿 = 独立复核实际 |

---
*driver: `e2e/dogfood-l4-nspay-measure.mjs` · DONE / build 绿 / 0 hang · 验证 Track A + C-base + Bash 超时 fix 实战生效 · C 格再点亮 N=2*
