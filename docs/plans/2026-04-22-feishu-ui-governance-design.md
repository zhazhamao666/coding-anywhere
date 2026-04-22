# Feishu UI Governance And Protocol Refactor Design

## Context

`Coding Anywhere` 现在已经不是单一的 DM 机器人，而是同时覆盖：

- 飞书 DM
- 已绑定项目群主时间线
- 已注册的话题线程
- 桌面 Codex thread 的生命周期通知
- `/ops/ui` 后台观察面

当前 UI 主要由以下几块组成：

- [src/feishu-card/navigation-card-builder.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card/navigation-card-builder.ts)
- [src/feishu-card/card-builder.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card/card-builder.ts)
- [src/feishu-card/desktop-completion-card-builder.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card/desktop-completion-card-builder.ts)
- [src/feishu-card/streaming-card-controller.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card/streaming-card-controller.ts)
- [src/feishu-card-action-service.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card-action-service.ts)
- [src/bridge-service.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/bridge-service.ts)
- [src/app.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/app.ts)

这几块分别演进，已经出现两个问题：

1. 用户面对的是多套卡片心智，而不是一套统一产品。
2. 实现层既分散又重复，任何一个新动作、新状态或新字段都要在多处同步。

## Goals

- 用一套统一的 Feishu 卡片系统覆盖导航、列表、状态、运行中、完成态和桌面通知。
- 用一套明确的回调协议覆盖“立即换卡”“异步最终态回填”“启动长任务并另起进度卡”三类动作。
- 把当前飞书卡片与 `/ops/ui` 的状态词汇、上下文字段和动作语义对齐。
- 删除重复 builder、重复动作 value 拼装和重复 Codex 设置控件。
- 在不削弱现有能力的前提下，把当前实现收敛到可继续扩展的结构。

## Non-Goals

- 不在这次重构里引入新的业务能力，例如自动建群、线程级完整前端管理页或通用工作流平台。
- 不切换现有的飞书 surface 绑定模型；DM、项目群和原生线程的业务语义保持不变。
- 不把 `/ops/ui` 做成独立 SPA；本次只做信息架构和状态词汇治理。
- 不引入 JSON 1.0 兼容层；当前项目继续统一使用 JSON 2.0。

## Official Constraints

本次设计以飞书官方文档为准。实现前已重新核对以下文档：

- [处理卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)
- [卡片回传交互回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)
- [延时更新消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/delay-update-message-card)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [卡片 JSON 2.0 结构](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)

需要严格遵守的约束如下：

- 回调版本固定使用新版 `card.action.trigger`，`schema` 固定为 `2.0`。
- 卡片回调必须在 3 秒内返回 `HTTP 200`。
- 已发送卡片支持交互 30 天；可更新有效期 14 天。
- 延时更新卡片时，必须先响应回调，再使用 `event.token` 更新；并行或提前更新会失败或被还原。
- 延时更新 token 有效期 30 分钟，且最多可使用 2 次。
- JSON 2.0 卡片只能使用共享卡片，即 `config.update_multi = true`。
- JSON 2.0 卡片不能更新成 JSON 1.0。
- 交互消息卡片请求体最大 30 KB；JSON 2.0 卡片最多 200 个元素或组件。

## Current Problems In Code

### 1. Builder 分裂，BridgeService 直接承担 UI 组装

[src/bridge-service.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/bridge-service.ts) 里有 21 处 `buildBridgeHubCard(...)` 调用。多数卡片都在业务分支里直接拼：

- `summaryLines`
- `sections`
- `rows`
- `actions`

这导致：

- 信息顺序靠每个分支自己维护
- 字段命名和文案容易漂移
- 一个新字段要改多处
- 很难证明“不同卡片的当前项目 / 当前线程 / 状态”是同一套语义

### 2. 同一能力被实现了两份

Codex 设置控件至少存在两份实现：

- [src/feishu-card/card-builder.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card/card-builder.ts)
- [src/bridge-service.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/bridge-service.ts)

这不是简单的代码重复，而是 UI contract 分裂：

- 字段来源不同
- 说明文案不同
- 控件布局和上下文注入点不同

继续沿用这类重复，后面会继续出现“相同动作，不同卡片表现不同”的问题。

### 3. 卡片点击链路混用了多种更新模型

当前 [src/feishu-card-action-service.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card-action-service.ts) 的主要模型是：

1. 回调里先返回一张确认卡或目标卡
2. 后台再对同一条消息做 `updateInteractiveCard(...)`

与此同时，[src/feishu-card/streaming-card-controller.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-card/streaming-card-controller.ts) 又同时支持：

- `im.message.patch`
- CardKit streaming element 更新
- CardKit 整卡 update

这和官方推荐模型不一致。官方模型实际上是三条互斥路径：

- 3 秒内直接返回更新后的卡
- 3 秒内返回空体或 toast，然后用回调 token 延时更新
- 不更新当前卡

当前实现把“直接回卡”和“后续 patch 同一张卡”混在了一条点击链路里，属于本次必须清理的技术债。

### 4. 回调 payload 归一化过度收缩

[src/feishu-ws-client.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/feishu-ws-client.ts) 目前只保留了：

- `open_id`
- `open_message_id`
- `token`
- `action.tag`
- `action.name`
- `action.option`
- `action.value`
- `action.form_value`

但新版 `card.action.trigger` 还包含：

- `context.open_chat_id`
- `action.options`
- `action.checked`
- `action.input_value`
- `host`
- `timezone`

当前裁剪后的结构刚好够现有按钮用，但它把协议边界锁死在了“按钮 / 单选 / 表单”这几类组件上，后续无法自然扩展。

### 5. 飞书卡片与 `/ops/ui` 口径不一致

[src/app.ts](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/src/app.ts) 的 `/ops/ui` 仍然更像调度面板：

- 用原始 `tool_active`、`canceling` 等状态值直出
- 卡片和后台使用不同的字段顺序
- 飞书里强调“当前项目 / 当前线程 / 当前状态”，后台里强调“run / queue / session”

这不是单独的前端问题，而是同一个系统的状态语言没有统一。

## Proposed Design

### A. 建立统一的卡片渲染层

在 `src/feishu-card/` 下引入三层结构：

1. `card-model.ts`
定义共享的 view model，而不是在业务代码里直接拼 JSON：

```ts
interface FeishuCardModel {
  title: string;
  template?: "blue" | "green" | "orange" | "red" | "grey";
  summary: string;
  facts: CardFact[];
  sections: CardSection[];
  controls?: CardControl[];
  actions?: CardAction[];
}
```

2. `card-frame-builder.ts`
负责把 `facts / sections / controls / actions` 渲染成统一的 JSON 2.0 结构。

3. 各业务 builder 只负责把领域状态变成 model：

- `navigation-card-builder.ts`
- `run-card-builder.ts`
- `desktop-completion-card-builder.ts`
- 后续如有需要，再加 `list-card-builder.ts`

BridgeService 不再直接拼字符串数组，而是只创建 typed model。

### B. 统一信息架构

所有飞书卡片统一遵守下面的顺序：

1. 标题和摘要
2. 核心事实区
3. 主体内容区
4. 控件区
5. 动作区

其中“核心事实区”固定只承载这些字段的子集：

- Root
- 当前项目
- 当前线程
- 当前 surface
- 当前状态
- 当前 Codex 设置

这样导航卡、状态卡、桌面卡和运行卡虽然内容不同，但用户看到的定位信息顺序是稳定的。

### C. 明确三种卡片动作协议

这次重构不再使用“所有按钮都先确认卡，再后台 patch”这种混合模型，而是显式区分三种动作：

#### 1. `inline_replace`

适用于：

- 打开计划表单
- 切换当前项目 / 当前会话 / 状态这类可在 3 秒内完成的只读刷新
- 桌面 continue 这类同步完成的绑定动作

规则：

- 回调里直接返回目标卡
- 不再对同一张卡做后续 patch

#### 2. `token_finalize`

适用于：

- `/ca new`
- `thread create-current`
- `thread switch`
- 其他不能稳定保证 3 秒内完成、但不需要流式进度的卡片动作

规则：

- 回调里只返回 toast 或空体
- 后台完成实际操作
- 使用 `card.action.trigger.event.token` 调用延时更新接口回填最终卡
- 一个点击链路最多做有限次数的最终态更新，不走流式 patch

#### 3. `spawn_run_message`

适用于：

- `submit_plan_form`
- `answer_plan_choice`
- 后续任何会真正触发 Codex 长任务的卡片动作

规则：

- 回调里只返回 toast 或空体
- 不再尝试更新“被点击的那张卡”
- 由 Bridge/Adapter 在当前 surface 下创建新的进度卡消息
- 新进度卡可以继续使用 CardKit streaming 或 message patch，因为它已经是新的消息链路，不再属于回调即时更新链路

这是本次协议治理的关键点。它既遵守官方模型，也解决了回调 token 只能更新 2 次、不适合长任务流式更新的问题。

### D. 动作 value 改为统一 contract

当前动作 value 由多处手工拼装。重构后统一通过 `card-action-contract.ts` 生成，分为：

- `command_action`
- `plan_form_action`
- `plan_choice_action`
- `continue_thread_action`
- `preference_action`

并补上统一的上下文字段：

- `chatId`
- `surfaceType`
- `surfaceRef`
- `messageId`
- `threadId`
- `mode`

这样可以把 builder 层、回调层和 bridge 层对同一动作的理解保持一致。

### E. 扩展回调归一化结构

`NormalizedCardActionEvent` 需要升级，至少保留：

```ts
interface NormalizedCardActionEvent {
  open_id: string;
  tenant_key?: string;
  open_chat_id?: string;
  open_message_id?: string;
  token?: string;
  action: {
    tag?: string;
    name?: string;
    option?: string;
    options?: string[];
    checked?: boolean;
    input_value?: string;
    value?: Record<string, unknown>;
    form_value?: Record<string, unknown>;
  };
}
```

这样后续 builder 才能基于协议本身扩展，而不是依赖当前按钮的特定实现。

### F. 统一状态元数据

建立一份共享状态元数据，用于飞书卡片和 `/ops/ui`：

- 内部状态码
- 用户可见中文标签
- badge 样式
- 是否可取消
- 是否属于终态

目标不是让后台完全长得像飞书，而是让用户在两个界面看到同一套状态语言。

### G. 流式卡片与终态卡片的边界

运行中卡片保持单独 builder，但要用统一 card frame 输出。

保留：

- CardKit streaming shell
- fallback interactive card patch
- 计划 todo / 单选题结构化展示

但要收紧这两点：

- 运行中卡和终态卡共享同一套 facts / controls / actions 排列
- 终态摘要与完整结果、按钮、设置控件不再各自拼装

### H. `/ops/ui` 只做治理，不做产品化重写

`/ops/ui` 本次不拆成前后端分离项目，只做三件事：

1. 用和飞书一致的状态标签
2. 对齐“当前项目 / 当前线程 / 当前状态 / 最近摘要”字段顺序
3. 清理原始内部词汇直接暴露的问题

这样可以把成本控制在本轮范围内，同时补齐“用户从飞书跳到后台排障时，看到的是同一套对象模型”。

## Implementation Strategy

### Phase 1: 协议与基础设施

- 扩展 `NormalizedCardActionEvent`
- 为 `FeishuApiClient` 增加延时更新消息卡片能力
- 在 `FeishuCardActionService` 内显式实现三种回调模式

### Phase 2: 卡片系统收敛

- 建立 shared card model / frame builder / action builder
- 先迁移运行卡、导航卡和桌面卡
- 删除重复的 Codex 设置控件和 stop action value 生成逻辑

### Phase 3: 状态口径统一

- 在飞书卡片和 `/ops/ui` 上复用同一套状态 metadata
- 对齐字段顺序和术语

### Phase 4: 文档与回归

- 更新 [docs/project-full-overview.md](D:/eijud/OneDrive/eijud-sync/project/coding-anywhere/docs/project-full-overview.md)
- 补充或修正飞书配置说明中与卡片回调模型相关的描述
- 跑 Feishu card / ws / adapter / bridge / desktop card / app UI 相关测试

## Risks

### 1. 协议切换会影响现有按钮行为

特别是从“确认卡 + 后台 patch”切到 “toast + token final update / 新进度消息” 后，部分按钮的视觉反馈会变。

应对：

- 先以测试锁死三类动作的预期行为
- 不在同一轮里同时改业务语义和视觉语义

### 2. 长任务卡片从“原卡更新”改为“新进度消息”会影响用户习惯

这是必要代价，因为回调 token 不支持无限流式更新。该变化需要在文档里明确。

### 3. BridgeService 仍然很大

本次重构的目标不是一次性拆散整个 BridgeService，而是先让 UI 组装离开业务分支。只要 model 生成点收敛，后续再拆业务服务才有基础。

## Testing Strategy

重点覆盖以下回归面：

- `tests/feishu-card-action-service.test.ts`
  - inline replace
  - token finalize
  - spawn run message
- `tests/feishu-ws-client.test.ts`
  - 新版回调字段归一化
- `tests/feishu-card-builder.test.ts`
  - 统一 card frame 输出
- `tests/desktop-completion-card-builder.test.ts`
  - 新 frame 下的桌面通知布局
- `tests/streaming-card-controller.test.ts`
  - 运行卡流式更新仍可工作
- `tests/feishu-adapter.test.ts`
  - callback 触发长任务后创建新的进度消息
- `tests/app.test.ts`
  - `/ops/ui` 词汇与状态标签更新

## Acceptance Criteria

- 现有飞书卡片收敛为一套共享 card frame。
- 异步卡片交互不再混用“直接回卡 + 后续 patch 同一卡”。
- 计划表单 / 计划单选触发的长任务使用新的进度消息链路。
- `/ops/ui` 与飞书卡片使用同一套状态词汇。
- `docs/project-full-overview.md` 与实现保持一致。

