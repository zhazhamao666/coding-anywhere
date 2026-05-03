# 项目总览

最后修订：2026-05-04

这份文档只记录当前实现的主线事实、边界和验证入口。修订前的长文档已归档到 [项目总说明归档](./project-full-overview-archive-2026-05-03.md)，历史变更、过往细节和旧链路请到归档中查证。

## 1. 项目定位

`Coding Anywhere` 是一个单实例的飞书到 Codex 桥接服务。它把一个明确的飞书工作面(surface)映射到一个 Codex 原生线程(native thread)，再把运行状态、最终回复、图片/文件结果和运维观测带回飞书。

当前产品化工作面只有两类：

- 飞书 DM
- 已绑定项目的飞书群主时间线

当前不把飞书话题(topic)、群 `thread_id` 主题或历史话题绑定当成产品入口，也不把它们纳入真实飞书 UI 回归。除非先设计并确认专用夹具，否则不要新增 topic 类 live smoke 或手工真实联调。

## 2. 当前能力

核心能力：

- 飞书 DM 和已绑定项目群主时间线可以接收普通文本 prompt。
- 同一个飞书工作面会绑定到一个 Codex 原生 `thread_id`，后续消息续跑同一个 Codex 线程。
- 每次执行 prompt 都临时拉起 `codex exec --json` 或 `codex exec resume --json <thread_id>`，任务结束后 worker 退出。
- 同一个线程串行执行，不同线程可并发，全局并发受 `scheduler.maxConcurrentRuns` 控制。
- `/ca`、`/ca session`、`/ca status`、`/ca new`、`/ca stop` 和项目/会话命令提供飞书侧入口。
- 飞书卡片支持导航、会话切换、运行状态、计划模式单次开关、Codex 模型/推理/速度下拉设置。
- 图片和文件可以先暂存到当前工作面，下一条文本消息自动带入 Codex；图片继续通过 Codex CLI 图片参数输入，普通文件通过 `[bridge-attachments]` 元数据暴露本地路径。
- Markdown(`.md` / `.markdown`) 和 draw.io(`.drawio` / `.drawio.xml`) 会按语义类型标记给 Codex，便于读取、改写和回传源文件。
- assistant 可以通过受控 `[bridge-assets]` 指令回发本地图片和文件；旧 `[bridge-image]` 继续兼容。出站图片优先用飞书原生图片消息，超限或原生图片能力不可用时可降级为文件消息。
- 桌面 Codex 线程的生命周期可以通知到飞书，并通过“在飞书继续”接管到 DM 或已绑定项目群主时间线。
- `/ops/*` 提供项目、线程、run 和实时调度观测。
- Windows 本地提供 `start-coding-anywhere.cmd` 与 `stop-coding-anywhere.cmd` 一键启停。

一句话：当前系统是“飞书入口 + Codex 原生线程 + run 级 worker + 状态卡/图片文件结果回推 + 运维观测”的本地单实例桥接服务。

## 3. 主链路

飞书到 Codex：

```text
Feishu DM / Bound Group Main Timeline
  -> FeishuWsClient
  -> FeishuAdapter
  -> BridgeService
  -> RunWorkerManager
  -> CodexCliRunner
  -> codex exec / codex exec resume
  -> Codex
  -> BridgeService
  -> StreamingCardController / text / image / file reply
  -> Feishu API
```

后台观测：

```text
Browser / script
  -> Fastify /ops/*
  -> SessionStore
  -> SQLite
  -> RunWorkerManager live registry
```

运行不变量：

- 一个 CA 服务长期常驻。
- Codex 原生线程长期存在，是执行上下文真相源。
- run worker 是短生命周期进程。
- `sessionName` 和旧 `thread_bindings` 只保留兼容或观测意义，不再作为普通 prompt 的主路由真相源。
- 服务按单实例设计，不支持多实例集群部署。

术语口径：

- 工作面(surface)：飞书 DM 或已绑定项目群主时间线。
- 会话(session)：飞书用户看到的当前会话概念。
- Codex 原生线程(native thread)：实际续跑上下文，通常表现为 `thread_id`。
- run：一次 prompt 执行，对应一个短生命周期 `codex exec` / `codex exec resume` worker。

## 4. 主要模块

| 模块 | 职责 |
| --- | --- |
| `src/runtime.ts` | 装配配置、SQLite、Codex runner、bridge、飞书长连接、卡片回调和 `/ops/*`。 |
| `src/feishu-ws-client.ts` | 接入飞书长连接，归一化消息和卡片回调，并补充连接诊断日志。 |
| `src/feishu-adapter.ts` | 过滤和解析飞书消息，下载图片/文件，识别工作面，发送文本、图片、文件和卡片。 |
| `src/bridge-service.ts` | 业务编排核心：命令解析、surface 解析、线程绑定、run 编排、计划交互、资源指令和桌面接管。 |
| `src/run-worker-manager.ts` | 维护全局并发、线程级串行锁、排队任务和取消状态。 |
| `src/codex-cli-runner.ts` | 调用 Codex CLI，解析 JSONL 事件，归一化文本、工具、计划和子代理事件。 |
| `src/codex-sqlite-catalog.ts` | 只读发现 `~/.codex/state_*.sqlite` 与 rollout，生成 Codex 派生项目和线程列表。 |
| `src/workspace/session-store.ts` | SQLite 持久化项目、群绑定、线程绑定、run 观测、待处理图片/文件和计划交互。 |
| `src/feishu-card/*` | 构建 JSON 2.0 卡片、导航卡、状态卡、桌面生命周期卡和统一动作契约。 |
| `src/codex-desktop-*`、`src/desktop-completion-notifier.ts` | 观察桌面 Codex rollout，并把生命周期通知投递到飞书。 |

更细的模块历史说明见 [归档文档](./project-full-overview-archive-2026-05-03.md)。

## 5. 工作面与消息路由

### DM

DM 绑定当前以 Codex 原生线程为准：

```text
channel + peer_id -> codex_thread_id
```

DM 可以先选择项目，也可以直接切换到某个 Codex 原生线程。若还没有绑定线程，下一条普通 prompt 会在当前所选项目下创建新线程；若还没选项目，则回退到 root `cwd`。

执行 `/ca project switch <projectKey|name>` 时，如果当前窗口已经绑定旧线程，bridge 会先解除旧绑定，避免新项目消息继续跑进旧项目线程。

### 已绑定项目群主时间线

项目群主时间线通过 `project_chats` 记录“项目到群”的绑定，通过 `codex_chat_bindings` 记录“当前群对话到 Codex 原生线程”的绑定。

群消息能否进入服务首先取决于飞书后台权限：

- 只有群 @ 权限时，必须 `@机器人` 才会被推送。
- 若要不带 @ 的普通群消息也进入服务，需要申请并发布“获取群组中所有消息”相关权限。
- `feishu.requireGroupMention` 只控制本地过滤，不会扩大飞书实际推送范围。

### 历史话题链路

历史飞书话题和群 `thread_id` 主题记录可能仍在 SQLite 中，也有测试保护，但当前入口会拒绝把它们作为产品化 surface。`/ca thread create*` 这类会创建飞书主题的旧命令当前会返回“不支持创建飞书主题”。

### 图片/文件资源链路

图片和文件消息不会立即触发 Codex。当前流程是：

```text
Feishu image/file
  -> downloadMessageResource(type=image|file)
  -> pending_bridge_assets
  -> 轻量确认
  -> 下一条同 surface 文本消息
  -> codex exec/resume
```

消费规则：

- 图片资源会传给 Codex CLI 的图片输入参数，同时也出现在 `[bridge-attachments]` 元数据里。
- 普通文件不会传给图片参数，而是在 `[bridge-attachments]` 中提供 `file_name`、`local_path`、`mime_type`、`file_size`、`semantic_type` 等元数据。
- Markdown 和 draw.io 文件会分别标记为 `semantic_type=markdown`、`semantic_type=drawio`。
- `local_path` 是内部句柄，只给 Codex 使用；飞书进度卡、最终正文、错误和 caption 会脱敏为文件名。

待处理资源按同一个工作面隔离，并复用 `root.idleTtlHours` 做过期清理。维护任务会把过期/失败/已消费且超过 TTL 的本地资源文件从桥接资源根目录内安全删除。

assistant 回发资源时使用 `[bridge-assets]`：

```text
[bridge-assets]
{"assets":[
  {"kind":"image","path":".../result.png","caption":"结果图"},
  {"kind":"file","path":".../report.md","file_name":"report.md","presentation":"markdown_preview"},
  {"kind":"file","path":".../diagram.drawio","file_name":"diagram.drawio","presentation":"drawio_with_preview","preview":{"format":"png"}}
]}
[/bridge-assets]
```

出站路径边界：

- 普通 run：只允许当前 run 的 `[bridge-output-assets] root_path` 下的文件，或本轮已消费入站附件的 exact `local_path`。
- 桌面 completion：只允许该 completion 的专属输出根目录下的文件。
- 不再允许任意项目 `cwd` 或全局临时目录中的文件被最终回复直接外发。

当前 `presentation=markdown_preview` 与 `drawio_with_preview` 会作为语义元数据保留并随文件 reply 传递；已实现 `.md`、`.drawio` 源文件回传，自动渲染 Markdown 预览卡或 draw.io 预览图仍是后续增强。

## 6. `/ca` 入口

常用命令：

- 导航与会话：`/ca`、`/ca help`、`/ca hub`、`/ca session`
- 运行控制：`/ca status`、`/ca stop`、`/ca logs`
- 新会话：`/ca new`
- 项目：`/ca project list`、`/ca project current`、`/ca project switch <projectKey|name>`、`/ca project threads <projectKey|name>`、`/ca project bind <projectId> <chatId> <cwd> [name]`、`/ca project bind-current <projectId> <cwd> [name]`、`/ca project bind-current <projectKey|name>`
- 线程：`/ca thread list <projectId>`、`/ca thread list-current`、`/ca thread switch <threadId>`

上下文规则：

- `/ca` 和 `/ca session` 会按 surface 状态返回不同卡片：未选项目、已选项目但未绑线程、已绑定线程三种状态分开展示。
- 只有真正进入 Codex 原生线程后，稳定态会话卡才展示计划模式、下次任务设置、会话切换、更多信息和最近上下文。
- `/ca status` 优先展示当前 surface 的 live run；没有 live run 时展示空闲态上下文摘要。
- `/ca new` 只清理当前 surface 的线程绑定，不立刻调用 Codex；下一条普通 prompt 才创建新线程。
- `/ca stop` 只停止当前 surface 的排队或运行任务，不开放任意 `runId` 停止。
- `/ca logs` 当前只返回会话标识，不是完整日志查询入口。
- `/ca thread create*` 当前会返回“不支持创建飞书主题”，不是可用创建入口。
- 模型(model)、推理强度(reasoning effort)和速度(speed)设置按“当前线程优先、当前 surface 兜底、系统默认回退”生效。
- 计划模式是 surface 级单次开关，下一条普通文本会被包装为 `/plan ...`，消费一次后自动恢复为关。

## 7. 数据与配置

当前 `config.toml` 支持：

- `[server]`
- `[storage]`
- `[codex]`
- `[scheduler]`
- `[feishu]`
- `[root]`

仓库只提交 `config.example.toml`。新环境先执行 `npm run init:config`，再填写本地 `config.toml`。旧 `[acpx]` 只作为兼容入口读取并归一化到 `config.codex.command`，不代表当前运行模型。

说明：`scheduler.maxConcurrentRuns` 有代码默认值；`config.example.toml` 不一定显式写出 `[scheduler]`。

关键配置：

- `scheduler.maxConcurrentRuns`：全局同时运行 worker 数。
- `codex.defaultModel`、`codex.defaultReasoningEffort`、`codex.defaultSpeed`：飞书侧设置的默认回退值。
- `codex.modelOptions`、`codex.reasoningEffortOptions`、`codex.speedOptions`：飞书卡片下拉候选项。
- `feishu.allowlist`：按 `open_id` 控制用户白名单；缺省或空数组表示不启用。
- `feishu.requireGroupMention`：群主时间线本地 mention 过滤。
- `feishu.desktopOwnerOpenId`：桌面通知无法路由到项目群时的 DM fallback 用户。
- `feishu.encryptKey`：飞书加密推送解密密钥。
- `feishu.reconnectCount`、`feishu.reconnectIntervalSeconds`、`feishu.reconnectNonceSeconds`：长连接重连控制。
- `root.idleTtlHours`：线程空闲回收、待处理图片/文件过期和桥接资源文件清理共用 TTL。

更多飞书后台配置见 [飞书配置说明](./feishu-setup.md)，部署视角见 [管理员部署手册](./admin-deployment.md)。

## 8. 持久化模型

主要 SQLite 表：

- `projects`：CA 视角项目。
- `project_chats`：项目绑定到飞书群。
- `codex_window_bindings`：DM 窗口绑定到 Codex 原生线程。
- `codex_chat_bindings`：群主时间线绑定到 Codex 原生线程。
- `codex_threads`：飞书 surface 到 Codex 原生线程的兼容绑定记录。
- `codex_thread_watch_state`：桌面 rollout 观察 offset 和去重状态。
- `codex_thread_desktop_notification_state`：桌面生命周期卡状态和冻结路由。
- `pending_bridge_assets`：待消费图片/文件资源，以及资源消费、失败、过期状态。
- `pending_plan_interactions`：待回答计划选择题。
- `observability_runs`、`observability_run_events`：run 级观测与阶段时间线。

实时调度态不落 SQLite，由 `RunWorkerManager` 内存维护，包括 `activeRuns`、`queuedRuns`、`locks` 和 `cancelingCount`。`/ops/runtime` 读取实时态，`/ops/overview` 组合实时态和历史统计。

runtime 启动时会把上次异常退出后残留的非终态 run 统一收口为 `error`，避免后台长期挂着僵尸运行态。

## 9. 运维入口

当前 `/ops/*` 支持：

- `/healthz`
- `/readyz`
- `/metrics`
- `/ops/overview`
- `/ops/runtime`
- `/ops/runs`
- `/ops/runs/:id`
- `/ops/runs/:id/cancel`
- `/ops/sessions`
- `/ops/projects`
- `/ops/projects/:id/threads`
- `/ops/threads/:id`
- `/ops/threads/:id/runs`
- `/ops/ui`

`/ops/ui` 以告警和队列优先：活跃任务、排队任务、取消中、最近失败、最近取消优先展示，历史任务和会话快照降为次级。项目和线程的细粒度管理目前主要仍通过 JSON 接口完成。

## 10. 验证路径

基础本地验证：

1. `npm run doctor`
2. `npm run build`
3. `npm run test`
4. Windows 本地可双击 `start-coding-anywhere.cmd` 启动，双击 `stop-coding-anywhere.cmd` 停止。

真实飞书验证必须遵守测试夹具边界：

- 只允许使用 `coding-anywhere-autotest`。
- DM 验证前先执行 `/ca project switch coding-anywhere-autotest` 或 `/ca project current`，确认当前项目正确。
- 群验证前先确认群名是 `coding-anywhere-autotest`，再执行 `/ca project current`，确认当前群绑定到该项目。
- 真实 UI 回归只覆盖 DM 和已绑定项目群主时间线；不覆盖 topic、话题、群 `thread_id` 主题或 handoff 伪场景。
- 不满足夹具条件时停止真实联调，优先改用 mock、单测或补专用 smoke。
- 除非用户明确要求并再次确认，真实联调中不要自动绑定或解绑非测试群。
- `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1` 是危险开关，不属于常规验证路径。

现有 live smoke：

- `npm run test:feishu:auth`
- `npm run test:feishu:live` 或 `npm run test:feishu:live:dm`
- `npm run test:feishu:live:group`
- `npm run test:feishu:live:dm:ui`
- `npm run test:feishu:live:group:ui`
- `node scripts/feishu-live.mjs dm bridge-assets`
- `node scripts/feishu-live.mjs group bridge-assets`

`bridge-assets` 场景覆盖：上传 Markdown 附件给 Codex 读取、Codex 生成 PNG / `.md` / `.drawio` 文件、通过 `[bridge-assets]` 回传到飞书，并使用动态 run 后缀避免历史消息误判。

真实 Codex CLI 验证默认显式 opt-in：

- `npm run -s test -- tests/codex-real-smoke.test.ts`，需要 `TEST_CODEX_REAL=1`
- `npm run -s test -- tests/codex-real-resume.test.ts`，需要 `TEST_CODEX_RESUME=1`

常规回归测试已覆盖 Codex JSONL 解析、桥接计划模式、卡片回调、图片/文件资源链路、Markdown/draw.io 语义识别、出站路径脱敏与边界、桌面 lifecycle 通知、ops、Windows 启停脚本和飞书 live smoke 配置守卫。详细测试清单可查归档文档或 `tests/` 目录。

## 11. 当前限制

- 没有完整 DM Hub。
- 不能自动创建飞书项目群，只能绑定已有群。
- 不提供飞书 topic / 话题 / 群 `thread_id` 主题的产品化入口或真实 UI 回归。
- `/ops/ui` 仍主要服务 run 控制、告警排查和历史详情，不是完整项目/线程管理后台。
- 飞书卡片按钮不是通用任意参数表单平台。
- 普通对话 run 的终态投递固定为“终态卡 + 完整正文消息”。
- 当前“计划模式”是 bridge 基于 `codex exec` / `codex exec resume` 拼出的飞书侧工作流，不等同于官方交互式 CLI 原语。
- 桌面 lifecycle 通知已支持 DM / group continue 接管，但 history/mute 回调和失败后自动修复还未接通。
- 当前支持文本、图片和普通文件；语音未接通。
- `.md` 与 `.drawio` 支持源文件传输和语义标记；自动 Markdown 预览卡、draw.io PNG/SVG/PDF 渲染预览仍是后续增强。
- outbound 资源路径必须位于当前 run/desktop completion 专属输出目录，或是本轮已消费入站附件的 exact `local_path`；不允许直接外发任意项目 `cwd` 文件。
- 真实飞书网页登录 smoke 依赖首次人工登录和持久 profile；SSO、验证码或二次验证仍需要人工介入。
- 不支持多实例集群部署。

## 12. 相关文档

- [飞书配置说明](./feishu-setup.md)：飞书应用、事件、卡片回调、权限和图片/文件能力配置。
- [管理员部署手册](./admin-deployment.md)：部署、升级、回滚、Windows 运行和管理员检查清单。
- [故障排查手册](./troubleshooting.md)：常见飞书、运行、回调、Codex 和路由问题。
- [版本发布与变更记录规范](./release-and-changelog.md)：发布节奏、CHANGELOG 和验证证据要求。
- [项目总说明归档](./project-full-overview-archive-2026-05-03.md)：2026-05-03 精简前的长文档，用于历史溯源。
