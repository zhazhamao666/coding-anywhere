# Feishu Desktop Completion Notifications Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect native Codex thread completions that happen outside the bridge, notify Feishu automatically with the final result, and let the user continue the same thread from Feishu.

**Architecture:** Add a local Codex completion observer that tails rollout JSONL files and persists watch state in SQLite. Reuse existing Feishu topic bindings, project-group bindings, and DM thread switching to route notifications and hand the thread over to the normal Codex conversation surface.

**Tech Stack:** TypeScript, better-sqlite3, Feishu IM/card APIs, JSON 2.0 cards, Vitest, existing bridge runtime

---

### Task 1: Lock watch-state persistence with tests

**Files:**
- Create: `tests/session-store-desktop-watch.test.ts`
- Modify: `src/workspace/session-store.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

Add tests that assert the store can:

- create and reload a `codex_thread_watch_state` row;
- update `last_read_offset`;
- persist `last_completion_key`;
- persist `last_notified_completion_key`;
- leave notification state unchanged when only offsets move.

Example test skeleton:

```ts
it("persists desktop watch state for a native thread", () => {
  const store = createSessionStore();

  store.upsertCodexThreadWatchState({
    threadId: "thread-1",
    rolloutPath: "C:/Users/demo/.codex/sessions/rollout-1.jsonl",
    rolloutMtime: "2026-04-20T10:00:00.000Z",
    lastReadOffset: 123,
    lastCompletionKey: "thread-1:key-1",
    lastNotifiedCompletionKey: "thread-1:key-1",
  });

  expect(store.getCodexThreadWatchState("thread-1")).toMatchObject({
    threadId: "thread-1",
    lastReadOffset: 123,
    lastCompletionKey: "thread-1:key-1",
    lastNotifiedCompletionKey: "thread-1:key-1",
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/session-store-desktop-watch.test.ts`
Expected: FAIL because the watch-state table and methods do not exist.

**Step 3: Write minimal implementation**

Add:

- new type definitions for desktop watch state;
- SQLite migration for `codex_thread_watch_state`;
- store methods:
  - `upsertCodexThreadWatchState(...)`
  - `getCodexThreadWatchState(threadId)`
  - `listCodexThreadWatchStates()`

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/session-store-desktop-watch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/session-store-desktop-watch.test.ts src/workspace/session-store.ts src/types.ts
git commit -m "test: add desktop watch state persistence"
```

### Task 2: Lock completion extraction behavior with tests

**Files:**
- Create: `tests/codex-desktop-completion-observer.test.ts`
- Create: `tests/fixtures/codex/desktop-completion-single.jsonl`
- Create: `tests/fixtures/codex/desktop-completion-repeat.jsonl`
- Create: `src/codex-desktop-completion-observer.ts`

**Step 1: Write the failing test**

Add tests that assert an observer/parser can:

- read from a given byte offset;
- detect `task_complete`;
- extract the latest final assistant message;
- build a stable `completionKey`;
- emit nothing when no new terminal event exists.

Example assertion shape:

```ts
expect(events).toEqual([{
  threadId: "thread-1",
  completedAt: "2026-04-20T10:00:10.000Z",
  finalAssistantText: "done text",
  completionKey: expect.stringContaining("thread-1"),
}]);
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/codex-desktop-completion-observer.test.ts`
Expected: FAIL because the observer/parser does not exist.

**Step 3: Write minimal implementation**

Create `src/codex-desktop-completion-observer.ts` with pure functions to:

- read appended JSONL lines from a watched rollout file;
- extract completion metadata;
- return:
  - next offset;
  - extracted completion event or `undefined`.

Keep file reading and parsing logic separate from Feishu delivery logic.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/codex-desktop-completion-observer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/codex-desktop-completion-observer.test.ts tests/fixtures/codex/desktop-completion-single.jsonl tests/fixtures/codex/desktop-completion-repeat.jsonl src/codex-desktop-completion-observer.ts
git commit -m "feat: add desktop completion extraction"
```

### Task 3: Lock route resolution with tests

**Files:**
- Create: `tests/desktop-completion-routing.test.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/workspace/session-store.ts`
- Modify: `src/codex-sqlite-catalog.ts`

**Step 1: Write the failing test**

Add tests covering route precedence:

- exact native thread already bound to a Feishu topic => route to topic;
- no topic binding but project bound to group => route to group timeline;
- no topic or group => route to DM fallback;
- invalid group/topic => fall back to DM.

Test with small doubles rather than full runtime boot.

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-completion-routing.test.ts`
Expected: FAIL because no route resolver exists.

**Step 3: Write minimal implementation**

Add a route resolver abstraction, either:

- inside `BridgeService`, or
- as a new helper module consumed by runtime/notification delivery.

It must return a normalized delivery target shape:

```ts
{
  mode: "thread" | "project_group" | "dm",
  peerId?: string,
  chatId?: string,
  surfaceRef?: string,
}
```

Also add config support for `feishu.desktopOwnerOpenId`, with the rule:

- optional if allowlist length is 1;
- required for DM fallback if allowlist length is greater than 1.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/desktop-completion-routing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-routing.test.ts src/bridge-service.ts src/workspace/session-store.ts src/codex-sqlite-catalog.ts src/config.ts config.example.toml
git commit -m "feat: add desktop completion route resolution"
```

### Task 4: Lock notification card rendering with tests

**Files:**
- Create: `tests/desktop-completion-card-builder.test.ts`
- Create: `src/feishu-card/desktop-completion-card-builder.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

Add tests that assert:

- DM notification cards render a notification-style layout, not a generic navigation card;
- group notification cards use a different primary action label;
- the card includes project name, thread name, completion status, completion time, and result summary;
- the card does not include raw navigation clutter like `项目列表` or `导航`.

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-completion-card-builder.test.ts`
Expected: FAIL because the builder does not exist.

**Step 3: Write minimal implementation**

Create a dedicated card builder instead of reusing `buildBridgeHubCard(...)` directly. The builder should accept:

```ts
{
  mode: "dm" | "project_group",
  projectName: string,
  threadTitle: string,
  completedAt: string,
  summaryLines: string[],
  lastUserHint?: string,
  threadId: string,
}
```

and output a JSON 2.0 card with:

- one primary action;
- at most two secondary actions;
- notification-oriented copy.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/desktop-completion-card-builder.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-card-builder.test.ts src/feishu-card/desktop-completion-card-builder.ts src/types.ts
git commit -m "feat: add desktop completion notification cards"
```

### Task 5: Lock DM continue handoff with tests

**Files:**
- Create: `tests/desktop-completion-dm-handoff.test.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-card/desktop-completion-card-builder.ts`

**Step 1: Write the failing test**

Add a test for a DM notification card button click that asserts:

- the DM window becomes bound to the native `thread_id`;
- the response card becomes the normal "current session" card rather than a "thread switched" acknowledgement card;
- the next plain DM message resumes the same native thread.

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-completion-dm-handoff.test.ts`
Expected: FAIL because the dedicated handoff action does not exist.

**Step 3: Write minimal implementation**

Add a new button action path, likely a new `bridgeAction` such as:

- `continue_desktop_thread`

For DM this action should:

- bind the DM to the thread;
- load recent conversation;
- return the same card shape used by the normal current-session view.

Do not reuse the older "线程已切换" card for this flow.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/desktop-completion-dm-handoff.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-dm-handoff.test.ts src/feishu-card-action-service.ts src/bridge-service.ts src/feishu-card/desktop-completion-card-builder.ts
git commit -m "feat: add DM handoff for desktop completion notifications"
```

### Task 6: Lock group continue handoff with tests

**Files:**
- Create: `tests/desktop-completion-group-handoff.test.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/project-thread-service.ts`

**Step 1: Write the failing test**

Add a group timeline notification click test that asserts:

- a Feishu topic gets created or linked for the native thread;
- the normal current-session card is posted into that topic;
- the original notification card is updated to indicate continuation moved to the topic.

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-completion-group-handoff.test.ts`
Expected: FAIL because the group handoff path does not exist.

**Step 3: Write minimal implementation**

Implement the group handoff action using the existing project-thread service and existing native-thread link behavior. Keep the original group timeline message as a notification artifact only.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/desktop-completion-group-handoff.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-group-handoff.test.ts src/feishu-card-action-service.ts src/bridge-service.ts src/project-thread-service.ts
git commit -m "feat: add group topic handoff for desktop completion notifications"
```

### Task 7: Wire observer and notification publishing into runtime

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/feishu-adapter.ts`
- Modify: `src/feishu-api-client.ts`
- Create: `src/desktop-completion-notifier.ts`
- Create: `tests/runtime-desktop-completion-notifier.test.ts`

**Step 1: Write the failing test**

Add a runtime-level integration test that simulates:

- a discovered completion event;
- route resolution;
- card send;
- full final result send;
- watch-state advancement.

Also verify:

- same `completionKey` is not sent twice;
- changed `completionKey` sends a new message.

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/runtime-desktop-completion-notifier.test.ts`
Expected: FAIL because runtime does not yet wire the notifier.

**Step 3: Write minimal implementation**

Create a notifier service that:

- receives extracted completion events;
- resolves the delivery target;
- sends a new notification card message;
- sends the full final result message below it;
- persists the last notified completion key.

Wire it into `runtime.ts` on a polling timer near the other maintenance loops.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/runtime-desktop-completion-notifier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/runtime-desktop-completion-notifier.test.ts src/runtime.ts src/desktop-completion-notifier.ts src/feishu-adapter.ts src/feishu-api-client.ts
git commit -m "feat: wire desktop completion notifications into runtime"
```

### Task 8: Lock bridge-originated suppression with tests

**Files:**
- Create: `tests/desktop-completion-suppression.test.ts`
- Modify: `src/desktop-completion-notifier.ts`
- Modify: `src/workspace/session-store.ts`

**Step 1: Write the failing test**

Add tests that assert:

- a recently finished `observability_runs` record for the same `thread_id` suppresses the desktop notification;
- a stale or unrelated observability run does not suppress the notification.

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/desktop-completion-suppression.test.ts`
Expected: FAIL because suppression logic does not exist yet.

**Step 3: Write minimal implementation**

Add a helper query in `SessionStore` for recent terminal observability runs by `thread_id`, and use it in the notifier to skip bridge-originated completions inside the correlation window.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/desktop-completion-suppression.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-suppression.test.ts src/desktop-completion-notifier.ts src/workspace/session-store.ts
git commit -m "fix: suppress duplicate notifications for bridge-originated runs"
```

### Task 9: Sync docs and configuration docs

**Files:**
- Modify: `docs/project-full-overview.md`
- Modify: `docs/feishu-setup.md`
- Modify: `config.example.toml`

**Step 1: Update docs**

Document:

- the new desktop completion observer;
- new notification routing behavior;
- DM/group continue behavior;
- repeated completion behavior;
- `feishu.desktopOwnerOpenId`;
- verification steps.

**Step 2: Run verification**

Run:

- `npm run test -- tests/session-store-desktop-watch.test.ts`
- `npm run test -- tests/codex-desktop-completion-observer.test.ts`
- `npm run test -- tests/desktop-completion-routing.test.ts`
- `npm run test -- tests/desktop-completion-card-builder.test.ts`
- `npm run test -- tests/desktop-completion-dm-handoff.test.ts`
- `npm run test -- tests/desktop-completion-group-handoff.test.ts`
- `npm run test -- tests/runtime-desktop-completion-notifier.test.ts`
- `npm run test -- tests/desktop-completion-suppression.test.ts`
- `npm run build`

Expected: all tests pass and the build succeeds.

**Step 3: Commit**

```bash
git add docs/project-full-overview.md docs/feishu-setup.md config.example.toml
git commit -m "docs: describe desktop completion notification flow"
```
