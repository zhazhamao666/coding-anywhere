# Feishu Card UI Governance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把飞书卡片从“导航面板式 UI”重构成一致的会话型 UI，统一主卡、运行卡、完成态卡、诊断卡、选择卡和桌面通知卡的信息架构与交互协议。

**Architecture:** 保持现有 `card.action.trigger` + JSON 2.0 + 三类回调模式不变，在 builder / action contract / bridge model 三层上收敛视图语义。稳定态卡片统一承载“会话上下文 + 下次任务设置 + 计划模式开关 + 后续动作”，运行态卡片只承载“本次任务状态 + 下次任务设置 + 停止动作”，诊断信息与选择列表通过原卡 `inline_replace` 切换，不额外污染消息时间线。

**Tech Stack:** TypeScript, Vitest, Feishu JSON 2.0 cards, Feishu `card.action.trigger`, existing bridge/session store/runtime infrastructure

---

### Task 1: 收敛卡片视图模型与共享 frame

**Files:**
- Modify: `src/feishu-card/action-contract.ts`
- Modify: `src/feishu-card/frame-builder.ts`
- Modify: `src/feishu-card/navigation-card-builder.ts`
- Modify: `src/runtime-status-labels.ts`
- Test: `tests/feishu-card-action-contract.test.ts`
- Test: `tests/feishu-card-builder.test.ts`

**Step 1: Write the failing tests**

为以下行为补测试：
- 稳定态卡片支持 `计划模式 [开/关]` 状态项
- 完成态按钮顺序为 `新会话 | 切换线程 | 更多信息`
- 诊断卡为只读结构，且保留 `返回当前会话`
- 选择卡每行只有一个主动作

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/feishu-card-action-contract.test.ts tests/feishu-card-builder.test.ts
```

Expected:
- FAIL，提示缺少新的 action metadata / frame layout / card sections

**Step 3: Write minimal implementation**

在共享 builder 层引入统一视图能力：

```ts
type StableCardMode = "session" | "completed" | "failed" | "stopped";

interface PlanModeState {
  enabled: boolean;
  singleUse: true;
}

interface DiagnosticViewModel {
  contextRows: string[];
  recentRunRows: string[];
  nextRunRows: string[];
}
```

重点实现：
- frame builder 支持稳定态固定区块顺序
- action contract 支持 `toggle_plan_mode`、`open_diagnostics`、`close_diagnostics`
- 列表卡行 action contract 统一为单主动作

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/feishu-card-action-contract.test.ts tests/feishu-card-builder.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/feishu-card/action-contract.ts src/feishu-card/frame-builder.ts src/feishu-card/navigation-card-builder.ts src/runtime-status-labels.ts tests/feishu-card-action-contract.test.ts tests/feishu-card-builder.test.ts
git commit -m "refactor: unify feishu card frame semantics"
```

### Task 2: 重做稳定态主卡与选择卡

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-card/navigation-card-builder.ts`
- Modify: `src/types.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/feishu-card-builder.test.ts`

**Step 1: Write the failing tests**

补测试覆盖：
- `[当前会话已就绪]` 展示 `下次任务设置 + 计划模式 [关] + 切换线程 | 更多信息`
- `[任务已完成] / [任务出错] / [任务已停止]` 展示 `计划模式 [关] + 新会话 | 切换线程 | 更多信息`
- 项目列表卡行按钮统一为 `进入项目`
- 线程列表卡行按钮统一为 `切换到此线程`

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/bridge-service.test.ts tests/feishu-card-builder.test.ts
```

Expected:
- FAIL，当前输出仍包含旧版按钮或旧版摘要结构

**Step 3: Write minimal implementation**

在 `BridgeService` 里收敛稳定态 model 生成：

```ts
interface StableSessionCardModel {
  projectLabel: string;
  threadLabel: string;
  statusLabel: string;
  scopeLabel: string;
  nextRunSettings: SettingsSummary;
  planMode: PlanModeState;
  nextStepText: string;
  actions: StableAction[];
}
```

具体调整：
- 模型一行单独展示
- `推理` / `速度` 采用同层设置行
- 完成态正文标题统一为 `Codex 最终返回了什么`
- 选择卡彻底移除路径、raw source、完整 `threadId`

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/bridge-service.test.ts tests/feishu-card-builder.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/bridge-service.ts src/feishu-card/navigation-card-builder.ts src/types.ts tests/bridge-service.test.ts tests/feishu-card-builder.test.ts
git commit -m "refactor: rebuild feishu stable session cards"
```

### Task 3: 实现计划模式开关与诊断卡切换

**Files:**
- Modify: `src/feishu-card-action-metadata.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/codex-preferences.ts`
- Test: `tests/feishu-card-action-service.test.ts`
- Test: `tests/feishu-adapter.test.ts`
- Test: `tests/bridge-service.test.ts`

**Step 1: Write the failing tests**

补测试覆盖：
- 点击 `计划模式 [关]` 后返回 `inline_replace`，主卡原地变成 `计划模式 [开]`
- 计划模式只影响下一条用户消息，触发一次后自动回到 `关`
- 点击 `更多信息` 后返回诊断卡；点击 `返回当前会话` 后原地切回主卡
- 不再存在独立 `计划表单卡`

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/feishu-card-action-service.test.ts tests/feishu-adapter.test.ts tests/bridge-service.test.ts
```

Expected:
- FAIL，当前仍会生成旧计划卡或缺少 toggle/diagnostics 动作

**Step 3: Write minimal implementation**

关键实现：

```ts
type SessionMode = "normal" | "plan_next_message";

interface SurfaceInteractionState {
  sessionMode: SessionMode;
  diagnosticsOpen: boolean;
}
```

实现要求：
- `toggle_plan_mode` 只改 surface/thread 会话态，不立即触发 run
- bridge 在消费下一条普通文本时判断 `plan_next_message`，包装为计划模式消息后自动清回 `normal`
- `open_diagnostics` / `close_diagnostics` 仅做视图切换，不改业务上下文

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/feishu-card-action-service.test.ts tests/feishu-adapter.test.ts tests/bridge-service.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/feishu-card-action-metadata.ts src/feishu-card-action-service.ts src/bridge-service.ts src/codex-preferences.ts tests/feishu-card-action-service.test.ts tests/feishu-adapter.test.ts tests/bridge-service.test.ts
git commit -m "feat: add feishu session plan-mode toggle"
```

### Task 4: 重做运行态、完成态与过渡交互

**Files:**
- Modify: `src/feishu-card/card-builder.ts`
- Modify: `src/feishu-card/streaming-card-controller.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-card-action-service.ts`
- Test: `tests/streaming-card-controller.test.ts`
- Test: `tests/feishu-card-action-service.test.ts`
- Test: `tests/bridge-service.test.ts`

**Step 1: Write the failing tests**

补测试覆盖：
- 运行中卡只保留 `停止任务（危险）`
- `Ran N commands` 仅作为 `当前进展` 内一行，而不是独立区块
- `切换线程` / `新会话` 成功后只出现 `toast + 目标会话卡`
- 完成态与失败态保留 `更多信息`

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/streaming-card-controller.test.ts tests/feishu-card-action-service.test.ts tests/bridge-service.test.ts
```

Expected:
- FAIL，当前仍可能保留旧导航动作、成功卡或旧区块布局

**Step 3: Write minimal implementation**

实现重点：
- 运行态卡的 button area 只允许 stop/cancel
- 完成态正文区复用 `Codex 最终返回了什么`
- `new session` / `switch thread` 回调统一走 `toast + token finalize -> stable card`
- 删除独立的“成功切换 / 创建成功 / 绑定成功”卡 model

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/streaming-card-controller.test.ts tests/feishu-card-action-service.test.ts tests/bridge-service.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/feishu-card/card-builder.ts src/feishu-card/streaming-card-controller.ts src/bridge-service.ts src/feishu-card-action-service.ts tests/streaming-card-controller.test.ts tests/feishu-card-action-service.test.ts tests/bridge-service.test.ts
git commit -m "refactor: simplify feishu runtime card flows"
```

### Task 5: 收敛桌面通知与飞书接管链路

**Files:**
- Modify: `src/feishu-card/desktop-completion-card-builder.ts`
- Modify: `src/desktop-completion-notifier.ts`
- Modify: `src/bridge-service.ts`
- Test: `tests/desktop-completion-card-builder.test.ts`
- Test: `tests/desktop-completion-notifier.test.ts`
- Test: `tests/desktop-completion-dm-handoff.test.ts`
- Test: `tests/desktop-completion-group-handoff.test.ts`

**Step 1: Write the failing tests**

补测试覆盖：
- `桌面任务进行中` 不展示按钮
- `桌面任务已完成` 只保留 `在飞书继续（主）`
- 点击 `在飞书继续` 后直接落到标准 `[当前会话已就绪]` 卡，而不是桌面专属成功卡

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/desktop-completion-card-builder.test.ts tests/desktop-completion-notifier.test.ts tests/desktop-completion-dm-handoff.test.ts tests/desktop-completion-group-handoff.test.ts
```

Expected:
- FAIL，当前桌面卡仍可能保留多余动作或旧接管语义

**Step 3: Write minimal implementation**

实现重点：
- 桌面通知卡仅承担“通知 + 接管”
- 飞书接管成功后统一进入稳定态会话卡
- 保持桌面完成态正文与普通完成态的 `Codex 最终返回了什么` 语义一致

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/desktop-completion-card-builder.test.ts tests/desktop-completion-notifier.test.ts tests/desktop-completion-dm-handoff.test.ts tests/desktop-completion-group-handoff.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/feishu-card/desktop-completion-card-builder.ts src/desktop-completion-notifier.ts src/bridge-service.ts tests/desktop-completion-card-builder.test.ts tests/desktop-completion-notifier.test.ts tests/desktop-completion-dm-handoff.test.ts tests/desktop-completion-group-handoff.test.ts
git commit -m "refactor: align desktop completion handoff cards"
```

### Task 6: 更新总文档并跑回归验证

**Files:**
- Modify: `docs/project-full-overview.md`
- Modify: `docs/plans/2026-04-22-feishu-ui-governance-design.md`
- Test: `tests/feishu-card-builder.test.ts`
- Test: `tests/feishu-card-action-service.test.ts`
- Test: `tests/streaming-card-controller.test.ts`
- Test: `tests/desktop-completion-card-builder.test.ts`
- Test: `tests/feishu-adapter.test.ts`
- Test: `tests/feishu-ws-client.test.ts`
- Test: `tests/app.test.ts`

**Step 1: Update documentation**

把总文档与设计文档同步到新实现：
- 去掉“计划模式表单卡”的旧描述
- 写清 `计划模式` 已改为会话级单次开关
- 写清 `更多信息` 为原卡 `inline_replace` 诊断卡
- 写清完成态按钮与桌面接管链路的新规则

**Step 2: Run regression suite**

Run:

```bash
npx vitest run tests/feishu-card-builder.test.ts tests/feishu-card-action-service.test.ts tests/streaming-card-controller.test.ts tests/desktop-completion-card-builder.test.ts tests/feishu-adapter.test.ts tests/feishu-ws-client.test.ts tests/app.test.ts
```

Expected:
- PASS

**Step 3: Run full build**

Run:

```bash
npm run build
```

Expected:
- PASS，无 TypeScript 错误

**Step 4: Commit**

```bash
git add docs/project-full-overview.md docs/plans/2026-04-22-feishu-ui-governance-design.md src tests
git commit -m "docs: sync feishu card ui governance"
```

## Execution Notes

- 默认在 `main` 上按任务顺序执行，不新建分支，除非人工确认需要隔离开发。
- 每个任务结束后都先跑对应最小测试集，再提交。
- 如果中途发现飞书卡片字段或回调约束与当前认知不一致，必须先回到官方文档核对，再继续编码。
- 如需真实链路验证，再单独使用现有 Playwright / live auth 能力，不把 live 测试混进默认回归集。

Plan complete and saved to `docs/plans/2026-04-23-feishu-card-ui-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - 我在当前会话里按任务逐个推进、逐个验证、逐个提交

**2. Parallel Session (separate)** - 另开一个执行会话，按计划批量推进并在检查点回报

