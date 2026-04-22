# Feishu Desktop Running Lifecycle Notifications Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add full desktop-run lifecycle notifications in Feishu so a desktop-originated top-level Codex thread creates a running card, keeps that card updated with public progress, then patches the same card into a completed card with the final result preview and continuation action.

**Architecture:** Extend the current desktop-completion poller into a lifecycle poller, introduce a durable notification-state table that stores the active running-card `message_id`, and add a shared public-progress model so both desktop notifications and bridge-run cards show plan progress and `Ran N commands` without leaking raw command lines.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Feishu IM interactive cards and message patching, existing runtime poller, existing bridge progress-card rendering.

---

### Task 1: Add notification-state persistence tests

**Files:**
- Create: `tests/session-store-desktop-notification-state.test.ts`
- Modify: `src/workspace/session-store.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

Add tests that verify the store can:

- insert a desktop notification state row;
- reload it after reopening the store;
- update `lastRenderHash` without losing `messageId`;
- clear the row;
- keep route fields (`deliveryMode`, `peerId`, `chatId`, `surfaceType`, `surfaceRef`) intact.

Example:

```ts
it("persists desktop running notification state", () => {
  store.upsertCodexThreadDesktopNotificationState({
    threadId: "thread-1",
    activeRunKey: "thread-1:run-1",
    status: "running_notified",
    messageId: "om_running_1",
    deliveryMode: "dm",
    peerId: "ou_demo",
    lastRenderHash: "hash-1",
  });

  expect(store.getCodexThreadDesktopNotificationState("thread-1")).toMatchObject({
    activeRunKey: "thread-1:run-1",
    status: "running_notified",
    messageId: "om_running_1",
    deliveryMode: "dm",
    peerId: "ou_demo",
    lastRenderHash: "hash-1",
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session-store-desktop-notification-state.test.ts
```

Expected: FAIL because the new table and store methods do not exist.

**Step 3: Write minimal implementation**

Add:

- `CodexThreadDesktopNotificationStateRecord` type in `src/types.ts`
- new SQLite table `codex_thread_desktop_notification_state`
- store methods:
  - `upsertCodexThreadDesktopNotificationState(...)`
  - `getCodexThreadDesktopNotificationState(threadId)`
  - `clearCodexThreadDesktopNotificationState(threadId)`
  - `listCodexThreadDesktopNotificationStates()`

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/session-store-desktop-notification-state.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/session-store-desktop-notification-state.test.ts src/workspace/session-store.ts src/types.ts
git commit -m "test: add desktop notification state persistence"
```

### Task 2: Lock lifecycle observer behavior with tests

**Files:**
- Create: `tests/codex-desktop-lifecycle-observer.test.ts`
- Create: `tests/fixtures/codex/desktop-running-progress.jsonl`
- Create: `tests/fixtures/codex/desktop-running-complete-same-poll.jsonl`
- Modify: `src/codex-desktop-completion-observer.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

Add tests that verify the observer can:

- detect a new run start from top-level rollout data;
- track `commandCount` without exposing raw commands;
- extract `todo_list` plan items;
- produce a `progressSnapshot`;
- collapse start+complete in the same poll into a completion-only result;
- keep `completionKey` behavior unchanged.

Example assertions:

```ts
expect(result.progressSnapshot).toMatchObject({
  runKey: expect.stringContaining("thread-1"),
  commandCount: 3,
  planTodos: [
    { text: "Task 1", completed: false },
  ],
});

expect(JSON.stringify(result.progressSnapshot)).not.toContain("powershell.exe");
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex-desktop-lifecycle-observer.test.ts
```

Expected: FAIL because the observer only supports completion extraction today.

**Step 3: Write minimal implementation**

Refactor `src/codex-desktop-completion-observer.ts` into a lifecycle observer that can emit:

- `runStarted`
- `progressSnapshot`
- `completion`
- `nextOffset`

Preserve the old completion extraction helpers if useful for compatibility, but the runtime should consume the richer lifecycle result.

Rules:

- prefer `turn.started` when available;
- count `command_execution` items by incrementing `commandCount`;
- parse `todo_list` into `PlanTodoItem[]`;
- do not keep raw command text in user-facing progress output.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/codex-desktop-lifecycle-observer.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/codex-desktop-lifecycle-observer.test.ts tests/fixtures/codex/desktop-running-progress.jsonl tests/fixtures/codex/desktop-running-complete-same-poll.jsonl src/codex-desktop-completion-observer.ts src/types.ts
git commit -m "feat: add desktop lifecycle observer"
```

### Task 3: Add shared public-progress fields to bridge progress state

**Files:**
- Modify: `src/types.ts`
- Modify: `src/progress-relay.ts`
- Modify: `tests/progress-relay.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- command-execution runner events increment `commandCount`;
- preview stays generic;
- plan todos continue to flow through state reduction;
- `latestTool` no longer controls user-facing card copy.

Example:

```ts
expect(next.commandCount).toBe(3);
expect(next.preview).toBe("[ca] running command");
expect(next.preview).not.toContain("npm test");
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/progress-relay.test.ts
```

Expected: FAIL because `commandCount` does not exist yet and preview currently includes the tool name.

**Step 3: Write minimal implementation**

Extend `ProgressCardState` with:

- `commandCount?: number`
- `latestPublicMessage?: string`

Update `reduceProgressEvent(...)` so:

- command execution increments `commandCount`;
- user-facing preview becomes generic;
- text/waiting events continue to drive `latestPublicMessage`.

Keep any raw tool detail internal-only if needed for ops, but do not keep routing it into card preview.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/progress-relay.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/progress-relay.ts tests/progress-relay.test.ts
git commit -m "feat: add shared public progress state"
```

### Task 4: Stop treating raw command strings as user-facing tool labels

**Files:**
- Modify: `src/codex-cli-runner.ts`
- Modify: `tests/codex-cli-runner.test.ts`

**Step 1: Write the failing test**

Update/add tests so command execution no longer expects raw command strings in user-facing event content.

Example:

```ts
expect(events).toContainEqual({
  type: "tool_call",
  toolName: "command_execution",
  content: "command_execution",
});
```

or, if the event type is changed, assert that the runner emits a generic command-execution event without the raw command text.

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex-cli-runner.test.ts
```

Expected: FAIL because tests and implementation still expect the raw command text.

**Step 3: Write minimal implementation**

Change `parseCodexExecLine(...)` so `command_execution` does not feed the raw command line into user-facing event fields.

Allowed approaches:

- keep `type: "tool_call"` but use a generic `toolName`;
- or introduce a new event kind such as `command_execution`.

Recommendation:

- keep the surface area small for now and use a generic `tool_call` payload or dedicated command counter logic.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/codex-cli-runner.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/codex-cli-runner.ts tests/codex-cli-runner.test.ts
git commit -m "fix: hide raw command text from runner events"
```

### Task 5: Add shared helper sections for todo list and command count

**Files:**
- Modify: `src/feishu-card/card-builder.ts`
- Create: `tests/feishu-card-public-progress.test.ts`

**Step 1: Write the failing test**

Add card-builder tests that verify:

- running cards show `Ran N commands` when `commandCount > 0`;
- raw command text is not present;
- plan todo rendering is preserved;
- terminal cards still show the completed summary.

Example:

```ts
expect(serialized).toContain("Ran 3 commands");
expect(serialized).not.toContain("powershell.exe");
expect(serialized).toContain("计划清单");
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/feishu-card-public-progress.test.ts tests/feishu-card-builder.test.ts
```

Expected: FAIL because the current builder still renders `最近工具`.

**Step 3: Write minimal implementation**

Refactor `src/feishu-card/card-builder.ts`:

- remove user-facing `最近工具`;
- add helper sections for:
  - public progress summary
  - plan todos
  - command count
- render `Ran N commands` when applicable.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/feishu-card-public-progress.test.ts tests/feishu-card-builder.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/feishu-card/card-builder.ts tests/feishu-card-public-progress.test.ts tests/feishu-card-builder.test.ts
git commit -m "feat: render public progress without raw commands"
```

### Task 6: Remove raw-command leakage from `/ca` session/status summaries

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `tests/bridge-service.test.ts`

**Step 1: Write the failing test**

Update summary-card tests to assert:

- `最近工具` is no longer shown in user-facing summary lines;
- `Ran N commands` or `已执行命令：N` appears instead.

Example:

```ts
expect(serialized).toContain("Ran 3 commands");
expect(serialized).not.toContain("最近工具");
expect(serialized).not.toContain("npm test");
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bridge-service.test.ts
```

Expected: FAIL because bridge summaries still include `最近工具`.

**Step 3: Write minimal implementation**

Change the current-session and status summary builders in `src/bridge-service.ts` to use:

- sanitized preview;
- command count;
- plan snapshot where relevant.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/bridge-service.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/bridge-service.ts tests/bridge-service.test.ts
git commit -m "fix: redact raw command details from bridge summaries"
```

### Task 7: Add desktop lifecycle card builder tests

**Files:**
- Modify: `src/feishu-card/desktop-completion-card-builder.ts`
- Modify: `src/types.ts`
- Create: `tests/desktop-lifecycle-card-builder.test.ts`

**Step 1: Write the failing test**

Add tests for both running and completed card modes:

- running card header is `桌面任务进行中`;
- completed card header is `桌面任务已完成`;
- running card has no `在飞书继续`;
- completed card does have `在飞书继续`;
- plan todos render;
- `Ran N commands` renders;
- raw command text does not render.

Example:

```ts
expect(runningSerialized).toContain("桌面任务进行中");
expect(runningSerialized).toContain("Ran 3 commands");
expect(runningSerialized).not.toContain("在飞书继续");
expect(runningSerialized).not.toContain("powershell.exe");

expect(doneSerialized).toContain("桌面任务已完成");
expect(doneSerialized).toContain("在飞书继续");
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/desktop-lifecycle-card-builder.test.ts
```

Expected: FAIL because the current builder only supports completed cards.

**Step 3: Write minimal implementation**

Extend the desktop card builder input model with:

- `status`
- `startedAt?`
- `completedAt?`
- `lastUserText?`
- `finalAssistantPreview?`
- `planTodos?`
- `commandCount?`
- `latestPublicMessage?`

Support two rendering modes:

- `running`
- `completed`

Reuse shared helper sections for todo and command count.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/desktop-lifecycle-card-builder.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/feishu-card/desktop-completion-card-builder.ts src/types.ts tests/desktop-lifecycle-card-builder.test.ts
git commit -m "feat: add desktop running and completed lifecycle cards"
```

### Task 8: Add notifier tests for running-card create and progress patch

**Files:**
- Modify: `src/desktop-completion-notifier.ts`
- Create: `tests/desktop-lifecycle-notifier.test.ts`

**Step 1: Write the failing test**

Add tests covering:

- `publishRunning(...)` creates a running card and stores `messageId`;
- subsequent `publishRunningUpdate(...)` patches the same message;
- no patch happens when the render hash is unchanged;
- `publishCompleted(...)` patches the same message into a completed card;
- if completion patch fails, notifier sends a fresh completed card as fallback and clears active state.

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/desktop-lifecycle-notifier.test.ts
```

Expected: FAIL because the notifier currently only supports completion sends.

**Step 3: Write minimal implementation**

Refactor the notifier into lifecycle operations:

- `publishRunning(...)`
- `publishRunningUpdate(...)`
- `publishCompleted(...)`

or a single richer `publishLifecycleTransition(...)` API if preferred.

Requirements:

- running create returns/saves `message_id`;
- progress updates call `updateInteractiveCard(messageId, card)`;
- completion patches the same message when possible;
- fallback to a fresh completed card on patch failure.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/desktop-lifecycle-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/desktop-completion-notifier.ts tests/desktop-lifecycle-notifier.test.ts
git commit -m "feat: add desktop lifecycle notifier patch flow"
```

### Task 9: Add runtime lifecycle tests

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime-desktop-completion-notifier.test.ts`

**Step 1: Write the failing test**

Extend runtime tests to verify:

- bootstrap still skips historical data;
- a new running lifecycle creates exactly one running card;
- later progress updates patch the same message;
- completion patches the same message instead of sending a second status card;
- same-poll start+complete only yields the completed card;
- subagent and Feishu-originated suppression still work.

Example assertions:

```ts
expect(apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1);
expect(apiClient.updateInteractiveCard).toHaveBeenCalledWith("om_running_1", expect.any(Object));
expect(apiClient.sendInteractiveCard).toHaveBeenCalledTimes(1); // still one status card
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/runtime-desktop-completion-notifier.test.ts
```

Expected: FAIL because runtime only knows the completion-only flow today.

**Step 3: Write minimal implementation**

Update `pollDesktopCompletionNotifications(...)` so it:

- creates running notifications when a new lifecycle starts;
- stores notification state;
- patches on progress change when `renderHash` changes;
- patches or falls back on completion;
- clears state after terminal handling.

Preserve:

- bootstrap skip behavior;
- completion-key dedupe;
- bridge-originated suppression;
- subagent suppression.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/runtime-desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime-desktop-completion-notifier.test.ts
git commit -m "feat: add desktop running lifecycle polling"
```

### Task 10: Update follow-up final-result delivery behavior

**Files:**
- Modify: `src/desktop-completion-notifier.ts`
- Modify: `tests/desktop-completion-notifier.test.ts`

**Step 1: Write the failing test**

Adjust/add tests to verify:

- completed cards always include a final-result preview;
- a separate full result message is sent only when needed;
- long Markdown results still use the existing markdown-card delivery helper;
- raw command text is not injected by notifier-generated summaries.

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/desktop-completion-notifier.test.ts
```

Expected: FAIL because current notifier always sends the final result after the completion card and does not distinguish preview vs follow-up policy.

**Step 3: Write minimal implementation**

Adjust completion sending logic so:

- completed card includes last user text and final result preview;
- full result follow-up is conditional based on size/structure;
- the existing assistant markdown/text delivery helper is still reused for the full result when follow-up is needed.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/desktop-completion-notifier.ts tests/desktop-completion-notifier.test.ts
git commit -m "feat: refine desktop completed-card result delivery"
```

### Task 11: Run focused regression suite

**Files:**
- No code changes expected

**Step 1: Run focused tests**

Run:

```bash
npm test -- tests/session-store-desktop-notification-state.test.ts tests/codex-desktop-lifecycle-observer.test.ts tests/progress-relay.test.ts tests/codex-cli-runner.test.ts tests/feishu-card-public-progress.test.ts tests/feishu-card-builder.test.ts tests/bridge-service.test.ts tests/desktop-lifecycle-card-builder.test.ts tests/desktop-lifecycle-notifier.test.ts tests/desktop-completion-notifier.test.ts tests/runtime-desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 2: Fix any failures**

If any test fails:

- patch the minimal implementation;
- rerun only the failing test first;
- rerun the whole focused suite.

**Step 3: Commit**

```bash
git add -A
git commit -m "test: verify desktop lifecycle notification regressions"
```

### Task 12: Run build and broad runtime smoke tests

**Files:**
- No code changes expected unless a build/runtime issue is found

**Step 1: Run build**

Run:

```bash
npm run build
```

Expected: success

**Step 2: Run broader smoke tests**

Run:

```bash
npm test -- tests/desktop-completion-routing.test.ts tests/desktop-completion-dm-handoff.test.ts tests/desktop-completion-group-handoff.test.ts tests/feishu-adapter.test.ts tests/feishu-card-action-service.test.ts tests/runtime.test.ts
```

Expected: PASS

**Step 3: Fix any failures**

If needed, make minimal compatibility fixes and rerun the affected tests.

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: stabilize desktop lifecycle notification integration"
```

### Task 13: Sync the project overview document

**Files:**
- Modify: `docs/project-full-overview.md`

**Step 1: Update the document**

Revise the overview so it accurately reflects:

- desktop lifecycle notifications now include running-card create + patch + completed patch;
- plan list and `Ran N commands` are shown in desktop cards;
- raw command details are no longer exposed in user-facing Feishu status cards;
- the desktop notification system now uses a second notification-state table in addition to watch-state polling.

**Step 2: Verify accuracy**

Re-read the sections that mention:

- current goals
- current capabilities
- architecture
- runtime responsibilities
- testing coverage

**Step 3: Commit**

```bash
git add docs/project-full-overview.md
git commit -m "docs: sync desktop lifecycle notification architecture"
```

### Task 14: Final verification and delivery

**Files:**
- No code changes expected

**Step 1: Check git status**

Run:

```bash
git status --short
```

Expected: clean worktree

**Step 2: Re-run final verification**

Run:

```bash
npm run build
npm test -- tests/runtime-desktop-completion-notifier.test.ts tests/desktop-lifecycle-notifier.test.ts tests/desktop-lifecycle-card-builder.test.ts tests/bridge-service.test.ts tests/feishu-card-builder.test.ts
```

Expected: PASS

**Step 3: Summarize implementation**

Prepare a concise summary covering:

- running-card lifecycle support
- completed-card patching
- `Ran N commands` public progress
- command-detail redaction
- tests run

**Step 4: Commit any final cleanup if needed**

```bash
git add -A
git commit -m "chore: finalize desktop lifecycle notification rollout"
```
