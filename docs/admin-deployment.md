# 管理员部署手册

这份手册面向实际负责部署、升级、重启和维护 `Coding Anywhere` 的管理员。

目标不是解释产品怎么用，而是回答这几个问题：

- 这套服务应该怎么部署
- 需要准备什么环境
- 如何长期稳定运行
- 如何升级和回滚
- 出问题时先查什么
- 后台任务观测应该从哪里看

## 1. 部署目标

当前版本最适合的部署目标是：

- 1 个飞书应用
- 1 个桥接服务实例
- 1 台运行 `codex` 的主机
- 1 个受控 root 目录

这不是一个多副本、高可用、无状态横向扩缩容服务。当前版本更像一个“单实例专用执行器”。

## 2. 推荐拓扑

推荐部署拓扑如下：

```text
飞书 DM
  -> 飞书长连接事件
  -> Coding Anywhere
  -> Codex CLI
  -> Codex
  -> CA 回写飞书
```

其中：

- 飞书负责消息入口
- Coding Anywhere 负责路由、会话绑定、消息回写
- SQLite 负责持久化 root、session 与 backend observability run/event
- `codex exec` / `codex exec resume` 负责实际执行和续跑线程
- Codex 负责实际代码任务

## 3. 单实例原则

当前版本必须遵守一个原则：

**同一个飞书应用，同一时刻只保留一个 Coding Anywhere 实例对外工作。**

原因：

- 长连接事件模式不是为多副本广播设计的
- 多实例同时运行会让排查变复杂
- 重启时如果旧实例没关干净，最容易出现重复回复、状态错乱、误判故障

管理员部署时，优先保证“单实例、可重启、易观察”，而不是多实例。

## 4. 环境前提

部署前至少要满足以下条件：

- Node.js 已安装
- `npm install` 能正常完成
- 本机可运行 `codex`
- 部署机全局 `codex` CLI 版本与日常使用的 Codex 桌面端版本尽量接近；如果两边版本差距过大，桌面端创建的 native thread 在 bridge 里续跑时更容易遇到 JSONL 协议或空输出诊断问题
- 飞书应用已配置好机器人与长连接事件
- 至少有一个可访问的本地 root 目录

## 5. 目录约定

建议把部署目录固定下来，不要频繁移动项目位置。

示例：

```text
D:\services\feishu-codex-bridge
```

项目目录内关键位置：

- `config.example.toml`
- 本地 `config.toml`
- `data/bridge.db`
- `logs/`
- `docs/`
- `dist/`

## 6. 首次部署步骤

### 第一步：拉取代码并安装依赖

```bash
npm install
```

### 第二步：初始化配置

```bash
npm run init:config
```

说明：

- 仓库只提交 `config.example.toml`
- `npm run init:config` 会在本地生成或补齐 `config.toml`
- 真实 `config.toml` 只保留在部署机，不提交到 git
- 当前正式配置段是 `[codex]`；旧 `[acpx]` 仍可作为兼容别名读取，但不再建议继续使用

### 第三步：填写 `config.toml`

最关键的是这些字段：

- `feishu.appId`
- `feishu.appSecret`
- `feishu.allowlist`（按需）
- `feishu.encryptKey`
- `feishu.reconnectCount`
- `feishu.reconnectIntervalSeconds`
- `feishu.reconnectNonceSeconds`
- `codex.command`
- `[root]`

推荐把 `root.cwd` 指向一个“项目父目录”，而不是整个磁盘。

如果你要启用飞书导航卡按钮回调，飞书应用后台要把“事件与回调”的订阅方式配置成：

```text
使用长连接接收事件/回调
```

这样本地 Coding Anywhere 只需要主动连飞书，不需要额外暴露公网回调地址。

如飞书后台开启了加密推送，`encryptKey` 必须与本地配置一致。

关于 `feishu.allowlist`：

- 留空数组时，表示不做飞书用户白名单校验
- 只有显式填入非空 `open_id` 列表后，bridge 才会按用户放行
- 一旦启用 allowlist，只放可信用户

### 第四步：执行预检

```bash
npm run doctor
```

只有在 `doctor` 没有阻塞项时才进入下一步。

### 第五步：构建

```bash
npm run build
```

### 第六步：启动

```bash
npm run start
```

### 第七步：做最小联调

先看本机：

```text
http://127.0.0.1:3000/readyz
```

再在飞书里发送：

```text
/ca status
```

如果这两步都正常，再继续更复杂的联调。

然后建议立即打开：

```text
http://127.0.0.1:3000/ops/ui
```

确认后台观测页也能正常加载。

## 7. 配置项管理员视角说明

### `[server]`

- `host`
- `port`

建议：

- 开发阶段可保持 `127.0.0.1`
- 如无明确需要，不要暴露到公网

### `[storage]`

- `sqlitePath`
- `logDir`

建议：

- 放到稳定目录
- 定期备份 `data/bridge.db`
- 定期清理 `logs/`

### `[codex]`

- `command`

建议：

- 默认保持 `command = "codex"`
- 升级或排障后执行 `codex --version`，确认当前服务实际调用的是哪个 CLI；Windows 上还可以用 `where codex` 检查 PATH 中是否同时存在 npm 安装版和 Codex 桌面端自带版

### `[feishu]`

- `appId`
- `appSecret`
- `apiBaseUrl`
- `websocketUrl`
- `allowlist`
- `requireGroupMention`
- `encryptKey`
- `reconnectCount`
- `reconnectIntervalSeconds`
- `reconnectNonceSeconds`

建议：

- `allowlist` 可留空；若启用，只放受信任用户
- 飞书后台的事件与回调订阅方式使用“长连接”
- 如果飞书后台开启加密推送，就同步填写 `encryptKey`
- `reconnectCount = -1` 表示无限重试，建议保留默认值
- 生产环境不要把真实凭据提交进 git

### `[root]`

CA root 至少要有：

- `id`
- `name`
- `cwd`
- `repoRoot`
- `branchPolicy`
- `permissionMode`
- `envAllowlist`
- `idleTtlHours`

建议：

- `id` 简短稳定，例如 `main`
- `cwd` 指向一个真实的项目父目录
- `repoRoot` 与 `cwd` 保持一致或更严格的边界
- `permissionMode` 默认使用 `workspace-write`

## 8. Windows 上的推荐运行方式

当前项目已经为 Windows 的 `npm run start` 做了 UTF-8 启动器适配，所以日常启动优先使用：

```bash
npm run start
```

如果你更偏好一键脚本，也可以直接使用仓库根目录的：

```text
start-coding-anywhere.cmd
stop-coding-anywhere.cmd
```

不要长期依赖：

```bash
npm run dev
```

因为 `dev` 是 `tsx watch`，更适合开发，不适合长期常驻。

### 推荐方式 A：管理员手动启动

适合：

- 个人使用
- 小规模内部使用
- 仍在联调阶段

方式：

1. 打开新终端
2. 进入项目目录
3. 执行 `npm run start`

### 推荐方式 B：Windows 计划任务

适合：

- 需要机器开机自动启动
- 不想手工每次点启动

建议做法：

1. 创建一个启动脚本
2. 开机时自动执行
3. 脚本内容只做一件事：进入目录并运行 `npm run start`

### 推荐方式 C：用服务管理器包装

如果你习惯使用 Windows 服务管理器或类似 NSSM 的工具，也可以把：

```text
node scripts/start.mjs
```

作为实际启动命令。

关键原则只有一条：

**永远只保留一个活跃实例。**

## 9. 日常运维动作

### 查看服务是否在线

本机检查：

```text
http://127.0.0.1:3000/healthz
http://127.0.0.1:3000/readyz
http://127.0.0.1:3000/ops/ui
```

飞书检查：

```text
/ca status
```

### 查看后台任务轨迹

管理员还可以直接查看：

```text
http://127.0.0.1:3000/ops/ui
http://127.0.0.1:3000/ops/overview
http://127.0.0.1:3000/ops/runtime
http://127.0.0.1:3000/ops/runs
http://127.0.0.1:3000/ops/sessions
```

建议使用方式：

1. `/ops/ui` 看当前正在跑什么、排队了什么、正在取消什么、最近失败了什么、最近取消了什么
2. `/ops/runtime` 看实时 active / queued / canceling / locks 快照
3. `/ops/runs/:id` 看单条任务的完整时间线
4. `/ops/sessions` 看当前 thread 到 session 的对应关系

### 查看当前功能是否可用

飞书里按顺序测试：

1. `/ca status`
2. `test`
3. `/ca session`
4. `/ops/ui`

### 重启服务

推荐顺序：

1. 关闭旧实例
2. 确认旧实例真的退出
3. 再启动新实例
4. 立即检查 `readyz`
5. 飞书里发 `/ca status`

## 10. 升级流程

每次升级建议按下面顺序执行：

1. 备份 `config.toml`
2. 备份 `data/bridge.db`
3. 拉取最新代码
4. 运行：

```bash
npm install
npm run build
npm test
npm run doctor
codex --version
```

5. 停掉旧实例
6. 启动新实例：

```bash
npm run start
```

7. 按 [项目总说明](./project-full-overview.md) 里的“推荐验证路径”做一轮最小回归
8. 再打开 `/ops/ui` 和 `/ops/runtime` 确认后台观测也正常

## 11. 回滚流程

如果升级后出现异常，建议用最保守的方式回滚：

1. 停掉当前实例
2. 切回上一个可用提交
3. 恢复对应版本的 `config.toml`
4. 如有必要，恢复 `data/bridge.db`
5. 重新执行：

```bash
npm run build
npm run start
```

6. 再做一次最小联调：

```text
/ca status
test
```

7. 确认 `/ops/ui`、`/ops/runtime` 和 `/ops/overview` 也恢复正常

## 12. 建议的管理员检查清单

每天或每次改动后，管理员至少确认：

- `readyz` 正常
- 飞书 `test` 不重复回复
- `/ca status` 正常
- `/ops/ui` 能看到告警队列、最近失败/取消，以及任务详情
- 当前只运行了一个实例
- `config.toml` 没被误改

## 13. 安全建议

当前版本至少遵守这几条：

- 如启用 `allowlist`，只把可信用户加入其中
- 不把真实 `appSecret` 提交到 git
- 不随便把 `permissionMode` 改成 `danger-full-access`
- root 路径要明确，不要把整个盘符都作为 `repoRoot`

## 14. 日志和状态建议

管理员排障时优先看 5 类信息：

1. 本机控制台输出
2. `readyz`
3. `/ops/ui`、`/ops/runtime` 与 `/ops/overview`
4. 飞书 `/ca status`
5. [故障排查手册](./troubleshooting.md)

如果这 5 类信息都对不上，再去查更深层的问题。

## 15. 最小上线标准

如果你要把它当成“日常可用”的桥接服务，建议至少满足下面这些条件：

- 能稳定执行 `npm run start`
- 重启后 `readyz` 正常
- 飞书 `test` 只回复 1 次
- `/ca status`、`/ca session`、`/ca new` 正常
- `/ops/ui` 能看到 `活跃任务 / 排队任务 / 取消中 / 最近失败 / 最近取消`，并能继续点开时间线详情
- 至少有一个 root 可用
- 管理员知道如何重启、升级、回滚

## 16. 管理员最常用的命令

```bash
npm run doctor
npm test
npm run build
npm run start
```

## 17. 最推荐的管理员工作流

最推荐的稳定工作流是：

1. 改代码
2. `npm test`
3. `npm run build`
4. `npm run doctor`
5. 停旧实例
6. `npm run start`
7. 飞书里发 `/ca status`
8. 飞书里发 `test`
9. 打开 `/ops/ui` / `/ops/runtime` 确认 run 已落库且实时状态正常
10. 通过后再继续使用

这套流程虽然朴素，但对当前版本最稳。

补充说明：

- 本手册中的 `3000` 是 `config.example.toml` 的默认端口；如果你在本地修改了 `[server].port`，请替换成实际端口
