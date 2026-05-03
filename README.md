# Coding Anywhere

`Coding Anywhere` 是一个单实例的飞书到 Codex 桥接服务。它把飞书里的一个明确工作面(surface)绑定到 Codex 原生线程(native thread)，让用户可以在飞书里继续查看项目、切换会话、发起任务、观察运行状态，并把最终结果带回当前对话。

当前产品化入口只有两类：

- 飞书 DM
- 已绑定项目的飞书群主时间线

飞书话题(topic)、群 `thread_id` 主题和历史话题绑定不是当前产品入口，也不是真实飞书 UI 回归范围。

## 为什么要做

这个项目不是通用 AI 聊天平台，也不是 OpenClaw 的替代品。它刻意把目标收窄到一件事：把飞书里的协作上下文稳定映射到本机 Codex 工作流。

这样做的价值是：

- 安全边界更清楚：飞书消息直接进入本机 Codex，权限、数据流和审计点更容易解释。
- 操作路径更短：项目、会话、运行状态和停止任务都尽量通过卡片按钮完成。
- 上下文更稳定：同一个飞书工作面续跑同一个 Codex 原生线程，减少“跑错项目/跑错会话”的风险。
- 运维更可见：`/ops/*` 能看到 run、线程、项目和实时调度状态。

## 当前能力

- 支持飞书 DM 与已绑定项目群主时间线。
- 支持 `/ca`、`/ca session`、`/ca status`、`/ca new`、`/ca stop`、项目列表和会话切换。
- 支持导航卡、会话卡、运行状态卡、计划模式单次开关，以及 Codex 模型(model)、推理强度(reasoning effort)、速度(speed)下拉设置。
- 使用 `codex exec --json` 创建新 Codex 原生线程，使用 `codex exec resume --json <thread_id>` 续跑已有线程。
- 同一个线程串行执行，不同线程可以并发，全局并发由 `scheduler.maxConcurrentRuns` 控制。
- 支持图片和文件桥接：图片/文件先暂存到当前工作面，下一条文本消息自动带入 Codex；assistant 可以通过受控 `[bridge-assets]` 指令回发原生飞书图片或文件，旧 `[bridge-image]` 继续兼容。
- 支持 Markdown(`.md` / `.markdown`) 和 draw.io(`.drawio` / `.drawio.xml`) 源文件的入站识别、Codex 读取提示和出站文件回传。
- 支持桌面 Codex 线程生命周期通知，并可通过“在飞书继续”接管到 DM 或已绑定项目群主时间线。
- 支持 `/healthz`、`/readyz`、`/metrics`、`/ops/ui`、`/ops/overview`、`/ops/runtime` 等运维入口。
- Windows 下提供 `start-coding-anywhere.cmd` 和 `stop-coding-anywhere.cmd` 一键启停脚本。

更完整的架构和边界见 [项目总览](./docs/project-full-overview.md)。

## 典型体验

一个常见流程是：

1. 在飞书发送 `/ca`。
2. 点击项目列表，选择要进入的项目。
3. 查看会话列表，点击“切换到此会话”。
4. 落到“当前会话已就绪”卡片。
5. 直接发送自然语言，让 Codex 在当前线程里继续工作。

稳定态卡片会突出回答 4 个问题：

```text
当前在哪个项目？
当前在哪个 Codex 线程？
下一条消息会使用什么 model / reasoning effort / speed？
现在能切换会话、打开计划模式，还是查看运行状态？
```

命令是初始化和兜底入口，高频浏览与切换尽量交给卡片按钮。

## 快速开始

```bash
npm install
npm run init:config
npm run doctor
npm run build
npm run start
```

Windows 上也可以直接运行：

```text
start-coding-anywhere.cmd
stop-coding-anywhere.cmd
```

配置约定：

- 仓库只提交 `config.example.toml`。
- 真实 `config.toml` 只保留在本地，不提交到 git。
- 新环境先执行 `npm run init:config`，再填写本地配置。
- 当前正式配置段是 `[codex]`；旧 `[acpx]` 只作为兼容读取入口，不代表当前运行模型。

启动前至少准备好：

- 一个已配置机器人的飞书应用。
- 正确的 `feishu.appId` 和 `feishu.appSecret`。
- 本机可运行的 `codex` CLI。
- 一个受控 root 目录。
- 如需群主时间线能力，飞书后台已发布对应群消息权限。

飞书侧配置见 [飞书配置说明](./docs/feishu-setup.md)，部署和升级见 [管理员部署手册](./docs/admin-deployment.md)。

## 最小使用方式

对大多数使用场景，可以先记住这些入口：

- `/ca`：打开当前工作面的入口卡。
- `/ca session`：查看当前会话卡。
- `/ca status`：查看当前工作面的 live run 或空闲摘要。
- `/ca new`：清理当前工作面的线程绑定，下一条普通消息创建新 Codex 原生线程。
- `/ca stop`：停止当前工作面的排队或运行任务。

仍适合用命令完成的场景：

- 首次绑定项目群。
- 直接切换到某个已知 `threadId`。
- 做少量底层状态确认。

## 真实飞书测试原则

真实飞书测试默认只能使用 `coding-anywhere-autotest` 夹具。

- DM 验证前先执行 `/ca project switch coding-anywhere-autotest` 或 `/ca project current`，确认当前项目正确。
- 群验证前先确认群名是 `coding-anywhere-autotest`，再执行 `/ca project current`，确认当前群绑定到该项目。
- 常规真实 UI 回归只覆盖 DM 和已绑定项目群主时间线，不覆盖 topic、话题、群 `thread_id` 主题或 handoff 伪场景。
- 不满足夹具条件时停止真实联调，改用 mock、单测、专用 smoke，或先确认新夹具。
- `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1` 是危险开关，不属于常规验证路径。

现有脚本：

```bash
npm run test:feishu:auth
npm run test:feishu:live
npm run test:feishu:live:dm
npm run test:feishu:live:group
npm run test:feishu:live:dm:ui
npm run test:feishu:live:group:ui
node scripts/feishu-live.mjs dm bridge-assets
node scripts/feishu-live.mjs group bridge-assets
```

## 运维入口

默认端口来自 `config.example.toml`：

```text
http://127.0.0.1:3000/healthz
http://127.0.0.1:3000/readyz
http://127.0.0.1:3000/metrics
http://127.0.0.1:3000/ops/ui
http://127.0.0.1:3000/ops/overview
http://127.0.0.1:3000/ops/runtime
http://127.0.0.1:3000/ops/projects
```

如果改过 `[server].port`，按实际端口访问。

## 当前限制

- 不能自动创建飞书项目群，只能绑定已有群。
- 不提供飞书 topic / 话题 / 群 `thread_id` 主题的产品化入口。
- `/ops/ui` 主要服务 run 控制、告警排查和历史详情，不是完整项目/线程管理后台。
- 没有完整 DM Hub。
- 当前“计划模式”是 bridge 基于 Codex CLI 拼出的飞书侧工作流，不等同于官方交互式 CLI 原语。
- 当前支持文本、图片和普通文件；语音未接通。
- `.md` 和 `.drawio` 支持源文件传输与语义标记；自动 Markdown 预览卡、draw.io 渲染预览仍是后续增强。
- outbound 资源路径必须位于当前 run/desktop completion 专属输出目录，或是本轮已消费入站附件的 exact `local_path`；不允许直接外发任意项目 `cwd` 文件。
- 真实飞书网页登录 smoke 依赖首次人工登录和持久 profile；SSO、验证码或二次验证仍需要人工介入。
- 不支持多实例集群部署。

## 文档

- [项目总览](./docs/project-full-overview.md)
- [飞书配置说明](./docs/feishu-setup.md)
- [管理员部署手册](./docs/admin-deployment.md)
- [故障排查手册](./docs/troubleshooting.md)
- [版本发布与变更记录规范](./docs/release-and-changelog.md)

## 开源许可

本仓库使用 [MIT License](./LICENSE)。
