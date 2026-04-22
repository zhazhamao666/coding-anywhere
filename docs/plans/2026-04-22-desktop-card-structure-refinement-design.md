# Desktop Card Structure Refinement Design

## Context

The desktop lifecycle notification chain is already connected end-to-end:

- runtime polls top-level native Codex threads
- `task_started` creates a running card
- progress patches the same card
- `task_complete` patches the card into completed

However, the current desktop card UX and some data selection rules are still wrong in ways that create user confusion:

1. The card body is ordered like a status dashboard instead of a conversation continuation surface.
2. Completion cards still send an extra "完整回复" message/card after the main card updates.
3. `Ran N commands` is rendered as a standalone progress block on the desktop card, which adds noise.
4. `你最后说了什么` is derived from the latest `role=user` rollout message, which can accidentally select synthetic subagent/system text.
5. Completion status can still be shown for a thread whose latest top-level state is actually still running.

This design tightens the desktop card so it behaves like a thread continuation summary, not an ops panel.

## Goals

- Reorder desktop cards so the human prompt always appears before the current/final Codex output.
- Stop sending a second "完整回复" message after the completion card updates.
- Remove the standalone `进度 / Ran N commands` section from desktop cards.
- Preserve Codex meaning by avoiding ad-hoc text scrubbers for final assistant content.
- Distinguish real human user input from synthetic user-like messages using rollout structure rather than string heuristics.
- Ensure completion status reflects the latest top-level thread state, not any older completion inside the same thread.

## Non-Goals

- Redesign the existing DM/group streaming status cards outside the desktop lifecycle flow.
- Introduce a full CodexApp-style transcript UI in Feishu.
- Add desktop history or mute callback implementations in this change.
- Normalize or rewrite arbitrary assistant prose with custom sanitization rules.

## Constraints

- Feishu interactive cards still have payload limits; completion cards must remain within the existing 30 KB budget.
- The current Feishu API model remains:
  - create interactive message
  - patch same `message_id`
  - do not depend on extra update paths in the same action chain
- We should prefer structural interpretation of rollout events over textual cleanup rules.

Official references checked before implementation:

- [Send message](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [Delay update message card](https://open.feishu.cn/document/server-docs/im-v1/message-card/delay-update-message-card)
- [Handle card callbacks](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)

## Current Problems In Code

### 1. Card body order is wrong

`src/feishu-card/desktop-completion-card-builder.ts` currently builds:

- overview
- `当前情况` or `Codex 最终返回了什么`
- `你最后说了什么`
- `进度`
- `计划清单`

This makes the card feel like an ops dashboard and hides the actual conversation setup.

### 2. Completion flow duplicates the final result

`src/desktop-completion-notifier.ts` currently:

1. patches or sends the completion card
2. then sends another full assistant message/card via `resolveFeishuAssistantMessageDelivery(...)`

That means the user sees:

- completion card
- extra "完整回复" card or text

The new target behavior is a single completion card only.

### 3. `Ran N commands` is already structural, but displayed in the wrong place

Current command count comes from structured `shell_command` events:

- desktop lifecycle observer increments `commandCount`
- no raw shell command is shown on the desktop card

So the event source is already good. The UX issue is the dedicated desktop card section:

- `**进度**`
- `Ran 45 commands`

This should be removed from the desktop card layout.

### 4. "你最后说了什么" uses the wrong source

`resolveLastUserReminder(...)` in `src/desktop-completion-notifier.ts` currently scans:

- `CodexSqliteCatalog.listRecentConversation(...)`
- then returns the latest item with `role === "user"`

But `listRecentConversation(...)` in `src/codex-sqlite-catalog.ts` only preserves:

- `role`
- `text`
- `timestamp`

This loses the distinction between:

- actual human prompt
- synthetic "user-looking" messages injected by system/subagent flows

As a result, synthetic messages like subagent notification wrappers can appear as `你最后说了什么`.

### 5. Thread completion still needs latest-top-level semantics

Desktop completion should not mean:

- "we saw a final answer and task_complete somewhere"

It must mean:

- "the latest top-level state for this thread is complete"

If the thread has already continued into a newer top-level running turn, the card must remain or become running.

## Proposed Design

### A. Desktop card information architecture

#### Running card

Sections:

1. Overview
2. `你最后说了什么`
3. `当前情况`
4. `计划清单` (only if present)

Do not show:

- standalone `进度`
- `Ran N commands`
- `在飞书继续`

#### Completed card

Sections:

1. Overview
2. `你最后说了什么`
3. `Codex 最终返回了什么`
4. `计划清单` only if we explicitly decide it adds value for completed runs

Recommended v1 behavior:

- do not render `计划清单` on completed cards
- keep completion card focused on prompt and answer

Buttons:

- `在飞书继续`
- `查看线程记录`
- `静音此线程`

#### Summary field

Card `config.summary.content` should continue to use a short synthesized line, but it should reflect the same hierarchy:

- project / thread / status
- current progress text for running
- final answer preview for completed

### B. Completion content strategy

The completion card should carry the final assistant content directly.

New rule:

- no extra "完整回复" message/card after completion

Payload policy:

- if final assistant content fits inside the completion card budget, render it directly
- if it exceeds the budget, truncate inside the same completion card
- do not send a second fallback card/text for this desktop lifecycle surface

This keeps the UI single-surface and avoids making the completion experience look like a two-step export.

### C. Use structure, not ad-hoc cleanup, for command visibility

We should not sanitize arbitrary assistant prose with regex-like cleanup rules.

Instead:

- command execution stays represented structurally as `shell_command` events
- the desktop card simply does not render a standalone command-count section
- final assistant content is shown as the assistant wrote it, subject only to payload truncation and normal markdown/plain-text handling

This preserves Codex meaning while still avoiding raw command exposure from the card layout itself.

### D. Introduce a desktop thread display snapshot

The core fix is to stop building desktop cards from the lossy `listRecentConversation(...)` API.

We need a dedicated rollout-derived snapshot for desktop notifications, produced from top-level thread structure.

New derived shape:

```ts
interface CodexDesktopDisplaySnapshot {
  lastHumanUserText?: string;
  latestTopLevelProgressText?: string;
  latestTopLevelPlanTodos?: PlanTodoItem[];
  latestFinalAssistantText?: string;
  latestTopLevelStatus: "running" | "completed";
}
```

This should be produced from rollout parsing, not from the generic recent-conversation API.

#### `lastHumanUserText`

Should only come from true top-level human prompt messages. It must exclude:

- subagent notifications
- plan-answer wrapper payloads
- other synthetic/user-like bridge text

The key requirement is structural filtering, not string pattern cleanup.

If the rollout format does not currently preserve enough structure, we should extend the conversation extractor to annotate user items with origin metadata rather than guessing later.

### E. Tighten completion semantics to latest top-level state

Completion must reflect the thread's latest top-level lifecycle state.

Rules:

- a completion only becomes card status `已完成` if no newer top-level running turn exists after it
- if a newer top-level running turn exists, that older completion is treated as stale for display purposes
- subagent-local completion must never close the top-level desktop card

This applies both:

- during normal incremental polling
- during service bootstrap / restart recovery

### F. Plan display policy

Running card:

- render top-level plan todos if present

Completed card:

- omit plan todos by default in this change

Reason:

- the completed card should behave like a conversation handoff, not a status dashboard
- plan items are much more useful while the task is still running

## Implementation Strategy

### Option 1: Minimal patch on current desktop notifier

- reorder sections in builder
- remove command block
- stop sending full reply
- add lightweight filters around `listRecentConversation`

Pros:

- small diff

Cons:

- keeps relying on lossy conversation extraction
- still vulnerable to synthetic user pollution

### Option 2: Recommended structural snapshot path

- extend rollout parsing / catalog extraction for desktop display semantics
- desktop notifier consumes that structured snapshot
- builder becomes purely presentational

Pros:

- fixes both UX and data correctness
- avoids regex-style content scrubbing
- scales better for future desktop card improvements

Cons:

- slightly broader diff

### Option 3: Reuse generic recent conversation plus special-case string cleanup

Pros:

- quickest to implement

Cons:

- exactly the kind of brittle text-rule system we want to avoid
- likely to regress when Codex output format changes

Recommendation: Option 2.

## File-Level Design

### `src/feishu-card/desktop-completion-card-builder.ts`

Change responsibilities:

- reorder body sections
- remove standalone command-count section
- render completed result directly in-card
- render plan only for running cards
- adjust payload compaction paths accordingly

### `src/desktop-completion-notifier.ts`

Change responsibilities:

- stop calling `sendCardResult` / `sendTextResult` after completion
- pass full completion result into the builder
- stop using generic `resolveLastUserReminder(...)` for desktop cards
- consume the new structured desktop display snapshot instead

### `src/codex-desktop-completion-observer.ts`

Potential changes:

- extend top-level lifecycle extraction to surface richer display-state signals
- make sure status reflects latest top-level turn only

### `src/codex-sqlite-catalog.ts`

Likely changes:

- either add a richer desktop-display reader
- or extend recent-conversation extraction so user messages carry origin metadata

Recommendation:

- add a separate desktop-display extraction path instead of mutating generic recent conversation behavior too aggressively

### `src/runtime.ts`

Potential changes:

- if observer output shape changes, runtime passes richer snapshot through
- completion/running arbitration remains latest-top-level-state only

### `tests/*`

Need new or updated tests for:

- card section order
- no standalone `进度 / Ran N commands` on desktop cards
- completed card does not emit secondary full-reply message
- synthetic user-like messages are excluded from `你最后说了什么`
- stale completion vs newer running turn
- subagent activity does not close top-level desktop card

## Testing Strategy

### Unit tests

- `tests/desktop-completion-card-builder.test.ts`
- `tests/desktop-completion-notifier.test.ts`
- `tests/codex-sqlite-catalog.test.ts` or a new desktop-display extractor test
- `tests/codex-desktop-lifecycle-observer.test.ts`

### Runtime integration tests

- `tests/runtime-desktop-completion-notifier.test.ts`

Need explicit scenarios:

1. Running card section order
2. Completed card section order
3. Completed card renders answer directly and no extra message is sent
4. Synthetic subagent notification is not chosen as last human input
5. Thread with plan + subagent activity remains running if latest top-level state is still running

## Risks

### Risk 1: We still cannot reliably distinguish human vs synthetic prompt from rollout

Mitigation:

- first inspect whether rollout already preserves enough event structure
- only fall back to additional metadata extraction if strictly necessary

### Risk 2: Full completion text may overflow the card too often

Mitigation:

- keep current 30 KB compaction budget
- truncate inside the same card
- avoid second-message fallback in this flow

### Risk 3: Generic recent-conversation behavior could be affected unintentionally

Mitigation:

- prefer a desktop-specific extractor over changing generic thread-switch preview semantics

## Acceptance Criteria

- Desktop cards show `你最后说了什么` before `当前情况` or `Codex 最终返回了什么`.
- Desktop completion updates do not send a second "完整回复" card/text.
- Desktop cards no longer show a standalone `进度 / Ran N commands` section.
- `你最后说了什么` never displays subagent/system wrapper text for the scenarios covered in tests.
- Threads whose latest top-level state is still running are never shown as completed.
- Existing Feishu run suppression behavior remains intact.
