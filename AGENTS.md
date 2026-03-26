# Project Rules

## Documentation Sync Rule

- 任何代码改动都必须同步检查并更新 [docs/project-full-overview.md](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/docs/project-full-overview.md)。
- 只要改动影响以下任一方面，就必须同步更新该文档：
  - 需求目标
  - 架构设计
  - 消息流转
  - 配置结构
  - 命令与功能
  - 部署方式
  - 运维方式
  - 已知限制
  - 测试与验证流程

## Working Expectation

- 在开始修改代码前，先阅读 [docs/project-full-overview.md](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/docs/project-full-overview.md)。
- 在提交代码前，确认总文档是否仍然准确反映当前实现。

## Feishu Development Rule

- 只要改动涉及飞书 SDK、事件与回调、长连接、消息卡片、CardKit、消息/群组 API、线程/话题、权限或开发者后台配置，必须先使用 `chrome-devtools` 访问飞书开放平台最新官方文档核实方案与字段，再开始实现；禁止仅凭记忆、本地 SDK README、旧报错经验或搜索摘要直接下结论。
- 飞书相关能力的证据优先级固定为：
  - `open.feishu.cn` 最新官方文档 / API Explorer / 官方卡片文档
  - 官方 SDK 当前版本源码或类型定义
  - 本地项目中的已有实现
  - SDK README、历史博客、论坛回答、过往经验
- 当官方文档与 SDK README、示例代码或本地认知冲突时，以最新官方文档为准；如果仍有歧义，必须做最小复现验证后再实现，不得猜测性编码。
- 只要改动涉及飞书卡片，必须先核对目标卡片的 JSON 版本以及对应组件文档；严禁把 JSON 1.0 和 JSON 2.0 的组件/字段/回调结构混用。
- 只要改动涉及飞书卡片回调，必须先核对最新 `card.action.trigger` 回调结构、响应结构、时限要求和错误码说明；不要沿用旧版 `card.action.trigger_v1` 或旧版消息卡片回调结构，除非需求明确要求兼容旧版。
- 只要改动涉及飞书长连接，必须先核对“事件订阅”和“回调订阅”的最新官方配置方式，并确认当前方案是否支持长连接接收；不要仅根据本地 SDK README 判断某能力是否只能走 HTTP。
- 只要改动涉及飞书开发者后台配置，必须核对最新后台文档中的订阅方式、权限要求和发布要求；不要假设旧版后台路径、字段名或启用方式仍然有效。
- 进行飞书相关 bugfix 时，先从官方错误码、官方回调/卡片文档和真实请求/响应 payload 反推根因，再修改代码；禁止先改代码再倒推文档。
