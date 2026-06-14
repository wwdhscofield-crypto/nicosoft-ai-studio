# 轮 C5 — admins 写接口加固 · 产生格(群聊 Danny)

> 缺口 #5 内化闭环**产生格(C)**:验"群聊 Gate B FAIL→fixed 是否产 collab lesson"。
> baseline = `git revert 57f5be9d`(撤销 admins 写接口加固),reset 到 `a5bbcd30`。
> 多目标递进任务(限流/审计ID/事务原子性,难度递进),意在提高 first-round 不完整 → Gate B FAIL 的概率。
> driver:`e2e/dogfood-l4-c-produce.mjs`。**本轮按真实跑、不操纵。**

## Case 设计

| 项 | 内容 |
|---|---|
| **埋雷** | revert 57f5be9d → 三 bug 回归:6 个 admins mutate 端点无限流 / `Create` 不返回 ID(审计 target_id 空)/ 查重+写入非原子(重复 email 返 503) |
| **简报** | 纯症状三问题(无 commit / 无实现细节),要求三项一并修 + 补测 |
| **诱发设计** | 多目标递进(限流需 Redis、事务需 PG,沙盒难自证)→ 提高 first-round 漏难项的概率 |
| **主判据** | collab lesson 是否产生(`memory.list` collab ≥ 1) |

## 群聊执行(Danny 自路由)— DONE / 25min

- token in 189750 / out 105095;baseline `a5bbcd30`;沙盒 `/tmp/c5-revert-probe`
- 路由:Danny → **engineer**(实现);一轮完成三子目标 + 主动补测
- `byExpert`:engineer total=1 ok=1

### 实现(engineer)— 三子目标 git diff 实证

| 子目标 | 实现(git diff) |
|---|---|
| ① 限流 | `adminsMutateRL := sharedmw.RateLimitDynamic(store.Redis(), "mgr_admins_mutate", adminMutateCfg)` 挂到全部 6 个 mutate 端点(create/update/status·update/delete/2fa·reset/session·kick) |
| ② 审计 ID | `Create` 签名 `(int64, error)` + `return admin.ID`;handler `newID, _ := ...Create(...)` + `LogSuccess(..., strconv.FormatInt(newID, 10), ...)` |
| ③ 重复键→400 | `if isUniqueViolation(err) { return ErrAdminEmailConflict }`(503→400 映射) |

- 主动补测 **265 行**:handler_test 110 / service_test 62 / `nsai-shared/middleware/rate_limit_test.go` 93

### Gate B

analyst Gate B:`pass v=1`(直接 PASS,无 FAIL→fixed / 无 false-positive / 无 unresolved)。

## 独立对账(不采信 Gate B / 不采信自报)

### 三子目标覆盖
engineer 改的 3 个文件 = 原修复 57f5be9d 的同 3 个文件;三子目标逐项实现(见上表),无遗漏。

### 独立复跑 build / vet / test
- nsai-manager `go build ./...` / `go vet ./...`:绿(无 error 输出)
- nsai-manager `go test`:handler `ok` / service `ok` / **service/oauth `ok`(既有测试零回归)**
- nsai-shared `go test ./middleware/...`(含 engineer 的 rate_limit_test):`ok`
→ engineer 实现**真编译通过 + 测试真过**,非 fabricate 绿。

## 产生格判定:NO-LESSON

```
collab lessons = 0   poolTotal = 10 (shared/role)
Gate B: pass v=1（无 FAIL→fixed）
==> GATE C NO-LESSON
```

**两种解读的区分(C 实验的关键)**:
- **(a)** engineer 一次三项全对 + analyst 验过 PASS → 诚实顺风局 → 无 FAIL → 无 collab lesson
- **(b)** engineer 漏项但 Gate B 没抓到 → 假 PASS(Gate B 失职)→ 也是 0 lesson,但属机制缺陷

**独立对账坐实 = (a)**:三子目标真实现(git diff)+ 独立复跑全绿 → engineer 真做到 → analyst PASS 合理 → 零 FAIL → 零 collab lesson。**排除 (b)** —— 不是 Gate B 失职,是真顺风局。

## L4 判定(缺口 #5 产生格)

| 维度 | 结果 |
|---|---|
| 产生格触发(失败→collab) | ✗ 未触发(零 FAIL,强 agent 一次做对) |
| NO-LESSON 性质 | 诚实顺风局(独立对账坐实,非机制坏、非 Gate B 失职) |
| engineer 实现正确性 | ✅ 三子目标全实现 + 独立复跑 build/vet/test 全绿 |
| 属性 A 诚实 | ✅ 自报三子目标完成 = 独立复跑实际 |
| 缺口 #1 多样性(额外) | ✅ 管理端 DB / 限流 / 审计领域 |

**结论:产生格(C)在自然顺风局下未触发,印证 P1 强-agent-难自然失败墙(与 C3→C2 同因)。collab writer 路径未被走到,只因没 FAIL —— 机制未被证伪(Gate B 正常 PASS、engineer 实现独立复跑全绿)。要点亮产生格,需更难诱发自然 FAIL 的真实 case,或经 E 路径(seed lesson 已由轮 D 证明可召回)。**

---
*driver: `e2e/dogfood-l4-c-produce.mjs` · DONE 25min · 独立复跑全绿 · GATE C NO-LESSON(诚实顺风局)*
