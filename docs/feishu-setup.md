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
- 一键创建出来的机器人通常不会默认打开群消息相关权限；如果要在群里使用，后续仍需手动到“权限管理”和“事件与回调”补齐下面第 4、6 节列出的权限与事件订阅

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

## 2.1 按需获取 `allowlist` / `open_id`

`feishu.allowlist` 不是飞书后台现成的一项“白名单配置”，而是 `Coding Anywhere` 本地配置里的“允许哪些飞书用户使用这套 bridge”的 `open_id` 列表。

如果你暂时不想做用户限制，可以直接保留：

```toml
allowlist = []
```

只有当你主动往 `allowlist` 里填入 `open_id` 时，bridge 才会开始按用户白名单校验。

如果你要配置 `allowlist`，最常见的 `open_id` 获取方式有 3 种：

1. 通过飞书官方 API 调试台获取
2. 通过飞书 OpenAPI 按手机号或邮箱查询
3. 直接从机器人收到的真实消息事件 payload 中读取

### 方式一：通过 API 调试台快速复制

官方文档：

- [如何获取指定用户的 Open ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-openid)
- [API 调试台](https://open.feishu.cn/api-explorer)

按官方文档的当前路径，进入 API 调试台后：

1. 找到“发送消息”接口
2. 把查询参数 `user_id_type` 设为 `open_id`
3. 点击“快速复制 open_id”
4. 搜索或选择目标成员
5. 复制得到形如 `ou_xxx` 的值

### 方式二：通过 OpenAPI 查询

官方文档：

- [通过手机号或邮箱获取用户 ID](https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id)

做法：

1. 给应用申请 `contact:user.id:readonly` 权限
2. 调用接口时把 `user_id_type` 设为 `open_id`
3. 请求里传用户邮箱或手机号
4. 从响应里的 `user_id` 读取 `ou_xxx`

### 方式三：直接从入站消息事件读取

官方文档：

- [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)

这个事件的官方结构里，本来就会带：

```json
event.sender.sender_id.open_id
```

所以如果你的机器人已经能收到该用户的消息，抓一次真实入站 payload，也可以直接拿到当前应用下的 `open_id`。

注意：

- `open_id` 是“应用内用户 ID”，同一个人在不同飞书应用里的 `open_id` 不同
- 不要把另一个飞书应用里的 `ou_xxx` 直接拿来填当前应用的 `allowlist`
- 用户 ID 概念差异可参考飞书官方的 [用户身份概述](https://open.feishu.cn/document/home/user-identity-introduction/introduction)

## 3. 发布应用版本

只要你修改过能力、权限、事件或回调配置，都要确认：

1. 已创建版本
2. 已确认发布
3. 如果企业有管理员审核流程，已经审核通过

很多“后台明明配好了但机器人没反应”的问题，最后都卡在“改完没发布”。

## 4. 配置事件订阅

进入“开发配置 -> 事件与回调”，在“事件配置”里确认：

1. 订阅方式是“使用长连接接收事件”
2. 已经添加“接收消息 v2.0”事件，对应事件类型是 `im.message.receive_v1`

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

如果你还希望把机器人拉进群里，用在“已绑定项目群主时间线”场景里，就需要再确认两件事：

1. 飞书后台已经允许机器人接收群消息
2. 你是否要在项目配置里开启 `feishu.requireGroupMention = true`

飞书“接收消息”事件会根据应用权限决定实际推送范围：

- 只开通单聊消息权限时，只会收到 DM
- 只开通“群组中用户 @ 机器人消息”权限时，只会收到 `@机器人 ...` 这类群消息
- 想让群里直接发送 `/ca` 或普通文本也能触发，需要申请并发布“获取群组中所有消息”权限；这是敏感权限，后台改完后必须创建并发布新版本

一键创建的 OpenClaw 机器人不一定会默认打开这些权限。进入“权限管理”后，至少按目标场景检查：

| 场景 | 需要开通的权限 |
| --- | --- |
| DM 私聊 | `读取用户发给机器人的单聊消息` |
| 群里 `@机器人 /ca` | `获取群组中用户@机器人消息`，或 `获取群组中其他机器人和用户@当前机器人的消息` |
| 群里直接 `/ca` | `获取群组中所有消息（敏感权限）` |

如果这次的问题表现为“DM 正常，但群里直接 `/ca` 没有任何日志和回复”，优先检查最后一项是否已经开通、创建版本并发布。

建议：

- 想降低误触发，设为 `true`
- 想让已绑定项目群主时间线里的消息默认都能进入服务，保留 `false`

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

说明：

- 仓库只提交 `config.example.toml`
- `npm run init:config` 会在本地生成可编辑的 `config.toml`
- 真实 `config.toml` 只保留在本机，不提交到 git

```toml
[feishu]
appId = "cli_xxx"
appSecret = "replace-me"
websocketUrl = "wss://open.feishu.cn/open-apis/bot/v2/hub"
apiBaseUrl = "https://open.feishu.cn/open-apis"
allowlist = []
requireGroupMention = false
encryptKey = ""
reconnectCount = -1
reconnectIntervalSeconds = 120
reconnectNonceSeconds = 30
```

字段对应关系：

| 飞书后台值 | `config.toml` 字段 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `App ID` | `feishu.appId` | 是 | 飞书开放平台应用凭据 |
| `App Secret` | `feishu.appSecret` | 是 | 飞书开放平台应用凭据 |
| 当前实际使用人的 `open_id`（按需） | `feishu.allowlist` | 否 | 空数组表示不做用户白名单校验；只有配置了非空 `open_id` 列表后，bridge 才会按用户放行 |
| 当前实际使用人的 `open_id`（按需） | `feishu.desktopOwnerOpenId` | 否 | 用于桌面 completion 无法路由到项目群主时间线时的 DM fallback；这是接收通知的人，不是机器人 ID。若本地只有一个已见 DM 用户、目标线程已绑定 DM，或 `allowlist` 只有一个用户，可留空 |
| 加密密钥 | `feishu.encryptKey` | 按需 | 只有飞书后台启用了加密推送才填 |
| 群消息是否必须 `@` 机器人 | `feishu.requireGroupMention` | 按需 | 这是项目侧开关，不是飞书后台字段 |
| 重连次数 | `feishu.reconnectCount` | 否 | `-1` 表示无限重试，建议保留默认值 |
| 重连间隔 | `feishu.reconnectIntervalSeconds` | 否 | 每次失败后的基础重试间隔，默认 `120` 秒 |
| 重连抖动 | `feishu.reconnectNonceSeconds` | 否 | 首次重试前附加的随机抖动上限，默认 `30` 秒 |

两个通常不用改的默认值：

- `feishu.websocketUrl = "wss://open.feishu.cn/open-apis/bot/v2/hub"`
- `feishu.apiBaseUrl = "https://open.feishu.cn/open-apis"`
- `feishu.reconnectCount = -1`
- `feishu.reconnectIntervalSeconds = 120`
- `feishu.reconnectNonceSeconds = 30`

## 10. 启动前最小检查清单

在项目目录里按顺序执行：

```bash
npm run doctor
```

确认 `doctor` 至少不再报告这些阻塞项：

- `feishu.appId`
- `feishu.appSecret`

如果你主动配置了 `feishu.allowlist`，还要额外确认：

- `allowlist` 里没有残留 `ou_xxx` 这类占位值

然后再启动服务，并做最小联调：

1. 飞书 DM 发送 `/ca`
2. 确认能收到导航卡
3. 飞书 DM 先发送一张图片
4. 确认只收到“已收到图片，请继续发送文字说明”
5. 再发送 `test`
6. 确认服务有最终回复，并且这次 run 会带上刚才暂存的图片

如果你还需要群主时间线能力，再继续按 [项目总说明](./project-full-overview.md) 里的“推荐验证路径”做群主时间线回归。当前真实联调不覆盖飞书 topic / 话题 / 群 `thread_id` 主题。

## 11. 最容易踩的坑

- 手动配置了 `allowlist`，但里面还留着 `ou_xxx` 占位值
- 把别的飞书应用里的 `open_id` 误填到当前应用的 `allowlist`
- 把机器人 ID 当成 `desktopOwnerOpenId`；这个字段需要填写接收桌面通知的用户 `open_id`。单用户本地使用时也可以留空，等 bridge 收到一次你的 DM 后自动记住
- 飞书后台改完能力、权限、事件或回调后，没有重新发布版本
- 事件配置或回调配置被误设成了 HTTP，而不是长连接
- 飞书后台打开了加密推送，但 `config.toml` 里的 `feishu.encryptKey` 仍然为空
- 想在群里直接发 `/ca`，但应用只开了群 @ 机器人消息权限；这种情况下飞书不会推送未 @ 的群消息，需要申请“获取群组中所有消息”权限，或改成 `@机器人 /ca`
- 想在群主时间线里使用，但后台没开群消息权限，或者项目里把 `feishu.requireGroupMention` 设成了 `true` 却没有带 mention
- 图片消息能收到，但应用没有“读取消息资源”能力，导致服务拿不到图片文件
- Codex 已经产出本地图片，但应用没有“上传图片 / 发送图片消息”能力，导致 bridge 只能回文本降级说明
- 生成图片超过飞书原生图片消息可接受的大小，导致上传失败

## 参考链接

- 飞书官方一键入口：[一键创建一个 OpenClaw 机器人](https://open.feishu.cn/page/openclaw)
