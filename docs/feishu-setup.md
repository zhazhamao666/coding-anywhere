# Feishu App Setup

这份清单用于拿到 `config.toml` 里需要的真实值。

## 1. 创建企业自建应用

1. 打开 `https://open.feishu.cn`
2. 进入应用管理，创建企业自建应用
3. 填写应用名称、描述和图标

## 2. 复制凭据

在“凭证与基础信息”里复制：

- `App ID`
- `App Secret`

将它们分别填入：

- `feishu.appId`
- `feishu.appSecret`

## 3. 开启机器人能力

在“应用能力 -> 机器人”中：

1. 启用机器人能力
2. 设置机器人名称

## 4. 配置事件订阅

在“事件订阅”中：

1. 选择“使用长连接接收事件（WebSocket）”
2. 添加事件 `im.message.receive_v1`

## 5. 配置权限

按已验证的 Feishu/OpenClaw 基线，至少确认具备消息接收与发送相关权限，重点检查：

- `im:message`
- `im:message:readonly`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`
- `im:chat.access_event.bot_p2p_chat:read`

说明：

- 当前 Coding Anywhere 会优先使用飞书交互卡片与 CardKit 做实时状态反馈
- 如果你的环境里 CardKit 当前不可用，Coding Anywhere 会自动回退到普通交互卡片更新
- 因此基础消息权限必须可用，才能保证最差情况下仍有状态卡回写

## 6. 发布应用

1. 创建版本
2. 提交发布
3. 等待企业管理员审核或自动通过

## 7. 获取 allowlist 的 open_id

把真实用户 `open_id` 填到 `feishu.allowlist`。占位值 `ou_xxx` 只是示例，不能直接使用。

## 8. 运行本地预检

在项目目录执行：

```bash
npm run doctor
```

只有当 `doctor` 不再报告 `blocking` 项时，再启动服务。
