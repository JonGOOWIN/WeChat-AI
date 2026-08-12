# 运行时配置（管理面板）

`/admin` → **设置** 页可以改绝大多数原本只能写在 `.env` 里的配置。

## 优先级

```
.env（进程启动时读一次）  ←  默认值
        ↓ 被覆盖
wa:settings:runtime（Redis JSON）  ←  管理面板写入
        ↓
生效配置（进程内的同一个 cfg 对象）
```

- Redis 里**没有**某一项时，就用 `.env` 的值。
- 面板里把某项改回 `.env` 默认值，会**删除**该覆盖 —— 以后再改 `.env` 又能生效。
- 「全部恢复默认」删除整份 Redis 覆盖文档。

## 传播

每个节点每 **5 秒** 读一次 `wa:settings:runtime`，有变化才写入本进程配置并推给各服务。
所以：改动在**本节点立即生效**，其他节点**最多 5 秒**。没有用 pub/sub —— 一次 GET
相对请求路径上的 Redis 流量可以忽略，也省掉一条订阅连接。

## 范围

**不可配置（env-only）**，因为它们要么在能读 Redis 之前就得正确，要么改了会破坏已有数据：

| 变量 | 原因 |
|------|------|
| `REDIS_URL` | 鸡生蛋：覆盖本身存在 Redis 里 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 平台模型凭证 |
| `LLM_PROVIDER_SECRET` | 改了之后所有用户已加密的自定义模型 key 全部解不开 |
| `WECHAT_AI_TOKEN` / `LINUXDO_ADMIN_IDS` | 权限根，改错会把自己锁在外面 |
| `SESSION_COOKIE_NAME` / `COOKIE_SECURE` | 改了当场踢掉所有会话 |
| `PUBLIC_BASE_URL` / `CORS_ORIGINS` | 站点自身 URL 与跨域白名单 |
| `WECHAT_AI_HOST` / `WECHAT_AI_PORT` | 监听端口在 `listen()` 时固定 |

其余全部在面板里，包括 `TOOLS_BASE_URL` / `TOOLS_API_KEY`（密钥在 UI 里只显示掩码）。

`apps/api/src/runtime-config.test.ts` 有一条守卫用例：**任何新增的 AppConfig 字段**要么进
`SETTING_SPECS`，要么进那份 env-only 名单，否则测试直接失败。

`DEFAULT_PERSONA_SLUG` 刻意不在面板里：`cfg.defaultPersonaSlug` 在代码里没有任何消费方，
默认人设走的是数据库 `is_default`（管理台「人设」→ 设默认）。放进面板只会得到一个
「保存成功但什么都没发生」的控件。

## 需重启的项

绝大多数配置是热生效的。以下几项写入 Redis 后会打上橙色「需重启」徽章：

| 项 | 为什么 |
|----|--------|
| `WORKER_ENABLED` | `worker.start()` 只在启动时跑一次 |
| `REPLY_CONCURRENCY` | 消费者池在 `start()` 一次性拉起，没有单消费者取消机制，缩容做不到 |
| `LOG_LEVEL` | Fastify 创建实例时固化 logger |
| `STICKER_MAX_BYTES` | 路由注册时固化 `bodyLimit` |

## 热生效是怎么做到的

`cfg` 对象**按引用**传给 `registerRoutes` 和各个服务，所以：

- **路由**：87 处 `ctx.cfg.*` 是每请求读的，原地改 `cfg` 就够了，零改动。
- **在构造时快照选项的服务**：由 `runtime-config-apply.ts` 显式推送 ——
  `ChatService` / `TryChatService` / `BotWorkerManager` / `ActivityBus` 各有一个
  `applyRuntimeOptions`（或 `applyRuntimeConfig`）。

几个需要特殊处理、否则会静默失效的地方：

- 连续普通 AI 对话按 Bot + 联系人分别聚合。`replyBatchSilenceMs`（默认 10 秒）和
  `replyBatchMaxWaitMs`（默认 20 秒）会重装所有尚未关闭批次的 timer；
  `replySkipBiasPercent` 与 `replyCountWeight1..4` 会在下一次批次规划时读取。
  跳过比例只是长期校准目标：只有整批没有回复义务才可跳过，直接问题、请求、决策和
  重要情绪不会因为调高比例而被丢弃。P2P、广播和主动联系不走该批次路径。
- 管理台把这组设置按「批次 → 判断 → 回复」展示：可关闭连续消息聚合；静默与最长等待
  直接用秒填写。1／2／3／4 条回复是已决定回复后的百分比分布，四项必须合计 100%；
  短／普通／长回答同样是百分比分布，三项必须合计 100%。保存时静默等待不得大于最长等待，
  负数、非有限值、越界或合计错误会整笔拒绝，不会静默修正。
- 一般 prompt、Chatflow 与网页试聊会在同一轮生成稳定的质量计划：`replyCoveragePercent` 默认
  70，只决定已回复批次里一般话题的覆盖，不会丢掉直接问题、明确请求、重要决定或情绪
  表达；`replyFollowUpPercent` 默认 20；短／普通／长权重默认 60／30／10，对应整份可见
  回复 1–20／21–60／61–160 字。`emotionContinuityTurns` 默认 4 个完成轮次，
  `repetitionWindowAssistantTurns` 默认检查最近 12 个 assistant 轮次。以上设置会在下一轮
  对话热生效；同一批次重试使用稳定 turn key，不会重新抽取另一组目标。生成结果如超出
  长度上限、追问过多或复用近期显著套话，只允许在送出前重写一次；仍不合格就不发送，
  不会产生重复气泡。默认关闭二次 AI 排版时，最坏是初稿＋重写共 2 次 LLM 调用；若同时
  开启 `replyFilterEnabled`，初稿与重写各自还会排版一次，最坏共 4 次 LLM 调用，会增加
  成本与延迟。管理面板的「重复检查 assistant 轮数」提示会显示这项代价。
  正式微信逐栏按全局→人设→联系人合并；网页试聊只有全局→人设。Chatflow 的每个 LLM
  节点都会附加质量区块，即使节点自定义 system 且未引用人设变量。完整校准方式与限制见
  `docs/conversation-quality.md`。
- `ChatService.webSearch` 原本在构造函数里判断一次，`WEB_SEARCH_ENABLED=false` 启动就永远
  是 `null`。现在按 tools 配置的指纹惰性重建。
- `BotWorkerManager` 的 10 个 `readonly` 标量改成可写，且 setter 里复刻了构造函数的
  clamp —— 面板不能写进一个构造函数本来会拒绝的值（比如 `leaseRenewSec=0`）。
- `leaseRenewSec` 还决定 `setInterval` 周期，改动时重新装载定时器。
- `ProactiveScheduler.globalEnabled` 被 `start()` 闩住（早退且留下 `stopped=true`），
  false→true 必须重新进 `start()`，光改标志没用。
- `setRedisCommandHook` 现在无条件安装，否则 `DATA_STREAM_ENABLED` 这个开关永远是死的。

## API

**整个页面（含只读）限超管。** 超管 = 仍是管理员的用户里 `created_at` 最早那位。

| Method | Path | 权限 | 说明 |
|--------|------|------|------|
| GET | `/api/v1/admin/settings/runtime` | **超管** | 分组 + 全部项（当前值 / env 默认值 / 是否已覆盖 / 是否需重启）+ 交叉校验警告 |
| PATCH | `/api/v1/admin/settings/runtime` | **超管** | `{ patch: {key: value}, reset: [key] }` |
| POST | `/api/v1/admin/settings/runtime/reset` | **超管** | 删除全部覆盖 |

连读也限超管：这个面板能拿到 tools 网关密钥，能整个集群关掉 worker，
payload 本身也把每一个调参项和当前生效值列了出来。普通管理员访问返回
403 `super_admin_required`。

前端跟着服务端一起收口，和「节点 / 广播 / 数据流」用同一套三处门禁：
`switchTab` 拦截并回落到「系统」页、`boot()` 隐藏侧栏按钮与 `<section>`、
命令面板（Ctrl/⌘K）过滤掉该条目。

两个写操作都会记审计（`runtime_settings_updated` / `runtime_settings_reset`），
含变更的 key 列表与需重启的 key。

密钥字段（`type: "secret"`）的约定：

- GET 只返回掩码 `••••••••`，永远不回真值
- PATCH 传空字符串 = **不修改**
- PATCH 传 `-` = **清空**
- 把掩码原样回传会被忽略，不会变成字面值

## 交叉校验

保存时会返回警告（只提示，不改用户填的值）：租约 TTL ≤ 续约间隔、延迟上下限倒挂、
`memoryFullInjectMax < memoryTopK`、开了联网但没配 tools 网关、配了网关但密钥为空、
二次过滤与模型直出 JSON 同时开启。

对话自然度参数属于硬校验，不走上述警告：静默等待大于最长等待、两组百分比分布不等于
100，或任一数值为负数、非有限值、超出范围时，PATCH 返回 400 且不写入 Redis。

## Redis 读失败时的行为

「读不到」和「不存在」必须分开——把两者都当成「没有覆盖」会让一次网络抖动
把整个节点悄悄退回 `.env`（此前被面板收紧的开关会瞬间放开）。所以：

- **轮询读失败** → 保持上一份已知配置不动，打一条日志，`refresh()` 返回 false。
- **文档里任何已知字段无法转换，或推送到在线服务时抛错** → 整份候选配置都不提交；
  `cfg`、覆盖项、更新时间与更新人继续显示上一份已知正确值，同一份 Redis 文档会在下次轮询重试。
- **写路径读失败** → 直接拒绝，返回 **503**。绝不能基于失败的读做合并再写回，
  那会把其他所有覆盖一起抹掉。
- **例外：全部恢复默认**。它本来就要丢弃旧文档，所以读不到时也允许执行 ——
  这是文档损坏时唯一的产品内自救路径。

## 取值受限的项

`SettingSpec.options` 声明闭集，面板渲染成下拉框，服务端对不在集合里的值直接拒绝
（不做替换，免得把拼写错误藏起来）。目前只有 `LOG_LEVEL` 用到：pino 遇到未知级别会在
Fastify 建实例时抛错，而这一项又是「需重启」，一个拼写错误会在下次重启时让每个节点
反复崩溃，而且管理接口起不来、改不回去。

## 并发写

`patch()` 是读-改-写：读 Redis 当前文档 → 合并 → 整份写回。合并是**按文档**而不是按字段的，
所以两个超管在两个节点同时保存，后写的那份会带着自己的改动覆盖掉前一份的全部改动。

为此写路径上加了一把短锁 `wa:settings:runtime:lock`（`SET NX EX 5`，最多重试 5 次 ×
120ms），把整个集群的读-改-写串起来。锁只在写时用，读路径完全不碰它。
拿不到锁时不阻塞管理员，仍然继续写 —— 锁是降低窗口，不是强一致保证；写操作是超管专属
且极低频，这个取舍是刻意的。

## 多节点注意

`MAX_BOTS_PER_WORKER`、`LEASE_TTL_SEC`、`REBALANCE_SLACK` 参与的是**集群共享**的租约/再平衡
协议。因为覆盖存在 Redis、所有节点读同一份，各节点最终看到的是同一组值 —— 但在 5 秒收敛
窗口内可能短暂不一致，表现为一次多余的再平衡。改这几项建议避开高峰。
