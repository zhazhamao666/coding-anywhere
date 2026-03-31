# 飞书配置说明

> 推荐做法：直接使用飞书官方的 [一键创建一个 OpenClaw 机器人](https://open.feishu.cn/page/openclaw)，然后把生成好的飞书应用凭据填回 `Coding Anywhere`。

## 一句话推荐

优先走这条路径：

1. 登录飞书后打开官方一键创建入口。
2. 按官方流程把飞书应用创建出来。
3. 拿到这套应用的 `App ID`、`App Secret`。
4. 把它们填回本项目的 `config.toml`。
5. 用长连接方式配置事件和卡片回调。
6. 执行 `npm run doctor`，确认本地配置无误后再启动服务。

如果你已经有一个可用的飞书应用，也可以直接复用，不需要重新创建。

## 1. 创建飞书应用

官方入口：

- [一键创建一个 OpenClaw 机器人](https://open.feishu.cn/page/openclaw)

说明：

- 这个链接会先跳到飞书登录页；这是正常现象，登录企业飞书后再继续即可
- 如果企业策略不允许直接使用一键创建，就在飞书开发者平台手动创建企业自建应用，并添加“机器人”能力

创建完成后，确认应用已经具备：

- 企业自建应用
- 机器人能力
- 正常可发布的应用版本
- 能接收消息事件
- 能读取消息里的图片资源
- 能上传图片并发送原生图片消息

## 2. 获取 App ID 和 App Secret

在目标应用的“基础信息 -> 凭证与基础信息”里记录：

- `App ID`
- `App Secret`

这两个值要分别填到：

- `feishu.appId`
- `feishu.appSecret`

注意：

- 这是飞书开放平台调用凭据，不要提交到 git
- `config.example.toml` 里的 `cli_xxx` 和 `replace-me` 只是占位值

## 3. 发布应用版本

只要你修改过能力、权限、事件或回调配置，都要确认：

1. 已创建版本
2. 已确认发布
3. 如果企业有管理员审核流程，已经审核通过

很多“后台明明配好了但机器人没反应”的问题，最后都卡在“改完没发布”。

## 4. 配置事件订阅

进入“开发配置 -> 事件与回调”，在“事件配置”里确认：

1. 订阅方式是“使用长连接接收事件”
2. 已经添加消息接收事件

对 `Coding Anywhere` 来说，至少要保证“接收消息”链路是通的。

说明：

- inbound 图片不会走单独事件类型，仍然通过同一条“接收消息”链路进入服务
- bridge 会从消息内容里解析 `image_key`，再调用“获取消息中的资源文件”接口下载图片

## 5. 配置卡片回调

在同一个“开发配置 -> 事件与回调”页面的“回调配置”里确认：

1. 订阅方式是“使用长连接接收回调”
2. 已添加卡片交互回调

原因很简单：

- `Coding Anywhere` 的导航卡按钮依赖飞书卡片交互回调
- 当前项目就是通过飞书长连接直接处理按钮点击并回卡

## 6. 按需打开群聊能力

如果你只打算先在飞书 DM 里使用，可以先把目标限定在私聊联通，不急着开群聊敏感权限。

如果你还希望把机器人拉进群里，用在“已注册的话题线程”场景里，就需要再确认两件事：

1. 飞书后台已经允许机器人接收群消息
2. 你是否要在项目配置里开启 `feishu.requireGroupMention = true`

建议：

- 想降低误触发，设为 `true`
- 想让已注册线程里的消息默认都能进入服务，保留 `false`

## 7. 图片能力额外检查

如果你要启用“飞书图片 <-> Codex”链路，还要额外确认：

1. 应用已经具备读取消息资源的权限，否则 bridge 拿不到 inbound 图片二进制
2. 应用已经具备上传图片、发送图片消息的权限，否则 outbound 图片只能退回文本说明
3. 发送给飞书的单张图片需要满足飞书原生图片接口限制；当前实现按官方常见限制以 `10MB` 作为可发送上限参考，超限图片应在生成侧先压缩或改走文件链路

## 8. 按需配置加密推送

如果你在飞书后台启用了事件或回调加密推送，再把飞书后台里的加密密钥填到：

- `feishu.encryptKey`

如果后台没有开启加密推送，就保持空字符串：

```toml
encryptKey = ""
```

## 9. 把飞书应用信息填回 Coding Anywhere

飞书侧准备好之后，回到项目目录执行：

```bash
npm run init:config
```

然后把 `config.toml` 里的 `[feishu]` 段改成真实值。一个最常见的写法如下：

```toml
[feishu]
appId = "cli_xxx"
appSecret = "replace-me"
websocketUrl = "wss://open.feishu.cn/open-apis/bot/v2/hub"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = ["ou_xxx"]
requireGroupMention = false
encryptKey = ""
```

字段对应关系：

| 飞书后台值 | `config.toml` 字段 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `App ID` | `feishu.appId` | 是 | 飞书开放平台应用凭据 |
| `App Secret` | `feishu.appSecret` | 是 | 飞书开放平台应用凭据 |
| 当前实际使用人的 `open_id` | `feishu.allowlist` | 是 | `ou_xxx` 只是占位值，必须替换 |
| 加密密钥 | `feishu.encryptKey` | 按需 | 只有飞书后台启用了加密推送才填 |
| 群消息是否必须 `@` 机器人 | `feishu.requireGroupMention` | 按需 | 这是项目侧开关，不是飞书后台字段 |

两个通常不用改的默认值：

- `feishu.websocketUrl = "wss://open.feishu.cn/open-apis/bot/v2/hub"`
- `feishu.apiBaseUrl = "https://open.feishu.cn/open-apis"`

## 10. 启动前最小检查清单

在项目目录里按顺序执行：

```bash
npm run doctor
```

确认 `doctor` 至少不再报告这些阻塞项：

- `feishu.appId`
- `feishu.appSecret`
- `feishu.allowlist`

然后再启动服务，并做最小联调：

1. 飞书 DM 发送 `/ca`
2. 确认能收到导航卡
3. 飞书 DM 先发送一张图片
4. 确认只收到“已收到图片，请继续发送文字说明”
5. 再发送 `test`
6. 确认服务有最终回复，并且这次 run 会带上刚才暂存的图片

如果你还需要群线程能力，再继续按 [项目总说明](./project-full-overview.md) 里的“推荐验证路径”做线程侧回归。

## 11. 最容易踩的坑

- `allowlist` 里还留着 `ou_xxx` 占位值
- 飞书后台改完能力、权限、事件或回调后，没有重新发布版本
- 事件配置或回调配置被误设成了 HTTP，而不是长连接
- 飞书后台打开了加密推送，但 `config.toml` 里的 `feishu.encryptKey` 仍然为空
- 想在群话题线程里使用，但后台没开群消息权限，或者项目里把 `feishu.requireGroupMention` 设成了 `true` 却没有带 mention
- 图片消息能收到，但应用没有“读取消息资源”能力，导致服务拿不到图片文件
- Codex 已经产出本地图片，但应用没有“上传图片 / 发送图片消息”能力，导致 bridge 只能回文本降级说明
- 生成图片超过飞书原生图片消息可接受的大小，导致上传失败

## 参考链接

- 飞书官方一键入口：[一键创建一个 OpenClaw 机器人](https://open.feishu.cn/page/openclaw)
