# Feishu Desktop Running Lifecycle Notifications Design

**Date:** 2026-04-22

## Goal

Upgrade the existing "desktop completion notification" feature into a full desktop lifecycle notification flow so Feishu can:

- receive a `running` card when a desktop-originated top-level Codex thread starts a new turn;
- keep that same card up to date with public progress while the desktop task is still running;
- update the same card into a `completed` card when the turn ends;
- include the last user prompt and the final assistant result preview on the completed card;
- avoid exposing raw command lines or script execution details in any user-facing Feishu card or summary.

## Product Summary

Today the system only supports the tail end of the experience:

- the runtime tails native Codex rollout JSONL files;
- it detects `task_complete`;
- it sends a new "桌面任务已完成" card;
- it follows with the final assistant result as a separate message.

This leaves three product gaps:

1. There is no "桌面任务进行中" state in Feishu for desktop-originated work.
2. The completion card is not the same card the user saw during execution because there is no running card to update.
3. Existing progress-card code paths can still leak raw command execution details because they treat command text as a user-visible tool label.

This design closes all three.

## User Requirements Captured From Conversation

The approved user intent is:

- when a desktop Codex thread is running, Feishu should receive a `进行中` card;
- while that thread keeps running, the card should be updated with the latest progress;
- the running card should show the plan list and progress in the same spirit as the current Feishu-conversation execution UI;
- raw shell/script command details must not be shown;
- instead of raw command text, the UI should only show aggregate information such as `Ran 3 commands`;
- when the desktop turn finishes, the same card should be updated into `已完成`;
- the completed card should include:
  - what the user last said;
  - what Codex finally replied;
  - the latest plan snapshot;
  - the command count summary;
- the `在飞书继续` button must not appear while the desktop task is still running; it only appears after completion.

## Existing Implementation We Must Respect

### Already Implemented

- Desktop-originated native thread completions are observed by runtime polling local rollouts.
- The poller skips historical completions on bootstrap.
- The poller suppresses:
  - subagent thread completions;
  - recent Feishu-originated completion echoes on the same native thread.
- The completion notifier already knows how to route to:
  - DM
  - bound project group timeline
  - bound Feishu thread surface
- The bridge already supports continuing a native thread from Feishu after clicking a card action.
- Feishu conversation runs already have a streaming/progress card system and already render `todo_list` items structurally.

### Not Yet Implemented

- No running-state observer for desktop-originated work.
- No persistent notification state storing the active `message_id` for a desktop-running card.
- No mechanism to patch a desktop-running card into a desktop-completed card.
- No shared "public progress" abstraction that hides raw command strings while preserving command counts and plan progress.

## Non-Goals

This design intentionally does **not** do the following:

- live stream every token or every micro-event from the desktop rollout into Feishu;
- allow "在飞书继续" before the desktop turn reaches a terminal state;
- redesign the whole Feishu topic model for project groups;
- alter `/ops` internal observability requirements, where raw tool detail may still be useful;
- fully sanitize all assistant-authored final answers, because assistant output may legitimately discuss commands as content;
- change the bridge-originated streaming execution architecture outside the minimum changes needed to stop leaking raw commands in user-facing Feishu cards and summaries.

## Success Criteria

The feature is considered complete when all of the following are true:

1. A new desktop-originated top-level thread turn creates exactly one user-facing running card in Feishu.
2. That running card is updated in place while the turn is still active.
3. The same card is updated in place to a completion card when the turn finishes.
4. The completed card includes:
   - last user message preview;
   - final assistant preview;
   - latest plan snapshot;
   - `Ran N commands`;
   - completion timestamp.
5. Raw `command_execution.command` strings are not shown in any user-facing Feishu state card, status card, or desktop notification card.
6. Existing Feishu-originated runs still suppress duplicate desktop notifications.
7. Subagent thread completions still do not notify.
8. The completed card exposes `在飞书继续`; the running card does not.

## Feishu API Model

This design continues to use the same Feishu message model already present in the codebase:

- create an `interactive` message when the desktop run enters `running`;
- store the returned `message_id`;
- later patch that same `message_id` when the desktop run progress changes;
- patch that same `message_id` again to turn it into the final completed card.

This uses the existing `im.message.patch` client capability already wrapped by `updateInteractiveCard(...)`.

The design does **not** depend on card callback immediate-return semantics because the desktop lifecycle updates are background runtime operations, not button callbacks.

## Terminology

- **native thread**: the long-lived Codex `thread_id` in local Codex state.
- **desktop run**: a top-level native-thread turn that starts outside the bridge's own run worker pipeline.
- **running card**: the initial Feishu interactive message created when a desktop run starts.
- **completed card**: the same interactive message after it has been patched to reflect the terminal state.
- **public progress**: the sanitized, user-facing subset of execution state that can be rendered in Feishu without exposing raw command strings.
- **notification state**: the durable record mapping an in-flight desktop run to the Feishu message that represents it.
- **run key**: the identifier for one concrete desktop turn lifecycle.
- **completion key**: the identifier for one concrete completion event.

## Design Options

### Option 1: Keep completion-only notifications and add a second running card

**Pros**

- Very small incremental change.
- Minimal schema work.

**Cons**

- Creates multiple status cards for the same desktop run.
- Breaks the desired "same card evolves from running to completed" experience.
- Makes noisy Feishu history for long-running threads.

**Verdict**

Rejected.

### Option 2: Reuse the existing bridge streaming-card controller directly for desktop runs

**Pros**

- Maximum UI consistency with Feishu-originated runs.
- Reuses an existing patching mechanism.

**Cons**

- The current streaming state carries bridge-specific fields and assumptions.
- It still shows `latestTool`, which currently leaks raw command text.
- Desktop polling is not the same as bridge worker event streaming.
- Mixing "bridge run" and "desktop observed turn" in the same lifecycle object would make debugging and suppression logic harder.

**Verdict**

Rejected as the primary model, but some rendering helpers will be reused.

### Option 3: Add a dedicated desktop lifecycle state machine with a shared public-progress abstraction

**Pros**

- Matches the product requirement directly.
- Keeps desktop observation logic separate from bridge worker logic.
- Lets us fix the raw command leakage globally for user-facing cards.
- Still reuses the existing plan/todo rendering and Feishu card patching infrastructure.

**Cons**

- Requires new durable state.
- Requires new observer extraction beyond `task_complete`.
- Requires coordinated updates across runtime, notifier, card builders, runner progress mapping, and store.

**Verdict**

Approved and recommended.

## High-Level Architecture

```text
local Codex rollout append
  -> desktop lifecycle observer
  -> public progress extractor
  -> runtime lifecycle state machine
  -> route resolution
  -> create or patch Feishu running/completed card
  -> optional full final result follow-up message
  -> user clicks "在飞书继续" after completion
  -> existing thread handoff flow
```

## Core Design

### 1. Split the problem into two durable layers

The system needs two different persistent concerns:

1. **rollout watch progress**
   This tracks where runtime has read in the rollout file.
2. **active Feishu notification lifecycle**
   This tracks which Feishu message represents the current desktop run.

The existing `codex_thread_watch_state` table is sufficient only for the first concern. It stores:

- rollout path
- mtime
- last read offset
- last completion key
- last notified completion key

It does **not** store:

- active run key
- active notification status
- running-card `message_id`
- last render hash
- frozen delivery target

Therefore the new lifecycle feature must introduce a second table rather than overloading the existing one.

### 2. Introduce a new durable notification-state table

Add:

`codex_thread_desktop_notification_state`

Proposed columns:

- `thread_id TEXT PRIMARY KEY`
- `active_run_key TEXT`
- `status TEXT NOT NULL`
- `started_at TEXT`
- `last_event_at TEXT`
- `message_id TEXT`
- `delivery_mode TEXT`
- `peer_id TEXT`
- `chat_id TEXT`
- `surface_type TEXT`
- `surface_ref TEXT`
- `anchor_message_id TEXT`
- `last_render_hash TEXT`
- `last_completion_key TEXT`
- `updated_at TEXT NOT NULL`

### 2.1 Status values

Allowed values:

- `idle`
- `running_notified`
- `completed`

In practice we do not need to persist `idle` rows; absence of a row is equivalent to idle. The stored status values can therefore be:

- `running_notified`
- `completed`

### 2.2 Why the route is frozen into notification state

When a desktop run first enters `running`, we create a Feishu card and receive a `message_id`.

That `message_id` belongs to a specific Feishu surface. If route resolution changed later because the thread was rebound elsewhere, patching the existing card would still need the original surface context. Therefore the runtime must freeze the chosen delivery target into notification state at running-card creation time.

### 3. Extend the observer from "completion detector" to "lifecycle observer"

The current observer only detects:

- final assistant message (`phase = final_answer`)
- `task_complete`

The new observer must also extract:

- whether a new top-level desktop run has started;
- the latest public progress summary;
- the latest plan list snapshot;
- the command count for the active run.

### 3.1 New observer output shape

Introduce a new observer result structure alongside the existing completion extraction:

- `runStarted?: { runKey, startedAt }`
- `progressSnapshot?: { runKey, latestPublicMessage, planTodos, commandCount, lastEventAt, finalAssistantText?, lastUserText? }`
- `completion?: { completionKey, completedAt, finalAssistantText }`
- `nextOffset`

### 3.2 Start detection rules

Start detection should be conservative and stable:

1. Prefer explicit `turn.started`.
2. If not available in a rollout format, accept the first top-level business event after idle.
3. If the first visible event is already `task_complete` and the turn both started and completed between polls, skip running-card creation and go straight to a completed card.

The observer should ignore subagent rollouts exactly as today.

### 3.3 Public progress extraction rules

The public progress snapshot is intentionally sanitized.

It should collect:

- `latestPublicMessage`
  - prefer assistant/user-readable progress content such as analysis or agent messages;
  - normalize to plain text;
  - truncate later at render time, not in the observer.
- `planTodos`
  - parse `todo_list` items using the same semantics already used by the runner path.
- `commandCount`
  - increment on each top-level `command_execution` item start;
  - do not preserve the command text for Feishu rendering.
- `lastUserText`
  - for completed cards, from recent conversation history.
- `finalAssistantText`
  - for completed cards, last `final_answer`.

### 3.4 Public progress must not expose raw command strings

This is a hard requirement.

The observer may still see raw command text in the rollout. It must not forward that raw text into Feishu notification rendering.

The only user-facing command artifact is:

`Ran N commands`

### 4. Introduce a shared public-progress model

The bridge already has a `ProgressCardState` for Feishu-originated runs. However it currently includes and renders:

- `latestTool`
- preview strings that may embed raw tool/command names

This is the wrong level of abstraction for desktop lifecycle cards and is also too leaky for user-facing bridge cards.

We should introduce a shared public-progress representation that both paths can render safely.

Proposed fields:

- `latestPublicMessage?: string`
- `planTodos?: PlanTodoItem[]`
- `commandCount?: number`
- `startedAt?: number | string`
- `elapsedMs?: number`
- `status`
- `stage`

We can implement this in one of two ways:

1. Add these fields to `ProgressCardState`, while keeping `latestTool` only for ops/debug internals.
2. Create a dedicated helper-level view model and derive it from `ProgressCardState` plus desktop observer output.

Recommendation:

Use approach 1 for the first implementation to minimize churn. Add:

- `commandCount?: number`
- `latestPublicMessage?: string`

Then update card builders to prefer those fields over `latestTool`.

### 5. Global user-facing command redaction rules

This requirement is not desktop-only. At least four user-facing surfaces currently expose command detail:

1. running/progress card markdown
2. current/status summary cards
3. desktop-running cards
4. desktop-completed cards

The design rule is:

- raw `command_execution.command` may still exist in internal event logs and `/ops`;
- raw command strings must not appear in Feishu user-facing cards, summaries, or running/completed status snippets;
- user-facing cards should instead show:
  - `Ran N commands`
  - plan list
  - latest public message

### 6. Running-card UX

Header:

- title: `桌面任务进行中`
- template: blue or orange; recommendation: blue for neutrality

Body sections:

1. overview
   - 项目
   - 线程
   - 状态：进行中
   - 开始时间
2. latest user context
   - label: `你最后说了什么`
   - show the most recent meaningful user message
3. current progress
   - label: `当前情况`
   - show latest public message if present
   - otherwise fallback to a neutral message such as `桌面端正在继续执行该线程，完成后会在此更新结果。`
4. plan list
   - if `planTodos` exists, render exactly like the current Feishu run card does
5. command count
   - show `Ran N commands` when `commandCount > 0`

Buttons:

- `查看线程记录`
- `静音此线程`

No `在飞书继续`.

### 7. Completed-card UX

The completed card is a patch of the same message.

Header:

- title: `桌面任务已完成`
- template: green

Body sections:

1. overview
   - 项目
   - 线程
   - 状态：已完成
   - 完成时间
2. last user context
   - label: `你最后说了什么`
3. final result preview
   - label: `Codex 最终返回了什么`
   - render a readable preview from final assistant text
   - if too long, truncate and note that full content is below
4. final plan snapshot
   - latest `planTodos` if present
5. command count
   - `Ran N commands`

Buttons:

- `在飞书继续`
- `查看线程记录`
- `静音此线程`

### 8. Full final-result follow-up message strategy

The completed card itself must include:

- last user prompt preview
- final assistant preview

But we should still preserve the ability to send the full final answer as a separate message when necessary.

Rule:

- if the final answer preview fits comfortably and is simple, the card preview may be sufficient and no extra message is required;
- if the final answer is long or heavily formatted, send the full result as a follow-up message/card after the completed-card patch;
- the completed card should then say that the full reply is available below.

This is a small change from the current behavior, which always follows the completion card with a separate result message.

### 9. Runtime lifecycle state machine

For each top-level native thread:

#### 9.1 Initial bootstrap

- Read rollout from offset 0.
- Record latest offset in `codex_thread_watch_state`.
- Do not emit running or completion notifications for historical data.
- If historical data already contains a completion, set `last_completion_key` and `last_notified_completion_key` to that historical completion key.

#### 9.2 New running state

When a new observer poll detects a new run key and there is no matching active notification:

1. resolve the delivery route;
2. create the running card;
3. persist notification state:
   - run key
   - status `running_notified`
   - message id
   - frozen route
   - render hash
   - started at
   - last event at

#### 9.3 Running update

When a later poll detects the same run key still active:

1. build the public running card payload;
2. compute `renderHash`;
3. if hash unchanged, do nothing;
4. if hash changed, patch the existing message;
5. update `last_render_hash` and `last_event_at`.

#### 9.4 Completion

When a later poll detects `task_complete` for the active run:

1. if there is an active notification state for the same run key:
   - patch that message into the completed card;
   - optionally send the full final answer follow-up;
   - persist `last_completion_key` and clear active lifecycle state.
2. if there is no active notification state:
   - this means the running phase was skipped, lost, or never emitted;
   - send a fresh completed card using the existing completion-notification behavior;
   - optionally send the full final answer follow-up;
   - persist `last_completion_key`.

#### 9.5 Same-poll start-and-complete collapse

If a run starts and completes entirely between two polls:

- skip running-card creation;
- send only the completed card.

This avoids a confusing "flash" of running state in Feishu.

### 10. Route resolution rules

Route resolution remains the same as the current desktop-completion system:

1. exact thread-bound Feishu thread surface
2. project-group main timeline
3. owner DM fallback

The route chosen at running-card creation time is frozen into notification state.

### 11. Suppression rules

The current suppression rules remain and apply to the whole lifecycle:

1. **subagent suppression**
   - ignore `sourceInfo.kind = subagent`.
2. **Feishu-originated run suppression**
   - if a recent bridge-managed run on the same `thread_id` was finished within the correlation window, suppress both the running card and the completion update path for that desktop lifecycle.

This is important because otherwise a Feishu-originated run could produce:

- normal bridge running card
- normal bridge completed card
- desktop-running card
- desktop-completed patch

which would be a severe UX regression.

### 12. Failure handling

#### 12.1 Running-card create failure

If runtime detects a running state but creating the running card fails:

- do not persist active notification state;
- keep watch offsets moving;
- later, if completion is detected, fall back to sending a fresh completed card.

#### 12.2 Running-card patch failure

If patching the running card fails during a non-terminal update:

- keep the notification state;
- allow retry on the next poll if the render hash is still stale.

#### 12.3 Completion patch failure

If patching the running card into the completed card fails:

- send a fresh completed card as fallback;
- optionally send the full final answer follow-up;
- clear the active notification state so future turns do not keep targeting a dead message.

#### 12.4 Runtime restart

If the service restarts mid-run:

- watch-state bootstrap should not replay historical running notifications;
- if the turn completes later and no active notification state is present, the system may still send a fresh completed card;
- this is acceptable degradation.

### 13. Card rendering reuse strategy

We should **not** directly reuse `buildBridgeCard(...)` for desktop lifecycle messages because it includes:

- model controls
- reasoning/speed controls
- stop button
- bridge-specific layout assumptions

However, we should reuse and extract shared pieces:

- todo list rendering
- command-count rendering
- public progress summary formatting

Recommended change:

- keep `buildBridgeCard(...)` for bridge worker runs;
- add shared helper functions such as:
  - `buildTodoSection(planTodos)`
  - `buildCommandCountSection(commandCount)`
  - `buildPublicProgressSection(...)`
- use them from both:
  - `card-builder.ts`
  - `desktop-completion-card-builder.ts`

### 14. Raw command leakage fixes required outside desktop notifier

The following changes are required to make the "no raw script detail in Feishu cards" guarantee true:

#### 14.1 `codex-cli-runner.ts`

Current behavior:

- `command_execution` sets `toolName = parsed.item.command`

Change:

- stop storing the raw command string as the user-facing tool label;
- instead emit a generic event that increments `commandCount`.

#### 14.2 `progress-relay.ts`

Current behavior:

- `tool_call` sets preview to `[ca] tool_call: ${event.toolName}`

Change:

- if the event represents command execution, preview should become a generic public string or remain unchanged;
- increment `commandCount`;
- do not expose the command text.

#### 14.3 `card-builder.ts`

Current behavior:

- renders `最近工具：${state.latestTool}`

Change:

- remove the user-facing raw `最近工具` line from Feishu cards;
- render `Ran N commands` instead when available.

#### 14.4 `bridge-service.ts`

Current behavior:

- status/current-session summaries include `最近工具`

Change:

- replace these with `已执行命令：N` or `Ran N commands`.

### 15. Data model changes in detail

#### Existing table kept

`codex_thread_watch_state`

No semantic change. It continues to represent the polling cursor and dedupe state.

#### New table

`codex_thread_desktop_notification_state`

Store methods required:

- `upsertCodexThreadDesktopNotificationState(...)`
- `getCodexThreadDesktopNotificationState(threadId)`
- `clearCodexThreadDesktopNotificationState(threadId)`
- `listCodexThreadDesktopNotificationStates()`

#### Suggested TypeScript type

```ts
interface CodexThreadDesktopNotificationStateRecord {
  threadId: string;
  activeRunKey: string | null;
  status: "running_notified" | "completed";
  startedAt: string | null;
  lastEventAt: string | null;
  messageId: string | null;
  deliveryMode: "dm" | "project_group" | "thread" | null;
  peerId: string | null;
  chatId: string | null;
  surfaceType: "thread" | null;
  surfaceRef: string | null;
  anchorMessageId: string | null;
  lastRenderHash: string | null;
  lastCompletionKey: string | null;
  updatedAt: string;
}
```

### 16. Testing strategy

This feature spans four layers and should be verified at each one.

#### 16.1 Observer tests

Need fixtures covering:

- start only
- start + todo_list + command_execution
- start + multiple progress updates
- start + complete in same poll
- complete without final answer
- subagent thread ignored

Assertions:

- run key extraction
- command counting
- todo extraction
- final assistant extraction
- completion key stability

#### 16.2 Store tests

Need tests for:

- notification-state persistence
- update existing running row with new render hash
- clear state on completion/fallback

#### 16.3 Notifier tests

Need tests for:

- create running card and persist `message_id`
- patch running card on progress change
- do not patch when render hash unchanged
- patch to completed card
- fallback to fresh completed card if patch fails
- completed card exposes `在飞书继续`
- running card does not

#### 16.4 Shared public-progress tests

Need tests for:

- command executions increment `commandCount`
- raw command text is absent from card markdown
- todo list still renders
- final done card summary still works

#### 16.5 Runtime integration tests

Need end-to-end tests proving:

- bootstrap skips historical runs
- new running lifecycle creates one running card
- repeated progress updates patch the same message
- completion patches the same message
- no second status card is created for the same lifecycle
- subagent and Feishu-originated suppression still hold

## Implementation Sequence

1. Introduce notification-state persistence.
2. Extend the observer into a lifecycle observer with run-start detection and public progress extraction.
3. Add shared public-progress fields and remove raw-command rendering from user-facing Feishu cards.
4. Build running/completed desktop lifecycle cards.
5. Update runtime poller to manage create/patch/complete transitions.
6. Preserve completion fallback behavior when running-state patching is unavailable.
7. Update docs and tests.

## Risks

### Risk 1: False-positive running detection

If the observer interprets noisy rollout events as a new run too aggressively, users could get running cards for turns that do not represent meaningful work.

Mitigation:

- prefer explicit `turn.started`;
- require meaningful public progress or later completion to validate the run;
- collapse same-poll start+complete to completion-only.

### Risk 2: Message patch drift after rerouting

If the thread gets rebound to another Feishu surface while still running, patching the original running card could appear inconsistent.

Mitigation:

- freeze the route for the active lifecycle;
- only future runs re-resolve route.

### Risk 3: Raw command leakage remains in some older card path

Mitigation:

- explicitly audit and update all user-facing Feishu card/summary builders;
- leave raw command visibility only in `/ops` and internal observability.

### Risk 4: Large completed-card payload

Mitigation:

- keep completed-card final-answer preview bounded;
- send the full final result separately when needed.

## Final Recommendation

Implement a dedicated desktop lifecycle state machine on top of the existing rollout poller, backed by a new notification-state table and a shared public-progress rendering model.

This gives the desired product behavior:

- one running card per desktop run;
- live progress updates with plan list and command count;
- no raw command leakage;
- one completed patch on the same card;
- `在飞书继续` only after completion.
