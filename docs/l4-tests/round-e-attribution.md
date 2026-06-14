# 轮 E — 内化闭环·归因格:p0=0 撞强-agent 墙(诚实收口)

> 内化闭环最后一格。A(跨轮共享)/ B(recall 管道)/ D(collab 召回+注入)已点亮机制管道;nspay 大项目点亮 C(失败→产 collab)。
> E 问的是 A–D 都没回答的唯一问题:agent 是否**因为**那条召回的 collab lesson 而避开同类错误——而不是它本来就不会犯?
> 单次跑答不了,需要三臂对照。本轮按用户方向**用 nspay 这轮 agent 自己产出的 2 条 lesson + 同类坑**闭合 C→E 同一个环。
> 结论:**p0=0**——强 agent 在自己的领域、面对自己 lesson 的主题,无 lesson 时也教科书级正确 → 归因无信号可测。E 被强-agent 墙结构性阻挡。

## 实验设计(三臂对照)

| 臂 | 记忆 | 测量 |
|---|---|---|
| **none** | 空 | trap 命中率 p0 |
| **placebo** | 1 条无关真实 collab(api_key 常量时间加固)| p_placebo —— 控制"有任何记忆就更谨慎" |
| **targeted** | nspay 这轮自然产的 2 条 collab(逐字)| p1 |

归因成立 ⟺ **p1 ≪ p_placebo ≈ p0**。

- **载体**(lesson 诞生的同一领域):从零实现 nspay 的两个核心模块——**订单状态机(§4)+ Webhook 签名/投递(§7)**,SPEC 逐字取自 `nspay/docs/rebuild-spec.md`(`/tmp/e-nspay-mod/SPEC-E.md`)。无需真实 DB/链(用接口表达持久化边界)→ 跑得快、可判。
- **验收故意模糊**:"为核心逻辑补充必要的单元测试"——**点名两个模块,但绝不说"每个/两个都测/每条分支"**。这道模糊正是 lesson-2 要补的缝,而 lesson-2 字面就举了这对例子("order state machine AND webhook signing"):lesson 当初正是在这俩模块上栽了测试完整性的跟头,如今 agent 又遇到它俩。
- **靶向 lesson**(逐字,nspay round 自然产):
  1. 可测性:*"Critical decision logic inlined inside a DB transaction or handler is effectively untestable; extract the pure branching core into a standalone function so its every branch can be unit-tested without a live database."*
  2. 完整性:*"When acceptance criteria explicitly enumerate which core modules need unit tests (e.g. 'order state machine AND webhook signing'), treat the list as conjunctive—verify each named module has dedicated tests, not just some of them."*
- **安慰剂**:真实但无关的 api_key 常量时间 lesson(刚好废物利用上一版 api_key 方向)。
- **Trap 命中** = 两个点名模块至少一个无专门单测,**或**关键决策逻辑内联不可测(无纯核)。**避开** = 两模块都有专门测 **且** 决策核抽成可脱 DB 单测的纯函数。
- **注入证明**(placebo/targeted):grep wire 是否含 lesson 逐字特征句(不注入 marker,lesson 保持 100% 逐字),坐实 agent 确实看到了——沿用轮 D 的方法。
- driver:`e2e/dogfood-l4-e-attribution.mjs`(ARM=none|placebo|targeted × ROUND);单聊 engineer,bypass,每 run reset 载体到空 baseline。

## 插曲:judge enumeration bug(抓到即修)

Arm none 首跑 `e-result.json` 报 `goFiles: []` / `bothCovered: false` → 形似 trap 命中。**但这是 judge 的假阴**:agent 实际在 `/tmp/e-nspay-mod/internal/` 下写了 26 个 go 文件,`git status --porcelain` 把未跟踪的新目录折叠成单行 `?? internal/`,解析 `.go` 后缀得 0。不信自动数,**直接 ls 仓库**才发现真相。修复:driver 改用 `git status --porcelain -uall` 逐文件列出。**这正是"review 自己代码必须看数据不只读逻辑 / 不靠猜"的红线**——若采信 `bothCovered:false`,会得出完全相反的错误结论(误判 p0>0)。

## p0 结果:Arm none = trap 完全避开,教科书级(零 lesson)

重判(`git ls-files --others` 正确枚举)+ **读真码**坐实:

- **26 go / 10 test 文件 / 54 个 test 函数**;`bothCovered = true`(状态机:`model/status_test.go` 7 测 + `order/service_test.go` 13 测;webhook:`sign_test` / `dispatcher_test` / `ssrf_test` / `payload_test` / `crypto_test`)。
- **可测性达成**(无 lesson):
  - `func CanTransition(from, to Status) bool { return forwardTransitions[from][to] }` —— **纯表查找,无 DB**;`IsTerminal()` 同。
  - `order/service.go:305` 的事务逻辑 **调用** `model.CanTransition(from, to)` —— DB 耦合的 service 委托给纯核。**正是 lesson-1 字面规定的"抽出纯分支核,脱离 DB 单测每条分支"**。
  - `model/status_test.go` 逐分支直测纯核:`TestCanTransitionLegalForwardMoves` / `NoRollbackFromOnChain` / `RejectsIllegalAndSelf`。
  - `func Sign(secret []byte, timestamp int64, rawBody []byte) string` —— 纯 HMAC-SHA256,无 DB,被 `TestSignFormatAndDeterminism` / `TestVerify` 测。
- 独立复跑 `go build / vet / test` 全绿。

→ **agent 在零 lesson 下,独立做到了那 2 条 nspay lesson 规定的全部事**(抽纯核 + 两模块都测)。`p0 = 0`(trap 避开)。

## 诊断:强-agent 墙在"自己领域 + 自己 lesson 主题"上复现

| 探针 | 载体 | p0 |
|---|---|---|
| C4(早先) | 三协议静默失败 | 0(且 prompt 漏题) |
| **本轮 none** | nspay 自己的两模块 | **0**(纯核+两模块都测,教科书级) |
| nspay 全量 | 18 表 / 11018 LOC | 踩了(**仅项目规模**触发,且靠 Gate B 兜) |

**E 的结构性死结**:归因要成立,agent 必须在**无 lesson 时真会犯错**(p0>0),lesson 才有改变行为的空间。但强 agent 在**任何跑得起 3 臂×N 的规模**上都不犯这类错——它默认就抽纯核、就两模块都测。这类错只在 nspay 那种**项目规模的认知负载**下才冒头,而那个规模跑 3 臂×N ≈ 27h,成本不可行。

**C/D 能点亮 vs E 点不亮,是同一堵墙的两面**:C(产生)、D(召回注入)只需"机制跑通"——给定一次失败、给定一条 collab,就能演示;E(归因)却需要"强 agent 先犯错"才有可测的行为差,而强 agent 恰恰不犯(除非项目规模)。

## L4 判定

| 维度 | 结果 |
|---|---|
| 实验执行 | ✅ 三臂 driver + 中性载体 + 注入证明 + judge(bug 已修)就绪;none 臂跑通 DONE |
| p0 测量 | **0**(教科书级避开,读真码坐实,非 grep) |
| 归因可测性 | ❌ **结构性不可测**:p0=0 → lesson 无可改变的行为 → 无信号 |
| 诚实度 | ✅ judge 假阴被"看数据不靠猜"当场抓修;不强凑绿 |
| **内化闭环 E 格** | **○ 受阻(有证据)**——非"没做",是"强-agent 墙下做不出信号" |

## 结论

1. **E 归因在可负担规模上结构性不可测**:强 agent 在自己的领域、面对自己 lesson 的主题,无 lesson 时也做对 → 没有"被 lesson 纠正"的错误可言。这个 p0=0 本身就是诚实、有价值的 L4 结论,精确刻画了 E 难点的根因。
2. **内化闭环现状**:A ✓ / B ✓ / C ✓(nspay 点亮)/ D ✓(确定性)/ **E ○(受阻,有证据)**。机制管道(共享→召回→产生→注入)全通;唯独"召回改变行为"的因果,被卡在"强 agent 不犯错"上。
3. **真正点亮 E 的唯一路径**是项目规模 3 臂×N(≈27h,成本不可行),或接受 C+D 已证明机制、E 留作"受强-agent 墙阻挡"的明确结论。**用户采纳后者。**
4. **副产物**:driver 的 enumeration 假阴 bug 当场抓修;api_key 常量时间方向降级为安慰剂(未浪费)。

---
*driver: `e2e/dogfood-l4-e-attribution.mjs` · Arm none DONE 29min / 54 test 函数 / p0=0 读真码坐实 · 内化闭环 E 格:受强-agent 墙结构性阻挡(有证据)*
