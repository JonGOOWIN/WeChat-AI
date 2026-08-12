# E2E 验收清单

环境：已配置 `.env`、完成 `db:migrate` + `db:seed`、至少一个 Bot 登录、LLM 可用。

## A. 安装与诊断

- [ ] `pnpm install` 成功
- [ ] `pnpm db:migrate` / `pnpm db:seed` 成功
- [ ] `pnpm diag` 在配置正确时 PASS（弱 token / 无 bot 仅警告）
- [ ] `pnpm test` 全部通过

## B. Admin

- [ ] 打开 `http://127.0.0.1:8787/admin` 可加载
- [ ] 填入正确 Token 后总览卡片有数据
- [ ] 可见默认人设 `catgirl` / `girlfriend`
- [ ] 可创建新人设并出现在列表
- [ ] 可发布人设新版本

## C. Bot 与多人

- [ ] `pnpm ilink:login` 扫码成功，Admin → Bot 可见账号
- [ ] 微信用户 A 发消息后，Admin → 用户出现 pending
- [ ] 批准 A 后，A 收到角色扮演回复（默认猫娘风格）
- [ ] 用户 B 同时发消息：会话与记忆不与 A 串味
- [ ] Admin 将 A 分配为女友人设，A 回复风格变化
- [ ] A 发送 `/角色 xxx` 收到「仅后台分配」提示
- [ ] 未批准用户收到开通引导（或被忽略）

## D. 记忆

- [ ] A 陈述偏好（如「我叫小明」）后，多轮后记忆列表出现相关事实（每 N 轮抽取）
- [ ] 重启 `pnpm dev` 后 A 的记忆仍在
- [ ] Admin 重置 A 记忆后列表清空

## E. 多 Bot（可选）

- [ ] 第二次 `pnpm ilink:login -- --name bot2` 增加第二个 Bot
- [ ] 两个 Bot 的 peer 互不混淆

## F. 限流与体验

- [ ] 同一用户短时间连发超限，收到「发得太快」提示
- [ ] typing 调用失败不影响正常回复（best-effort）

### F.1 输入状态（getconfig + status 1/2）

- [ ] 发消息后微信显示「对方正在输入中」
- [ ] 回复送达后指示器**消失**（不是等服务端超时）
- [ ] 多气泡回复期间指示器在气泡之间持续显示
- [ ] 被限流 / 未批准被拒 / 用户互聊中继后，指示器也停止
- [ ] 抓包确认每个 peer 只有一次 `getconfig`（票据缓存生效），之后只有 `sendtyping`
- [ ] `sendtyping` 携带 `typing_ticket` 与 `status`
- [ ] 人为让 `getconfig` 失败（改 baseUrl）→ 回复仍正常送达

### F.2 入站媒体

- [ ] `VISION_ENABLED=false` 时发图 → 回「看不了图片」，且**没有**产生 LLM 调用
- [ ] `VISION_ENABLED=true` 且模型支持视觉时发图 → 回复据实描述图中内容
- [ ] 发图 + 文字说明 → 两者一起进入同一轮对话
- [ ] 一条消息发 3+ 张图 → 只识别 `VISION_MAX_IMAGES` 张，其余按「看不了」告知
- [ ] 超过 `INBOUND_MEDIA_MAX_BYTES` 的图 → 降级为「看不了」，回复不失败
- [ ] 发视频 / 文件 → 按类型回话，且模型**没有**编造内容
- [ ] 发带转写的微信语音 → 按文字正常对话，不出现「我听不到」
- [ ] `VOICE_TRANSCRIPT_ENABLED=false` 后同一条语音 → 回「没听清，麻烦打字」，且不走 LLM
- [ ] 该开关与 `VISION_ENABLED` 互不影响（图片关、语音开是默认组合）
- [ ] 发图后下一轮追问 → 历史里是 `[图片]` 占位符，上下文没丢
- [ ] chatflow 模式人设收到图 → 看到 `[图片]` 占位符，不报错

## G. 安全

- [ ] 无 Token 访问 `/api/v1/*` 返回 401
- [ ] Token 不出现在审计全文中；仅存 Redis `wa:bot:{id}:creds`

## H. 用户对话（@LINUX DO）

- [ ] 用户中心可生成绑定码；微信 `/绑定 CODE` 成功；`/我的身份` 显示用户名
- [ ] 双方均绑定且各聊过机器人后，A 发 `@B用户名`，B 收到请求
- [ ] B `/同意` 后互发文字，内容带 `[用户名]` 前缀
- [ ] `/断开` 后普通消息恢复 AI 角色扮演
- [ ] 未绑定 / 无 context_token 的目标：发起方收到明确错误提示
- [ ] `hello @user` 不触发请求（整条消息匹配）

## I. AI 网关（自定义模型 / 联网搜索）

前置：已部署 `huggingface/wechat-ai-tools`，主站配置 `TOOLS_BASE_URL` / `TOOLS_API_KEY` / `LLM_PROVIDER_SECRET`。

- [ ] `/app` → **我的模型**：可添加连接（名称 / Base URL / Key / 模型），列表显示掩码 Key
- [ ] 可停用 / 启用 / 删除连接
- [ ] 未配置 `LLM_PROVIDER_SECRET` 时页面提示明确、不落库
- [ ] 人设选择「我的连接」后对话正常；抓包确认主站 **未**直连该 base_url（仅打 TOOLS）
- [ ] 人设开启联网搜索 + `WEB_SEARCH_ENABLED=true`：问时事类问题触发 `/v1/web-search`
- [ ] 审计日志 / 应用日志中 **不含** upstream api_key 明文
- [ ] Fork 他人人设：新人设 `llmProviderId` 为空（不继承作者密钥）
- [ ] 用户人设编辑器「进阶对话风格」：逐项切换继承／覆盖，保存重载后状态一致；长度比例非 100 时显示错误
- [ ] Admin 官方人设编辑器：同样可逐项继承／覆盖；清除覆盖后重载显示「继承全局」
- [ ] Fork 他人人设：对话风格覆盖保持一致，同时 `llmProviderId` 仍为空

## J. Chatflow

- [ ] 人设编辑器切「Chatflow 流程」保存后，卡片显示 Chatflow 徽章
- [ ] `/chatflow?persona=<id>` 可加载（未保存图时显示默认 start→llm→answer）
- [ ] 拖拽节点、连线、编辑属性后「保存并启用」成功
- [ ] 非本人人设打开为只读（保存按钮禁用）
- [ ] 微信对该人设发消息，回复由流程产出
- [ ] 网页试聊 chatflow 人设可正常回复（走平台模型，不消耗作者额度）
- [ ] `search` 节点在人设未开搜索 / 未配 TOOLS 时报错清晰
- [ ] `http` 节点填非 allowlist 域名 → 被拒（`http_blocked`）
- [ ] chatflow 人设不触发主动联系（skip: `chatflow_no_proactive`）
- [ ] 图校验：无 answer / 多个 start / 超 `CHATFLOW_MAX_NODES` → 400

## K. 对话质量全路径（合并后串行）

- [ ] 后台「对话与回复」修改五组质量参数并保存，重新加载后值不变
- [ ] Prompt 人设的联系人覆盖留空时逐栏继承；清除后不恢复旧值
- [ ] Chatflow LLM 节点使用不含 `{{system_prompt}}` 的自定义 system，activity 仍显示有效 profile 与 reason codes
- [ ] 网页试聊同一人设，activity 只反映全局→人设，不出现联系人覆盖
- [ ] activity 不出现消息正文、stable turn key、topic ID 或模型密钥

本节必须在浏览器资源可用、功能合并后串行真点；单元测试通过不等于本节已验收。

## 验收结论

全部关键项（A–D、F–G）通过即可判定：**系统已完成并可验收**。  
E 为多 Bot 增强项；H 为用户对话增强项；真机扫码依赖本机微信与 iLink 可用性。  
I / J 需先部署 HF 工具服务（`docs/ai-gateway.md`、`docs/chatflow.md`）；未部署时这两节整体跳过。
