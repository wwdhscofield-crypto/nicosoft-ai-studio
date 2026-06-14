# 轮 C — 单聊直聊(Flynn)· hang(fail-open 部署后重跑)

**背景**:B-1 / B-2 两次被线上旧 nsai hang bug 雪崩困死(14 / 17 abort,ERROR);nsai 改 fail-open(`0cd5dac2`)部署后重跑。

## 结果:DONE / 23min / 70 turns / 0 abort·STALL·retry

- 对比 B-1/B-2(36 / 41min ERROR):fail-open 彻底止血
- 收尾汇报完整:5 改动文件 + §3 硬约束逐项 + §4 语义表 + build/vet/test/race/gofmt 实际输出

## 收尾质量(独立复验,非采信自报)

- **诚实**:汇报 5 文件 = `git status` 实际
- **真实工作**:transcript 有 FAIL→修→绿迭代痕迹(4 处),非 fabricate;micro 压缩 51 次
- **独立复跑全绿**:nsai-api build / vet / 全量 test(0 FAIL) + nsai-shared 全过
- 测试覆盖简报 3 类:信号矩阵 / 挂死复现 / 跨读直通

## L4 价值 + 发现

- 单聊收尾质量 ✓(**N=1**)
- 验证三层:prompt 纪律 / **loop harness self-check(单聊也有)** / collab Gate B(仅群聊)
- **发现**:loop self-check 的 `bashRanClean` 被管道(`go test … | tail`)吞 exit code 绕过 —— 这轮实际**没真把关**,靠 Flynn 自觉 + 我复验兜底。机制定位是"软提醒"非"硬门"
- 结论:单聊**能完美收尾**;但"自动把关"这轮靠 agent 自觉,**自动验证机制的有效性未真正证**
