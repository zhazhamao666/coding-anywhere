# 故障排查手册

这份手册聚焦当前实现已经接通的 DM 与群线程链路。

## 先做的基础检查

先依次检查：

1. `npm run doctor`
2. `http://127.0.0.1:3000/readyz`
3. `http://127.0.0.1:3000/ops/overview`
4. 飞书里发 `/ca status`

## 现象 1：DM 正常，但群线程完全没有反应

最可能原因：

- 这条群消息不在原生话题线程里
- 本地没有该 `(chat_id, thread_id)` 的注册记录
- 开启了 `feishu.requireGroupMention`，但消息没带 mention

检查方法：

- 确认消息是否发在话题线程内
- 检查 `codex_threads` 是否有对应记录
- 检查 `config.toml` 里的 `feishu.requireGroupMention`

处理动作：

- 把消息放到已注册线程里发送
- 先补齐线程注册
- 或者带 mention 后重试

## 现象 2：群线程里有状态或结果，但回到了 DM

最可能原因：

- 线程消息没有正确带上 `message_id`
- adapter 没识别成线程 surface

检查方法：

- 看 `/ops/runs/:id` 里的 `delivery_chat_id` / `delivery_surface_ref`
- 看 run 是否写成了 thread 类型

处理动作：

- 确认飞书事件里有 `chat_id` 和 `thread_id`
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

## 现象 5：`/ops/projects` 有数据，但线程消息仍然报 `THREAD_NOT_REGISTERED`

最可能原因：

- 项目存在，但对应飞书线程没有注册

检查方法：

- 看 `/ops/projects/<project-id>/threads`
- 确认目标 `thread_id` 是否真的在列表里

处理动作：

- 先补齐该飞书话题和本地 `codex_threads` 的映射

如果当前还没有线程记录，可以先执行：

```text
/ca thread create <projectId> <title...>
```

如果你已经在目标项目群里，也可以直接用：

```text
/ca project current
/ca thread create-current <title...>
/ca thread list-current
```

## 现象 6：不带 mention 的群线程消息被忽略

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

- `/ops/ui` 现在已经支持 live / queued / 历史时间线，但项目 / 线程视图仍主要通过 JSON 接口 drill-down
- 连续流式文本事件现在会做聚合展示，不会逐 chunk 展开

检查方法：

- 直接访问：

```text
http://127.0.0.1:3000/ops/projects
http://127.0.0.1:3000/ops/threads/<thread-id>
```

处理动作：

- 项目和线程视图优先走 JSON 接口排查

## 现象 10：`readyz` 正常，但群线程仍不触发

最可能原因：

- 服务健康，但飞书线程可见性或群权限不满足

检查方法：

- 确认机器人能看到该话题
- 确认消息事件里包含目标线程的 `thread_id`

处理动作：

- 改用机器人自己创建或已确认可见的话题

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
