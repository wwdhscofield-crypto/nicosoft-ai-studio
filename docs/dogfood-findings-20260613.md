# Dogfood 发现档案 — 2026-06-13 夜间自主轮次

> 用户睡前指令:每轮发现记档、轮 A 结束自动接轮 B。本文件随每轮终态更新。
> 当晚上下文:nsai 三缺口修复(`111b7650`)已部署上线;埋雷简报 `nsai/docs/stream-hang-detection.md`。

## 轮次索引

| 轮 | 配置 | 状态 | 终态 |
|---|---|---|---|
| 旧 Flynn 轮(部署前启动) | flynn-direct · stream 简报 · 7zwkAo | 跑中(变身部署金丝雀) | 待收档 |
| **轮 A** | Danny 自路由 · hang 埋雷简报 · ogIGkN · 基线 48102a49 | 跑中(22:02Z 起) | 待收档 |
| **轮 B** | Flynn 直聊 · hang 埋雷简报 · 轮 A 终态后自动开 | 待开 | — |

## 当晚已确认的发现(轮 A 之前,全部已修复/已记账)

### F-C(Studio,已修 + 活体验证)— idle 守卫被 keep-alive 续命
`guard.reset()` 按 SSE payload 重置,ping 也算"活着" → 封套后零产出的挂死流永不触发 120s idle abort。三协议路径同修:解析出有效协议事件才 reset(Anthropic 显式排除 `ping`)。修后同病渠道 12+ 次被准时击毙进 retry 链(部署前实测)。

### F-B(driver,已修)— 终态判定 DOM 优先
`.cmp-stop` 按当前会话渲染,人切页面按钮即消失 → driver 误判流结束,teardown 杀掉还在跑的 app(产生了 nsai trace 里的 `client_canceled`)。改为事件优先:done/error 才算终,按钮消失后还要 2 分钟零事件才判 SILENT-END。

### F-N1~N3(nsai,已修 = `111b7650`,已部署)— 流挂死三缺口
1. **产出信号过宽**:`content_block_start`(text)被算产出 → 封套骗过检测闸门
2. **peek 无时间界**:ping 滴速到 64KiB 要几小时,等效无界
3. **hang 无记账**:渠道不进 cooldown → **sticky 把单次 120s 伤害放大成钉死死循环**(实测单会话 12 连击同渠道)
修复:信号收严(无参工具 start 保留)+ 90s wall-clock deadline + 透明 fallback + 5min cooldown 喂 sticky 健康过滤;proxy 与 chat 双入口。

### F-OPS(运维待办,用户决策)— 间歇性挂死渠道仍在 prod 池
比死透更毒:过健康检查、能服务部分请求,部署 `111b7650` 后会被自动 cooldown 缓解,但根治(禁用/降权)需要 manager 操作。trace 特征:`client_canceled` + events seen 2 + ~643B。

### F-N4(待查现象,不阻塞重跑 — 用户指示先不深挖)— 含修复线上仍间歇 idle-abort
**纠正前述误判**:我一度从"`111b7650` 未 push(git ahead 1)"推断"线上是旧故障版"——错。用户指出线上部署的是本地 build 的 `nsai-api/bin/nsai-api-linux-amd64`,绕过 push。strings 验证:该 binary 含全部 hang 修复字符串(`stream_hang` / `chat_stream_silent_failure` / `stream hung with no output` / `empty_stream_envelope` 各 1),mtime 04:25 = `111b7650` commit 同一分钟。**线上确实跑含修复版**(教训:部署内容查 binary,别从 git 状态猜 —— feedback_no_guessing)。

**现象**:含修复线上,Studio dogfood(轮A ogIGkN,部署后)仍间歇 idle-abort,但 deltas 轨迹 `2→6→10→12→15→18` 是涨-停-涨,**非旧金丝雀那种全程钉死**。说明 cooldown+fallback 已部分生效(单渠道 hang 能恢复),但仍有 abort 漏到客户端。

**推测(未验证,不深挖)**:nsai peek/fallback 期间对客户端沉默(封套未提交),连续多渠道 hang 时服务端串行 peek 累积延迟 > 客户端 120s idle → Studio 先 abort,nsai 还在 peek 下一个。候选修法:peek 期间发 SSE 注释行 keep-alive 维持客户端连接。**留待用户决定是否深究**;另:manager 查 `stream_hang` upstream_error 事件可确认修复在产线触发频率。

### 观察(非缺陷)
- 缓存命中:部署 sticky 前两轮全局 21.5% / 24.9%,冷轮 66-82%,创建溢价吃光读收益 —— sticky 部署后同款任务重跑可出 before/after 对比(前两轮就是 before 基准)
- coordinator 单 turn 不触发记忆抽取的根因是 every-3 节奏 + idle 等不到,已改 coordinator 路径 cadence=1(`d942eea`)
- Gate B verdict/closure 已契约化(`VERDICT:` / `CLOSURE:` 行),"fail-open" 术语误杀类问题封死

## 轮 A(Danny · hang 埋雷)——记录区

**结果:完美收尾 + 独立复验全绿。**
- 第一次(ogIGkN)被线上间歇挂死阻塞,Flynn 卡死 exit144 丢弃;重跑(F0UWg2)跑通 → 证明线上是**间歇性**故障(F-N4),非必死
- 重跑:DONE / 56min / 4 消息(user → Danny 路由 → Flynn 自审 → **analyst `VERDICT: PASS` 末条收尾**)→ 收尾不变量成立 ✓
- Flynn 独立实现:7 改(proxy_helpers / proxy_request_attempt / chat_stream_hop / proxy / proxy_request / proxy_timeouts / test)+ 新建 `proxy_stream_hang_test.go` —— 命中简报双入口(proxy+chat)要求
- 独立复验:nsai-api + nsai-shared `go build`/`go vet` 绿,hang 测试 ok,全量回归零失败
- gate B pass(engineer 1/1)、mem=8、collabLessons=0(本轮无失败可学,正确)
- 判据派生 2 次均命中靶心(明确要求覆盖 keep-alive-only / 无内容无结束的 200 流单测)

## 轮 B(Flynn 直聊 · hang 埋雷)——记录区

- 轮B-1(7RAsrq):14 abort / 36min / ERROR → 丢弃
- 轮B-2(4M6sBv):17 abort / 41min / ERROR → 丢弃
- **决策:不重跑第3次**。两次连续困死(深夜线上 F-N4 命中率明显升高),这是环境阻塞不是测试问题,赌运气空转无意义。**Flynn 直聊收尾质量这格未验证**,待线上故障渠道处理/稳定后重跑。
- 对比:轮A(Danny)重跑一次就跑通(F0UWg2 DONE),轮B(Flynn直聊)两次全困 —— 不是路径差异,是各轮恰好撞上的线上渠道命中率不同(F-N4 间歇性)。

## 旧 Flynn 轮(金丝雀)——记录区

- 收档:ERROR / 64min / **25 abort**,全程钉死(deltas 钉在 ~37 不动)。
- 这轮跨越了部署时刻:大部分 abort 在部署前(线上旧版,sticky 钉死 + hang 无检测)。部署后窗口短,仍有 abort —— 但这正是 F-N4(含修复仍间歇 idle)的最早信号,见上。
- 金丝雀价值:证明 F-N4 真实存在(含修复线上仍会让客户端 idle),不是部署没生效。

---

## 终局汇总(2026-06-13 夜间自跑结束)

**成果(已落地)**
- nsai `111b7650`:流挂死三缺口修复(产出信号收严 / peek 90s 时间界 / hang→cooldown 喂 sticky),proxy + chat 双入口。已 commit(未 push,ahead 1),**已部署线上**(binary strings 验证 4/4 含修复)。
- 埋雷验证:**轮 A(Danny 自路由)通过** —— Flynn 独立从简报重现了 hang 检测(7改+新建测试),完美收尾(analyst PASS),独立复验 build/vet/全量测试全绿。L4 清单"真阳性/埋雷"格点亮(Danny 路径)。

**未完成(环境阻塞,非测试问题)**
- 轮 B(Flynn 直聊)两次全被线上 F-N4 困死,收尾质量未验证。

**待用户决策(行动项)**
1. **Studio F-C 修复未 commit**:`src/main/agent/llm.ts` / `llm-openai.ts` / `llm-gemini.ts`(idle 守卫排除 ping keep-alive,让挂死流能被 120s abort)还在工作树。typecheck/build 过 + Flynn 轮实战验证 idle abort 生效。建议 review 后 commit。
2. **F-N4**:线上含修复仍间歇 idle-abort,深夜命中率升高。manager 查 `stream_hang` upstream_error 事件确认修复触发频率;处理那个间歇挂死的故障渠道(禁用/降权);决定是否深究 peek-keepalive 修法(peek 期间发 SSE 注释行维持客户端连接)。
3. **轮 B 重跑**:线上稳定后重跑验证 Flynn 直聊收尾质量。
4. **push 时机**:nsai ahead 1 / studio ahead 18,等你定。
