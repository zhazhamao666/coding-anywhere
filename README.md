# Coding Anywhere

把 Feishu DM、已绑定项目群主时间线和已注册线程桥接到 Codex 的单实例服务。

它可以把 Codex 带进现有的 Feishu 协作流里，让你直接在飞书中查看项目、浏览线程、切换到指定 Codex 线程，并在原上下文里继续追问和协作。

它的价值不只是“能连上 Codex”，而是把这条链路做得更适合团队日常使用：更贴近现有沟通场景，更容易控制安全边界，也更适合通过卡片按钮完成高频操作。

类似的需求其实一直很多。`Claude Code` 已经通过官方产品把编程助手带到更多终端，这本身就说明“随手可用的编程代理入口”是成立的需求；而在 Codex 侧，团队依然会需要一个直接进入 Feishu 协作流的桥接层。

## 为什么在有 OpenClaw 之后还要做它

市面上已经有 OpenClaw 这类更通用的方案，所以这个项目并不是想替代一切，而是刻意把问题收窄。

我的判断是，在很多团队里，`Feishu <-> Codex` 这条链路本身就值得单独做成一个小而专注的工具：

- 更清晰的安全边界：消息从 Feishu 直接进入本机的 Codex 工作流，中间少一层额外的通用代理或编排层，权限、数据流和审计点都更容易讲清楚
- 更少的调用成本：如果目标本来就是把飞书里的上下文送给 Codex，再把结果回到飞书，那么少一层额外模型参与，通常也意味着更低的延迟、成本和不确定性
- 更单一的产品职责：OpenClaw 这类工具往往要覆盖更广的问题空间，而这个项目只关心一件事，就是把 Feishu 里的一个明确会话稳定映射到 Codex 线程，并把操作尽量收敛到卡片按钮里
- 更贴近真实协作流：很多时候团队真正需要的不是一个“更全能”的聊天壳，而是一个能在现有 Feishu 线程里低摩擦继续工作的桥

所以如果你的目标是做一个通用 AI 平台，这个项目并不一定是答案；但如果你的目标是让 Codex 在 Feishu 里用得更顺手、更直连、更可控，那它就有存在价值。

## 为什么它适合放在飞书里用

- 打开一张导航卡后，常见操作主要靠按钮点击，不需要反复手输命令
- 项目列表、线程列表、当前项目、当前会话都能直接以结构化卡片展示
- 当前 surface 有 live run 时，可以直接查看运行状态并在卡片里停止任务
- “当前会话已就绪”主卡会常驻展示下次任务设置、计划模式开关和最近上下文，继续工作时不用先退回大导航卡
- 可以直接在飞书里看到当前会话的 Codex 模型、推理和速度，并在“当前会话”“运行状态”和具体对话卡里随时切换
- 在 DM 里可以从“项目列表 -> 线程列表 -> 切换到此线程”一路点进 Codex 原生线程
- 在 DM 里切换项目时，会主动退出之前绑定的旧线程，避免普通消息误跑到别的项目
- 线程列表会把 Codex subagent 解析成母 agent / 子 agent 结构化展示，不再把 raw `source` JSON 暴露给飞书用户
- 卡片按钮回调走飞书长连接，点击后可以原地刷新，不用额外暴露公网回调地址
- DM、已绑定项目群和已注册线程都能接入，同一线程里的上下文可以持续复用
- assistant 的 Markdown 结果会优先走 JSON 2.0 Markdown 卡片，卡片摘要和会话预览也不会再裸露原始 Markdown 标记

## 典型体验

你在飞书里做的事通常是这样的：

1. 先打开 `/ca`
2. 点击“项目列表”
3. 点进某个项目，再进入“线程列表”
4. 点击“切换到此线程”
5. 落到“当前会话已就绪”主卡后，直接继续发自然语言，让 Codex 在这个线程里接着干活

一个简化后的卡片大致会长这样：

```text
[当前会话已就绪]
项目：coding-anywhere
线程：README polish
状态：空闲

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

计划模式  [关]

按钮：切换线程 | 更多信息
```

用户看到的重点不是命令本身，而是“当前我在哪个项目 / 哪个线程里”“下一条消息会怎么跑”，以及“下一步我可以点什么”。

也就是说，命令更多是初始化和兜底入口，真正高频的浏览和切换动作已经尽量收敛到卡片按钮里了。

## 当前能力

- 支持 Feishu DM
- 支持已绑定项目群主时间线和已注册线程
- 支持卡片按钮导航、项目浏览、线程浏览、线程切换和群级项目绑定
- 支持 `/ca status` 结构化运行状态卡，以及当前 surface 的 `/ca stop`
- 支持“当前会话已就绪”稳定态主卡、只读诊断卡，以及 `计划模式 [开/关]` 单次开关
- 支持在 `/ca`、`/ca status`、`/ca session` 以及具体对话卡中展示当前生效的 `model` / `reasoning effort` / `speed`
- 支持在 `/ca session`、`/ca status` 和具体对话卡中通过下拉框切换当前线程 / 当前 surface 的 `model` / `reasoning effort` / `speed`
- 支持在 DM 中通过 `/ca project switch <projectKey>` 切到另一个 Codex 项目，并自动解除旧线程绑定
- DM 中的项目列表直接读取本机 Codex `state_*.sqlite`
- DM 中只记录“当前窗口绑定到哪个 Codex thread_id”，不镜像整份 Codex 项目目录
- 已注册线程可复用长期存在的 Codex 会话
- 支持文本 + 图片桥接；图片可暂存到下一条文本 run，也支持 assistant 回发原生飞书图片消息
- 运行中的流式状态卡本身也会带“停止任务”按钮
- assistant 的 Markdown 正文会优先以 JSON 2.0 Markdown 卡片发送；过大时回退为清洗后的纯文本
- 线程列表会按父线程分组展示子 agent，并显示 agent 名称、角色、父线程和层级
- 单个线程串行执行，多个线程可并发执行
- 线程内支持状态回推和最终结果回复
- 提供本地 Feishu live auth / live smoke 脚本，能用真实网页链路验证按钮卡和命令 smoke
- 提供 `/ops/runtime` 实时调度快照、`/ops/runs/:id/cancel` 取消接口，以及可直接取消 live run 的 `ops/ui`
- Windows 下额外提供 `start-coding-anywhere.cmd` / `stop-coding-anywhere.cmd` 一键启停脚本

## 适合谁

- 已经在用 Feishu 协作，但希望把 Codex 放进现有沟通流里的人
- 想把“继续刚才那个线程”这件事做得比终端切来切去更顺手的团队
- 更偏好点卡片按钮，而不是记忆长命令的人

## 快速开始

```bash
npm install
npm run init:config
npm run doctor
npm run start
```

Windows 上如果你更想用一键脚本，也可以直接运行：

```text
start-coding-anywhere.cmd
stop-coding-anywhere.cmd
```

飞书侧配置建议先看：[飞书配置说明](./docs/feishu-setup.md)。这份说明默认优先复用飞书官方的 OpenClaw 一键创建入口，再把生成好的应用凭据回填到本项目。

配置约定：

- 仓库只跟踪 `config.example.toml`
- 真实 `config.toml` 只保留在本地，不提交到 git
- 新环境先执行 `npm run init:config`，再按需填写本地 `config.toml`

`[codex]` 里除了 `command` 之外，还可以按需补充：

- `defaultModel`
- `defaultReasoningEffort`
- `defaultSpeed`
- `modelOptions`
- `reasoningEffortOptions`
- `speedOptions`

这样飞书里的“当前会话”“运行状态”和具体对话卡就能展示并提供更贴近你本机 Codex 环境的默认模型、推理与速度候选项。

启动前你至少需要准备好：

- 一个已配置长连接的 Feishu 应用
- 正确的 `appId`、`appSecret`
- `config.toml` 里的允许用户列表和 root 配置
- 本机可用的 Codex CLI 环境

补充说明：

- 首次启动时如果本地还没有 `data/bridge.db`，程序会自动创建 SQLite 数据库和所需表结构
- 仓库不会提交真实 `config.toml`，所以新环境仍然需要先执行 `npm run init:config` 并补齐配置，服务才会正常启动
- 如果你会跑真实飞书 live smoke，建议额外设置 `FEISHU_LIVE_PROJECT_KEY=coding-anywhere-autotest` 之类的专用测试项目；smoke 会先切到该项目，再发送测试指令

## 最小使用方式

虽然这个项目支持一组 `/ca` 命令，但对大多数使用场景来说，可以先这样用：

- 用 `/ca` 打开导航卡
- 用卡片按钮浏览项目和线程
- 如有需要，先在“当前会话已就绪”主卡里调整模型 / 推理 / 速度，或切一次 `计划模式 [开/关]`
- 用自然语言继续对当前线程提问
- 长任务跑起来后，用“运行状态”或“停止任务”按钮查看和控制当前 surface 的 live run

目前仍然更适合用命令完成的场景只有少数几类：

- 第一次绑定项目群
- 创建新的线程
- 查询少量底层状态

## 当前限制

- 还不能自动创建 Feishu 项目群，只能先绑定已有 `chatId`
- 需要自由输入标题或参数的动作，仍然要走命令入口
- DM 中的 Codex 项目/线程浏览依赖本机 `~/.codex/state_*.sqlite`
- 当前只支持文本 + 图片；通用文件、语音仍未接通
- 不支持多实例集群部署

## 运维入口

```text
http://127.0.0.1:3000/healthz
http://127.0.0.1:3000/readyz
http://127.0.0.1:3000/metrics
http://127.0.0.1:3000/ops/ui
http://127.0.0.1:3000/ops/overview
http://127.0.0.1:3000/ops/runtime
http://127.0.0.1:3000/ops/projects
```

说明：

- 上面是 `config.example.toml` 的默认端口；如果你在本地改过 `[server].port`，请按实际端口访问
- `/ops/ui` 现在采用“告警优先”布局：先看 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消`，再看次级历史和会话快照，并支持直接取消 live run
- `/ops/runtime` 会返回实时调度快照，适合脚本或排障时直接读取
- 连续流式文本不会为每个 chunk 单独落一条事件，而是按同阶段连续流合并

## 文档

- [项目总说明](./docs/project-full-overview.md)
- [飞书配置说明](./docs/feishu-setup.md)
- [故障排查手册](./docs/troubleshooting.md)
- [管理员部署手册](./docs/admin-deployment.md)

## 开源许可

本仓库使用 [MIT License](./LICENSE)。
