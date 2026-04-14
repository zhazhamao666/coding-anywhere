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
5. 基于 native `thread_id` 的 DM / 群线程执行解析
6. 基于 Codex CLI `exec` / `exec resume` 的短生命周期 run worker
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
20. DM 中可以从 Codex 项目列表进入线程列表，也可以先把“当前这个飞书聊天窗口”切到某个 Codex 项目，再决定是否查看线程或创建新会话
21. DM 中也可以把“当前这个飞书聊天窗口”切换到某个 Codex 原生线程
22. DM 中未绑定窗口首次收到普通 prompt 时，会优先在当前所选项目路径下创建新的 native Codex thread；如果还没选项目，则回退到 root 路径，再把当前窗口绑定到该 `thread_id`
23. 通过 `project current` 和线程创建成功回执返回结构化摘要卡片
24. 通过 `/ca help` 和未知子命令回退到导航卡
25. 通过飞书卡片按钮回调复用 `/ca` 导航命令，并原地刷新卡片
26. DM 中带按钮的导航型卡片通过普通 `interactive` 消息发送，不再依赖 CardKit/cardId 回写
27. 按钮点击后会在飞书长连接回调里直接返回新版 `card.action.trigger` 标准响应体，而不是同步调用消息 patch 或 CardKit 更新接口
28. 结构化导航卡和列表卡会维持 JSON 2.0 结构，并通过官方 `raw card` 回调响应即时刷新
29. `project list` 与 `thread list*` 在空结果时也会返回结构化卡片，而不是退回纯文本系统提示
30. 导航卡、项目列表卡、线程列表卡、当前项目卡等会使用各自的卡片标题，不再统一显示为 `CA Hub`
31. Windows CLI 入口会在启动时主动把控制台代码页切到 UTF-8，降低 PowerShell 中中文日志乱码的概率
32. `npm run dev` 与 `npm run start` 会在 Windows 启动前主动清理当前项目残留的 `node`/`npm`/`cmd` 进程，以及配置端口上的旧监听，降低 `EADDRINUSE` 启动失败概率
33. `npm run dev` 与 `npm run start` 维持前台子进程模型，并显式转发 `SIGINT` / `SIGTERM`，便于在当前终端 `Ctrl+C` 或关闭窗口时一起退出
34. 飞书 SDK 传入的数组形态日志会先归一化成单条字符串，再交给项目日志器输出，减少控制台中出现 JSON 数组样式的日志
35. 普通消息不再走 `acpx sessions ensure + prompt`；所有执行面统一改为 `codex exec --json` 创建线程或 `codex exec resume --json <thread_id>` 续跑线程
36. DM 中切换到某个 Codex 原生线程后，切换成功卡片会附带“最后 1 条 user 消息 + 最后 4 条 assistant 消息”的原文预览，便于快速恢复上下文
37. 长任务在飞书中的终态展示调整为“摘要卡 + 完整正文消息”：状态卡收口时只保留终态摘要与“查看下方消息”的提示，完整 assistant 正文仍单独作为普通消息 / 线程回复发送，避免同一份结果在卡片和消息中重复完整展示
38. `/ca new` 不再重置 CA session，而是创建并切换到新的 native Codex thread
39. `/ca stop` 对 native thread 明确返回不可用，而不是继续假装映射到 `acpx cancel`
40. `thread list-current` 在已绑定项目群中会直接列出当前项目对应的 Codex native thread
41. `/ca thread switch <threadId>` 现在不仅可用于 DM，也可用于已注册飞书线程重绑当前 surface，或在项目群中创建一个绑定到选中 native thread 的新飞书话题
42. DM 与已注册飞书线程的导航卡现在提供一次性“计划模式”按钮，点击后会打开 JSON 2.0 表单卡，并把输入包装成 `/plan ...` 送入当前 native Codex thread
43. 计划中的 `todo_list` 会被结构化渲染到飞书状态卡，而不再只作为一段 waiting 文本掠过
44. bridge 现在会把计划中的单选问题持久化为待回答交互，并在飞书卡片上渲染可点击选项；用户点选后会继续续跑同一个 native Codex thread
45. 飞书卡片中的所有 `/ca` 命令按钮现在都会先在 `card.action.trigger` 中即时返回确认卡，再在后台完成实际操作并通过 `updateInteractiveCard` 回填最终结果；只有纯表单切换类动作仍保留即时返回目标卡片的模型
46. runtime 输出到控制台的日志现在会统一在每一行开头追加本地时间戳，格式精确到毫秒，便于直接比对消息和回调时序
47. 真正进入 bridge 处理链路的飞书入站消息，以及发往飞书的出站消息，现在都会打印一条简略日志；同一条消息或卡片的连续推送更新会做去重收敛，避免控制台刷屏
48. 飞书 DM 和已注册群线程现在都可以先发送图片；bridge 会把图片下载为本地受管资产，并按当前飞书 surface 暂存，而不是立刻触发 Codex
49. 同一个 DM / 线程 surface 上，下一条普通文本消息会自动消费这些待处理图片，并通过 `codex exec -i ...` 或 `codex exec resume -i ...` 一起送入 Codex
50. bridge 现在会把图片附件清单包装进 prompt，明确告诉 Codex 当前带了几张图、文件名和来源消息 ID
51. assistant 可以通过 `[bridge-image] ... [/bridge-image]` 私有指令声明本地图片路径；bridge 会校验路径后，把图片作为原生飞书图片消息回发
52. 卡片按钮触发的异步 `/ca` 命令与计划模式链路也不会再静默吞掉图片结果；能发图时会真发图片，不能发图时会退回明确的文本卡说明
53. runtime 维护任务除了线程空闲回收外，还会按 TTL 清理过期的待处理图片资产，避免 pending 图片长期滞留
54. 仓库新增基于 Playwright 的飞书 live auth bootstrap 与 smoke 脚本：首次人工登录一次后，可复用本地持久化浏览器 profile 做真实飞书网页链路验证
55. 群主时间线中的 `/ca project list` 现在也会读取 Codex 派生项目列表，标出“已绑定当前群 / 已绑定其他群 / 未绑定”，并允许从未绑定项目行直接把当前群绑定到该项目
56. Codex 线程列表卡会把 subagent 来源解析为结构化的母 agent / 子 agent 展示，按父线程分组缩进显示 agent 名称、角色、父线程和层级，不再把 Codex raw `source` JSON 原样暴露到飞书卡片里

### 2.3 当前仍未打通的部分

当前还没有做成完整用户产品流的部分：

- 从 DM 直接创建项目群和线程的交互入口
- 自动创建飞书项目群本身
- 精准跳转到指定 `thread_id` 的客户端导航能力
- 完整的线程级前端管理页面

也就是说，群线程运行链路已经具备，并且现在可以用命令注册项目群和创建线程，但还没有做成完整的飞书导航型产品界面。

## 3. 高层架构

当前主链路可以简化为：

```text
Feishu DM / Group Thread
  -> FeishuWsClient
  -> FeishuAdapter
  -> BridgeService
  -> RunWorkerManager
  -> CodexCliRunner
  -> codex exec worker or codex exec resume worker
  -> Codex
  -> BridgeService
  -> StreamingCardController / text + image reply
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
  - DM 与已注册飞书线程最终都绑定到 native `thread_id`
  - DM 可以显式切到已有的 Codex 原生线程
- `Run Worker`
  - 每次执行 prompt 时临时拉起一个 `codex exec` / `codex exec resume`
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
- 初始化 `CodexCliRunner`
- 初始化 `RunWorkerManager`
- 初始化 `BridgeService`
- 初始化 `CodexSqliteCatalog`
- 初始化飞书 API client 和 WS client
- 将 `SessionStore` 注入飞书适配层，承接待处理图片资产
- 装配飞书长连接上的卡片按钮回调分发
- 由 `FeishuWsClient` 直接归一化 `card.action.trigger` 长连接 payload，并把按钮动作交给 `FeishuCardActionService`
- 装配 `/ops/*`
- 启动线程空闲回收和待处理图片过期清理定时器

### 5.1.1 `src/windows-console.ts`

Windows 控制台编码初始化模块。

职责：

- 在 Windows 环境下把控制台代码页切到 `65001`
- 将 `stdout` / `stderr` 默认编码设置为 `utf8`
- 供 `index.ts`、`doctor-cli.ts`、`init-config.ts` 这类 CLI 入口复用，减少 PowerShell 中中文日志乱码
- runtime 主日志在真正写入控制台前还会统一补上毫秒级时间戳前缀

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
- 图片消息下载与 surface 级暂存
- DM 与群线程 surface 识别
- mention-only fallback 过滤
- 对真正进入 bridge 的飞书入站消息打印简略收包日志
- 创建状态卡控制器
- 将 CA 输出转成飞书文本消息、图片消息、卡片或线程回复
- 发送导航类按钮卡片时统一使用普通 `interactive` 消息卡片
- 保留 CardKit 仅用于流式进度卡，不再把导航卡混入 CardKit/cardId 回写链路
- 对普通对话 run 的终态保持“摘要卡 + 完整正文消息”分工，避免卡片和消息同时完整展示同一大段 assistant 结果

### 5.3 `src/bridge-service.ts`

业务编排核心。

职责：

- `/ca` 命令解析
- surface 解析
- DM 绑定或线程绑定的 native thread 解析
- DM 中读取 Codex `state_*.sqlite` 的项目/线程目录
- DM 中把当前窗口切换到选中的 Codex thread_id
- 在项目群中把选中的 native thread 绑定成新的飞书话题线程
- 生成 `/ca` 导航卡内容
- 为导航卡按钮编码回放命令上下文
- 为计划模式表单和计划选择按钮编码 bridge 动作上下文
- root 上下文封装
- 同 surface 待处理图片的消费与 prompt 附件清单封装
- run 生命周期组织
- 线程状态更新
- 观测数据写入
- 计划交互的持久化与续跑编排
- `[bridge-image]` 私有指令解析、路径校验与图片回复编排

### 5.3.1 `src/bridge-image-directive.ts`

bridge 图片指令解析与路径校验层。

职责：

- 解析 assistant 输出中的 `[bridge-image]` 指令块
- 从可见 assistant 文本中剥离 bridge 私有指令
- 校验图片路径必须位于当前 run `cwd` 或 bridge 受管资产目录内
- 对缺失文件、非法路径和坏 JSON 生成可读的降级错误文本

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
- 对计划模式按钮返回 JSON 2.0 表单卡，并读取 `form_value` 中的多行输入
- 对 bridge 持久化的计划选择返回即时确认卡，并在后台继续同一 native thread
- 对所有 `/ca` 命令按钮统一先返回即时确认卡，再在后台完成命令并用 `updateInteractiveCard` 回填终态卡，避免卡片回调超时，同时保留计划表单打开动作的即时切卡体验
- 当后台异步 run 返回图片结果时，优先发送原生飞书图片消息；无法发图时退回明确的文本说明，不静默吞掉结果

### 5.5 `src/run-worker-manager.ts`

run 调度层。

职责：

- 控制全局并发上限
- 对同一线程或同一 DM 上下文做串行执行

### 5.6 `src/codex-cli-runner.ts`

Codex 执行适配层。

职责：

- 通过 `codex exec --json` 创建新的 native thread
- 通过 `codex exec resume --json` 续跑已有 native thread
- 将 surface 暂存图片映射成 `codex exec -i <file>` / `codex exec resume -i <file>`
- 解析 `codex exec` / `codex exec resume` 的 JSONL 事件流
- 将 native `todo_list` 计划事件归一化为 bridge `waiting`
- 将 native `collab_tool_call` 子代理事件归一化为 bridge `tool_call`
- 从 assistant 文本中提取 bridge 约定的计划选择指令块，并转成结构化计划交互草稿
- 仅承载 Codex CLI 执行语义，不再解析或依赖旧的 `acpx prompt`

### 5.6.1 `src/codex-sqlite-catalog.ts`

Codex 本地线程目录读取层。

职责：

- 自动发现 `~/.codex/state_*.sqlite`
- 只读打开 Codex SQLite
- 按 `cwd` 归并出派生项目列表
- 提供线程列表和线程按 `thread_id` 查询
- 提供线程最近对话预览读取，数据来源是对应 rollout JSONL 中的 `response_item`
- 线程标题优先取 `session_index.jsonl` 中最新的 `thread_name`，以尽量和 Codex App 显示保持一致；取不到时再回退到 SQLite `threads.title`
- 解析 Codex `source` 字符串，普通来源会显示为 `VS Code` / `CLI` / `未知`，subagent JSON 会转成父线程、层级、agent 名称和角色等内部展示字段；无法识别的 JSON 会降级为 `Codex 元数据`，不对飞书用户展示 raw JSON
- 当 `state_*.sqlite` 还没追上最新线程时，会继续读取 `session_index.jsonl` 与 `sessions/**/rollout-*.jsonl` 里的 `session_meta`，补齐最近创建但尚未落进 SQLite 的线程
- 不在 CA 本地复制保存 Codex 项目/线程清单

### 5.7 `src/project-thread-service.ts`

项目线程创建服务。

职责：

- 在项目群中发根消息
- 获取飞书返回的 `message_id` / `thread_id`
- 为新话题创建 native Codex thread，或把已有 native Codex thread 绑定进新话题
- 创建 `codex_threads` surface 绑定记录

注意：

- 这个服务已经存在
- 当前已经通过 `/ca thread create` 暴露成可触发入口
- 但还没有自动建群或图形化创建流

### 5.8 `src/feishu-card/streaming-card-controller.ts`

飞书侧状态承载器。

职责：

- DM 流式状态优先使用 CardKit，失败时回退到普通 interactive card
- 线程场景优先通过回复消息在原话题内承载状态
- 终态成功时将状态卡收口为摘要卡，完整 assistant 正文继续通过普通消息 / 线程回复回推
- 终态失败时收口错误卡或直接回复错误

### 5.9 `src/workspace/session-store.ts`

SQLite 持久化层。

当前负责：

- root 配置
- DM 旧会话快照绑定
- DM Codex 原生线程绑定
- projects
- project_chats
- codex_threads
- pending_bridge_assets
- pending_plan_interactions
- observability_runs
- observability_run_events
- `/ops/*` 查询

另外：

- 启动迁移时会把旧版遗留表 `workspaces`、`users`、`acp_sessions`、`runs`、`message_links`、`event_offsets` 清理掉
- 如果数据库里仍只有旧版 `workspaces` 根配置而没有 `bridge_root`，会先把旧根信息迁入 `bridge_root` 再删除旧表
- 如果数据库里的 `codex_threads` 仍以 `thread_id` 作为主键，启动迁移会自动重建为“按飞书 surface 建模”的新结构，允许多个话题绑定到同一个 native `thread_id`
- `pending_bridge_assets` 会按飞书 surface 暂存待处理图片，记录本地文件路径、来源消息和当前状态；runtime 维护任务会按 TTL 标记过期图片
- `pending_plan_interactions` 会按飞书 surface 记录待回答的计划单选问题；同一 surface 上出现新的待回答问题时，旧记录会被标记为 `superseded`

## 6. 路由与消息流

## 6.1 DM 普通消息

```text
Feishu DM text
  -> FeishuAdapter
  -> BridgeService
  -> lookupDmCodexSelection / codex_window_bindings
  -> 解析 / 创建 native thread
  -> submit to Codex
  -> 状态卡更新
  -> 最终文本回写 DM
```

DM 执行绑定现在以 native thread 为准：

```text
channel + peerId -> codex_thread_id
```

如果当前 DM 还没有绑定 native thread，则普通 prompt 会先创建一个新的 native thread，再把该窗口绑定过去。

如果这个 DM surface 上已经先收到过图片，则这些待处理图片会在这条文本消息进入 Codex 前被一并消费，并作为 `-i` 图片参数传给 `codex exec` / `codex exec resume`。

## 6.2 群线程普通消息

```text
Feishu group thread text
  -> FeishuAdapter
  -> (chat_id, thread_id)
  -> BridgeService.resolveContext
  -> SessionStore.getCodexThreadBySurface(chat_id, thread_id)
  -> project cwd + native thread id
  -> submit to Codex
  -> 在线程中回复状态 / 结果
```

线程场景使用：

```text
(channel, chat_id, surface_type=thread, surface_ref=thread_id)
```

来解析上下文。

如果同一个 `(chat_id, thread_id)` 上已经暂存过图片，则下一条线程文本消息会先消费这些图片，再续跑当前 native `thread_id`。

## 6.2.1 图片暂存链路

```text
Feishu DM / Group Thread image
  -> FeishuAdapter
  -> FeishuApiClient.downloadMessageResource(type=image)
  -> SessionStore.pending_bridge_assets
  -> 轻量确认消息
  -> 下一条同 surface 文本消息
  -> BridgeService.consumePendingBridgeAssets
  -> codex exec / codex exec resume -i ...
```

特点：

- 图片消息本身不会立即触发 Codex run
- 暂存作用域固定为 `(channel, peerId, chatId, surfaceType, surfaceRef)`
- assistant 若回传 `[bridge-image]` 指令，bridge 会在终态文本外额外发送原生飞书图片消息

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
- `/ca project bind-current <projectKey>`
- `/ca project current`
- `/ca project list`
- `/ca project switch <projectKey>`
- `/ca thread create <projectId> <title...>`
- `/ca thread create-current <title...>`
- `/ca thread list <projectId>`
- `/ca thread list-current`
- `/ca thread switch <threadId>`

其中，下面这些命令在不同 surface 中的语义已经不同：

- DM 中 `/ca project list`
  - 读取 Codex `state_*.sqlite`
  - 展示 Codex 派生项目列表
  - 每个项目行都可直接“查看线程”或“切换项目”
- 群聊 / 已注册线程中的 `/ca project list`
  - 如果已配置 Codex catalog，也展示 Codex 派生项目列表
  - 群主时间线中会标出每个项目的群绑定状态，并允许点击未绑定项目直接绑定当前群
  - 如果没有 Codex catalog，则回退展示 CA 本地注册的项目列表
- 已绑定项目群 / 已注册线程中的 `/ca thread list-current`
  - 通过当前项目的 `cwd` 对齐到 Codex catalog project
  - 直接列出该项目下的 native Codex thread

这些命令现在既可以在 DM 中用，也可以在线程中用。

其中：

- DM 中 `/ca new` 会创建新的 native thread 并切换当前窗口
- 如果 DM 当前没有 native thread 绑定但已经选中了项目，`/ca new` 与下一条普通 prompt 都会优先使用该项目的 `cwd`
- 已注册线程中的 `/ca new` 会创建新的 native thread 并重绑当前 Feishu thread surface
- `/ca stop` 对 native thread 统一返回不可用
- `/ca` 会按上下文返回不同内容，`/ca hub` 复用同一条路径：
  - DM（未绑定 native thread）：root、未绑定状态、Codex 项目概览
  - DM（已绑定 native thread）：当前项目路径、当前线程、当前 thread_id
  - 已绑定项目群：当前项目信息、最近线程摘要和项目级按钮入口
  - 已注册线程：当前线程信息、同项目线程摘要和线程级按钮入口
- `/ca` 的按钮会按上下文变化：
  - DM：`导航`、`会话状态`、`当前会话`、`新会话`、`项目列表`
  - 已切到 Codex 原生线程的 DM：`导航`、`项目列表`、`当前项目`、`线程列表`、`当前会话`、`新会话`
  - 已绑定项目群：`导航`、`当前项目`、`线程列表`、`项目列表`
  - 已注册线程：`导航`、`当前项目`、`线程列表`、`当前会话`、`新会话`、`停止`
- `/ca help` 与未知 `/ca` 子命令会复用同一张导航卡
- `/ca project list` 会返回项目列表卡片
- `/ca project current` 会返回当前项目摘要卡片；在 DM 中若当前没有 native thread 绑定，则会回退到当前所选项目
- `/ca thread list <projectId>` 与 `/ca thread list-current` 会返回线程列表卡片；在 DM 中若当前没有 native thread 绑定，则 `thread list-current` 会回退到当前所选项目
- 线程列表卡会汇总“线程数 / 母 agent / 子 agent”，父线程显示来源和分支，子线程以缩进行跟随父线程显示，并标出 agent 名称、角色、父线程引用和层级；父线程不在当前列表时会显示父线程 ID 和“不在当前列表”
- DM 中 `/ca thread switch <threadId>` 成功后会返回线程切换确认卡，并附带“最后 1 条 user + 最后 4 条 assistant”的最近对话原文预览
- DM 中已切到 Codex 原生线程后，`/ca session` 会返回当前会话卡片，并附带同一套“最后 1 条 user + 最后 4 条 assistant”的最近对话原文预览
- `/ca thread create*` 成功后会返回线程摘要卡片
- DM 中的项目列表卡和线程列表卡现在带行级按钮：项目列表可“查看线程”“切换项目”，线程列表可“切换到此线程”
- 群主时间线中的项目列表卡也带行级按钮：未绑定项目可“绑定到本群”，已绑定当前群可进入“当前项目”，已绑定其他群只展示状态，避免误转绑
- DM 中点选线程后，CA 只记录当前窗口绑定到哪个 `codex_thread_id`
- 已注册飞书线程中点选线程后，CA 会把当前 surface 重绑到选中的 native `thread_id`
- 已绑定项目群中点选线程后，CA 会新建一个飞书话题，并把该话题绑定到选中的 native `thread_id`
- 导航卡、列表卡和摘要卡上的按钮会通过飞书长连接回调重放无参 `/ca` 命令
- DM 和已注册飞书线程的导航卡额外带有一次性“计划模式”按钮；当前项目群主时间线仍不会直接展示这个入口
- 计划模式按钮会先返回一个 JSON 2.0 表单卡，提交后由 bridge 在后台发起 `/plan ...` 续跑
- 如果计划中抛出单选问题，状态卡会渲染结构化 todo list 与可点击选项按钮；按钮点击后继续同一个 native `thread_id`
- 长连接卡片回调会在本地先归一化成统一动作结构，再交给 `BridgeService` 生成新的卡片结果
- 按钮回调对导航场景直接返回新版 `card.action.trigger` 的 `raw card` 响应体
- 即时导航不再额外调用消息 patch 或 CardKit 更新接口
- 飞书卡片 JSON 2.0 导航卡不再使用旧版 `{\"tag\":\"action\"}` 容器；按钮区域改为 `column_set` 中嵌套 `button`

## 7. 线程级会话与 run 级 worker

## 7.1 会话策略

当前采用：

- 一个已注册飞书线程，对应一个 native Codex thread 绑定
- 同一个线程后续消息继续复用该 `thread_id`
- 同一个 native Codex thread 可以被多个已注册飞书话题引用；SQLite 以飞书 surface 作为绑定记录主语义
- DM 可以显式切到已有的 Codex 原生线程，也可以单独记录“当前项目”选择；当前项目主要用于在没有 native thread 绑定时决定 `project current`、`thread list-current` 以及首次普通 prompt / `/ca new` 的默认 `cwd`
- DM 可以在首次普通 prompt 时自动创建新的 native thread
- `sessionName` 仍作为观测字段保留，但执行真相源已经统一为 native `thread_id`

## 7.2 run 策略

每次 prompt 执行都拉起一个新的 `codex exec` 或 `codex exec resume` worker。

特点：

- worker 是短生命周期
- native thread 是长期存在
- 这样既能保留上下文，又不会让一个 worker 常驻不退
- 未绑定 surface 先执行 `codex exec --json`
- 已绑定 surface 执行 `codex exec resume --json <thread_id>`
- 若当前 surface 上存在待处理图片，会在同一轮 run 里附加为重复的 `-i <localPath>` 参数

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
- 将线程状态置为 `closed`

同一个维护周期里还会处理待处理图片资产：

- 周期性扫描 `pending_bridge_assets`
- 如果待处理图片超过 `root.idleTtlHours` 仍未被后续文本消息消费
- 将其标记为 `expired`

线程再次收到消息时，会继续复用该线程记录上的 native `thread_id`；runtime 不再尝试关闭 `acpx` session。

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

它不再参与普通 prompt 的主执行路由，当前主要保留给旧会话观测快照和兼容查询使用。

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
- `pending_bridge_assets`
- `pending_plan_interactions`

其中：

- `projects` 表示 CA 视角下的项目
- `project_chats` 表示一个项目对应的飞书项目群；当前群从项目列表绑定到另一个未绑定项目时，会先清理该群旧绑定，再写入新绑定，避免一个群同时绑定多个项目
- `codex_threads` 表示“飞书 surface 到 native Codex thread”的绑定记录
- `codex_threads` 以 `(chat_id, feishu_thread_id)` 唯一标识一个飞书话题 surface，而不是再把 `thread_id` 当作唯一主键
- 因此同一个 native `thread_id` 可以被多个飞书话题引用；项目摘要中的线程数按去重后的 native `thread_id` 统计
- `pending_bridge_assets` 表示某个飞书 surface 上还没被下一条文本 prompt 消费的图片资产；状态支持 `pending / consumed / failed / expired`
- `pending_plan_interactions` 表示某个飞书 surface 上最近一次待回答的 bridge 计划选择题，以及它对应的 native `thread_id`

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
- `[codex]`
- `[scheduler]`
- `[feishu]`
- `[root]`

仓库只提交 `config.example.toml` 作为示例模板；真实 `config.toml` 只保留在本地并由 `.gitignore` 忽略。新环境需要先执行 `npm run init:config`，再填写本地配置。

当前 `[codex]` 是正式配置入口；旧 `[acpx]` 仍会被兼容读取并归一化到 `config.codex.command`，但只用于平滑迁移，不再代表当前运行模型。

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
- 同时也被 runtime 用作待处理图片资产的过期 TTL

### 11.3 本地 live smoke 约定

为了验证“真实飞书用户发消息 -> bridge -> Codex -> 飞书回推”的整条链路，仓库额外约定了一套只用于本地或专用 runner 的 Playwright live smoke：

- `npm run test:feishu:auth` 会启动一个最大化的持久化浏览器 profile，默认打开 `https://feishu.cn/messages/`
- 登录成功后的页面既可能是 `https://feishu.cn/messages/`，也可能是租户域名下的 `/next/messenger/`
- 首次执行需要人工完成飞书登录；成功后会在仓库根目录 `.auth/feishu-profile` 保存本地登录态，并写入 `.auth/feishu-live-auth.json`
- `npm run test:feishu:live` 会复用该 profile 打开真实飞书 DM 页面，不再重复自动登录
- `FEISHU_LIVE_DM_URL` 用于指定待测机器人 DM 的网页地址；未设置时只允许做 auth bootstrap，不允许发消息 smoke
- `FEISHU_LIVE_CONVERSATION_NAME` 可在 `FEISHU_LIVE_DM_URL` 只能打开 messenger 根页时指定左侧会话名，例如机器人 DM 或测试群名
- `FEISHU_LIVE_OPS_BASE_URL` 可显式覆盖 `/ops` 根地址；未设置时会从 `config.toml` 的 `[server]` 配置自动推导
- `.auth/` 仅用于本地测试，不纳入 git

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
- 在 DM 中切到某个 Codex 原生线程后，可以直接看到该线程“最后 1 条 user + 最后 4 条 assistant”消息的原文预览
- 在 DM 中切到某个 Codex 原生线程后，点击“当前会话”也可以继续看到同一份最近对话预览
- 可以通过摘要卡快速确认当前项目和新建线程结果
- 普通对话 run 完成后，不会再在终态卡和普通消息里重复完整展示同一份 assistant 正文；卡片保留摘要，完整正文以下方消息为准
- 输入未知子命令时也能自动回到导航卡
- 可以在群主时间线里直接绑定当前群，而不用手工输入 `chatId`；也可以从项目列表卡中点击未绑定的 Codex 项目完成绑定，不需要知道 `projectId` 或手工复制 `cwd`
- 可以直接点击卡片按钮回到导航、当前项目和线程列表，而不用重新手输命令
- 当卡片同时展示“当前线程”和 `Session` 时，当前线程现在只显示线程名称，不再重复展示同一个 native `thread_id`
- 可以在 DM 和已注册飞书线程里直接点击“计划模式”，用表单方式发起一次 `/plan ...`
- 计划中的待办项会作为结构化 checklist 出现在飞书状态卡上
- 计划中的单选问题可以直接点卡片按钮继续，不需要把选项再手输回消息里
- 可以先在 DM 或已注册飞书线程里发送图片，再补一条文字说明；bridge 会自动把这些图片带进下一次 Codex run
- 如果 Codex 最终结果声明了合法的本地图片路径，飞书里会额外收到原生图片消息，而不是把路径字符串原样吐给用户
- 按钮回调通过同一条飞书长连接返回，不需要额外暴露公网回调地址
- 相同线程不会并发执行两个 run
- 后台可以看项目、线程和线程对应 run
- 运维侧可以先运行 `npm run test:feishu:auth` 完成一次人工登录，然后重复复用持久 profile 跑真实飞书网页版 smoke，而不用每次回归都重新登录

## 14. 当前限制

当前仍有这些限制：

- 没有完整 DM Hub
- 还不能自动创建飞书项目群，只能先绑定已有群；当前群可以通过 `/ca project bind-current` 或项目列表卡片按钮完成绑定
- CA 不提供精确跳转到指定飞书话题的能力
- 卡片按钮目前除了导航命令外，只额外覆盖桥接式计划模式的表单提交与单选题续跑，不是通用的任意参数命令表单平台
- 不直接向 `thread_id` 发普通消息，线程回推统一通过回复消息完成
- 普通对话 run 的终态投递策略当前固定为“摘要卡 + 完整正文消息”，尚未开放配置；如后续确有分场景需求，可再扩展为可配置策略，但当前记为低优先级后续计划
- 现在的“计划模式”是 bridge 基于 `codex exec` / `codex exec resume` 拼出来的工作流，不等同于官方交互式 CLI `/plan` 原语
- 当前只支持文本 + 图片；通用文件、语音仍未接通
- outbound 图片必须位于当前 run `cwd` 或 bridge 受管资产目录下；超出范围的路径会被拒绝并退回文本错误
- 真实飞书网页版 live smoke 当前采用“首次人工登录 + 持久 profile 复用”模型；如果租户启用了 SSO、验证码或二次验证，登录刷新仍需要人工介入
- 不支持多实例集群部署

## 15. 推荐验证路径

### 15.1 基础回归

1. `npm run doctor`
2. `npm run start`
3. 飞书 DM 发 `/ca`
4. 点击导航卡按钮验证回调
5. 飞书 DM 发 `/ca status`
6. 飞书 DM 发 `test`
7. 确认 DM 中先出现流式状态卡；run 完成后，卡片收口为摘要卡，完整 assistant 正文以下方单独消息展示
8. 打开 `/ops/ui`
9. 观察服务控制台，确认收包日志和发包日志都带有 `YYYY-MM-DD HH:mm:ss.SSS` 前缀，且流式状态更新不会连续刷出多条重复发包日志
10. 飞书 DM 先发一张图片，再补一条文字说明，确认 bridge 会先回复“已收到图片”，随后下一条文本 run 会消费该图片

### 15.2 群线程回归

前提有两种：

- 数据库中已经存在对应的 `project_chats` 和 `codex_threads` 记录
- 或者先通过 `/ca project bind` 和 `/ca thread create` 完成注册
- 或者在群主时间线直接执行 `/ca project bind-current`
- 或者在群主时间线发送 `/ca`，点击“项目列表”，再点击未绑定项目的“绑定到本群”
- 或者在已绑定项目群主时间线直接执行 `/ca thread create-current`

1. 在已注册的飞书话题里发普通文本
2. 若开启 `feishu.requireGroupMention`，则带上 mention
3. 观察线程内状态更新与最终结果，确认终态卡只保留摘要，完整 assistant 正文以线程内单独回复为准
4. 检查 `/ops/projects`、`/ops/projects/:id/threads`、`/ops/threads/:id/runs`

### 15.2.1 图片链路回归

1. 在 DM 中先发送一张图片，再发送“请结合刚才图片继续分析”
2. 确认图片消息本身不会直接触发 run，只会先收到轻量确认文本
3. 确认下一条文本消息触发的 run 会消费待处理图片，且同一张图片不会被后续文本重复带入
4. 在已注册飞书线程里重复上述流程，确认 thread surface 也能复用同样的暂存与消费逻辑
5. 如需验证出图链路，准备一个位于当前项目目录或 bridge 受管资产目录内的本地图片，让 assistant 返回 `[bridge-image]` 指令，确认飞书会收到原生图片消息

### 15.2.2 桥接式计划模式回归

1. 在 DM 中点击导航卡里的“计划模式”
2. 在表单里输入类似“帮我先梳理这个仓库的改造方案，不要直接改代码”
3. 提交后观察同一张卡被即时更新，并进入计划中的 waiting / todo 展示
4. 如果卡片出现计划单选题，直接点击某个选项，确认 run 会继续续跑同一个 native `thread_id`
5. 在已注册飞书线程里重复以上流程，确认 thread surface 也能复用相同链路

### 15.3 TTL 回归

1. 准备一个 `warm` 状态线程
2. 等待超过 `root.idleTtlHours`
3. 观察线程是否被关闭并进入 `closed`

### 15.4 飞书真实网页登录 smoke

前提：

- 本地 bridge 已启动，且当前只有一个 bridge 实例连接飞书长连接
- 已拿到机器人 DM 的网页版 URL，并设置 `FEISHU_LIVE_DM_URL`
- 首次运行前先执行 `npm run test:feishu:auth`，在打开的最大化浏览器中手动完成登录

1. `npm run test:feishu:auth`
2. 首次执行时，在打开的浏览器里完成登录，确认已经进入 `feishu.cn/messages` 后回到终端按 Enter
3. `npm run test:feishu:live`
4. smoke 会复用 `.auth/feishu-profile` 打开真实 DM，默认发送 `/ca`，并等待页面出现“导航”字样
5. smoke 还会请求 `/ops/overview` 确认本地 bridge 控制面可达；如需覆盖地址，设置 `FEISHU_LIVE_OPS_BASE_URL`
6. 如需调整 smoke 指令、会话选择或断言，可设置 `FEISHU_LIVE_SMOKE_TEXT`、`FEISHU_LIVE_CONVERSATION_NAME`、`FEISHU_LIVE_EXPECT_TEXT`、`FEISHU_LIVE_COMPOSER_SELECTOR`
7. 登录态失效时，重新运行 `npm run test:feishu:auth` 刷新 profile

### 15.5 Codex 真实调用烟测

当需要验证真实 Codex CLI 的 JSONL 协议、线程创建和预算控制时，可以运行：

1. `npm run -s test -- tests/codex-real-smoke.test.ts`
2. 需要触发真实调用时再设置 `TEST_CODEX_REAL=1`
3. 如需收紧调用预算，可额外设置 `TEST_CODEX_MAX_CALLS`、`TEST_CODEX_MAX_INPUT_TOKENS`、`TEST_CODEX_MAX_OUTPUT_TOKENS`
4. 其中的 create smoke 会使用一个只包含 `TOKEN.txt` 的最小工作区，并通过 `--output-schema` + `--output-last-message` 校验结构化最终结果
5. 需要验证线程续跑时，再运行 `tests/codex-real-resume.test.ts` 并同时设置 `TEST_CODEX_RESUME=1`
6. resume smoke 会先构建一个隔离的 Codex home，只复制认证和配置文件，不会复用旧的 `session_index.jsonl` 或 `state_*.sqlite`
7. resume smoke 的真实 token 消耗明显高于 create smoke，应继续保持显式 opt-in，并按需要单独调节预算上限
8. 桥级集成验证现在覆盖了 `tests/bridge-real-codex.test.ts`，默认通过真实 `BridgeService` + `CodexCliRunner` 配合 transcript 夹具回放，不依赖真实 Feishu 或真实 Codex 调用
9. `npm run doctor` 现在还会提示真实 Codex smoke 的前提条件，包括 `~/.codex/auth.json` 认证状态，以及这类测试默认是显式 opt-in、带真实调用成本的
10. 针对 Codex 原生计划行为和子代理行为的扩展测试，会优先使用一次性真实 JSONL 录制生成的 fixture，再回到默认的 transcript 驱动回归，不把这类高成本调用放进常规测试路径
11. `tests/codex-cli-runner.test.ts` 现在会直接回放 `plan-mode.jsonl` 与 `sub-agent.jsonl`，校验 native 计划事件和子代理生命周期事件是否被归一化成正确的 runner 事件
12. `tests/bridge-real-codex.test.ts` 现在也会用同一批 fixture 校验 bridge 层的等待态、工具调用观测和最终回复，不要求额外真实 Codex 调用
13. `tests/feishu-card-action-service.test.ts`、`tests/feishu-card-builder.test.ts`、`tests/bridge-service.test.ts` 现在会覆盖计划模式表单卡、todo list 展示、待回答计划选择题和续跑同一 native thread 的桥接链路

这组测试默认会跳过真实 Codex 调用，并通过临时工作区自动清理现场。

## 16. 一句话总结

这个项目现在已经从“飞书私聊直连 Codex”演进到：

**一个支持 DM / 群话题线程、文本与图片桥接、线程级会话、run 级 worker、线程内回推和项目/线程/run 三层观测的单实例桥接服务。**
