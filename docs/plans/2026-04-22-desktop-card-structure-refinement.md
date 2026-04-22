# Desktop Card Structure Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine desktop lifecycle cards so they read like a conversation handoff, not an ops panel, while fixing incorrect last-user extraction and latest-top-level completion semantics.

**Architecture:** Keep the existing desktop lifecycle polling model, but change the desktop card data source from generic recent-conversation text to a more structured desktop display snapshot. The builder becomes presentational, the notifier stops sending a second full-reply message, and runtime/observer/catalog logic tighten top-level state selection.

**Tech Stack:** TypeScript, Vitest, Feishu interactive message cards, SQLite-backed session store, Codex rollout JSONL parsing.

---

### Task 1: Lock the desired desktop card UI in tests

**Files:**
- Modify: `tests/desktop-completion-card-builder.test.ts`
- Modify: `src/feishu-card/desktop-completion-card-builder.ts`

**Step 1: Write the failing test**

Add tests that require:

- running card order:
  - overview
  - `你最后说了什么`
  - `当前情况`
  - optional `计划清单`
- completed card order:
  - overview
  - `你最后说了什么`
  - `Codex 最终返回了什么`
- no standalone `进度`
- no `Ran N commands`
- completed card omits `计划清单`

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/desktop-completion-card-builder.test.ts
```

Expected:

- FAIL because the builder still renders summary/progress before reminder
- FAIL because the command-count block still appears

**Step 3: Write minimal implementation**

Update `src/feishu-card/desktop-completion-card-builder.ts` to:

- reorder sections
- remove the command-count section
- render plan todos only for running cards

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/desktop-completion-card-builder.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-card-builder.test.ts src/feishu-card/desktop-completion-card-builder.ts
git commit -m "fix: simplify desktop card layout"
```

### Task 2: Remove the extra completion reply message

**Files:**
- Modify: `tests/desktop-completion-notifier.test.ts`
- Modify: `src/desktop-completion-notifier.ts`

**Step 1: Write the failing test**

Add notifier tests that require:

- completion card patch/send happens
- no follow-up `sendTextMessage` / `replyTextMessage` / `replyInteractiveCard` is emitted for the final assistant body

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/desktop-completion-notifier.test.ts
```

Expected:

- FAIL because completion currently sends the extra assistant delivery

**Step 3: Write minimal implementation**

Update `src/desktop-completion-notifier.ts` to:

- stop calling `resolveFeishuAssistantMessageDelivery(...)`
- remove the extra `sendCardResult(...)` / `sendTextResult(...)` path for desktop completion cards
- keep watch-state and notification-state updates intact

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/desktop-completion-notifier.test.ts src/desktop-completion-notifier.ts
git commit -m "fix: keep desktop completion in a single card"
```

### Task 3: Add structured extraction for “last human user text”

**Files:**
- Modify: `tests/codex-sqlite-catalog.test.ts`
- Modify: `src/codex-sqlite-catalog.ts`
- Modify: `src/types.ts`
- Modify: `src/desktop-completion-notifier.ts`

**Step 1: Write the failing test**

Add a catalog-level or extractor-level test fixture where the rollout contains:

- a real top-level human user prompt
- a later synthetic user-like subagent/system wrapper text

Require the new extractor to return the real human prompt, not the synthetic wrapper.

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex-sqlite-catalog.test.ts
```

Expected:

- FAIL because the current extraction only sees `role=user`

**Step 3: Write minimal implementation**

Introduce a richer desktop-display extraction path that returns:

- `lastHumanUserText`
- `latestFinalAssistantText`
- optionally top-level lifecycle display fields

Recommended approach:

- keep `listRecentConversation(...)` unchanged for existing thread-switch previews
- add a desktop-specific extractor in `src/codex-sqlite-catalog.ts`
- teach `DesktopCompletionNotifier` to consume this new structured source instead of `resolveLastUserReminder(...)`

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/codex-sqlite-catalog.test.ts tests/desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/codex-sqlite-catalog.test.ts src/codex-sqlite-catalog.ts src/types.ts src/desktop-completion-notifier.ts
git commit -m "fix: use human prompts for desktop card context"
```

### Task 4: Tighten latest-top-level completion semantics

**Files:**
- Modify: `tests/codex-desktop-lifecycle-observer.test.ts`
- Modify: `tests/runtime-desktop-completion-notifier.test.ts`
- Modify: `src/codex-desktop-completion-observer.ts`
- Modify: `src/runtime.ts`

**Step 1: Write the failing test**

Add tests covering:

- a thread using plan + subagent where a sub-step completes but the top-level turn is still running
- the desktop card must stay `进行中`
- the completion card must not be emitted

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex-desktop-lifecycle-observer.test.ts tests/runtime-desktop-completion-notifier.test.ts
```

Expected:

- FAIL because top-level state is still derived too loosely from any visible completion

**Step 3: Write minimal implementation**

Tighten observer/runtime logic so that:

- card status reflects latest top-level state only
- older or nested completion does not close the thread card
- a newer running top-level state always wins

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/codex-desktop-lifecycle-observer.test.ts tests/runtime-desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/codex-desktop-lifecycle-observer.test.ts tests/runtime-desktop-completion-notifier.test.ts src/codex-desktop-completion-observer.ts src/runtime.ts
git commit -m "fix: keep desktop cards aligned with latest top-level state"
```

### Task 5: Wire the new desktop display snapshot through the builder/notifier/runtime path

**Files:**
- Modify: `src/types.ts`
- Modify: `src/desktop-completion-notifier.ts`
- Modify: `src/runtime.ts`
- Modify: `src/codex-sqlite-catalog.ts`
- Modify: `tests/desktop-completion-notifier.test.ts`
- Modify: `tests/runtime-desktop-completion-notifier.test.ts`

**Step 1: Write the failing test**

Add end-to-end-ish notifier/runtime assertions that the desktop card now renders:

- last human user text first
- current/final content second
- no extra completion reply message
- no command-count section

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/desktop-completion-notifier.test.ts tests/runtime-desktop-completion-notifier.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

Plumb the structured desktop display snapshot all the way through:

- catalog/extractor -> notifier
- lifecycle/runtime status -> notifier
- notifier -> builder

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/desktop-completion-notifier.test.ts tests/runtime-desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/desktop-completion-notifier.ts src/runtime.ts src/codex-sqlite-catalog.ts tests/desktop-completion-notifier.test.ts tests/runtime-desktop-completion-notifier.test.ts
git commit -m "feat: use structured desktop display snapshots"
```

### Task 6: Update docs and run verification

**Files:**
- Modify: `docs/project-full-overview.md`
- Modify: any touched tests listed above

**Step 1: Update the project overview**

Document:

- new card section order
- no extra full-reply message for desktop completion
- human-prompt extraction behavior
- latest-top-level-state rule
- no desktop command-count section

**Step 2: Run targeted verification**

Run:

```bash
npm test -- tests/desktop-completion-card-builder.test.ts tests/desktop-completion-notifier.test.ts tests/codex-sqlite-catalog.test.ts tests/codex-desktop-lifecycle-observer.test.ts tests/runtime-desktop-completion-notifier.test.ts
```

Expected: PASS

**Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS

**Step 4: Commit**

```bash
git add docs/project-full-overview.md
git commit -m "docs: sync desktop card refinement behavior"
```

### Task 7: Final sanity verification commit

**Files:**
- No new files required beyond current working set

**Step 1: Run the final verification bundle**

Run:

```bash
npm test -- tests/desktop-completion-card-builder.test.ts tests/desktop-completion-notifier.test.ts tests/codex-sqlite-catalog.test.ts tests/codex-desktop-lifecycle-observer.test.ts tests/runtime-desktop-completion-notifier.test.ts tests/runtime.test.ts
npm run build
```

Expected: PASS

**Step 2: Check git status**

Run:

```bash
git status --short
```

Expected:

- only expected changes

**Step 3: Commit final polish if needed**

```bash
git add <relevant-files>
git commit -m "fix: finalize desktop card refinement"
```
