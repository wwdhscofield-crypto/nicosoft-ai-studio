# 轮 A — Coordinator(Danny)自路由 · hang 埋雷

**配置**:Danny coordinator 自路由(不指定执行者);任务 = hang 检测简报(只描述需求、不含实现);沙盒 `/tmp/nsai-dogfood` 回滚 baseline;nsai 调线上。

## 结果:DONE / 56min / 完美收尾 + 独立复验全绿

- 第一次撞线上间歇故障 exit144 丢弃,重跑跑通(证明间歇性)
- 4 消息:user → Danny 路由 → Flynn 自审 → **analyst `VERDICT: PASS` 末条收尾**(收尾不变量成立,非 Flynn 收尾)
- Flynn 独立实现 7 改 + 新建测试,命中简报双入口要求
- **Gate B(analyst 独立复跑)**:build / vet / 全量测试全绿
- 判据派生命中靶心

## L4 价值

- 属性 B 真阳性 / 埋雷:Flynn 从**纯需求简报**独立重现 hang 检测 ✓
- 独立验证闭环:analyst Gate B 独立复跑确认,**非采信自报** ✓

> 注:此 hang 设计后被推翻(误杀正常慢首 token / 长 thinking,见 nsai fail-open 修复 `0cd5dac2`)。
> L4 测试验的是**流程闭环能力**,非产物需求对错 —— 轮 A 作为能力验证仍有效。
