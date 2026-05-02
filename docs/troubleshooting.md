# 故障排查手册

这份手册聚焦当前产品化入口：DM 与已绑定项目群主时间线。飞书 topic / 话题 / 群 `thread_id` 主题不属于当前 live 或推荐真实联调 surface。

## 先做的基础检查

先依次检查：

1. `npm run doctor`
2. `http://127.0.0.1:3000/readyz`
3. `http://127.0.0.1:3000/ops/overview`
4. 飞书里发 `/ca status`

## 现象 1：DM 正常，但群主时间线完全没有反应

最可能原因：

- 飞书应用只开通了单聊消息权限，没有开通群消息或群 @ 机器人消息权限
- 目标群没有绑定到项目
- 开启了 `feishu.requireGroupMention`，但消息没带 mention

检查方法：

- 在飞书开放平台确认“接收消息 v2.0”事件已添加，且权限已按目标场景发布：直接群消息需要“获取群组中所有消息”，`@机器人` 场景至少需要群 @ 机器人消息权限
- 确认当前群已经通过 `/ca project bind-current` 或项目列表卡片绑定到 `coding-anywhere-autotest` 等目标项目
- 检查 `config.toml` 里的 `feishu.requireGroupMention`

处理动作：

- 先在群主时间线执行 `/ca project current` 自检
- 未绑定时先执行 `/ca project bind-current <projectId> <cwd> [name]`，或从项目列表卡片绑定当前群
- 或者带 mention 后重试

## 现象 1.1：DM 正常，但群里直接 `/ca` 完全没有反应

最可能原因：

- 飞书只会按照应用权限推送消息；未 @ 的群消息需要“获取群组中所有消息”权限
- 如果应用只有“群组中用户 @ 机器人消息”权限，群里直接 `/ca` 不会被推送到本地长连接，服务端日志也不会出现 `feishu recv chat_type=group`
- 应用权限、事件订阅或机器人能力改完后没有重新创建并发布版本

检查方法：

- 在飞书开发者后台确认机器人已经加入目标群
- 在“事件与回调”里确认订阅方式是“使用长连接接收事件”，并已添加“接收消息 v2.0”
- 在权限管理里确认已按预期申请并发布群消息权限

处理动作：

- 如果不想申请敏感权限，改用 `@机器人 /ca`
- 如果必须支持群里直接 `/ca`，申请“获取群组中所有消息”权限，发布新版本后重启 bridge

## 现象 2：群主时间线里有状态或结果，但回到了 DM

最可能原因：

- 群消息没有正确带上 `message_id`
- adapter 没识别成 group surface

检查方法：

- 看 `/ops/runs/:id` 里的 `delivery_chat_id` / `delivery_surface_ref`
- 看 run 是否写成了 group 类型

处理动作：

- 确认飞书事件里有 `chat_id`
- 确认当前运行的是最新版本代码

## 现象 3：线程里第二条任务一直不开始

最可能原因：

- 同一线程前一条 run 还在执行
- 当前 `scheduler.maxConcurrentRuns` 太小

检查方法：

- 看 `/ops/threads/<thread-id>/runs`
- 看 `/ops/overview` 的 `activeRuns`

处理动作：

- 等当前线程 run 完成
- 或提高 `scheduler.maxConcurrentRuns`
- 或换到另一个线程执行

## 现象 4：线程长时间不用后再次发消息，第一次变慢

最可能原因：

- 线程被 TTL 回收过
- session 需要重新 `ensure`

检查方法：

- 看线程状态是否已经是 `closed`
- 看最近活动时间是否已经超过 `root.idleTtlHours`

处理动作：

- 这是预期行为
- 再发一次普通消息即可重新 warm up

## 现象 5：`/ops/projects` 有数据，但当前会话仍然报 `THREAD_NOT_REGISTERED`

最可能原因：

- 项目存在，但当前 DM 或群主时间线还没有绑定到 native Codex thread

检查方法：

- 看 `/ops/projects/<project-id>/threads`
- 确认目标 `thread_id` 是否真的在列表里

处理动作：

- 先确认当前群已绑定项目，并把当前群会话切换到一个 native Codex thread

如果当前还没有 native thread，可以先执行：

```text
/ca new
```

如果你已经在目标项目群里，也可以直接用：

```text
/ca project current
/ca thread list-current
```

## 现象 6：不带 mention 的群主时间线消息被忽略

最可能原因：

- 已开启 mention-only 兜底模式

检查方法：

- 打开 `config.toml`
- 检查 `feishu.requireGroupMention`

处理动作：

- 带 mention 再发
- 或关闭该配置后重启服务

## 现象 7：线程里 `/ca new` 后仍像旧上下文

最可能原因：

- 你仍然基于旧任务结论继续追问
- 线程已切到新 session，但你没有重新描述上下文

检查方法：

- 立即在线程里执行 `/ca session`
- 确认 sessionName 是否变化

处理动作：

- 先 `/ca new`
- 再明确描述当前线程的新任务背景

## 现象 8：`/ca thread create` 报 `PROJECT_CHAT_NOT_CONFIGURED`

最可能原因：

- 这个项目还没有绑定飞书群

检查方法：

- 执行 `/ca project list`
- 看目标项目是否已经存在并带有 `chatId`

处理动作：

- 先执行：

```text
/ca project bind <projectId> <chatId> <cwd> [name]
```

如果你已经在目标项目群里，也可以直接用：

```text
/ca project bind-current <projectId> <cwd> [name]
```

## 现象 9：`/ops/ui` 看得到 run，但看不到项目 / 线程视图

最可能原因：

- `/ops/ui` 现在采用“告警优先”布局：首屏重点是 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消`，一般历史和会话快照已经降成次级区块
- `/ops/ui` 仍然主要围绕 run 观测与排障，不会把项目 / 线程管理直接做成首页主视图
- 连续流式文本事件现在会做聚合展示，不会逐 chunk 展开

检查方法：

- 直接访问：

```text
http://127.0.0.1:3000/ops/projects
http://127.0.0.1:3000/ops/threads/<thread-id>
```

处理动作：

- 项目和线程视图优先走 JSON 接口排查

## 现象 10：`readyz` 正常，但群主时间线仍不触发

最可能原因：

- 服务健康，但群权限、群绑定或 mention 条件不满足

检查方法：

- 确认机器人已经加入目标群
- 确认当前群已绑定项目
- 确认飞书后台已发布目标群消息权限

处理动作：

- 改用 `@机器人 /ca status` 验证群 @ 权限链路
- 需要不带 @ 的普通群消息时，申请并发布“获取群组中所有消息”权限

## 现象 11：导航卡能显示，但按钮点击后完全没反应

最可能原因：

- 飞书应用的“事件与回调”订阅方式没有切到“使用长连接接收事件/回调”
- 当前长连接只接了消息事件，没有成功接到回调事件
- 开启了加密推送，但本地 `encryptKey` 与飞书后台不一致

检查方法：

- 打开飞书应用后台，确认订阅方式已经切到“使用长连接接收事件/回调”
- 重启服务后观察长连接是否成功建立
- 如启用了加密推送，核对 `encryptKey`

处理动作：

- 把飞书应用改成长连接接收事件/回调
- 保持飞书后台与 `config.toml` 的加密配置一致
- 修改后重启服务，再重新发送 `/ca`

## 现象 12：飞书里回复 `[ca] error: RUN_STREAM_FAILED`

最可能原因：

- Codex CLI 子进程非 0 退出，但 stderr 没有给出可读错误
- bridge 版本太旧，未识别当前 Codex CLI 的新版 `event_msg` / `response_item` JSONL 输出
- 桌面端创建 thread 的 Codex 版本和部署机全局 `codex` CLI 版本差距过大

检查方法：

- 先看 `/ops/runs/<run-id>` 中的 `error_text`、`latest_preview` 和事件时间线
- 查对应 native thread 的 rollout，确认是否有 `task_complete`、`last_agent_message`、`agent_message` 或 `response_item`
- 在部署机执行：

```bash
codex --version
```

处理动作：

- 先升级到包含新版 JSONL 解析的 bridge 版本
- 尽量让桌面端 Codex 与部署机全局 `codex` CLI 版本保持接近
- 如果升级后错误变成 `CODEX_RUN_NO_ASSISTANT_OUTPUT`，说明 bridge 已经正确识别到 Codex turn 结束但没有 assistant 输出，继续按“现象 13”排查

## 现象 13：飞书里回复 `CODEX_RUN_NO_ASSISTANT_OUTPUT`

最可能原因：

- Codex CLI 确实启动并结束了 native turn，但 `task_complete.last_agent_message` 为空
- 本轮模型调用没有产出 assistant 正文，或被上游限制、超时、版本兼容问题提前收口

检查方法：

- 查看 `/ops/runs/<run-id>`，确认 run 是否进入 `error`
- 查对应 rollout 中最后一段事件，重点看：

```text
event_msg.task_started
event_msg.token_count
event_msg.task_complete(last_agent_message:null)
```

- 查看 token/rate limit 信息，确认是否出现额度或模型切换异常

处理动作：

- 先重试同一条消息；如果偶发恢复，按上游空输出处理
- 若稳定复现，升级全局 `codex` CLI 并重启 bridge
- 如果只在桌面端接管后的 thread 上复现，优先检查桌面端 Codex 与全局 `codex` CLI 的版本差距

## 现象 14：启动日志出现 `FEISHU_DESKTOP_OWNER_OPEN_ID_REQUIRED_FOR_DM_FALLBACK`

最可能原因：

- 桌面 completion 通知无法路由到项目群主时间线，需要退回 DM
- 当前本地数据库还没有见过任何 DM 用户，且 `allowlist` 为空、`desktopOwnerOpenId` 也为空
- 或者数据库里已经出现多个 DM 用户，系统无法安全判断该发给谁

检查方法：

- 确认你是否真的需要桌面 Codex 完成通知推送到飞书
- 在机器人 DM 里先发送一次 `/ca`，让 bridge 记住当前用户的 `open_id`
- 如果多人会使用同一个 bridge，显式配置 `feishu.desktopOwnerOpenId`

处理动作：

- 单用户本地使用：给机器人 DM 发一次 `/ca`，后续 fallback 会自动使用这个唯一 DM 用户
- 多用户或需要固定通知对象：把接收通知的用户 `open_id` 填入 `feishu.desktopOwnerOpenId` 后重启
- 不要填写机器人 ID；飞书主动发 DM 时目标必须是用户 `open_id`

## 常用排查入口

```bash
npm run doctor
npm test
npm run build
```

```text
http://127.0.0.1:3000/readyz
http://127.0.0.1:3000/ops/overview
http://127.0.0.1:3000/ops/projects
http://127.0.0.1:3000/ops/ui
http://127.0.0.1:3000/ops/runtime
```

补充说明：

- 本手册中的 `3000` 是 `config.example.toml` 的默认端口；如果你在本地修改了 `[server].port`，请替换成实际端口
