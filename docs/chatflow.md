# Chatflow

可视化对话编排（MVP）。人设可在 **prompt** 与 **chatflow** 两种模式间切换。

## 入口

- 用户中心「我的人设」：运行模式选 **Chatflow 流程**
- 编辑器：`/chatflow?persona=<id>`
- API：
  - `GET /api/v1/square/personas/:id/graph`
  - `PUT /api/v1/square/personas/:id/graph`（保存图并切换为 chatflow）

## 节点

| 类型 | 说明 | 出站 |
|------|------|------|
| `start` | 唯一入口 | 本地 |
| `llm` | 调用模型 | 平台 LLM 直连，或用户自定义 → **仅** HF tools `/v1/chat/completions` |
| `search` | 联网搜索 | **仅** HF tools `/v1/web-search` |
| `http` | HTTP 请求 | **仅** `TOOLS` 主机 + `CHATFLOW_HTTP_ALLOWLIST`（`*` = 任意公网，见下）|
| `memory` | 注入本轮已选记忆 | 本地 |
| `if-else` | 条件分支（true/false 句柄） | 本地 |
| `answer` | 最终回复模板 | 本地 |

默认图：`start → llm → answer`。

## 模板变量

节点文案支持 `{{query}}`、`{{system_prompt}}`、`{{history}}`、`{{memories}}`、`{{bot_name}}`、`{{llm_text}}`、`{{节点id.text}}` 等。

## 试聊

网页试聊支持 chatflow 人设：执行同一张已发布的图，但 **强制平台上游**（`upstream: null`），
避免消耗或泄露作者的自定义模型额度。

## 對話品質

每個 LLM 節點都會附加本輪有效的 RULE-002 品質區塊，自訂 system prompt 不能略過它。
正式微信採全域→人設→聯絡人；試聊沒有聯絡人層，只採全域→人設。詳見
`docs/conversation-quality.md`。

## 限制（MVP）

- Chatflow 人设 **禁用主动联系**（`skipReason: chatflow_no_proactive`）
- Fork 复制 graph/mode/web_search，**不复制** `llm_provider_id`
- 试聊不注入长期记忆（`memories` 为空）与表情目录
- LLM 节点的 `temperature` 暂用客户端默认值
- 完整 Dify（知识库、代码节点等）不做

## 环境变量

```env
CHATFLOW_HTTP_ALLOWLIST=          # 额外允许的 http 节点 host；`*` = 任意公网
CHATFLOW_MAX_STEPS=32
CHATFLOW_MAX_NODES=40
CHATFLOW_HTTP_TIMEOUT_MS=15000    # 单个 http 节点的墙钟上限
TOOLS_BASE_URL=...                # 搜索 / 用户自定义 LLM 必需
TOOLS_API_KEY=...
WEB_SEARCH_ENABLED=true           # 全局搜索开关；人设还需 webSearchEnabled
WEB_SEARCH_MAX_RESULTS=5          # 默认条数；search 节点可用 max_results 覆盖
```

以上都是**默认值**：`/admin` → 设置 → 「Chatflow」「联网搜索与工具网关」可直接改，
覆盖存 Redis，各节点 5 秒内生效，无需重启。详见 `docs/runtime-settings.md`。

## http 节点的出站边界

图是**人设作者**写的（`PUT .../graph` 仅 owner，`requireUser` 之外无审核），
响应正文还会回灌进 `vars`（截断 50KB）供 `answer` 引用。也就是说 http 节点等于把一次
**可读的**服务端请求交到普通注册用户手里，所以出站要按白名单管。

两个放大器值得单独记住：

- URL 是**模板**：`renderTemplate(node.data.url, vars)`，而 `vars.query` 就是原始
  用户消息（`engine.ts:127-133`）、`vars.llm_text` 是模型输出。作者写成
  `https://{{query}}/` 就等于把 host 的选择权交给**任何发消息的人**；写成引用上游
  `llm` 节点的变量，就等于交给可被 prompt 注入的模型输出。所以校验必须发生在
  **渲染之后**（现实现即如此），作者时校验 URL 是没用的。
- 触发不需要微信：网页试聊走同一张图，人设可以一直是 private，作者从不出现在广场
  或任何审核面上。

`CHATFLOW_HTTP_ALLOWLIST` 的两种写法：

| 值 | 含义 |
|----|------|
| 空 | http 节点只能打 `TOOLS_BASE_URL` 的 host:port。没配 TOOLS 就完全不可用 |
| `a.com,b.com` | 精确匹配 hostname，**不支持通配**：`a.com` 不覆盖 `api.a.com` |
| `*` | 任意**公网**地址 |

`*` 不是「不做检查」。放行前仍然逐项拦掉（`packages/core/src/chatflow/http-guard.ts`）：

**第一道：地址段**（写死的 IP 字面量）

- 回环 `127.0.0.0/8`、`::1`、`localhost`
- 私有段 `10/8`、`172.16/12`、`192.168/16`
- 链路本地 `169.254/16` —— 含 AWS/Azure IMDS `169.254.169.254`
- 运营商级 NAT `100.64/10` —— 含阿里云元数据 `100.100.100.200`
- IPv6 `fc00::/7`、**整个 `fe00::/8`**（不只 `fe80::/10`，站点本地 `fec0::/10` 同样在内）、
  `ff00::/8`，以及 `::ffff:`、`64:ff9b::` 里嵌的 IPv4
- IPv6 兜底：**不在全球单播 `2000::/3` 内的一律拒**，免得再漏某个保留前缀
- `0/8`、`192.0/16`、`198.18/15`、多播与保留段

判断走**地址段**而不是字面量，因为 `new URL()` 会把 `2130706433`、`0x7f.0.0.1`、
`0177.0.0.1`、`::ffff:127.0.0.1` 归一成别的写法 —— 只比字符串是拦不住的。

**第二道：主机名**

- 单标签主机名（docker service 名、`metadata`、`instance-data`）
- `.local` `.localhost` `.internal` `.svc` `.lan` `.intranet` `.corp` `.private` `.home.arpa`
- 长得像公网、其实是云元数据的名字：`metadata.tencentyun.com`（腾讯云 CVM，直接给
  角色凭证，无 token 步骤）、`metadata.goog`

**第三道：解析结果**

只看字面量挡不住 `169-254-169-254.nip.io` 这种通配 DNS（一个普通 `.io` 域名，解析到
IMDS 地址，不需要攻击者自建任何东西），也挡不住攻击者把自家 A 记录指向 `10.0.0.5`，
或 docker 内嵌 DNS 把 `service.network` 解析成网桥地址。所以放行前会 `dns.lookup`
一次，**任一**返回地址落在上面的段里就拒。

解析失败**不**算拦截：解析不出来的名字 fetch 也出不去，没有任何流量发生，不该把一次
DNS 抖动升级成 `http_blocked` 把整个流程打断。

**第四道：重定向与凭证**

- **每一跳重定向都重新过一遍全部检查**（`redirect: "manual"`，最多 3 跳）。否则一个允许的
  公网域名只要回一个 `302 → http://169.254.169.254/`，前面三道全白做。
- `Authorization` 跨 origin 会被摘掉；`TOOLS_API_KEY` 只发给 `TOOLS_BASE_URL` 的
  **host:port** —— 同一台机器换个端口都不给，`TOOLS_BASE_URL` 指向 loopback 时尤其重要。

### 已知边界

**DNS rebinding 仍有窗口。** 这里解析一次、`fetch` 自己再解析一次，控制着权威 DNS 且
TTL 压到极短的攻击者可以在两次之间翻记录。要堵死得把 socket 钉在**已经校验过的那个
地址**上，即 undici `Agent` 的 `connect.lookup` —— 需要把 undici 收成直接依赖，当前没做。
现在挡住的是所有直接写内网地址、以及所有**静态**解析到内网的名字。

**白名单是全站共享的**：加进去的 host 等于允许所有人的人设去请求它，别放带鉴权的内部接口。

联网搜索是**两道闸的与**：全局开关 + 人设自身的「联网」开关（用户中心「我的人设」里勾选）。
详见 `docs/ai-gateway.md`。
