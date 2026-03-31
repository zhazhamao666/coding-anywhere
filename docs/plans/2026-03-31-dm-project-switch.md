# DM Project Switch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let DM users switch the current Codex project from the project list without immediately switching threads, and use that project for current-project views and the next fresh conversation.

**Architecture:** Add a DM-only persisted project selection binding alongside the existing DM native-thread binding. Update bridge command handling and DM project list cards so project switching is explicit, thread-safe, and only influences fresh-thread creation when no active native thread is already bound.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Feishu interactive cards.

---

### Task 1: Add session-store coverage for DM project selection

**Files:**
- Modify: `src/workspace/session-store.ts`
- Modify: `src/types.ts`
- Test: `tests/session-store.test.ts` or the closest existing store test file

**Step 1: Write the failing test**

Add tests that verify:
- saving a DM project selection record;
- reading it back;
- clearing it;
- migration creates the selection table in a fresh database.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session-store.test.ts`

Expected: FAIL because the new persistence methods and table do not exist yet.

**Step 3: Write minimal implementation**

Add:
- the new type in `src/types.ts`;
- store methods for upsert/get/clear;
- the migration for the new table.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session-store.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/types.ts src/workspace/session-store.ts tests/session-store.test.ts
git commit -m "feat: persist dm project selection"
```

### Task 2: Add bridge tests for project switching and DM resolution

**Files:**
- Modify: `tests/bridge-service.test.ts`
- Reference: `src/bridge-service.ts`

**Step 1: Write the failing test**

Add tests for:
- `/ca project switch <projectKey>` returns a card confirming the selected project;
- DM project list card rows include both `查看线程` and `切换项目`;
- `/ca project current` uses the DM project selection when no thread binding exists;
- `/ca thread list-current` uses the selected project when no thread binding exists;
- first ordinary DM prompt creates a new native thread in the selected project's `cwd`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge-service.test.ts`

Expected: FAIL because the command and DM resolution path do not exist yet.

**Step 3: Write minimal implementation**

Update `src/bridge-service.ts` to:
- support `/ca project switch <projectKey>`;
- read and write DM project selection;
- prefer native thread binding over project selection;
- use the selected project's `cwd` when creating a fresh DM thread.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/bridge-service.ts tests/bridge-service.test.ts
git commit -m "feat: add dm project switching"
```

### Task 3: Cover card action callback for project switch

**Files:**
- Modify: `tests/feishu-card-action-service.test.ts`
- Reference: `src/feishu-card-action-service.ts`

**Step 1: Write the failing test**

Add a test for `/ca project switch <projectKey>` showing:
- immediate ack card;
- asynchronous patch of the final result card.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: FAIL until the project list row emits the switch command and the command returns a final card.

**Step 3: Write minimal implementation**

Only adjust code if needed after Task 2. Prefer keeping `FeishuCardActionService` unchanged unless a real gap appears.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/feishu-card-action-service.test.ts src/feishu-card-action-service.ts
git commit -m "test: cover dm project switch card actions"
```

### Task 4: Update docs

**Files:**
- Modify: `docs/project-full-overview.md`
- Create: `docs/plans/2026-03-31-dm-project-switch-design.md`
- Create: `docs/plans/2026-03-31-dm-project-switch.md`

**Step 1: Write the doc update**

Document that DM project list cards can now switch the current project independently of the current thread, and that a selected DM project becomes the source of truth for `project current`, `thread list-current`, and the next fresh DM thread when no native thread is bound.

**Step 2: Verify docs match implementation**

Check the documented priority order:
- current native thread binding first;
- DM project selection second;
- no current project otherwise.

**Step 3: Commit**

```bash
git add docs/project-full-overview.md docs/plans/2026-03-31-dm-project-switch-design.md docs/plans/2026-03-31-dm-project-switch.md
git commit -m "docs: describe dm project switching"
```

### Task 5: Full verification and final commit

**Files:**
- Modify: any files touched by Tasks 1-4

**Step 1: Run targeted verification**

Run:
- `npx vitest run tests/session-store.test.ts`
- `npx vitest run tests/bridge-service.test.ts`
- `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS.

**Step 2: Run compile verification**

Run: `npx tsc -p tsconfig.json --pretty false`

Expected: exit code 0.

**Step 3: Run full verification**

Run: `npx vitest run`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/types.ts src/workspace/session-store.ts src/bridge-service.ts tests/session-store.test.ts tests/bridge-service.test.ts tests/feishu-card-action-service.test.ts docs/project-full-overview.md docs/plans/2026-03-31-dm-project-switch-design.md docs/plans/2026-03-31-dm-project-switch.md
git commit -m "feat: add dm project switching"
```
