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

## Validated Interaction Spec (2026-04-23)

下面这部分不是泛化原则，而是本轮已经和实际使用路径一起确认过的飞书卡片交互规范。后续实现应优先满足这一版，而不是回退到“大导航卡 + 大按钮区”的模式。

### 1. 总体原则

- 飞书卡片采用“渐进式上下文”模型：首屏只回答“我在哪”“现在怎样”“下一步做什么”。
- 诊断字段默认后置，不在首屏展示：`Root`、项目路径、`threadId`、`projectId`、`runId`、`chatId`。
- 标题已经表达视图语义时，不再重复写 `视图：当前会话` 这类说明。
- 主交互应尽快回到自然聊天：一旦会话已就绪，就明确告诉用户“直接发送消息继续”，而不是继续把卡片当一级菜单。
- Codex 设置既是信息展示，也是原地可改的真实控制能力，不再做成“只能看不能改”的摘要。
- 除非当前卡片正在解释“群未绑定项目 / 群未绑定线程”这类绑定前状态，否则群卡片默认复用 DM 文案，不引入“当前话题”“在当前群继续回复”这类额外心智。

### 2. DM 首次使用链路

#### Step 1: 用户发送 `/ca`

目标：告诉用户当前尚未选择项目 / 线程，并给出唯一明确的下一步。

示例：

```text
[开始使用]
项目：未选择
线程：未绑定
状态：空闲

下一步：先选一个项目，再开始任务

最近项目
- coding-anywhere
- llm-wiki
- website-redesign

按钮：选择项目（主） | 更多信息
```

规则：

- 不展示 `Root`、项目路径、各类 ID、偏好设置。
- 最近项目最多展示 3 个；存在时作为辅助信息，不压过主动作。

#### Step 2: 用户进入项目选择后

目标：只让用户决定“继续旧线程还是新开会话”，不把设置、状态、导航全部塞进同一屏。

示例：

```text
[选择项目]
项目：coding-anywhere
线程：未绑定
状态：空闲

下一步：继续最近线程，或新开一个会话

最近线程
- UI 治理重构
- 飞书回调协议治理
- ops/ui 状态对齐

按钮：继续最近线程（主） | 新会话 | 查看全部线程
```

规则：

- 最近线程默认最多 3 条。
- `查看全部线程` 保留为次动作，不与主动作竞争。

#### Step 3: 会话准备完成后

目标：把“会话已就绪”和“下次任务设置”放进同一张首页卡，后续操作直接回到自然聊天。

示例：

```text
[当前会话已就绪]
项目：coding-anywhere
线程：UI 治理重构
状态：空闲
作用范围：当前线程

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

下一步：直接在这个窗口发送你的任务消息

按钮：计划模式 | 切换线程 | 更多信息
```

规则：

- 模型下拉单独占一行，避免模型名过长被截断。
- `推理` 与 `速度` 的标签和下拉在同一行表达；宽度不足时允许自动换行，但仍保持“标签 + 下拉”同行。
- 这里展示的是“下次任务设置”，并且必须是真实可改的下拉，不是纯展示文本。
- `作用范围` 必须明确：已绑定 native thread 时为“当前线程”；尚未绑定线程时为“当前会话入口，新线程会继承”。

### 3. 设置语义

飞书侧可见设置统一分成三种语义，不再用一组模糊的“当前设置”覆盖所有场景：

- `下次任务设置`
  - 可编辑
  - 表达“如果现在发起下一次任务，将使用什么设置”
- `本次任务设置`
  - 只读
  - 仅在运行中卡出现
  - 表达“当前这次已经开始的任务实际使用了什么设置”
- `刚完成任务设置`
  - 只读
  - 仅在完成态 / 失败态 / 取消态出现
  - 表达“刚刚结束的这次任务实际使用了什么设置”

交互规则：

- 用户在运行中或完成后修改下拉，只改变 `下次任务设置`。
- 已经开始的任务不会因为中途改下拉而改变自己的 `本次任务设置`。
- 因此运行中和完成态允许同时存在“本次 / 刚完成任务设置”和“下次任务设置”两套信息。

### 4. 运行中卡

目标：让用户在 2 秒内看懂“任务是否仍在推进”“做到哪了”“是否需要停止”，同时允许为下一次任务预设设置。

示例：

```text
[正在执行]
项目：coding-anywhere
线程：UI 治理重构
状态：运行中

本次任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 快速 v ]

当前进展
- 正在收敛飞书卡片首屏信息层级
- 已明确当前会话卡与运行中卡的边界
- 正在整理按钮与诊断信息的展示规则

按钮：停止任务（危险）
```

规则：

- 运行中卡的动作区只保留 `停止任务`。
- 不在运行中卡放 `查看会话`、`更多信息`、`新会话`、`切换线程` 这类导航动作，避免与流式更新互相打架。
- `当前进展` 最多展示 3 条，优先显示人类可读的公开进展。
- 如果存在结构化 `todo_list`，可以放在 `当前进展` 后面，最多展示 5 项。
- 不再额外创建独立的 `Ran N commands` 区块；但如果 Codex 当前公开进展本身就是 `Ran N commands`，它可以作为 `当前进展` 里的正常一行出现。

带计划清单时的示例：

```text
[正在执行]
项目：coding-anywhere
线程：UI 治理重构
状态：运行中

本次任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 快速 v ]

当前进展
- 正在细化运行中卡的展示规则

计划清单
- [x] 梳理当前问题
- [x] 定义会话卡结构
- [ ] 细化运行中卡
- [ ] 细化完成卡
- [ ] 按真实链路验收

按钮：停止任务（危险）
```

排队态示例：

```text
[等待执行]
项目：coding-anywhere
线程：UI 治理重构
状态：排队中

本次任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

当前进展
- 当前任务正在等待调度执行

按钮：取消排队（危险）
```

取消中示例：

```text
[正在停止]
项目：coding-anywhere
线程：UI 治理重构
状态：停止中

本次任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

当前进展
- 已收到停止请求，正在等待当前任务收口
```

规则：

- `取消中` 不再重复保留停止按钮，避免重复点击。

### 5. 完成态卡

目标：完成任务后优先在当前卡片展示“Codex 最终返回了什么”；只有在结果过长或超过卡片预算时，才额外补完整结果消息。

完成示例：

```text
[任务已完成]
项目：coding-anywhere
线程：UI 治理重构
状态：已完成

刚完成任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 快速 v ]

Codex 最终返回了什么
- 已完成飞书卡片信息架构方案
- 已明确主动作、次动作和诊断信息的边界
- 建议按真实使用路径逐步验收

完整结果见下方消息

下一步：直接回复继续当前线程

按钮：计划模式 | 新会话 | 切换线程
```

失败示例：

```text
[任务出错]
项目：coding-anywhere
线程：UI 治理重构
状态：出错

刚完成任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

错误摘要
- 飞书卡片回调更新超时
- 当前任务已终止，未继续执行后续步骤

下一步：可直接回复补充信息，或开启新会话

按钮：计划模式 | 新会话 | 切换线程
```

取消示例：

```text
[任务已停止]
项目：coding-anywhere
线程：UI 治理重构
状态：已停止

刚完成任务设置：GPT-5.4 / 高推理 / 标准速度

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

结果摘要
- 已按请求停止当前任务
- 当前线程保持不变，可继续发送下一条消息

下一步：直接回复继续当前线程

按钮：计划模式 | 新会话 | 切换线程
```

规则：

- 成功完成态卡片的正文区统一命名为 `Codex 最终返回了什么`。
- 默认优先在当前卡片展示最终结果正文；如果结果过长或超出卡片预算，则在当前卡片展示截断后的正文，并补一句“完整结果见下方消息”。
- 只有在超长 / 超预算时，才额外补完整结果消息或完整结果卡。
- `错误摘要` / `结果摘要` 仍保留给失败态与取消态。
- 完成态保留 `计划模式`、`新会话`、`切换线程` 三个高频后续动作，不再放 `查看会话`、`更多信息` 这类弱导航。

### 6. 计划模式卡

计划模式输入卡保持最简，不再提供与当前目标无关的次要按钮。

示例：

```text
[计划模式]
把你的需求整理成计划，我会包装成 /plan 送到当前线程。

输入框：请描述你想先梳理的方案

按钮：提交（主） | 返回当前会话
```

规则：

- 去掉 `清空`。
- 表单提交后走 `spawn_run_message`：toast 后新发进度卡，不回写表单卡。

计划单选卡示例：

```text
[需要你做一个选择]
问题：这次要先做设计稿，还是直接落实现？

按钮：先出设计 | 直接实现 | 先做调研
```

规则：

- 默认不在每个选项下再附长说明，避免整卡过高。

### 7. 已绑定项目群主时间线链路

项目群主时间线应尽量复用 DM 的心智模型，但要明确“当前群”这个共享入口的语义。

#### Step 1: 当前群未绑定项目

目标：告诉用户当前群还没有项目上下文，并给出唯一主动作。

示例：

```text
[当前群未绑定项目]
项目：未绑定
线程：未绑定
状态：空闲

下一步：先把这个群绑定到一个项目

最近项目
- coding-anywhere
- llm-wiki
- website-redesign

按钮：绑定项目（主） | 更多信息
```

规则：

- 不展示 `chatId`、项目路径、各类 ID。
- 最近项目最多展示 3 个。

#### Step 2: 当前群已绑定项目，但还没绑定线程

目标：只让用户决定“继续已有线程”还是“创建新的会话线程”，不在这个阶段提前暴露会话级设置。

示例：

```text
[当前群已绑定项目]
项目：coding-anywhere
线程：未绑定
状态：空闲
作用范围：当前群会话入口

下一步：选择已有线程，或直接发送消息创建新会话

最近线程
- UI 治理重构
- 飞书回调协议治理
- ops/ui 状态对齐

按钮：继续最近线程（主） | 新会话 | 查看全部线程
```

规则：

- 这一屏先不展示 `下次任务设置`。
- 原因不是设置无效，而是这一步同时承载“继续已有线程”和“创建新线程”两种入口；过早展示设置会让用户误以为它会立即作用到任何被选中的已有线程。
- 应明确告诉用户：如果此时直接发送普通群消息，系统会在当前项目下创建并绑定一个新的 native thread。

#### Step 3: 当前群已绑定到某个线程

目标：让项目群在“线程已就绪”之后与 DM 保持同一套交互心智。

示例：

```text
[当前会话已就绪]
项目：coding-anywhere
线程：UI 治理重构
状态：空闲
作用范围：当前线程

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

下一步：直接发送下一条消息继续当前线程

按钮：计划模式 | 切换线程 | 更多信息
```

规则：

- 一旦群已经绑定到具体 thread，设置就应与 DM 一样常驻展示，并且是真实可改。
- 一旦群已经绑定到具体 thread，标题、按钮和主文案都应尽量复用 DM 版本；不要再额外强调“群”或“话题”。

### 8. 已注册飞书线程链路

已注册线程 surface 是三类入口里最具体的一种，因此首页卡应最简，不再展示项目列表、线程列表或大段上下文菜单。

示例：

```text
[当前会话已就绪]
项目：coding-anywhere
线程：UI 治理重构
状态：空闲
作用范围：当前线程

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

下一步：直接发送下一条消息继续当前线程

按钮：计划模式 | 切换线程 | 更多信息
```

规则：

- 已注册线程入口和 DM 首页卡保持同一套主文案与按钮顺序。
- `切换线程` 属于首页高频动作，不能从原生线程首页卡移除。
- 不使用“当前话题”“在当前话题继续回复”这类文案；当前产品心智仍是“继续当前线程”。
- 后续普通消息、运行中卡和完成态卡全部复用 DM 已确认的规则。

### 9. 桌面通知与接管链路

桌面通知卡不应提前承担“当前会话控制台”的职责，而应保持“通知卡”语义；真正的设置与继续输入能力在用户点击 `在飞书继续` 后，统一落回标准 `[当前会话已就绪]` 卡。

#### Step 1: 桌面任务进行中

示例：

```text
[桌面任务进行中]
项目：coding-anywhere
线程：UI 治理重构
状态：进行中

你最后说了什么
- 审视飞书与后台的整个交互过程，重构 UI

当前情况
- 正在整理飞书卡片交互方案
- 已完成主链路梳理

计划清单
- [x] 梳理问题
- [ ] 细化桌面接管链路
- [ ] 校验文案一致性
```

规则：

- 运行中的桌面通知卡不展示 `在飞书继续`。
- 运行中的桌面通知卡不展示 `下次任务设置`，避免在尚未接管飞书 surface 时引入“当前会话已可控制”的错觉。
- 运行中的桌面通知卡不放任何按钮，避免未接通的辅助动作占据主流程位置。

#### Step 2: 桌面任务已完成

示例：

```text
[桌面任务已完成]
项目：coding-anywhere
线程：UI 治理重构
状态：已完成

你最后说了什么
- 审视飞书与后台的整个交互过程，重构 UI

Codex 最终返回了什么
- 已完成飞书卡片信息架构方案
- 已统一三类入口的会话心智
- 建议继续收敛桌面接管链路

下一步：如需继续这个线程，点击“在飞书继续”

按钮：在飞书继续（主）
```

规则：

- 桌面完成通知与普通完成态卡片在正文语义上统一使用 `Codex 最终返回了什么`。
- `在飞书继续` 仅在完成态出现，不在运行态出现。
- 在辅助动作真正接通前，`查看线程记录` 与 `静音此线程` 不占用桌面通知卡按钮位。
- 即便后续接通，辅助动作也不应与 `在飞书继续` 并列竞争主按钮位；接管后的标准会话卡里同样不出现这些动作。

#### Step 3: 用户点击 `在飞书继续`

示例：

```text
[当前会话已就绪]
项目：coding-anywhere
线程：UI 治理重构
状态：空闲
作用范围：当前线程

下次任务设置
模型  [ GPT-5.4 v ]
推理  [ 高 v ]    速度  [ 标准 v ]

下一步：直接发送下一条消息继续当前线程

按钮：计划模式 | 切换线程 | 更多信息
```

规则：

- 用户一旦点击 `在飞书继续`，桌面通知卡就应收口到标准会话卡，而不是继续停留在“桌面通知”语义。
- 接管后的标准会话卡复用 DM / 项目群 / 已注册线程已确认的统一规则。

### 10. `更多信息` / 诊断卡

`更多信息` 统一落到一张只读的诊断卡，用来承接所有不应出现在主卡首屏的技术字段与排障信息。

示例：

```text
[更多信息]
当前上下文
- 项目：coding-anywhere
- 项目路径：D:\...\coding-anywhere
- 线程：UI 治理重构
- threadId：th_xxx
- 作用范围：当前线程
- surface：feishu_dm

最近一次任务
- runId：run_xxx
- 状态：已完成 / 收口
- 开始时间：2026-04-23 14:32:10
- 已运行：2m 14s
- 本次任务设置：GPT-5.4 / 高推理 / 标准速度
- 最近公开进展：已完成飞书卡片信息架构方案

下次任务设置
- GPT-5.4 / 高推理 / 快速
- 生效范围：当前线程

按钮：返回当前会话（主）
```

规则：

- 诊断卡只在稳定态出现：`当前会话已就绪`、`任务已完成`、`任务出错`、`任务已停止`。
- 诊断卡不在运行中卡出现，避免与流式更新冲突。
- 诊断卡只放只读信息，不再放设置下拉；设置仍由主卡常驻承载。
- `最近一次任务` 同时展示 `开始时间` 和 `已运行时间`。
- `最近预览` 这个名字过于含糊，统一改成 `最近公开进展`；它对应当前 run snapshot 的 `latestPreview`，来源是 bridge / runner 最近一次公开发出的进展文本，并在展示前做 Markdown 归一化。
- `当前设置来源` 不再作为单独区块出现；它和 `生效范围` 容易混淆，也增加理解成本。诊断卡只保留 `下次任务设置` 与 `生效范围`。

### 11. 项目列表 / 线程列表选择卡

项目列表与线程列表统一收敛成“选择卡”版式：一行只承载一个对象、一个主动作，不再在单行里塞两层决策或过多技术细节。

统一规则：

- 行标题：对象名称（项目名或线程名）
- 行说明：最多 2 行
- 行按钮：最多 1 个主按钮
- 卡片底部动作：仅保留“返回”和“新建”这类全局动作
- 路径、完整 `threadId`、原始 `source`、复杂绑定细节不在选择卡首屏展示

#### 项目列表卡

DM 场景示例：

```text
[选择项目]
当前可用项目：12

项目
- coding-anywhere
  线程：3/12 · 最近更新：2026-04-23 14:20
  按钮：进入项目（主）

- llm-wiki
  线程：1/7 · 最近更新：2026-04-22 20:18
  按钮：进入项目（主）

- website-redesign
  线程：0/3 · 最近更新：2026-04-20 11:03
  按钮：进入项目（主）

按钮：返回当前会话 | 新会话
```

规则：

- 当前项目行内不再同时放 `查看线程` 与 `切换项目` 两个按钮，而是统一收敛成一个 `进入项目`。
- 用户点击 `进入项目` 后，再由下一张卡决定“继续已有线程”还是“新会话”，避免在项目列表行内同时做两层决策。
- 项目路径不在首屏行内展示，避免列表卡被路径信息撑高。

项目群场景示例：

```text
[选择项目]
当前可用项目：12

项目
- coding-anywhere
  线程：3/12 · 绑定状态：当前群已绑定
  按钮：当前项目

- llm-wiki
  线程：1/7 · 绑定状态：未绑定
  按钮：绑定到当前群（主）

- website-redesign
  线程：0/3 · 绑定状态：已绑定其他群
```

规则：

- 群场景下，每个项目行同样只允许 1 个动作。
- `绑定状态` 可以显示在行说明里，但不再把 `chatId`、完整绑定对象、路径等细节直接暴露到选择卡。

#### 线程列表卡

示例：

```text
[选择线程]
项目：coding-anywhere
线程总数：12

线程
- UI 治理重构
  主线程 · 最近更新：2026-04-23 14:20
  按钮：切换到此线程（主）

- 飞书回调协议治理
  主线程 · 最近更新：2026-04-22 20:18
  按钮：切换到此线程（主）

- 方案比对子任务
  子 agent · 父线程：UI 治理重构
  按钮：切换到此线程

按钮：返回当前会话 | 新会话
```

规则：

- 主线程默认展示：`主线程 · 最近更新`
- 子 agent 默认展示：`子 agent · 父线程：xxx`
- 不默认展示完整 `threadId`
- 不默认展示原始 `source` 文本
- `git branch` 不在首屏展示，除非后续验证它对用户切换线程有明确价值

#### 空结果与返回动作

规则：

- 空列表时保留统一的空态提示，不回退成系统文本。
- 底部动作统一为：
  - 已有当前会话：`返回当前会话 | 新会话`
  - 尚无当前会话：`返回导航 | 新会话`
- 选择卡负责“选项目”或“选线程”，不承担“看诊断信息”职责；技术细节统一交给 `更多信息` / 诊断卡。

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
