# 项目总说明

## 1. 项目定位

`Coding Anywhere` 是一个把飞书消息桥接到 Codex 的单实例后端服务。

当前实现已经不再只面向“飞书私聊”，而是同时覆盖三类工作面：

- 飞书 DM
- 已绑定项目的飞书群主时间线
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
2. 飞书群话题线程与已绑定项目群主时间线文本消息接入
3. `/ca` 命令与普通 prompt 分流
4. DM 与项目群主时间线级会话绑定
5. 基于 native `thread_id` 的 DM / 群主时间线 / 群线程执行解析
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
16. 在已绑定项目群中通过 `/ca thread create-current`、`/ca thread list-current`，以及普通群消息直接操作当前项目线程
17. 在群主时间线通过 `/ca project current` 查询当前群绑定到哪个项目
18. 通过 `/ca` 返回导航卡，集中展示当前上下文、项目概览、线程摘要和按钮化操作入口；`/ca hub` 继续兼容到同一张卡
19. DM 中的 `project list` 现在会直接读取 Codex `state_*.sqlite`，返回 Codex 派生项目列表卡片，而不是依赖 CA 本地项目清单
20. DM 中可以从 Codex 项目列表进入线程列表，也可以先把“当前这个飞书聊天窗口”切到某个 Codex 项目，再决定是否查看线程或创建新会话；手输切换命令时可使用真实 `projectKey` 或唯一项目显示名，bridge 会归一化保存真实 catalog key
21. DM 和已绑定项目群主时间线中都可以把“当前这个飞书对话窗口”切换到某个 Codex 原生线程
22. DM 中未绑定窗口、以及已绑定项目群主时间线中未绑定线程的群聊首次收到普通 prompt 时，会优先在当前项目路径下创建新的 native Codex thread；如果 DM 还没选项目，则回退到 root 路径，再把当前窗口绑定到该 `thread_id`
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
36. DM 中切换到某个 Codex 原生线程后，成功回执现在会直接落到“当前会话已就绪”稳定态主卡，并附带“最后 1 条 user 消息 + 最后 4 条 assistant 消息”的最近上下文预览，便于快速恢复上下文
37. 长任务在飞书中的终态展示现在收敛为“终态卡 + 完整正文消息”：终态卡会直接内嵌 `Codex 最终返回了什么` 的收敛正文、本次/下次任务设置，以及 `新会话 | 切换线程 | 更多信息` 后续动作；完整 assistant 正文仍单独作为普通消息 / 线程回复发送，避免卡片和消息同时完整重复同一大段结果
38. `/ca new` 不再重置 CA session，而是创建并切换到新的 native Codex thread；该行为现在同时适用于 DM、已绑定项目群主时间线和已注册飞书线程
39. `/ca stop` 现在会按当前 DM / 已注册飞书线程 surface 查找 live run：排队中的 run 直接取消并收口为 `canceled`，运行中的 run 会先进入 `canceling` 再终态收口
40. `thread list-current` 在已绑定项目群中会直接列出当前项目对应的 Codex native thread
41. `/ca thread switch <threadId>` 现在不仅可用于 DM，也可用于已注册飞书线程重绑当前 surface，或在已绑定项目群主时间线里把“当前群对话”直接绑定到选中的 native thread
42. 飞书稳定态会话卡上的“计划模式”现在已经改成 surface 级单次开关：点击后原卡即时切换 `计划模式 [开/关]`，下一条普通消息会自动按 `/plan ...` 送入当前 native Codex thread，并在消费一次后自动恢复为 `关`
43. 计划中的 `todo_list` 会被结构化渲染到飞书状态卡，而不再只作为一段 waiting 文本掠过
44. bridge 现在会把计划中的单选问题持久化为待回答交互，并在飞书卡片上渲染可点击选项；用户点选后会继续续跑同一个 native Codex thread
45. 飞书卡片回调现在显式分成三种模式：导航/设置类动作直接返回 `raw card` 即时替换；`/ca new`、线程切换等有界异步动作先返回 toast，再使用回调 `token` 调用延时更新接口回填终态卡；计划表单提交与计划选项点击则先返回 toast，再在当前 surface 下新发一条进度卡消息续跑，不再 patch 被点击的卡
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
57. `FeishuWsClient` 现在会在每次底层长连接真正连上后额外打印 transport connected 日志，并在 socket `close` / `error` 时输出关闭码、关闭原因和结构化错误信息，便于定位 DNS、TLS 或代理隧道层面的出网问题
58. 飞书长连接的重连次数、重连间隔和首次重连抖动现在都已提升为显式配置项，默认仍保持 SDK 的“无限重试 + 120 秒间隔 + 30 秒随机抖动”
59. `/ca status` 现在会返回结构化“运行状态”卡：若当前 surface 有 live run，则展示 `runId`、状态/阶段、耗时、最近工具、最新摘要和投递上下文；若没有，则返回空闲态并保留当前上下文摘要
60. `/ca` 与 `/ca session` 现在会先按 surface 的就绪状态分流：未选项目时返回只含 `查看项目` 的起始卡；已选项目但未绑线程时返回项目作用域入口卡（`切换线程 | 新会话 | 查看项目`）；只有真正已绑定 native thread 的 surface 才会进入“当前会话已就绪”稳定态主卡
61. runtime 现在额外暴露 `/ops/runtime` 实时调度快照，以及 `/ops/runs/:id/cancel` 运行中/排队任务取消接口
62. `/ops/ui` 已升级为“告警优先”的组合视图：概览首屏只保留 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消` 五个指标，左侧依次展示 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消 / 其他历史任务（次级） / 会话快照（次级）`，详情区则优先展示 `状态 / 项目 / 线程 / 开始时间 / 更新时间 / 结束时间 / 最近公开进展`，把 `Root / Session / delivery / cancel / tool` 等技术元数据后置；运行状态与阶段标签会和飞书卡片共用同一套中文词汇，不再在后台裸露 `running / tool_call` 这类英文原值
63. `observability_runs` 现在会额外记录 `cancel_requested_at`、`cancel_requested_by`、`cancel_source`，便于还原取消请求来源
64. runtime 启动时会把上次异常退出后遗留的非终态 run 统一收口为 `error`，避免 `/ops` 长期挂着僵尸 `running`
65. `/ops/runs` 历史列表改为按最近更新时间倒序展示，不再把更早的非终态 run 固定钉在顶部
66. 当 `/ca new` 或普通续跑命中非 Git 项目的 `cwd` 时，runner 现在会自动补 `--skip-git-repo-check`，允许非 Git 项目继续创建或续跑 native Codex thread
67. `/ca`、`/ca status`、`/ca session` 这几张主卡现在会优先展示人类可读的项目名 / 线程名；raw `thread_id` 只保留为辅助诊断字段，不再把 `Session` 作为主信息直接抛给飞书用户
68. 运行态相关动作现在只留在真正的运行中卡与 `/ca status` 里：稳定态会话卡继续只承载上下文、下次任务设置、计划模式开关和后续动作，避免把会话首页做成运维面板
69. 运行中的流式状态卡现在只保留一个“停止任务”危险按钮；即便 DM 走的是 CardKit 流式 shell 卡，非终态也会补上同一条 `/ca stop` 卡片回调入口，不再额外混入导航动作
70. `/ca`、`/ca status`、运行中的流式卡、普通对话 run 的终态卡，以及 assistant Markdown 正文卡写入 `config.summary` 的预览文本，都会先把 assistant Markdown 归一化为纯文本再展示，避免 `**标题**`、列表标记等原始语法直接泄漏到飞书卡片摘要区或会话列表预览
71. assistant 的最终正文如果包含明显 Markdown 结构，会优先以 JSON 2.0 Markdown 卡片发送；若内容过大超出飞书 `interactive` 消息安全体积，则会回退为去掉 Markdown 标记的纯文本消息
72. Windows 仓库根目录现在额外提供 `start-coding-anywhere.cmd` 与 `stop-coding-anywhere.cmd` 一键启停脚本；前者会先自拉起独立的 `cmd /k` 窗口，再执行 `npm run build` 和前台 `npm run start`，并在服务退出后保留窗口显示退出码，后者会通过共享清理逻辑停止当前项目相关进程
73. 飞书侧现在可以在 `/ca`、`/ca status`、`/ca session`、运行中的流式状态卡和普通对话 run 的终态卡中直接看到当前生效的 Codex `model`、`reasoning effort` 与 `speed`
74. Codex 偏好现在按“当前线程优先、当前 surface 兜底、系统默认回退”的顺序生效：已绑定 native thread 的 DM / 飞书线程会把设置记到 `thread_id` 级别；尚未绑定 native thread 的 DM、项目群或待创建线程 surface 则先记到当前 surface，并在后续创建新线程时继承
75. `/ca session`、`/ca status` 以及具体对话卡现在都会附带三个 JSON 2.0 `select_static` 下拉选择器，允许在飞书里随时切换当前线程 / 当前 surface 的 `model`、`reasoning effort` 与 `speed`；选项文案和顺序会对齐 Codex App
76. bridge 在需要显式覆盖 Codex 默认行为时，会把飞书侧选中的设置透传给 CLI：创建线程或续跑线程时分别写入 `codex exec -m <model>`、`-c model_reasoning_effort="..."`，以及速度相关的 `-c service_tier="fast"` / `-c features.fast_mode=...` 覆盖
77. DM 中执行 `/ca project switch <projectKey|name>` 时，如果当前窗口还绑定着旧的 native Codex thread，bridge 现在会先解除这条旧绑定，再把“当前项目”切到目标项目；后续普通消息会在新项目下创建 fresh thread，而不是继续误跑旧项目
78. 如果 DM 当前保存了“已选项目”和“已绑线程”两个互相冲突的跨项目状态，bridge 现在会优先相信显式项目选择，并自动清理那条旧线程绑定，避免继续把普通消息送进错误项目
79. Playwright 版真实飞书 live smoke 现在默认锁死到 `coding-anywhere-autotest` 夹具：`test:feishu:live` / `test:feishu:live:dm` 会先把测试 DM 切到该项目，`test:feishu:live:group` 只允许命中已绑定好的测试群 `coding-anywhere-autotest`，也会拒绝其他群名；如确实需要覆盖到别的项目或群夹具，必须显式设置危险开关 `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1`
80. 桌面 completion 通知卡的主按钮文案现在统一为“在飞书继续”，`continue_desktop_thread` 也已经覆盖三种接管路径：DM、已绑定飞书话题和项目群主时间线都会把目标 native Codex thread 接到对应飞书 surface，并统一落到“当前会话已就绪”稳定态主卡；其中项目群主时间线现在不再自动创建飞书话题，而是直接把当前群对话绑定到该 native thread
81. 飞书已绑定项目群主时间线现在和 DM 保持同一套心智：`切换到此线程` / `在飞书继续` 都会把当前对话窗口直接绑定到一个 native Codex thread，后续普通群消息会继续进入这个线程
82. 桌面侧原生 Codex thread 已经从“完成后单次通知”升级为完整生命周期通知：runtime 会在新一轮顶层 desktop run 发现 `task_started` 后先发一张 `桌面任务进行中` 卡，并在后续轮询里复用同一 `message_id` patch 最近公开进展与结构化计划清单；卡片会先展示“你最后说了什么”，再展示当前情况，不再额外放一个独立的 `进度 / Ran N commands` 区块；其中“你最后说了什么”会优先从 rollout 的结构化快照中提取，并显式忽略 `<subagent_notification>`、`<turn_aborted>` 这类 synthetic wrapper，避免把系统包装文本误显示成用户输入
83. 同一轮 desktop run 完成后，bridge 会优先把这张运行态卡原地更新成 `桌面任务已完成`，在同一张卡里直接展示“你最后说了什么”和 `Codex 最终返回了什么` 的正文内容，不再额外补发第二张“完整回复”卡或结果消息；`在飞书继续` 也只会出现在完成态
84. 飞书侧用户可见的运行状态摘要仍然遵循“公开进度”模型：脚本执行细节不再以 `最近工具：<raw command>` 形式直接出现，而是保留结构化进度或必要时折叠为 `Ran N commands` 这类计数摘要；桌面生命周期卡本身则不再单独展示命令计数区块
85. 桌面 lifecycle 轮询在判定通知来源时，现在不仅会压制“刚刚完成的 Feishu run 回声”，也会压制“当前仍在运行中的 Feishu run”；只要同一 native `thread_id` 上还有 live Feishu run，就不会再额外发出 `桌面任务进行中` 或 `桌面任务已完成` 卡，避免把飞书自己发起的任务误报成桌面任务
86. 飞书侧 assistant 最终结果现在会在发送前解析并隐藏 Codex app 的顶层 `::git-*` directive 行；如果能从对应仓库状态里稳定解析出 git 变更，则会在正文末尾追加一条紧凑摘要，例如 `12 个文件已更改`，但不会暴露具体文件名或 `+/-` 行数统计
87. 线程切换卡、线程绑定卡和“当前会话”卡里的最近对话预览，现在也会对 assistant 文本复用同一套 Codex app directive 可见性规则：`::git-stage` / `::git-commit` 这类 app 指令不会再原样显示到飞书卡片里，但若对应仓库可读，仍会保留 `N 个文件已更改` 这种紧凑摘要
88. “当前会话已就绪”稳定态主卡现在只在真正已绑定 native thread 的 surface 上出现：首屏只保留项目 / 线程 / 状态 / 作用范围四条上下文、常驻的下次任务设置下拉、计划模式状态项，以及 `切换线程 | 更多信息` 两个后续动作，不再在主卡首屏平铺线程 ID、群聊 ID、诊断字段或旧版大导航按钮组
89. 新群主时间线或未选项目的 DM 在 `/ca` 首屏不再错误展示计划模式、下次任务设置、`切换线程` 或 `更多信息`；这些控件只有在用户已经进入具体线程后才会出现，避免出现“看得见但根本不能完成下一步”的假入口
90. 群主时间线里的项目列表底部动作现在也会按当前群是否已绑定项目来收紧：未绑定项目时不再展示会失败的 `新会话`，只保留返回入口；绑定项目后才恢复 `新会话`
91. DM / 已绑定项目群里的 Codex 项目列表和线程列表现在开始改用“选择卡”版式：项目行统一只有 `进入项目` 一个主动作，线程行统一只有 `切换到此线程` 一个主动作；路径、raw source、完整 `thread_id` 和分支等技术字段会从首屏列表中移除，底部动作也统一收敛为“返回当前会话/返回导航 + 新会话”；线程列表会限制为最近 12 条并截断长标题/长身份行，确保延时更新卡片保持在飞书卡片大小限制内
92. 飞书稳定态会话卡上的 `计划模式 [开/关]` 现在已经改成 surface 级单次开关：点击后会原卡即时切换状态，不再先弹独立计划表单；下一条普通文本消息会自动按 `/plan ...` 包装送入当前会话，并在消费一次后自动回到 `关`
93. 飞书稳定态会话卡上的 `更多信息` 现在已经改成原卡 `inline_replace` 的只读诊断卡：会集中展示当前上下文、最近运行和下次任务设置摘要，并通过 `返回当前会话` 原地切回主卡，而不是额外污染消息时间线
94. 旧的 `open_plan_form` / `submit_plan_form` 计划表单链路已经退出飞书主会话卡流程；历史卡片回调仍可兼容处理，但新的稳定态会话 UI 不再把“计划模式”实现成一张独立表单卡
95. `feishu.allowlist` 现在已经改成可选配置：缺省或空数组时不做用户白名单校验；只有显式配置了非空 `open_id` 列表后，飞书消息入口才会按用户放行，`doctor` 也只会在列表里仍残留 `ou_xxx` 这类占位值时给出阻塞提示
96. 飞书卡片按钮现在会显式携带 surface 的 `chatType` 上下文；运行态进度卡、稳定态会话卡、模型/偏好下拉和线程选择入口都会把 DM / group 语义写进 action value；桌面 completion 卡会按 `mode` 写入 `p2p` / `group`，回调服务也会兼容只带 `mode` 的旧卡；DM 卡片即使在回调 payload 里带了 `open_chat_id` / `chatId`，bridge 也仍会把它识别成 DM，而不是误判成项目群主时间线
97. 因此，DM 中的 `/ca`、`/ca help`、未知子命令回退、`项目列表`、计划模式开关、模型/推理/速度下拉，以及 `在飞书继续` 后的新稳定态卡，都会继续沿用 DM 的会话语义：不会再冒出“当前群”“绑定到本群”这类群聊专用文案，也不会把 DM 的 surface 交互状态和设置偏好错误写成群聊键
98. Codex 模型下拉现在不再依赖脆弱的手工白名单顺序：GPT 家族模型会被归一化为小写 CLI ID、在飞书里统一显示为 `GPT-*`，并按数值版本倒序排列；同版本再按 Codex / Base / Spark / Mini 等变体排序，非 GPT 自定义模型保留原始 ID 并排在 GPT 家族之后
99. `CodexCliRunner` 现在同时兼容旧版 `item.*` JSONL 和新版 `event_msg` / `response_item` JSONL：可以从 `agent_message`、assistant `message` 和 `task_complete.last_agent_message` 提取最终正文，识别 `function_call` / `exec_command_end` 进度；当 Codex 进程非 0 退出且只留下 `task_complete(last_agent_message:null)` 时，会返回明确的 `CODEX_RUN_NO_ASSISTANT_OUTPUT`，不再把这类新版协议空输出误报成笼统的 `RUN_STREAM_FAILED`
100. 群聊文本入口现在会按飞书官方 `message.mentions` 字段识别 mention；当用户通过 `@机器人 /ca ...` 或 `@机器人 继续处理...` 触发应用时，bridge 会先移除开头的机器人 mention 占位符，再进行 `/ca` 命令识别或 prompt 投递，避免仅开通群 @ 消息权限时群命令被静默过滤
101. 桌面 completion 的 DM fallback 现在不再强制要求配置 `feishu.desktopOwnerOpenId`：bridge 会优先使用目标 native thread 已绑定的 DM 用户，其次使用单人 `allowlist`，最后使用本地唯一已见 DM 用户；只有出现多个 DM 候选且无法从线程绑定判断时才继续要求显式配置

### 2.3 当前仍未打通的部分

当前还没有做成完整用户产品流的部分：

- 从 DM 直接创建项目群和线程的交互入口
- 自动创建飞书项目群本身
- 精准跳转到指定 `thread_id` 的客户端导航能力
- 完整的线程级前端管理页面
- 飞书侧仍看不到 Codex 5 小时额度 / 周额度
- 飞书侧还不能直接查看和切换更多 profile 级高级参数
- 桌面侧原生 Codex thread 生命周期通知虽然已经接通“runtime 轮询 + lifecycle observer + 本地路由决策 + 进行中卡创建 / patch + 完成态原卡收口”整条链路，但 history/mute 回调和失败后的自动修复仍未接通
- 群聊里的“话题承载会话”仍然不是当前主交互模式；虽然项目线程创建与已注册原生话题 surface 仍可用，但“群主时间线直接绑定 thread”和“真正的话题群/话题模式”还没有做成一套完整、清晰的产品交互

也就是说，DM、已绑定项目群主时间线和已注册群线程都已经具备运行链路，但“群聊话题化承载会话”的完整产品方案仍然留待后续单独设计。

## 3. 高层架构

当前主链路可以简化为：

```text
Feishu DM / Bound Group Chat / Group Thread
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
  - DM、已绑定项目群主时间线与已注册飞书线程最终都可以绑定到 native `thread_id`
  - DM 与已绑定项目群都可以显式切到已有的 Codex 原生线程
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
- 通过 `FeishuWsClient` 对 SDK 底层 WebSocket transport 的 connect / close / error 补充诊断日志，便于排查长连接重连时的 DNS、TLS 和隧道问题
- 装配 `/ops/*`
- 把 `SessionStore` 的历史观测数据和 `RunWorkerManager` 的实时调度态拼装成统一的 `/ops/overview` / `/ops/runtime`
- 为 ops 侧取消动作补齐 queued run 的取消元数据落库与事件时间线
- 启动时把上次服务异常退出后残留的非终态 run 收口为明确终态，避免历史观测与 live runtime 脱节
- 启动桌面 lifecycle 轮询定时器：扫描本地 Codex catalog 的顶层 native thread rollout，跳过 `sourceInfo.kind = subagent` 的子线程；bootstrap `codex_thread_watch_state` 时会跳过纯历史 completion，但如果线程最新状态已经进入新的进行中 run，或同一轮 run 在某次 completion 之后仍继续产生顶层公开进展，则会优先恢复 / 保持 `桌面任务进行中` 卡；后续轮询会解析 `task_started`、`agent_message`、`update_plan`、`shell_command` 和 `task_complete`，先创建 `桌面任务进行中` 卡，再在同一 `message_id` 上持续 patch 公开进度，并在真正终态时更新成 `桌面任务已完成`；同时如果同一 `thread_id` 上存在 live Feishu run，或刚完成的 Feishu run 仍落在抑制窗口内，就不会重复从桌面通知出口推卡
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
- 支持跳过受保护的 PID，供 `npm run start` / `npm run dev` / 一键启停脚本避免误杀当前启动或停止命令自己的 `cmd` / `npm` 包装进程
- 在 Windows 下会先切换当前控制台到 UTF-8，再以前台方式拉起子进程
- 在收到终止信号时向子进程透传

### 5.1.3 `scripts/stop.mjs`

Windows 停止入口模块。

职责：

- 作为 `npm run stop` 的实际入口
- 复用 `scripts/startup-cleanup.mjs` 的清理逻辑，停止当前项目相关的残留 `node` / `npm` / `cmd` 进程和目标端口监听
- 在 Windows 下先切换控制台到 UTF-8
- 保护当前 stop 命令的祖先进程链，避免一键关闭时误杀自己的包装脚本
- 供仓库根目录的 `stop-coding-anywhere.cmd` 双击调用

### 5.1.4 `src/codex-desktop-completion-observer.ts`

桌面侧 native Codex rollout 生命周期提取模块。

职责：

- 只面向本地 rollout `.jsonl` 文件，不依赖飞书 SDK、bridge 路由或消息发送逻辑
- 从已记录的 byte offset 开始读取 rollout 文件新增的 JSONL 行
- 识别 `task_started`、`agent_message`、`update_plan`、`shell_command`、assistant `final_answer` 和 `task_complete`
- 维护一份面向飞书展示的公开进度快照：最近公开进展、结构化计划清单和命令计数
- 基于 `thread_id + turn_id|started_at` 生成稳定的 `runKey`，并继续基于 `thread_id + task_complete timestamp + hash(final assistant text or "")` 生成稳定的 `completionKey`
- 返回下一次继续 tail 所需的 `nextOffset`，供后续 runtime 轮询层持久化 watch state，并支持跨轮询累计同一轮 run 的进度

### 5.1.5 `src/desktop-completion-notifier.ts`

桌面侧 native Codex lifecycle 飞书投递模块。

职责：

- 接收已经提取好的 desktop lifecycle snapshot 和已经解析好的投递目标，不在这里重新做路由决策
- `publishRunning` 负责创建 `桌面任务进行中` 卡，并把冻结后的 `message_id`、surface 和公开进度写入 `codex_thread_desktop_notification_state`
- `updateRunning` 负责复用同一 `message_id` patch 运行态卡，只更新公开进展和计划清单
- `publishCompletion` 优先把运行态卡 patch 成完成态；如果当前没有可 patch 的运行态卡，则退回新发一张完成态卡
- 按目标类型分别执行 DM、已绑定飞书话题回复和项目群主时间线投递
- 在真正发飞书消息之前先校验 `codex_thread_watch_state` 是否已存在，避免“消息已经发出但 watch-state 持久化才报错”的半成功状态
- 在已绑定飞书话题中复用路由阶段已经解析好的稳定 `anchorMessageId`，把生命周期卡稳定回复到同一个话题根消息下，避免发送阶段再二次读取可变绑定
- 当 completion 没有可用的最终正文时，会发送明确的 `body unavailable` 文本回退，而不是落一条空白结果消息
- 生命周期卡始终展示 `你最后说了什么` 提醒区，优先使用 rollout 里结构化提取的“最后一句顶层人类输入”；拿不到时才回退到最近用户消息或线程标题
- 完成态卡会把 `Codex 最终返回了什么` 直接内嵌到同一张卡里；若正文过长，则只在这张卡内部做长度收敛，不再额外补发第二条完整结果消息
- 生命周期卡会对 reminder / result / 标题字段做截断，并在最终 JSON 仍偏大时降级到更紧凑的同结构卡片，确保 interactive payload 保持在可发送大小内
- 只有在完成态通知卡发送或 patch 成功后，才推进 `lastNotifiedCompletionKey`

### 5.2 `src/feishu-adapter.ts`

飞书消息适配层。

职责：

- 可选的用户 allowlist 校验（空 allowlist 时关闭）
- 文本消息过滤
- 图片消息下载与 surface 级暂存
- DM、已绑定项目群主时间线与群线程 surface 识别
- mention-only fallback 过滤
- 对真正进入 bridge 的飞书入站消息打印简略收包日志
- 创建状态卡控制器
- 将 CA 输出转成飞书文本消息、图片消息、卡片或线程回复
- 发送导航类按钮卡片时统一使用普通 `interactive` 消息卡片
- 保留 CardKit 仅用于流式进度卡，不再把导航卡混入 CardKit/cardId 回写链路
- 对普通对话 run 的终态保持“终态卡 + 完整正文消息”分工：终态卡直接内嵌 `Codex 最终返回了什么` 的收敛正文和后续动作，但不再和下方正文消息同时完整重复同一大段 assistant 结果
- 对 assistant 终态正文里的 Markdown 做飞书适配：结构化内容优先走 JSON 2.0 Markdown 卡，超长内容再降级为去标记纯文本
- 对 assistant 终态正文里的顶层 Codex app `::git-*` directive 做结构化解析：这些 directive 不再作为可见正文透出给飞书用户，而是转成可选的紧凑 git 变更摘要
- 这套 assistant 正文渲染策略现在已抽到共享 helper，供普通 bridge reply 和桌面 completion notifier 复用，保证 Markdown 卡 / 纯文本回退行为一致

### 5.3 `src/bridge-service.ts`

业务编排核心。

职责：

- `/ca` 命令解析
- surface 解析
- DM 绑定、群主时间线绑定或线程绑定的 native thread 解析
- DM 中读取 Codex `state_*.sqlite` 的项目/线程目录
- DM 中把当前窗口切换到选中的 Codex thread_id
- 把手输项目引用解析为 Codex catalog 项目：优先精确 `projectKey`，其次按 CA 本地项目记录的 `cwd` 对齐，最后才接受唯一的项目显示名 / 目录名，并始终保存真实 catalog key
- 在项目群中把选中的 native thread 直接绑定到当前群对话
- 生成 `/ca` 导航卡内容
- 让导航卡、运行状态卡、当前会话卡优先展示可读的项目 / 线程标签，并把 raw ID 降到辅助诊断层
- 为导航卡按钮编码回放命令上下文
- 在 DM 中执行项目切换时主动解除旧线程绑定，并对“已选项目”和“已绑线程”的跨项目冲突做自动清理
- 为计划模式表单和计划选择按钮编码 bridge 动作上下文
- 为未来的桌面 completion 通知提供纯本地路由解析：优先 native thread 的首选话题绑定，并把稳定 `anchorMessageId` 一起带入 thread target；其次精确项目绑定或唯一 cwd 命中的项目群，最后 DM fallback；cwd 命中多个项目时不会猜测路由目标
- 处理桌面 completion 的 continue handoff：DM、已绑定话题和项目群三条路径都会把目标 native thread 接到对应飞书 surface，并统一复用“当前会话已就绪”稳定态主卡；项目群主时间线会直接把当前群对话绑定到目标 thread，而不是创建新话题
- root 上下文封装
- 同 surface 待处理图片的消费与 prompt 附件清单封装
- run 生命周期组织
- 当前 surface live run 的状态查询与停止
- 运行中 run 的取消请求、取消中态回写和最终收口
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
- 对 `计划模式 [开/关]`、`更多信息`、`返回当前会话` 这类稳定态会话动作直接返回 `raw card` 原地替换结果
- 对 bridge 持久化的计划选择返回 toast，并在后台为当前 surface 新发进度卡消息继续同一 native thread
- 对有界异步 `/ca` 命令优先返回 toast，再使用 callback `token` 调用延时更新接口回填终态卡；只有拿不到 `token` 时才回退到 `open_message_id` patch
- 当后台异步 run 返回图片结果时，优先发送原生飞书图片消息；无法发图时退回明确的文本说明，不静默吞掉结果

### 5.4.1 `src/feishu-card/action-contract.ts`

飞书卡片动作 value 统一契约层。

职责：

- 统一编码 `/ca` 命令按钮、计划模式开关、诊断卡切换、计划选择按钮、Codex 设置回调和桌面线程 handoff 按钮的 `value`
- 统一补齐 `chatId`、`surfaceType`、`surfaceRef` 等 surface 上下文字段
- 供 `BridgeService`、稳定态会话卡、流式状态卡和桌面 completion 卡复用，避免多处手工拼接 callback payload

### 5.4.2 `src/feishu-card/frame-builder.ts`

飞书卡片共享外壳层。

职责：

- 统一产出 JSON 2.0 卡片的 `schema`、`config`、`header` 与 `body` 基础骨架
- 集中维护 JSON 2.0 的 `width_mode`、`update_multi` 与 `summary` 默认值
- 供导航卡、稳定态会话卡、诊断卡、流式状态卡和桌面 completion 卡复用，保证卡片基础结构一致

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
- 非终态状态卡会直接带“停止任务”按钮，方便在当前运行面板里立刻取消 live run
- 终态成功时将状态卡收口为摘要卡，完整 assistant 正文继续通过普通消息 / 线程回复回推
- 终态失败时收口错误卡或直接回复错误

### 5.8.1 `src/feishu-card/desktop-completion-card-builder.ts`

桌面端生命周期通知卡构建器。

职责：

- 为 native Codex thread 在桌面端运行中 / 已完成两种状态构建独立的 JSON 2.0 卡片
- 统一桌面 lifecycle 通知卡的主按钮文案为“在飞书继续”，并把 DM、已存在话题、项目群主时间线三种 handoff 场景编码进按钮 payload
- 运行态卡会展示项目名、线程名、开始时间、必显的“你最后说了什么”提醒区、最近公开进展和结构化计划清单，且不会显示 `在飞书继续`
- 完成态卡会展示完成时间、必显的“你最后说了什么”提醒区，以及直接内嵌在同一张卡里的 `Codex 最终返回了什么`
- 对 project / thread / summary / hint 这类用户或模型衍生文本先做 Markdown 去语法和多行收敛，避免借由 `markdown` 组件改写通知卡结构或摘要预览
- 对超长结果正文会在同一张完成态卡里做长度收敛，避免 interactive payload 超限，同时不再额外发“完整回复”卡
- builder 的输入契约通过 `src/types.ts` 暴露，便于后续 runtime、投递与回调链路复用同一份通知卡输入定义
- 统一产出后续 handoff 会复用的稳定动作名，如 `continue_desktop_thread`、`view_desktop_thread_history`、`mute_desktop_thread`
- 当前只负责生命周期卡的展示模型，不在这里重新做 rollout 观察或飞书路由决策

### 5.9 `src/workspace/session-store.ts`

SQLite 持久化层。

当前负责：

- root 配置
- DM 旧会话快照绑定
- DM Codex 原生线程绑定
- 已见 DM 用户记录，用于桌面 completion 在未显式配置 owner 时安全推断单用户 fallback
- 项目群主时间线 Codex 原生线程绑定
- projects
- project_chats
- codex_threads
- codex_thread_watch_state
- pending_bridge_assets
- pending_plan_interactions
- observability_runs
- observability_run_events
- `/ops/*` 查询

另外：

- 启动迁移时会把旧版遗留表 `workspaces`、`users`、`acp_sessions`、`runs`、`message_links`、`event_offsets` 清理掉
- 如果数据库里仍只有旧版 `workspaces` 根配置而没有 `bridge_root`，会先把旧根信息迁入 `bridge_root` 再删除旧表
- 如果数据库里的 `codex_threads` 仍以 `thread_id` 作为主键，启动迁移会自动重建为“按飞书 surface 建模”的新结构，允许多个话题绑定到同一个 native `thread_id`
- `codex_thread_watch_state` 会按 native desktop `thread_id` 持久化观察状态，记录当前 rollout 路径 / mtime、`last_read_offset`、`last_completion_key` 和 `last_notified_completion_key`，用于桌面线程观察与完成通知去重
- `codex_thread_desktop_notification_state` 会按 native desktop `thread_id` 持久化生命周期卡状态，记录当前 `runKey`、运行态卡 `message_id`、冻结路由、最近公开进展、计划快照、命令计数和 `last_render_hash`，用于跨轮询 / 跨重启继续 patch 同一张桌面任务卡
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

群消息入口统一来自飞书 `im.message.receive_v1` 事件，但是否能收到群消息首先取决于飞书开发者后台的事件订阅和消息权限：

- 只有群 @ 机器人权限时，飞书只会推送 @ 当前机器人的群消息；普通未 @ 的群消息不会到达本服务
- 若需要已绑定项目群主时间线里的普通消息不带 @ 也进入 Codex，需要申请并发布“获取群组中所有消息”相关权限
- 长连接订阅方式仍需在开发者后台“事件与回调”里保存为“使用长连接接收事件”

本地收到群消息后，只有满足下面任一条件才会进入 Codex：

- 是原生话题线程内消息，且能解析出 `chat_id + thread_id`
- 是群主时间线里的 `/ca` 命令
- 是已注册项目群主时间线里的普通文本消息

当群消息以 `@机器人` 开头时，飞书事件正文中的文本通常包含 `@_user_n` 这类 mention 占位符。bridge 会使用官方 `message.mentions` 字段识别机器人 mention，并在路由前剥离开头的机器人 mention，因此 `@机器人 /ca project bind-current ...` 会按 `/ca project bind-current ...` 处理，`@机器人 继续处理` 会按 `继续处理` 投递给当前 surface。

若开启 `feishu.requireGroupMention`，则已注册群线程消息必须带 mention 才会进入 Codex；该开关不会让飞书主动推送普通群消息，推送范围仍由飞书后台权限决定。

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
- `/ca project bind-current <projectKey|name>`
- `/ca project current`
- `/ca project list`
- `/ca project switch <projectKey|name>`
- `/ca thread create <projectId> <title...>`
- `/ca thread create-current <title...>`
- `/ca thread list <projectId>`
- `/ca thread list-current`
- `/ca thread switch <threadId>`

其中，下面这些命令在不同 surface 中的语义已经不同：

- DM 中 `/ca project list`
  - 读取 Codex `state_*.sqlite`
  - 展示 Codex 派生项目列表
  - 每个项目行只展示一个主动作按钮，当前默认展示“进入项目”；如需查看线程，可先进入项目后再进入线程列表
- DM 中 `/ca project switch <projectKey|name>`
  - 先按真实 Codex `projectKey` 精确匹配
  - 再按 CA 本地项目记录或唯一显示名 / 目录名解析到 Codex catalog 项目
  - 成功后保存真实 `projectKey`，后续 `/ca`、`/ca session` 和普通消息创建新线程都沿用归一化后的项目
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
- 当目标 `cwd` 不是 Git 仓库时，bridge 会自动补 `--skip-git-repo-check`，因此非 Git 项目也能创建或续跑 native thread
- `/ca status` 会优先读取当前 surface 的 live run；有任务时返回结构化运行状态卡，空闲时返回当前上下文摘要卡；主信息优先展示可读的项目 / 线程名，`thread_id` 等 raw ID 只作为辅助诊断显示
- `/ca`、`/ca status`、`/ca session` 以及具体对话卡都会直接展示当前生效的 `model`、`reasoning effort` 与 `speed`
- `/ca stop` 只作用于当前 surface 的 live run，不暴露任意 `runId`
  - 没有 live run：返回“当前没有运行中的任务”
  - queued：直接取消排队项并收口为 `canceled`
  - preparing / running / tool_active / waiting：先进入 `canceling`，随后终态收口为 `canceled`
- `/ca` 会按上下文返回不同内容，`/ca hub` 复用同一条路径：
  - DM（未绑定 native thread）：root、未绑定状态、Codex 项目概览
  - DM（已绑定 native thread）：当前项目路径、当前线程、当前 thread_id
  - 已绑定项目群：当前项目信息、最近线程摘要和项目级按钮入口
  - 已注册线程：当前线程信息、同项目线程摘要和线程级按钮入口
- 如果当前 surface 有 live run，`/ca` 会直接把当前运行摘要嵌进卡片里；没有 live run 时不会再显示“停止任务”
- `/ca` 的按钮会按上下文变化：
  - DM：`导航`、`运行状态`、`当前会话`、`新会话`、`计划模式`、`项目列表`，有 live run 时额外出现 `停止任务`
  - 已切到 Codex 原生线程的 DM：`导航`、`项目列表`、`当前项目`、`线程列表`、`计划模式`、`当前会话`、`运行状态`、`新会话`，有 live run 时额外出现 `停止任务`
  - 已绑定项目群：`导航`、`当前项目`、`线程列表`、`项目列表`
  - 已注册线程：`导航`、`当前项目`、`线程列表`、`计划模式`、`当前会话`、`运行状态`、`新会话`，有 live run 时额外出现 `停止任务`
- `/ca help` 与未知 `/ca` 子命令会复用当前 surface 的同一套入口卡，不再强制回到“当前会话已就绪”
- `/ca project list` 会返回项目列表卡片
- `/ca project current` 会返回当前项目摘要卡片；在 DM 中若当前没有 native thread 绑定，则会回退到当前所选项目
- `/ca thread list <projectId>` 与 `/ca thread list-current` 会返回线程列表卡片；在 DM 中若当前没有 native thread 绑定，则 `thread list-current` 会回退到当前所选项目
- 线程列表卡现在改用“选择卡”版式：首屏只展示线程标题、主线程 / 子 agent 标记、最近更新时间，以及必要时的父线程引用与层级，不再在列表首屏直接暴露 raw `thread_id`、来源 JSON 或分支字段
- DM 中 `/ca thread switch <threadId>` 成功后会返回线程切换确认卡，并附带“最后 1 条 user + 最后 4 条 assistant”的最近对话原文预览
- DM 或群主时间线在还没选项目时，`/ca` / `/ca session` 会先返回入口卡：只保留项目 / 线程 / 状态 / 作用范围和一个 `查看项目` 主动作，不会提前展示计划模式、下次任务设置或诊断入口
- 已选项目但还没绑定线程时，`/ca` / `/ca session` 会返回项目作用域入口卡：只保留 `切换线程 | 新会话 | 查看项目`
- 只有真正已切到 Codex 原生线程后，`/ca session` 才会返回“当前会话已就绪”卡：首屏只保留项目 / 线程 / 状态 / 作用范围、常驻设置项、计划模式开关与最近上下文预览；`更多信息` 会在原卡内切到只读诊断视图，再通过 `返回当前会话` 切回
- `/ca session`、`/ca status` 以及具体对话卡都会附带三个 JSON 2.0 `select_static` 下拉选择器，可直接在飞书里切换当前线程 / 当前 surface 的 `model`、`reasoning effort` 与 `speed`
- 对已经绑定 native thread 的上下文，设置会持久化到 `thread_id`；对尚未绑定 native thread 的上下文，设置会持久化到当前飞书 surface，并在后续 `new_codex_thread` 创建时继承
- `/ca thread create*` 成功后会返回线程摘要卡片
- DM 中的项目列表卡和线程列表卡现在带行级按钮：项目列表每行只保留一个主动作“进入项目”，线程列表每行只保留一个主动作“切换到此线程”；列表底部动作也统一收敛为“返回当前会话/返回导航 + 新会话”
- 群主时间线在未绑定项目时，项目列表底部不再展示会失败的 `新会话`
- 群主时间线中的项目列表卡也带行级按钮：未绑定项目可“绑定到本群”，已绑定当前群可进入“当前项目”，已绑定其他群只展示状态且不暴露对方群 ID，避免误转绑
- DM 中点选线程后，CA 只记录当前窗口绑定到哪个 `codex_thread_id`
- 已注册飞书线程中点选线程后，CA 会把当前 surface 重绑到选中的 native `thread_id`
- 已绑定项目群中点选线程后，CA 会把当前群对话直接绑定到选中的 native `thread_id`
- 导航卡、列表卡和摘要卡上的按钮会通过飞书长连接回调重放无参 `/ca` 命令
- 计划模式现在不再通过独立表单卡发起，而是作为稳定态会话卡上的单次开关；当前项目群主时间线在未进入具体会话前仍不会默认展示这一项
- 当计划模式处于 `开` 时，下一条普通文本会由 bridge 自动包装成 `/plan ...` 续跑；消费一次后自动恢复为 `关`
- 如果计划中抛出单选问题，状态卡会渲染结构化 todo list 与可点击选项按钮；按钮点击后继续同一个 native `thread_id`
- 长连接卡片回调会在本地先归一化成统一动作结构，再交给 `BridgeService` 生成新的卡片结果；归一化结果会保留 `open_chat_id`、`action.options`、`action.checked` 与 `action.input_value`
- 按钮回调对导航场景直接返回新版 `card.action.trigger` 的 `raw card` 响应体
- 即时导航不再额外调用消息 patch 或 CardKit 更新接口；有界异步动作则改用 callback `token` 的延时更新路径，长任务动作改为新发进度卡消息
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
- `codex_chat_bindings`
- `codex_threads`
- `codex_thread_watch_state`
- `codex_thread_desktop_notification_state`
- `pending_bridge_assets`
- `pending_plan_interactions`

其中：

- `projects` 表示 CA 视角下的项目
- `project_chats` 表示一个项目对应的飞书项目群；当前群从项目列表绑定到另一个未绑定项目时，会先清理该群旧绑定，再写入新绑定，避免一个群同时绑定多个项目
- `codex_chat_bindings` 表示“群主时间线 surface 到 native Codex thread”的绑定记录，按 `(channel, chat_id)` 唯一
- `codex_threads` 表示“飞书 surface 到 native Codex thread”的绑定记录
- `codex_threads` 以 `(chat_id, feishu_thread_id)` 唯一标识一个飞书话题 surface，而不是再把 `thread_id` 当作唯一主键
- 因此同一个 native `thread_id` 可以被多个飞书话题引用；项目摘要中的线程数按去重后的 native `thread_id` 统计
- `codex_thread_watch_state` 表示 native desktop 线程观察状态，记录 rollout 路径 / mtime、`last_read_offset`、`last_completion_key` 和 `last_notified_completion_key`，用于桌面端线程观察与完成通知去重
- `codex_thread_desktop_notification_state` 表示 native desktop 生命周期卡状态，记录当前 `runKey`、运行态卡 `message_id`、冻结路由、最近公开进展、计划快照、命令计数和 `last_render_hash`
- `pending_bridge_assets` 表示某个飞书 surface 上还没被下一条文本 prompt 消费的图片资产；状态支持 `pending / consumed / failed / expired`
- `pending_plan_interactions` 表示某个飞书 surface 上最近一次待回答的 bridge 计划选择题，以及它对应的 native `thread_id`

## 10.4 Run 观测

`observability_runs` 当前已扩展为同时记录：

- `project_id`
- `thread_id`
- `delivery_chat_id`
- `delivery_surface_type`
- `delivery_surface_ref`
- `cancel_requested_at`
- `cancel_requested_by`
- `cancel_source`

因此后台已经不再只是“看 session”，而是能看到这条 run 属于哪个项目、哪个线程、最终该投递回哪里。

另外，实时调度态不落 SQLite，而是由 `RunWorkerManager` 在内存中维护：

- `activeRuns`
- `queuedRuns`
- `locks`
- `cancelingCount`

`/ops/runtime` 会直接读取这份 live registry；`/ops/overview` 则把 SQLite 历史统计和 live runtime 指标拼装成统一概览。

另外，runtime 每次启动时都会先对 SQLite 中残留的非终态 run 做一次恢复：

- 统一把 `done / error / canceled` 之外的历史 run 收口为 `error`
- `finished_at` 会补成当前启动时刻
- 原有 `updated_at` 会保留，因此不会因为恢复动作把老 run 重新顶到历史列表最前面
- `/ops/runs` 默认也会按 `updated_at DESC` 展示，优先看到最近真正发生过更新的任务

另外，`observability_run_events` 的写入策略已经做了收敛：

- 生命周期、工具调用、终态仍按阶段保留事件
- 连续的流式 `text` / `waiting` 更新会按“相邻同阶段事件”合并
- 取消请求会先落一条 `canceling` 阶段事件，再由终态更新收口为 `canceled` 或 `error`
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
- `codex.defaultModel`
  - 飞书侧在没有线程级 / surface 级偏好时展示和回退使用的默认模型
- `codex.defaultReasoningEffort`
  - 飞书侧在没有线程级 / surface 级偏好时展示和回退使用的默认推理强度
- `codex.defaultSpeed`
  - 飞书侧在没有线程级 / surface 级偏好时展示和回退使用的默认速度；当前 bridge 会使用 `standard | fast` 这组用户语义值
- `codex.modelOptions`
  - `/ca session`、`/ca status` 和具体对话卡模型下拉框的候选项；若未配置，会结合本机 `~/.codex/config.toml` 与内置常见模型做兜底
  - GPT 家族 ID 会大小写归一为 CLI 使用的小写形式，展示时统一格式化为 `GPT-*`，排序按数值版本倒序，同版本再按 Codex / Base / Spark / Mini 等变体稳定排列；非 GPT 自定义模型保留原始 ID 并排在 GPT 家族之后
- `codex.reasoningEffortOptions`
  - `/ca session`、`/ca status` 和具体对话卡推理下拉框的候选项；若未配置，会结合本机 `~/.codex/config.toml` 与内置 `low ~ xhigh` 做兜底，并按 Codex App 文案展示
- `codex.speedOptions`
  - `/ca session`、`/ca status` 和具体对话卡速度下拉框的候选项；当前支持 `standard`、`fast`
- `feishu.allowlist`
  - 飞书用户白名单；当前按 `open_id` 生效
  - 缺省或空数组表示不做用户白名单校验
  - 配置了非空列表后，只有命中的用户消息才会进入 bridge
- `feishu.requireGroupMention`
  - 群线程兜底模式
  - 为 `true` 时，只有带 mention 的线程消息才会进入 Codex；mention 依据飞书官方 `message.mentions` 字段识别
  - 该配置只控制本地过滤，不替代飞书后台权限；若应用只有群 @ 机器人消息权限，未 @ 的普通群消息不会被飞书推送到长连接
- `feishu.desktopOwnerOpenId`
  - 桌面 completion 通知在无法路由到已有话题或项目群时，用于显式指定 DM fallback 的目标用户 `open_id`
  - 这是“接收通知的人”的 `open_id`，不是机器人自身的 App ID 或机器人 ID
  - 可省略场景：目标 native thread 已经绑定过某个 DM、`feishu.allowlist` 只有 1 个 open_id，或本地数据库里只有一个已见 DM 用户
  - 若存在多个 DM 候选且无法通过线程绑定消歧，则仍应配置该字段，避免桌面任务结果发错人
- `feishu.encryptKey`
  - 飞书长连接消息或回调启用加密推送时使用的解密密钥
- `feishu.reconnectCount`
  - 飞书长连接重试次数
  - `-1` 表示无限重试
- `feishu.reconnectIntervalSeconds`
  - 飞书长连接失败后的基础重连间隔
- `feishu.reconnectNonceSeconds`
  - 飞书长连接首次重试前附加的随机抖动上限

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
- `npm run test:feishu:live` 与 `npm run test:feishu:live:dm` 会复用该 profile 打开真实飞书测试 DM；`npm run test:feishu:live:group` 会复用同一 profile 打开真实飞书测试群，不再重复自动登录
- 真实飞书测试用例的第一目标是贴合用户实际旅程，用来检验 UI 和交互是否合理、功能是否正常；不能把“能通过命令直达某状态”误当成“用户路径已经顺畅”
- 用例必须明确区分“夹具准备”和“用户主旅程”：`/ca project switch`、`/ca project current`、预置绑定、清理状态这类动作只允许出现在准备阶段或专项测试说明里，不应混入主旅程步骤
- 常规 DM / group 主旅程应从用户自然入口开始：通常先发送 `/ca`，再根据返回卡片点击 `查看项目`、`当前项目`、`切换线程`、`返回当前会话` 等按钮继续；如果某一步要验证卡片交互，就优先点击卡片按钮，而不是直接发送等价命令
- 专项 live 测试可以先用 `/ca project switch`、桌面 handoff、预置线程等方式构造上下文，但用例名称和步骤应说明它是在验证特定功能点，而不是普通用户导航路径
- 每一步断言必须等待当前动作产生的新可见结果，不能只因为历史消息里已有同名文案就提前通过；否则无法发现卡片未刷新、点击旧卡、延时更新失败这类真实交互问题
- live smoke 不再只发一条可配置命令，而是按 surface 执行主要用户旅程；其中夹具准备步骤会和用户主旅程分开记录。DM 会先用 `/ca project switch coding-anywhere-autotest` 做夹具准备，然后主旅程从 `/ca` 开始，点击 `查看项目`、从项目列表返回当前会话、点击 `切换线程`，再查看 `/ca status` 与 `/ca session`；群聊会先用 `/ca project current` 做夹具自检，然后主旅程从 `/ca` 开始，点击 `查看项目`、点击 `当前项目`、点击 `线程列表` 与查看 `/ca status`
- 做图片链路 live smoke 时，至少要覆盖“先发图片、bridge 回 `[ca] 已收到图片，请继续发送文字说明。`、再发文字消费图片”这条链路；单元回归也需要覆盖图片消息下载方法在真实 API client 实例上不能丢失 `this` 绑定
- `FEISHU_LIVE_TARGET_URL` 用于指定待测飞书网页入口；兼容旧变量 `FEISHU_LIVE_DM_URL`。未设置时只允许做 auth bootstrap，不允许发消息 smoke
- `FEISHU_LIVE_SURFACE` 用于显式指定当前 smoke 场景：`dm` 或 `group`；默认是 `dm`
- `FEISHU_LIVE_CONVERSATION_NAME` 可在 `FEISHU_LIVE_TARGET_URL` 只能打开 messenger 根页时指定左侧会话名；若 `FEISHU_LIVE_SURFACE=group` 且未显式提供，则默认固定为测试群 `coding-anywhere-autotest`；未开启危险开关时，group smoke 也会拒绝任何其他群名
- `FEISHU_LIVE_PROJECT_KEY` 默认固定为 `coding-anywhere-autotest`；该值可以是 Codex 真实 `projectKey`，也可以是唯一项目显示名。DM smoke 的夹具准备会先发送 `/ca project switch coding-anywhere-autotest`，由 bridge 解析并保存真实 catalog key；群聊 smoke 的夹具准备只校验当前群已经绑定到该项目，不自动改绑
- 如果确实需要把 live smoke 覆盖到非测试项目或非默认测试群，必须显式设置 `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1`；默认会直接拒绝执行
- 即便不是走 `npm run test:feishu:live*`，任何新增的真实飞书联调也必须复用同一套 autotest 夹具：DM 只能落到当前项目为 `coding-anywhere-autotest` 的测试 DM，群聊只能落到群名为 `coding-anywhere-autotest` 且已绑定该项目的测试群；在向飞书发送任何真实测试消息前，都必须先做一次 `/ca project current` 级别的就地确认
- `FEISHU_LIVE_OPS_BASE_URL` 可显式覆盖 `/ops` 根地址；未设置时会从 `config.toml` 的 `[server]` 配置自动推导
- 为避免本地真实联调启动时补发历史桌面 completion 通知，联调启动 bridge 时可设置 `BRIDGE_DISABLE_DESKTOP_COMPLETION_POLLING=1`；这只关闭桌面 rollout 轮询，不影响飞书长连接收消息、卡片回调和 `/ops` 接口
- `.auth/` 仅用于本地测试，不纳入 git

## 12. 后台观测与运维接口

当前 `/ops/*` 已支持：

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

说明：

- `/ops/overview` 会额外展示 live `activeRuns / queuedRuns / cancelingRuns` 以及最长活跃/排队时长
- `/ops/runtime` 直接返回实时调度态，包括 active / queued runs、当前锁占用和每个 live run 的关键上下文
- `/ops/runs/:id/cancel` 允许 ops 侧按 `runId` 取消 live run；本期只支持 cancel，不支持 retry
- `/ops/ui` 现在采用告警优先的信息层级：左侧按 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消 / 其他历史任务（次级） / 会话快照（次级）` 排列，任务详情则先展示状态、项目、线程、开始/更新/结束时间与最近公开进展，再展示技术元数据和完整时间线
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
- 在项目群主时间线把现有 Codex 原生线程绑定进新飞书话题时，回执卡会明确区分“线程已绑定”和“线程已创建”，并显示最近对话预览
- 在 DM 中切换项目后，旧线程绑定会被立即解除；这时下一条普通消息会在新项目下创建 fresh thread，而不是继续跑旧项目的上下文
- 可以在 DM 或已注册飞书线程里直接点击“运行状态”，看到当前 surface 的 live run、耗时、最近工具和摘要；没有 live run 时也能看到空闲态上下文摘要
- 可以在 DM 或已注册飞书线程里直接点击“停止任务”或发送 `/ca stop`，请求停止当前 surface 上正在执行或排队的任务
- 可以通过摘要卡快速确认当前项目和新建线程结果
- 桌面生命周期通知卡完成后，会直接在同一张卡里展示 `Codex 最终返回了什么` 的正文内容，不再额外补一张“完整回复”消息
- 输入未知子命令时也能自动回到导航卡
- 可以在群主时间线里直接绑定当前群，而不用手工输入 `chatId`；也可以从项目列表卡中点击未绑定的 Codex 项目完成绑定，不需要知道 `projectId` 或手工复制 `cwd`
- 可以直接点击卡片按钮回到导航、当前项目和线程列表，而不用重新手输命令
- 当卡片同时展示“当前线程”和 `Session` 时，当前线程现在只显示线程名称，不再重复展示同一个 native `thread_id`
- 可以在 DM 和已注册飞书线程的“当前会话已就绪”卡里直接切换 `计划模式 [开/关]`，让下一条普通消息按 `/plan ...` 方式发起
- `/ops/ui` 首屏现在会先强调 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消` 这类告警与队列信息，其他历史任务和会话快照降成次级区块；点进详情后也会先看到状态、项目、线程、开始时间和最近公开进展，再看到技术元数据
- 计划中的待办项会作为结构化 checklist 出现在飞书状态卡上
- 计划中的单选问题可以直接点卡片按钮继续，不需要把选项再手输回消息里
- 可以先在 DM 或已注册飞书线程里发送图片，再补一条文字说明；bridge 会自动把这些图片带进下一次 Codex run
- 如果 Codex 最终结果声明了合法的本地图片路径，飞书里会额外收到原生图片消息，而不是把路径字符串原样吐给用户
- 按钮回调通过同一条飞书长连接返回，不需要额外暴露公网回调地址
- 相同线程不会并发执行两个 run
- 后台可以看项目、线程和线程对应 run
- Windows 本地使用时，现在可以直接双击仓库根目录的 `start-coding-anywhere.cmd` / `stop-coding-anywhere.cmd` 完成一键启停，不必再手动切目录并分别输入 build/start 命令
- `start-coding-anywhere.cmd` 会先拉起一个独立的 `cmd` 窗口承载服务日志；这样即使当前是临时 PowerShell / Terminal 宿主，服务窗口也不会跟着宿主一起消失
- 服务退出后，`start-coding-anywhere.cmd` 仍会保留该日志窗口，并显示退出码，便于排查启动后秒退或异常退出
- 当飞书长连接发生底层断线或重连时，控制台现在会额外打印 transport connected、socket close code / reason 和结构化 socket error，方便直接区分业务超时与 DNS / TLS / 代理链路故障
- 运维侧可以先运行 `npm run test:feishu:auth` 完成一次人工登录，然后重复复用持久 profile 跑真实飞书网页版 smoke，而不用每次回归都重新登录

## 14. 当前限制

当前仍有这些限制：

- 没有完整 DM Hub
- 还不能自动创建飞书项目群，只能先绑定已有群；当前群可以通过 `/ca project bind-current` 或项目列表卡片按钮完成绑定
- CA 不提供精确跳转到指定飞书话题的能力
- `/ops/ui` 仍然主要围绕 run 控制、告警排查与历史详情展开，项目/线程管理页仍以 JSON drill-down 为主，没有做成完整多页后台
- 卡片按钮目前除了导航命令外，还覆盖稳定态会话卡的 `计划模式 [开/关]`、`更多信息` 诊断切换、Codex 设置下拉，以及桥接式计划选择续跑；但它仍不是通用的任意参数命令表单平台
- 不直接向 `thread_id` 发普通消息，线程回推统一通过回复消息完成
- 普通对话 run 的终态投递策略当前固定为“终态卡 + 完整正文消息”：终态卡会收敛显示 `Codex 最终返回了什么` 和后续动作，但完整 assistant 正文仍以下方消息承载；如后续确有分场景需求，可再扩展为可配置策略，但当前记为低优先级后续计划
- 现在的“计划模式”仍然是 bridge 基于 `codex exec` / `codex exec resume` 拼出来的工作流，只是飞书侧入口已经从独立表单卡收敛成会话级单次开关；它依然不等同于官方交互式 CLI `/plan` 原语
- 桌面 completion 通知虽然已经有本地路由决策、DM owner 配置解析、实际消息发送器、runtime 轮询，以及 DM / group / topic continue handoff，但 history/mute 回调以及“同一 completion 失败后自动修复”还没有接通
- 当前只支持文本 + 图片；通用文件、语音仍未接通
- outbound 图片必须位于当前 run `cwd` 或 bridge 受管资产目录下；超出范围的路径会被拒绝并退回文本错误
- 真实飞书网页版 live smoke 当前采用“首次人工登录 + 持久 profile 复用”模型；如果租户启用了 SSO、验证码或二次验证，登录刷新仍需要人工介入
- 不支持多实例集群部署

## 15. 推荐验证路径

### 15.1 基础回归

1. `npm run doctor`
   - 若未配置 `feishu.allowlist`，这里不再把它视为阻塞项；如果手动配置了 allowlist，则确认其中没有 `ou_xxx` 这类占位值
2. Windows 本地双击 `start-coding-anywhere.cmd`，确认会先执行 `npm run build`，成功后进入前台服务日志；如需手工验证，也可直接执行 `npm run start`
3. 飞书 DM 发 `/ca`：如果当前还没选项目，应先看到只含 `查看项目` 的起始卡；如果已经进入具体线程，才应看到“当前会话已就绪”主卡
4. 如果要验证“切换项目后不再误跑旧线程”，先在一个已绑定旧线程的 DM 中执行 `/ca project switch <projectKey|name>`，确认返回卡会明确提示“已退出之前绑定的线程”
5. 点击导航卡按钮验证回调
6. 飞书 DM 发 `/ca status`
7. 飞书 DM 发一个足够长的任务，再次点击“运行状态”，确认卡片能展示 `runId`、状态、耗时、最近工具与摘要
8. 在任务仍未结束时发送 `/ca stop`，确认 run 会先进入 `canceling`，随后收口为 `canceled`
9. 打开 `/ops/runtime` 与 `/ops/ui`，确认 `/ops/ui` 首屏按 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消 / 其他历史任务（次级） / 会话快照（次级）` 排列，且详情区先显示状态、项目、线程、开始/更新/结束时间与最近公开进展，再显示技术元数据和时间线
10. 再发一个普通任务，确认 DM 中先出现流式状态卡；run 完成后，卡片收口为终态卡，并直接显示 `Codex 最终返回了什么` 的收敛正文、`新会话 | 切换线程 | 更多信息` 动作，以及下次任务设置；完整 assistant 正文以下方单独消息展示
11. 观察服务控制台，确认收包日志和发包日志都带有 `YYYY-MM-DD HH:mm:ss.SSS` 前缀，且流式状态更新不会连续刷出多条重复发包日志；如长连接发生抖动，还应能看到 `feishu ws transport connected`、`feishu ws socket closed: code=...; reason=...` 和 `feishu ws socket error` 这类诊断日志
12. 飞书 DM 先发一张图片，再补一条文字说明，确认 bridge 会先回复“已收到图片”，随后下一条文本 run 会消费该图片
13. Windows 本地双击 `stop-coding-anywhere.cmd`（或执行 `npm run stop`），确认服务进程退出，且再次双击启动时不会因残留端口占用而失败
14. 飞书 DM 或已注册线程里点击 `/ca session`、`/ca status`，再启动一个普通任务，确认三种卡片都会显示当前 `model` / `reasoning effort` / `speed`，并能通过下拉框切换
15. 切换模型、推理或速度后，再次点击 `/ca status` 或直接续跑当前线程，确认状态卡能展示新的值，且随后的 native Codex run 会按选中的参数执行

### 15.2 群线程回归

前提有两种：

- 数据库中已经存在对应的 `project_chats`、`codex_chat_bindings` 和 `codex_threads` 记录
- 或者先通过 `/ca project bind` 和 `/ca thread create` 完成注册
- 或者在群主时间线直接执行 `/ca project bind-current`
- 或者在群主时间线发送 `/ca`，点击“项目列表”，再点击未绑定项目的“绑定到本群”
- 或者在已绑定项目群主时间线直接执行 `/ca thread create-current`

1. 在已注册的飞书话题里发普通文本
2. 若开启 `feishu.requireGroupMention`，或应用只开通了群 @ 机器人消息权限，则带上 `@机器人`；bridge 应移除开头 mention 后再把正文送入 Codex
3. 观察线程内状态更新与最终结果，确认终态卡会展示 `Codex 最终返回了什么` 的收敛正文，而完整 assistant 正文仍以下方线程内单独回复为准
4. 检查 `/ops/projects`、`/ops/projects/:id/threads`、`/ops/threads/:id/runs`

### 15.2.1 已绑定项目群主时间线回归

- 数据库中已经存在对应的 `project_chats` 记录
- 如需直接续跑已有 native thread，再额外准备一条 `codex_chat_bindings`

1. 在已绑定项目群主时间线里发送普通文本；若应用没有“获取群组中所有消息”权限，则使用 `@机器人 普通文本`
2. 观察状态更新与最终结果，确认普通群消息会继续进入当前绑定的 native `thread_id`
3. 在同一群执行 `/ca thread switch <threadId>`；若只开通群 @ 权限，则使用 `@机器人 /ca thread switch <threadId>`，确认回执为“当前会话已就绪”卡，而不是新话题提示
4. 再发送一条普通文本，确认实际续跑的是刚切换的 thread

### 15.2.2 图片链路回归

1. 在 DM 中先发送一张图片，再发送“请结合刚才图片继续分析”
2. 确认图片消息本身不会直接触发 run，只会先收到轻量确认文本
3. 确认下一条文本消息触发的 run 会消费待处理图片，且同一张图片不会被后续文本重复带入
4. 在已注册飞书线程里重复上述流程，确认 thread surface 也能复用同样的暂存与消费逻辑
5. 如需验证出图链路，准备一个位于当前项目目录或 bridge 受管资产目录内的本地图片，让 assistant 返回 `[bridge-image]` 指令，确认飞书会收到原生图片消息

### 15.2.3 桥接式计划模式回归

1. 先确保当前 DM 已经进入具体 thread；再打开 `/ca` 或 `/ca session`，确认此时才会落到“当前会话已就绪”稳定态主卡
2. 点击主卡上的 `计划模式 [关]`，确认原卡即时切换为 `计划模式 [开]`
3. 直接发送一条普通文本，例如“帮我先梳理这个仓库的改造方案，不要直接改代码”，确认不需要再填写独立表单
4. 观察当前 surface 下出现新的进度卡消息，并进入计划中的 waiting / todo 展示；这一条消息应自动按 `/plan ...` 方式续跑当前 native `thread_id`
5. 如果卡片出现计划单选题，直接点击某个选项，确认 run 会继续续跑同一个 native `thread_id`
6. 这一轮任务结束后，再次查看稳定态会话卡，确认 `计划模式` 已自动回到 `关`
7. 在已注册飞书线程里重复以上流程，确认 thread surface 也能复用相同链路

### 15.3 TTL 回归

1. 准备一个 `warm` 状态线程
2. 等待超过 `root.idleTtlHours`
3. 观察线程是否被关闭并进入 `closed`

### 15.4 飞书真实网页登录 smoke

前提：

- 本地 bridge 已启动，且当前只有一个 bridge 实例连接飞书长连接
- 已拿到测试 DM 或测试群的网页版 URL，并设置 `FEISHU_LIVE_TARGET_URL`
- 首次运行前先执行 `npm run test:feishu:auth`，在打开的最大化浏览器中手动完成登录
- 建议真实联调时以 `BRIDGE_DISABLE_DESKTOP_COMPLETION_POLLING=1 npm run start` 或等价方式启动 bridge，避免历史桌面 completion 通知污染 autotest 夹具

1. `npm run test:feishu:auth`
2. 首次执行时，在打开的浏览器里完成登录，确认已经进入 `feishu.cn/messages` 后回到终端按 Enter
3. DM 场景执行 `npm run test:feishu:live` 或 `npm run test:feishu:live:dm`；群聊场景执行 `npm run test:feishu:live:group`
4. DM smoke 会复用 `.auth/feishu-profile` 打开真实测试 DM，先执行 `/ca project switch coding-anywhere-autotest` 做夹具准备；随后用户主旅程从 `/ca` 开始，依次点击 `查看项目`、`返回当前会话`、`切换线程`，再检查 `/ca status` 与 `/ca session`
5. group smoke 会复用同一 profile 打开真实测试群，默认群名固定为 `coding-anywhere-autotest`；脚本会先执行 `/ca project current` 校验当前群已绑定到 `coding-anywhere-autotest`，再从 `/ca` 开始点击 `查看项目`、点击 `当前项目`、点击 `线程列表`、检查 `/ca status`，不会自动改绑
6. 两类 smoke 都会默认拒绝非 `coding-anywhere-autotest` 项目；group smoke 还会额外拒绝非默认测试群 `coding-anywhere-autotest`。如确实需要覆盖到别的项目或群夹具，必须显式设置 `FEISHU_LIVE_ALLOW_NON_AUTOTEST=1`
7. smoke 还会请求 `/ops/overview` 确认本地 bridge 控制面可达；如需覆盖地址，设置 `FEISHU_LIVE_OPS_BASE_URL`
8. 如需追加一条额外 smoke 指令，可设置 `FEISHU_LIVE_SMOKE_TEXT` 与 `FEISHU_LIVE_EXPECT_TEXT`；如需调整会话选择或输入框定位，可设置 `FEISHU_LIVE_CONVERSATION_NAME`、`FEISHU_LIVE_COMPOSER_SELECTOR`
9. 登录态失效时，重新运行 `npm run test:feishu:auth` 刷新 profile
10. 如果某个问题暂时没有被现有 smoke 覆盖，需要在任务执行过程中临时追加真实联调，也必须沿用同一套规则：DM 先确认或切换到 `coding-anywhere-autotest`，群聊先确认群名和 `/ca project current` 都指向 `coding-anywhere-autotest`；不满足条件时应先停下补夹具，而不是直接在业务会话里验证

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
11. `tests/codex-cli-runner.test.ts` 现在会直接回放 `plan-mode.jsonl` 与 `sub-agent.jsonl`，校验 native 计划事件和子代理生命周期事件是否被归一化成正确的 runner 事件；同时覆盖新版 `event_msg` / `response_item` JSONL、重复 assistant 文本去重，以及 `task_complete(last_agent_message:null)` 非 0 退出时的明确错误诊断
12. `tests/bridge-real-codex.test.ts` 现在也会用同一批 fixture 校验 bridge 层的等待态、工具调用观测和最终回复，不要求额外真实 Codex 调用
13. `tests/feishu-card-action-service.test.ts`、`tests/feishu-card-builder.test.ts`、`tests/bridge-service.test.ts` 现在会覆盖计划模式单次开关、诊断卡切换、todo list 展示、待回答计划选择题，以及续跑同一 native thread 的桥接链路
14. `tests/codex-preferences.test.ts` 会锁定 Codex 模型候选项规则：GPT 家族按数值版本倒序、大小写统一显示为 `GPT-*`，并能把本机 Codex config / profile 中大小写混杂的模型 ID 去重归一
15. `tests/codex-desktop-completion-observer.test.ts` 与 `tests/codex-desktop-lifecycle-observer.test.ts` 会分别锁定 completion 兼容层和完整 lifecycle observer：既覆盖 offset 读取、`task_complete` 检测、最终 assistant 正文提取和稳定 `completionKey`，也覆盖 `task_started` / `agent_message` / `update_plan` / `shell_command` 组合下的公开进度快照、稳定 `runKey` 和跨轮询累计命令计数
16. `tests/desktop-completion-routing.test.ts` 会用本地 SQLite store + 小型 catalog double 校验桌面 completion 的本地投递目标解析：同一 native thread 有多个话题绑定时会选择首选绑定；项目群 fallback 会先看精确 `projectKey`，再看唯一 cwd 命中；cwd 命中多个项目时不会猜测，而是退回 DM 或明确报出 DM owner 歧义错误
17. `tests/desktop-completion-card-builder.test.ts` 会锁定桌面生命周期卡在运行中 / 已完成两态下的字段顺序、按钮、计划清单和 payload 预算行为：运行态必须先显示“你最后说了什么”再显示当前情况，完成态则必须先显示提醒区、再显示直接内嵌的最终正文，而且不能再冒出独立的 `进度 / Ran N commands` 区块
18. `tests/config.test.ts`、`tests/doctor.test.ts` 与 `tests/feishu-adapter.test.ts` 现在会额外锁定飞书 allowlist 的新语义：缺省 allowlist 会回退为空数组、`doctor` 不再把“未配置 allowlist”视为阻塞，而空 allowlist 下的消息也能正常进入 bridge
19. `tests/desktop-completion-notifier.test.ts` 会校验桌面 lifecycle 投递器在 DM / 已绑定话题 / 项目群三种目标下的运行态卡创建、完成态原卡 patch、thread anchor 复用、成功后才推进 `lastNotifiedCompletionKey`，以及完成态正文直接内嵌在同一张卡里而不是额外补发第二条结果消息
20. `tests/desktop-completion-dm-handoff.test.ts` 会用真实 `BridgeService` + `FeishuCardActionService` harness 校验 DM 通知卡主按钮 `continue_desktop_thread`：点击后会把 DM 绑定到目标 native thread、回调直接返回标准“当前会话”卡，且下一条普通 DM 文本会续跑同一线程
21. `tests/runtime-desktop-completion-notifier.test.ts` 会校验 runtime 启动后真的开始轮询本地 rollout：首次 bootstrap watch state 时不会回放历史 run / completion，新的顶层 desktop run 会先创建一张运行态卡、在公开进展变化时 patch，并在真正 `task_complete` 后原地收口为完成态；如果旧 completion 之后又继续出现同一轮顶层公开进展，就必须优先维持进行中态；unchanged `completionKey` 不会重复推送，`sourceInfo.kind = subagent` 的子线程不会触发生命周期通知，近期飞书终态 run 对应的 desktop 回声也不会再额外发卡
22. `tests/codex-app-directive.test.ts`、`tests/feishu-assistant-message.test.ts` 与 `tests/feishu-adapter.test.ts` 会共同锁定飞书 assistant 最终结果里的 Codex app git directive 渲染：顶层 `::git-*` 行必须被隐藏，Feishu-visible 结果应保留自然语言结论，并在可解析时补上一条 `N 个文件已更改` 的紧凑摘要，同时不暴露文件名或 `+/-` 统计

这组测试默认会跳过真实 Codex 调用，并通过临时工作区自动清理现场。

## 16. 一句话总结

这个项目现在已经从“飞书私聊直连 Codex”演进到：

**一个支持 DM / 群话题线程、文本与图片桥接、线程级会话、run 级 worker、线程内回推和项目/线程/run 三层观测的单实例桥接服务。**
