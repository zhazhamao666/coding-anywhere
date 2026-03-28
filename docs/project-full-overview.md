# 项目总说明

## 1. 项目定位

`Coding Anywhere` 是一个把飞书消息桥接到 Codex 的单实例后端服务。

当前实现已经不再只面向“飞书私聊”，而是同时覆盖两类工作面：

- 飞书 DM
- 飞书群里的原生话题线程

它的目标不是做一个通用聊天机器人平台，而是把飞书中的一个明确上下文，稳定映射到一个 Codex 会话，并把运行状态、最终结果和后台观测一起带回来。

## 2. 当前目标

### 2.1 核心目标

当前版本重点解决这些问题：

- 用户可以在飞书里直接给 Codex 下达任务
- 长任务有实时状态，不是黑盒
- 同一个飞书线程可以复用长期存在的 Codex 会话
- 多个线程可以并行跑，但同一线程内不会并发污染上下文
- 后台可以从 run、thread、project 三层观察系统状态

### 2.2 已落地能力

当前代码已经实现：

1. 飞书 DM 文本消息接入
2. 飞书群话题线程文本消息接入
3. `/ca` 命令与普通 prompt 分流
4. DM 级会话绑定
5. 线程级 Codex 会话解析
6. 基于 `acpx` 的短生命周期 run worker
7. 全局并发限制与线程级串行执行
8. 线程级 run 投递目标持久化
9. 线程内回复式回推
10. 线程空闲 TTL 回收
11. SQLite 持久化项目、项目群、线程、run、事件
12. `/ops/*` 后台观测接口
13. 通过 `/ca project bind` 注册现有项目群
14. 通过 `/ca thread create` 创建线程记录并发起飞书话题
15. 在群主时间线通过 `/ca project bind-current` 直接绑定当前群
16. 在已绑定项目群中通过 `/ca thread create-current` 和 `/ca thread list-current` 直接操作当前项目线程
17. 在群主时间线通过 `/ca project current` 查询当前群绑定到哪个项目
18. 通过 `/ca` 返回导航卡，集中展示当前上下文、项目概览、线程摘要和按钮化操作入口；`/ca hub` 继续兼容到同一张卡
19. DM 中的 `project list` 现在会直接读取 Codex `state_*.sqlite`，返回 Codex 派生项目列表卡片，而不是依赖 CA 本地项目清单
20. DM 中可以从 Codex 项目列表进入线程列表，再把“当前这个飞书聊天窗口”切换到某个 Codex 原生线程
21. DM 中被选中的 Codex 线程只会持久化“当前窗口绑定到哪个 thread_id”，不会在 CA SQLite 里镜像维护 Codex 项目/线程清单
22. 通过 `project current` 和线程创建成功回执返回结构化摘要卡片
23. 通过 `/ca help` 和未知子命令回退到导航卡
24. 通过飞书卡片按钮回调复用 `/ca` 导航命令，并原地刷新卡片
25. DM 中带按钮的导航型卡片通过普通 `interactive` 消息发送，不再依赖 CardKit/cardId 回写
26. 按钮点击后会在飞书长连接回调里直接返回新版 `card.action.trigger` 标准响应体，而不是同步调用消息 patch 或 CardKit 更新接口
27. 结构化导航卡和列表卡会维持 JSON 2.0 结构，并通过官方 `raw card` 回调响应即时刷新
28. `project list` 与 `thread list*` 在空结果时也会返回结构化卡片，而不是退回纯文本系统提示
29. 导航卡、项目列表卡、线程列表卡、当前项目卡等会使用各自的卡片标题，不再统一显示为 `CA Hub`
30. Windows CLI 入口会在启动时主动把控制台代码页切到 UTF-8，降低 PowerShell 中中文日志乱码的概率
31. `npm run dev` 与 `npm run start` 会在 Windows 启动前主动清理当前项目残留的 `node`/`npm`/`cmd` 进程，以及配置端口上的旧监听，降低 `EADDRINUSE` 启动失败概率
32. `npm run dev` 与 `npm run start` 维持前台子进程模型，并显式转发 `SIGINT` / `SIGTERM`，便于在当前终端 `Ctrl+C` 或关闭窗口时一起退出
33. 飞书 SDK 传入的数组形态日志会先归一化成单条字符串，再交给项目日志器输出，减少控制台中出现 JSON 数组样式的日志
34. DM 里切到 Codex 原生线程后，普通消息不再走 `acpx sessions ensure + prompt`，而是走 `codex exec resume <thread_id> --json`

### 2.3 当前仍未打通的部分

当前还没有做成完整用户产品流的部分：

- 从 DM 直接创建项目群和线程的交互入口
- 自动创建飞书项目群本身
- 精准跳转到指定 `thread_id` 的客户端导航能力
- 完整的线程级前端管理页面
- 在项目群 / 飞书线程里切换到任意 Codex 原生线程的能力（已记录为后续方案 3，当前故意不做）

也就是说，群线程运行链路已经具备，并且现在可以用命令注册项目群和创建线程，但还没有做成完整的飞书导航型产品界面。

## 3. 高层架构

当前主链路可以简化为：

```text
Feishu DM / Group Thread
  -> FeishuWsClient
  -> FeishuAdapter
  -> BridgeService
  -> RunWorkerManager
  -> AcpxRunner / Codex native resume path
  -> acpx prompt worker or codex exec resume worker
  -> Codex
  -> BridgeService
  -> StreamingCardController / text reply
  -> Feishu API
  -> 飞书状态更新 + 最终结果回推
```

后台观测链路为：

```text
Browser / script
  -> Fastify /ops/*
  -> SessionStore
  -> SQLite
```

## 4. 运行模型

### 4.1 三层对象

当前实现里要明确区分三类对象：

- `CA 进程`
  - 单实例、长期常驻
- `Codex 会话`
  - 长期存在
  - DM 对应一个 session
  - 已注册的飞书线程对应一个 session
  - DM 也可以临时切到一个已有的 Codex 原生线程
- `Run Worker`
  - 每次执行 prompt 时临时拉起一个 `acpx prompt`
  - 任务结束后退出

### 4.2 会话和 worker 的关系

可以理解为：

```text
1 个 CA 服务
  -> N 个长期存在的 session
  -> M 个短生命周期 worker
```

其中：

- `N` 约等于当前活跃 DM 或飞书线程数
- `M` 约等于当前并发运行中的任务数
- 并且 `M` 受 `scheduler.maxConcurrentRuns` 控制

## 5. 模块职责

### 5.1 `src/runtime.ts`

运行时装配中心。

职责：

- 初始化 `SessionStore`
- 初始化 `AcpxRunner`
- 初始化 `RunWorkerManager`
- 初始化 `BridgeService`
- 初始化 `CodexSqliteCatalog`
- 初始化飞书 API client 和 WS client
- 装配飞书长连接上的卡片按钮回调分发
- 由 `FeishuWsClient` 直接归一化 `card.action.trigger` 长连接 payload，并把按钮动作交给 `FeishuCardActionService`
- 装配 `/ops/*`
- 启动线程空闲回收定时器

### 5.1.1 `src/windows-console.ts`

Windows 控制台编码初始化模块。

职责：

- 在 Windows 环境下把控制台代码页切到 `65001`
- 将 `stdout` / `stderr` 默认编码设置为 `utf8`
- 供 `index.ts`、`doctor-cli.ts`、`init-config.ts` 这类 CLI 入口复用，减少 PowerShell 中中文日志乱码

### 5.1.2 `scripts/startup-cleanup.mjs`

Windows 启动前清理模块。

职责：

- 读取 `config.toml` 中的服务端口
- 启动前扫描当前工作区相关的 `node` / `npm` / `cmd` 进程
- 额外扫描目标端口上的监听进程
- 在 `npm run dev` 与 `npm run start` 启动前做 best-effort 清理，减少残留进程导致的端口占用
- 在 Windows 下会先切换当前控制台到 UTF-8，再以前台方式拉起子进程
- 在收到终止信号时向子进程透传

### 5.2 `src/feishu-adapter.ts`

飞书消息适配层。

职责：

- 用户 allowlist 校验
- 文本消息过滤
- DM 与群线程 surface 识别
- mention-only fallback 过滤
- 创建状态卡控制器
- 将 CA 输出转成飞书消息、卡片或线程回复
- 发送导航类按钮卡片时统一使用普通 `interactive` 消息卡片
- 保留 CardKit 仅用于流式进度卡，不再把导航卡混入 CardKit/cardId 回写链路

### 5.3 `src/bridge-service.ts`

业务编排核心。

职责：

- `/ca` 命令解析
- surface 解析
- DM 绑定或线程绑定的 session 解析
- DM 中读取 Codex `state_*.sqlite` 的项目/线程目录
- DM 中把当前窗口切换到选中的 Codex thread_id
- 生成 `/ca` 导航卡内容
- 为导航卡按钮编码回放命令上下文
- root 上下文封装
- run 生命周期组织
- 线程状态更新
- 观测数据写入

### 5.4 `src/feishu-card-action-service.ts`

飞书卡片按钮回调编排层。

职责：

- 接收飞书按钮回调事件
- 从 `action.value` 中恢复 `/ca` 命令和上下文
- 将回调重放给 `BridgeService`
- 将文本结果包装成提示卡，或直接返回新的导航/摘要卡
- 对即时导航场景返回新版 `card.action.trigger` 规范要求的 `raw card` 响应体
- 不在即时导航回调里同步调用 `updateInteractiveCard` / `updateCardKitCard`，避免与官方立即更新模型冲突
- 当命令返回的是系统文本时，会构造带有明确标题的结果卡，而不是统一套用 `CA Hub` 头部

### 5.5 `src/run-worker-manager.ts`

run 调度层。

职责：

- 控制全局并发上限
- 对同一线程或同一 DM 上下文做串行执行

### 5.6 `src/acpx-runner.ts`

Codex 适配层。

职责：

- `sessions ensure`
- `prompt`
- `cancel`
- `close`
- 解析 `acpx` 事件流
- 对 DM 中已选中的 Codex 原生线程，改为通过 `codex exec resume --json` 执行并解析 JSONL 事件流

### 5.6.1 `src/codex-sqlite-catalog.ts`

Codex 本地线程目录读取层。

职责：

- 自动发现 `~/.codex/state_*.sqlite`
- 只读打开 Codex SQLite
- 按 `cwd` 归并出派生项目列表
- 提供线程列表和线程按 `thread_id` 查询
- 线程标题优先取 `session_index.jsonl` 中最新的 `thread_name`，以尽量和 Codex App 显示保持一致；取不到时再回退到 SQLite `threads.title`
- 当 `state_*.sqlite` 还没追上最新线程时，会继续读取 `session_index.jsonl` 与 `sessions/**/rollout-*.jsonl` 里的 `session_meta`，补齐最近创建但尚未落进 SQLite 的线程
- 不在 CA 本地复制保存 Codex 项目/线程清单

### 5.7 `src/project-thread-service.ts`

项目线程创建服务。

职责：

- 在项目群中发根消息
- 获取飞书返回的 `message_id` / `thread_id`
- 创建 `codex_threads` 记录

注意：

- 这个服务已经存在
- 当前已经通过 `/ca thread create` 暴露成可触发入口
- 但还没有自动建群或图形化创建流

### 5.8 `src/feishu-card/streaming-card-controller.ts`

飞书侧状态承载器。

职责：

- DM 流式状态优先使用 CardKit，失败时回退到普通 interactive card
- 线程场景优先通过回复消息在原话题内承载状态
- 终态时收口卡片或直接回复错误

### 5.9 `src/workspace/session-store.ts`

SQLite 持久化层。

当前负责：

- root 配置
- DM thread binding
- DM Codex 原生线程绑定
- projects
- project_chats
- codex_threads
- observability_runs
- observability_run_events
- `/ops/*` 查询

另外：

- 启动迁移时会把旧版遗留表 `workspaces`、`users`、`acp_sessions`、`runs`、`message_links`、`event_offsets` 清理掉
- 如果数据库里仍只有旧版 `workspaces` 根配置而没有 `bridge_root`，会先把旧根信息迁入 `bridge_root` 再删除旧表

## 6. 路由与消息流

## 6.1 DM 普通消息

```text
Feishu DM text
  -> FeishuAdapter
  -> BridgeService
  -> getBinding(channel, peerId)
  -> 解析 session
  -> submit to Codex
  -> 状态卡更新
  -> 最终文本回写 DM
```

DM 仍然沿用：

```text
channel + peerId -> session
```

但现在 DM 还新增了一条“Codex 原生线程绑定”分支：

```text
channel + peerId -> codex_thread_id
```

命中这条绑定时：

- 项目与线程信息来自 Codex `state_*.sqlite`
- 普通消息直接续跑该 Codex 原生线程
- 不会在 CA SQLite 中维护一份镜像项目/线程清单

## 6.2 群线程普通消息

```text
Feishu group thread text
  -> FeishuAdapter
  -> (chat_id, thread_id)
  -> BridgeService.resolveContext
  -> SessionStore.getCodexThreadBySurface(chat_id, thread_id)
  -> project cwd + thread session
  -> submit to Codex
  -> 在线程中回复状态 / 结果
```

线程场景使用：

```text
(channel, chat_id, surface_type=thread, surface_ref=thread_id)
```

来解析上下文。

## 6.3 群主时间线

当前实现不会把普通群主时间线消息直接送入 Codex。

只有满足下面条件时才会进入 Codex：

- 是群消息
- 是原生话题线程内消息
- 能解析出 `chat_id + thread_id`
- 该线程已经在本地 SQLite 注册
- 若开启 `feishu.requireGroupMention`，则消息内容中还必须带 mention

## 6.4 `/ca` 命令

当前命令仍然统一支持：

- `/ca`
- `/ca help`
- `/ca status`
- `/ca hub`（兼容别名）
- `/ca new`
- `/ca stop`
- `/ca session`
- `/ca logs`
- `/ca project bind <projectId> <chatId> <cwd> [name]`
- `/ca project bind-current <projectId> <cwd> [name]`
- `/ca project current`
- `/ca project list`
- `/ca thread create <projectId> <title...>`
- `/ca thread create-current <title...>`
- `/ca thread list <projectId>`
- `/ca thread list-current`

其中，下面两个命令在 DM 和群线程中的语义已经不同：

- DM 中 `/ca project list`
  - 读取 Codex `state_*.sqlite`
  - 展示 Codex 派生项目列表
- 群聊 / 已注册线程中的 `/ca project list`
- 仍然展示 CA 本地注册的项目列表

这些命令现在既可以在 DM 中用，也可以在线程中用。

其中：

- DM 中 `/ca new` 会重绑该 DM 的 session
- 线程中 `/ca new` 会重置该线程记录上的 sessionName
- `/ca` 会按上下文返回不同内容，`/ca hub` 复用同一条路径：
  - DM（未切到 Codex 原生线程）：root、当前 session、Codex 项目概览
  - DM（已切到 Codex 原生线程）：当前项目路径、当前线程、当前 thread_id
  - 已绑定项目群：当前项目信息、最近线程摘要和项目级按钮入口
  - 已注册线程：当前线程信息、同项目线程摘要和线程级按钮入口
- `/ca` 的按钮会按上下文变化：
  - DM：`导航`、`会话状态`、`当前会话`、`新会话`、`项目列表`
  - 已切到 Codex 原生线程的 DM：`导航`、`项目列表`、`当前项目`、`线程列表`、`当前会话`、`新会话`
  - 已绑定项目群：`导航`、`当前项目`、`线程列表`、`项目列表`
  - 已注册线程：`导航`、`当前项目`、`线程列表`、`当前会话`、`新会话`、`停止`
- `/ca help` 与未知 `/ca` 子命令会复用同一张导航卡
- `/ca project list` 会返回项目列表卡片
- `/ca project current` 会返回当前项目摘要卡片
- `/ca thread list <projectId>` 与 `/ca thread list-current` 会返回线程列表卡片
- `/ca thread create*` 成功后会返回线程摘要卡片
- DM 中的项目列表卡和线程列表卡现在带“查看线程”“切换到此线程”行级按钮
- DM 中点选线程后，CA 只记录当前窗口绑定到哪个 `codex_thread_id`
- 导航卡、列表卡和摘要卡上的按钮会通过飞书长连接回调重放无参 `/ca` 命令
- 长连接卡片回调会在本地先归一化成统一动作结构，再交给 `BridgeService` 生成新的卡片结果
- 按钮回调对导航场景直接返回新版 `card.action.trigger` 的 `raw card` 响应体
- 即时导航不再额外调用消息 patch 或 CardKit 更新接口
- 飞书卡片 JSON 2.0 导航卡不再使用旧版 `{\"tag\":\"action\"}` 容器；按钮区域改为 `column_set` 中嵌套 `button`

## 7. 线程级会话与 run 级 worker

## 7.1 会话策略

当前采用：

- 一个已注册飞书线程，对应一个长期存在的 Codex session
- 同一个线程后续消息继续复用该 session
- DM 也可以临时切到一个已有的 Codex 原生线程；此时后续消息直接续跑该线程，不会新建 CA 项目/线程记录

sessionName 的典型形式：

```text
codex-{projectId}-{threadId}
```

## 7.2 run 策略

每次 prompt 执行都拉起一个新的 `acpx prompt` worker。

特点：

- worker 是短生命周期
- 线程 session 是长期存在
- 这样既能保留上下文，又不会让一个 worker 常驻不退
- 对 DM 中已选择的 Codex 原生线程，worker 改为 `codex exec resume --json`

## 7.3 并发策略

当前策略是：

- 同一个线程只允许一个活跃 run
- 不同线程之间允许并发
- 全局并发上限由 `scheduler.maxConcurrentRuns` 控制

## 8. 线程状态机

当前数据模型支持这些线程状态：

- `provisioned`
- `warm`
- `running`
- `idle`
- `closed`
- `archived`

目前实际已接通的状态迁移重点是：

- 创建线程后：`provisioned`
- 真正执行时：`running`
- 执行完成或失败后：`warm`
- TTL 回收后：`closed`

## 9. 空闲回收

当前 runtime 已接入线程空闲回收：

- 周期性扫描 `warm` 状态线程
- 如果超过 `root.idleTtlHours` 没有活动
- 调用 `acpx sessions close`
- 将线程状态置为 `closed`

线程再次收到消息时，会重新 `ensureSession`，继续使用同一个线程记录。

## 10. 数据模型

## 10.1 Root

当前仍然只有一个 root。

字段包括：

- `id`
- `name`
- `cwd`
- `repoRoot`
- `branchPolicy`
- `permissionMode`
- `envAllowlist`
- `idleTtlHours`

## 10.2 DM 绑定

`thread_bindings` 继续承载：

```text
channel + peer_id -> session_name
```

它只用于 DM。

## 10.2.1 DM Codex 原生线程绑定

`codex_window_bindings` 承载：

```text
channel + peer_id -> codex_thread_id
```

它只在 DM 中使用，用于记录“当前这个飞书聊天窗口已经切到哪个 Codex 原生线程”。

这不是 Codex 项目/线程清单的镜像，只是当前窗口的选择状态。

## 10.3 项目与线程

当前 SQLite 已新增：

- `projects`
- `project_chats`
- `codex_threads`

其中：

- `projects` 表示 CA 视角下的项目
- `project_chats` 表示一个项目对应的飞书项目群
- `codex_threads` 表示一个飞书话题和一个 Codex 线程的一一映射

## 10.4 Run 观测

`observability_runs` 当前已扩展为同时记录：

- `project_id`
- `thread_id`
- `delivery_chat_id`
- `delivery_surface_type`
- `delivery_surface_ref`

因此后台已经不再只是“看 session”，而是能看到这条 run 属于哪个项目、哪个线程、最终该投递回哪里。

另外，`observability_run_events` 的写入策略已经做了收敛：

- 生命周期、工具调用、终态仍按阶段保留事件
- 连续的流式 `text` / `waiting` 更新会按“相邻同阶段事件”合并
- 因此 `/ops/ui` 和 `/ops/runs/:id` 看到的是更可读的阶段时间线，而不是每个 chunk 一条记录

## 11. 配置结构

当前 `config.toml` 主要包含：

- `[server]`
- `[storage]`
- `[acpx]`
- `[scheduler]`
- `[feishu]`
- `[root]`

飞书应用初始化、长连接配置以及 `config.toml` 的字段映射，可参考 [飞书配置说明](./feishu-setup.md)。

### 11.1 新增配置

本轮新增的关键字段有：

- `scheduler.maxConcurrentRuns`
  - 控制全局同时运行的 worker 数
- `feishu.requireGroupMention`
  - 群线程兜底模式
  - 为 `true` 时，只有带 mention 的线程消息才会进入 Codex
- `feishu.encryptKey`
  - 飞书长连接消息或回调启用加密推送时使用的解密密钥

### 11.2 TTL

当前线程回收仍复用 `root.idleTtlHours`。

也就是说：

- 它既是 root 侧的空闲 TTL
- 目前也被线程回收逻辑用作线程 session TTL

## 12. 后台观测与运维接口

当前 `/ops/*` 已支持：

- `/ops/overview`
- `/ops/runs`
- `/ops/runs/:id`
- `/ops/sessions`
- `/ops/projects`
- `/ops/projects/:id/threads`
- `/ops/threads/:id`
- `/ops/threads/:id/runs`
- `/ops/ui`

说明：

- `/ops/ui` 当前仍以 run 视角为主
- 项目与线程的新视图目前主要通过 JSON 接口提供

## 13. 用户可感知的行为变化

相对于早期“只有 DM”的版本，当前实现已经有这些实际变化：

- 已注册群线程中的消息可以直接进入 Codex
- 线程结果不再回 DM，而是在线程里回复
- 可以对线程使用 `/ca new`
- 可以直接从飞书命令注册现有项目群并创建线程
- 可以在已绑定项目群里直接创建线程和查看当前项目线程列表
- 可以在群主时间线快速确认当前项目绑定
- 可以通过导航卡查看当前上下文、项目概览和线程摘要
- 可以通过结构化列表卡快速浏览项目和线程
- 可以通过摘要卡快速确认当前项目和新建线程结果
- 输入未知子命令时也能自动回到导航卡
- 可以在群主时间线里直接绑定当前群，而不用手工输入 `chatId`
- 可以直接点击卡片按钮回到导航、当前项目和线程列表，而不用重新手输命令
- 按钮回调通过同一条飞书长连接返回，不需要额外暴露公网回调地址
- 相同线程不会并发执行两个 run
- 后台可以看项目、线程和线程对应 run

## 14. 当前限制

当前仍有这些限制：

- 没有完整 DM Hub
- 还不能自动创建飞书项目群，只能先绑定已有 `chatId`
- CA 不提供精确跳转到指定飞书话题的能力
- 卡片按钮目前只覆盖无参导航命令，不覆盖带自由文本参数的创建类命令
- 不直接向 `thread_id` 发普通消息，线程回推统一通过回复消息完成
- 只支持文本，不支持图片、文件、语音
- 不支持多实例集群部署

## 15. 推荐验证路径

### 15.1 基础回归

1. `npm run doctor`
2. `npm run start`
3. 飞书 DM 发 `/ca`
4. 点击导航卡按钮验证回调
5. 飞书 DM 发 `/ca status`
6. 飞书 DM 发 `test`
7. 打开 `/ops/ui`

### 15.2 群线程回归

前提有两种：

- 数据库中已经存在对应的 `project_chats` 和 `codex_threads` 记录
- 或者先通过 `/ca project bind` 和 `/ca thread create` 完成注册
- 或者在群主时间线直接执行 `/ca project bind-current`
- 或者在已绑定项目群主时间线直接执行 `/ca thread create-current`

1. 在已注册的飞书话题里发普通文本
2. 若开启 `feishu.requireGroupMention`，则带上 mention
3. 观察线程内状态更新与最终结果
4. 检查 `/ops/projects`、`/ops/projects/:id/threads`、`/ops/threads/:id/runs`

### 15.3 TTL 回归

1. 准备一个 `warm` 状态线程
2. 等待超过 `root.idleTtlHours`
3. 观察线程是否被关闭并进入 `closed`

## 16. 一句话总结

这个项目现在已经从“飞书私聊直连 Codex”演进到：

**一个支持 DM 和群话题线程、具备线程级会话、run 级 worker、线程内回推和项目/线程/run 三层观测的单实例桥接服务。**
