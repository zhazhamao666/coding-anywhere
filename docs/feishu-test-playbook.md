# 飞书标准测试剧本

这份剧本覆盖当前已经实现的两条链路：

- DM 链路
- 已注册群线程链路

## 开始前检查

先在本机执行：

```bash
npm run doctor
npm run start
```

再确认：

- `http://127.0.0.1:3100/readyz` 返回 `{"status":"ready"}`
- 飞书机器人在线
- 飞书应用已经配置为“使用长连接接收事件/回调”
- 如果要测群线程，数据库中已经有对应的 `project_chats` / `codex_threads` 记录

## 测试目标

本剧本覆盖：

1. DM 命令链路
2. DM 普通消息链路
3. 导航卡按钮回调
4. 群线程路由
5. mention-only 群线程兜底
6. 线程级 session 重置
7. 线程级 run 观测
8. 空闲线程回收
9. 项目群绑定与线程创建命令

## 测试 1：DM 基础连通性

飞书 DM 发送：

```text
/ca
/ca status
```

预期：

- `/ca` 返回 1 张导航卡
- `/ca help` 或未知子命令会回到同一张导航卡
- DM 中的导航卡包含当前 session 和项目入口
- 导航卡底部至少有“导航”“会话状态”“当前会话”“新会话”“项目列表”按钮
- 返回 `[ca] root=... session=... status=idle`

## 测试 2：DM 中浏览 Codex 项目和线程

在 DM 里先发送：

```text
/ca
```

然后依次点击卡片按钮：

- `项目列表`
- 任意项目行上的 `查看线程`
- 任意线程行上的 `切换到此线程`

预期：

- 点击后卡片会原地更新，而不是完全无响应
- `项目列表` 会读取本机 Codex `state_*.sqlite`
- `查看线程` 会进入该项目对应的线程列表卡
- `切换到此线程` 会返回“线程已切换”确认卡
- 切换后继续在这个 DM 里发送普通消息，会进入被选中的 Codex 原生线程

## 测试 3：群聊 / 已注册线程里的导航按钮回调

在已绑定项目群或已注册线程里先发送：

```text
/ca
```

然后依次点击卡片按钮：

- `导航`
- `当前项目`
- `线程列表`

预期：

- 点击后卡片会原地更新，而不是完全无响应
- `导航` 会回到当前上下文的 `/ca`
- `当前项目` 会在已绑定项目群里显示项目摘要；如果当前上下文没有项目，则返回提示卡
- `线程列表` 会在已绑定项目群里显示线程列表；如果当前上下文没有项目，则返回提示卡

## 测试 4：DM 普通消息直通 Codex

飞书 DM 发送：

```text
test
```

预期：

- 先出现状态卡
- 最终只回 1 条文本
- `/ops/runs` 能看到新增 run

如果前一步已经切到了某个 Codex 原生线程，则预期这条消息会继续进入那个线程。

## 测试 5：DM 会话重置

飞书 DM 发送：

```text
/ca new
/ca session
```

预期：

- 如果当前 DM 绑定的是普通 CA session，则 `session` 返回新的 sessionName
- 如果当前 DM 刚刚切到了某个 Codex 原生线程，则 `/ca new` 会清掉这个选择，并切回一个新的 CA session

## 测试 6：已注册群线程普通消息

前提：

- 群线程已经在本地 SQLite 中注册

如果还没有注册，可以先执行：

```text
/ca project bind proj-a oc_chat_1 coding-anywhere Demo Project
/ca project bind-current proj-a coding-anywhere Demo Project
/ca
/ca project current
/ca thread create proj-a feishu-nav
/ca thread create-current follow-up
```

在线程里发送：

```text
继续处理当前问题
```

预期：

- 消息被路由到对应线程 session
- 结果回复在原线程内，不回 DM
- `/ops/threads/:id/runs` 能看到这条 run

## 测试 7：群线程 mention-only 兜底

前提：

- `feishu.requireGroupMention = true`

在线程里先发送不带 mention 的消息：

```text
继续处理
```

预期：

- 不进入 Codex

再发送带 mention 的消息。

预期：

- 消息进入 Codex

## 测试 8：线程内 `/ca new`

在线已注册线程里发送：

```text
/ca new
/ca session
```

预期：

- 线程对应的 sessionName 发生变化
- 后续继续在该线程内发普通消息时，使用新的 session

## 测试 9：项目 / 线程观测接口

依次打开：

```text
http://127.0.0.1:3100/ops/projects
http://127.0.0.1:3100/ops/projects/<project-id>/threads
http://127.0.0.1:3100/ops/threads/<thread-id>
http://127.0.0.1:3100/ops/threads/<thread-id>/runs
```

预期：

- 能看到项目摘要
- 能看到线程状态和最近 run
- 能看到该线程的 run 历史

## 测试 10：线程空闲回收

前提：

- 线程状态已经回到 `warm`
- 超过 `root.idleTtlHours`

预期：

- runtime 会关闭该线程 session
- 线程状态进入 `closed`

## 测试 11：项目群绑定与线程创建

飞书里发送：

```text
/ca project bind proj-a oc_chat_1 coding-anywhere Demo Project
/ca project bind-current proj-a coding-anywhere Demo Project
/ca project current
/ca project list
/ca thread create proj-a feishu-nav
/ca thread create-current follow-up
/ca thread list proj-a
/ca thread list-current
```

预期：

- `project bind` 返回绑定成功
- `project bind-current` 在群主时间线里返回绑定成功
- `hub` 返回当前群上下文导航卡，并带当前项目线程摘要
- `project current` 返回当前项目摘要卡，并带项目 ID、chatId 和 cwd
- `project list` 返回项目列表卡，并能看到目标项目
- `thread create` 返回线程摘要卡，并带线程 ID、标题和 session
- `thread create-current` 在当前项目群主时间线里返回线程摘要卡，并带线程 ID、标题和 session
- `thread list` 和 `thread list-current` 都返回线程列表卡，并能看到新线程

## 最小回归建议

每次改代码后至少验证：

1. `/ca status`
2. `/ca`
3. DM 发 `test`
4. 已注册线程发 1 条普通消息
5. `/ops/projects`
6. `/ops/threads/<thread-id>/runs`
