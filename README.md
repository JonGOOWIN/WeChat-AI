<div align="center">

# WeChat-AI

**自托管微信角色扮演对话服务** · Self-hosted WeChat roleplay chatbot service

直连腾讯 **iLink**，数据存 **远端 Redis**，登录用 **LINUX DO OAuth**。
Connects directly to Tencent **iLink**, stores data in **remote Redis**, and authenticates via **LINUX DO OAuth**.

[功能 Features](#功能-features) · [架构 Architecture](#架构-architecture) · [快速开始 Quick Start](#快速开始-quick-start) · [文档 Docs](#文档-docs) · [许可证 License](#许可证-license)

[![community](https://github.com/user-attachments/assets/653f2b6b-ee32-4f0f-abe0-1ba96e4bb473)](https://linux.do/) [![Telegram Group](https://img.shields.io/badge/Telegram-Group-blue?logo=telegram&style=flat)](https://t.me/smnet_group/105727)

</div>

---

## 功能 Features

| 中文 | English |
|------|---------|
| LINUX DO OAuth 登录（用户 / 管理员） | LINUX DO OAuth login (user / admin) |
| 用户中心：扫码添加/删除微信机器人、批准私聊用户、分配人设，并为单个联络人调整对话风格 | User center: scan-QR add/remove WeChat bots, approve chat peers, assign personas, and tune conversation style per contact |
| 用户对话：绑定 LINUX DO 后微信内 `@用户名` 请求对话，对方 `/同意` 后双向中继 | P2P chat: after binding, `@username` in WeChat to request a chat, peer replies `/agree` to relay messages both ways |
| 管理后台：数据面板、Token 用量、用户与机器人、部署节点、表情包审核 | Admin dashboard: stats, token usage, users & bots, deploy nodes, sticker moderation |
| 表情包广场：投稿 / 我的库 / 公开需审核；恶意图过滤 | Sticker square: submit / my library / public needs review; malicious-image filtering |
| 回复文字与图片表情（主人表情库 → 模型引用 slug → iLink CDN 发图） | Text + image sticker replies (owner sticker library → model references slug → sent via iLink CDN) |
| 输入状态指示（getconfig + sendtyping，回复送达即消失） | Typing indicator (getconfig + sendtyping, disappears when reply is delivered) |
| 入站图片理解（`VISION_ENABLED`，默认关闭；caption 模式人设模型无需视觉） | Inbound image understanding (`VISION_ENABLED`, off by default; `caption` mode needs no vision-capable roleplay model) |
| 入站语音转写（微信自带转写，默认开启） | Inbound voice transcription (WeChat built-in STT, on by default) |
| 远端 Redis 存储（bot token 与表情包均在 Redis） | Remote Redis storage (bot tokens & stickers in Redis) |
| OpenAI 兼容 LLM + 按日 Token 统计 | OpenAI-compatible LLM + daily token stats |
| 用户自定义模型 + 联网搜索（经 HF 工具网关出站，主站不直连用户 API） | User custom models + web search (egress only via HF tools gateway) |
| Chatflow：可视化编排（`/chatflow`），人设可选 prompt / chatflow 模式 | Chatflow: visual orchestration (`/chatflow`), personas support prompt / chatflow mode |
| 多节点同构部署 + Cloudflare Worker 负载均衡 | Multi-node homogeneous deployment + Cloudflare Worker LB |
| OTA 增量更新（文件差量 + 自动重启） | OTA incremental updates (file diff + auto restart) |

## 架构 Architecture

```
微信用户 ──► 腾讯 iLink ──► 本系统多节点 (收消息 / 人设+记忆 / LLM / 回消息)
WeChat user ──► Tencent iLink ──► multi-node system (receive / persona+memory / LLM / reply)

浏览器 ──► 主域名 CF Worker LB ──► Node-1…N (同一镜像, 共享 Redis)
Browser ──► main domain CF Worker LB ──► Node-1…N (same image, shared Redis)
```

## 快速开始 Quick Start

### 本地开发 Local Development

开发与质量检查需要 Node.js 22.13 以上，并使用仓库锁定的 pnpm 11.15.0（`corepack enable` 会启用它）。
Development and quality checks require Node.js 22.13+ and the repository-pinned pnpm 11.15.0 (`corepack enable`).

```bash
corepack enable
pnpm install
cp .env.example .env
# 必填 Required: REDIS_URL（Upstash 用 rediss://）、LLM_API_KEY（平台）、LINUXDO_* 、LINUXDO_ADMIN_IDS
# 用户自定义 LLM / 联网搜索：部署 huggingface/wechat-ai-tools，配置 TOOLS_BASE_URL + TOOLS_API_KEY

pnpm db:seed
pnpm diag
pnpm dev
```

提交前执行完整本地门禁 / Run the complete local gate before committing:

```bash
npm run lint
npm test
npm run typecheck
npm run build
```

Lint 会检查 workspace 的 TypeScript 源码与测试、Cloudflare Worker TypeScript 源码及仓库脚本。`dist`、`build`、`coverage`、依赖、Wrangler 输出、静态浏览器页面、手动打包的 `cloudflare-worker/worker.js` 与测试 fixture 会明确排除。
Lint covers workspace TypeScript source/tests, Cloudflare Worker TypeScript source, and repository scripts. Generated/build output, dependencies, Wrangler output, static browser pages, the manually bundled `cloudflare-worker/worker.js`, and test fixtures are intentionally excluded.

Pull requests and pushes to `master` run four separately visible GitHub checks: `lint`, `test`, `typecheck`, and `build`. They use the same commands shown above. CI uses the same Node.js 22.13 floor required by the pinned pnpm 11.15.0. The repository variable `RUNS_ON` may select a self-hosted runner only when that runner is Linux with Docker installed; when it is unset, CI uses `ubuntu-latest`. Pull requests from forks always use `ubuntu-latest` and never receive the self-hosted label.

页面 / Pages：

| 路径 Path | 说明 Description |
|-----------|------------------|
| `/` | 功能落地页 + OG 分享图 Landing page |
| `/app` | 用户中心 User center (LINUX DO login) |
| `/docs` | 使用文档 Documentation |
| `/admin` | 管理后台 Admin dashboard |
| `/chatflow` | Chatflow 编辑器 Chatflow editor |

### Docker 一键部署 One-Click Deploy

```bash
# 配置好 .env 后 After configuring .env
docker compose up -d --build
```

详见 / See `docs/docker.md`。

### 多节点 Multi-Node

每台服务器运行**同一镜像**，共享同一个 Upstash Redis，用户只访问主域名。Cloudflare Worker 负责健康检查与轮询分流，源站地址只写在 Worker 的 `ORIGINS` 中。详见 / See `cloudflare-worker/README.md`。

Each server runs the **same image**, shares one Upstash Redis; users only visit the main domain. A Cloudflare Worker handles health checks and round-robin, origin addresses live only in the Worker's `ORIGINS`.

## 文档 Docs

| 文档 Doc | 内容 Content |
|----------|-------------|
| [docs/upstash-redis.md](docs/upstash-redis.md) | Upstash Redis 配置 Redis setup |
| [docs/oauth-linuxdo.md](docs/oauth-linuxdo.md) | LINUX DO OAuth 配置 |
| [docs/docker.md](docs/docker.md) | Docker / 多节点部署 Multi-node deploy |
| [docs/cloudflare.md](docs/cloudflare.md) | Cloudflare 缓存 Cache |
| [cloudflare-worker/README.md](cloudflare-worker/README.md) | CF Worker 多源站 LB |
| [docs/ai-gateway.md](docs/ai-gateway.md) | AI 网关（主站 ↔ HF）AI gateway |
| [docs/chatflow.md](docs/chatflow.md) | Chatflow 编排 |
| [docs/conversation-quality.md](docs/conversation-quality.md) | 對話品質優先級、校準與限制 |
| [docs/admin-api.md](docs/admin-api.md) | 管理 API |
| [docs/runbook.md](docs/runbook.md) | 运维手册 Ops runbook |
| [docs/e2e-checklist.md](docs/e2e-checklist.md) | 真机验收清单 E2E checklist |

## 仓库结构 Repository Structure

```
apps/api           # REST + iLink worker + Admin/App/Chatflow UI (public/*.html)
packages/ilink     # iLink HTTP 客户端 iLink HTTP client
packages/db        # Redis 仓储 / seed / 人设与模型连接 Redis repos / seed
packages/llm       # OpenAI 兼容 chat + tools 网关客户端
packages/core      # 会话、人设、记忆、路由、chatflow 引擎
huggingface/       # wechat-ai-tools：唯一外网 AI/搜索出口（可独立部署）
cloudflare-worker  # 主域名负载均衡 Cloudflare Worker LB
docs/              # runbook、E2E 清单、ADR
scripts/           # 构建 / 打包 / 验收脚本 build / pack / accept scripts
```

## 验收 Acceptance

```bash
pnpm accept          # 离线自动化门禁 offline automated gate
```

真机清单 / Real-device checklist：`docs/e2e-checklist.md` · 状态 / Status：`docs/ACCEPTANCE.md`

## 合规与风险 Compliance & Risk

- 使用腾讯 **微信 ClawBot / iLink** 能力，须遵守相关使用条款。
  Using Tencent **WeChat ClawBot / iLink** capabilities requires compliance with the applicable terms.
- 个人 Bot 存在限流与处置风险；默认 **白名单用户** 才可对话。
  Personal bots face rate-limit and takedown risks; by default only **approved users** can chat.
- 角色扮演内容会经 LLM API 出机；请自行评估隐私。
  Roleplay content leaves the machine via LLM APIs; assess your own privacy posture.
- iLink 协议以实测为准，字段可能变更；适配层见 `packages/ilink`。
  The iLink protocol is based on observed behavior and may change; the adapter lives in `packages/ilink`.

## 许可证 License

[Apache-2.0 with Commons Clause](LICENSE)

**禁止商用与转卖**：仅允许个人/非商业使用；不得以任何形式收取费用、提供付费托管/咨询服务，或将本代码用于商业产品转售。详见 [LICENSE](LICENSE)。

**No commercial use / no resale**: personal & non-commercial use only. You may not charge fees, offer paid hosting/support, or resell the code in commercial products. See [LICENSE](LICENSE).
