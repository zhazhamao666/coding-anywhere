# Feishu Card Callback Timeout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Feishu card button callbacks return immediately for risky mutating `/ca` commands, then update the same interactive card asynchronously when the command finishes.

**Architecture:** Keep read-only query/navigation commands on the existing synchronous callback path. Add a command-risk classifier in `FeishuCardActionService` so commands that create or bind threads return an immediate ack card and complete through `updateInteractiveCard`.

**Tech Stack:** TypeScript, Vitest, Feishu interactive card callbacks, Codex bridge services.

---

### Task 1: Lock the timeout regression with tests

**Files:**
- Modify: `tests/feishu-card-action-service.test.ts`
- Reference: `src/feishu-card-action-service.ts`

**Step 1: Write the failing test**

Add a test for `/ca new` button handling that:
- invokes `handleAction(...)`;
- expects an immediate raw card response titled with an ack;
- verifies `bridgeService.handleMessage(...)` received `/ca new`;
- verifies the final result is applied through `apiClient.updateInteractiveCard(...)`.

Add a second failing test for a risky `thread` command such as `/ca thread switch thread-123` in project-chat context.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: failures showing `/ca new` and risky `thread` commands are still handled synchronously and never patch the interactive card later.

**Step 3: Write minimal implementation**

Implement only the code needed to route risky commands to a background path and update the same message card on completion.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS for the new regression tests and all existing card-action tests.

**Step 5: Commit**

```bash
git add tests/feishu-card-action-service.test.ts src/feishu-card-action-service.ts
git commit -m "fix: avoid feishu callback timeouts for async card commands"
```

### Task 2: Implement asynchronous command completion cards

**Files:**
- Modify: `src/feishu-card-action-service.ts`
- Reference: `src/bridge-service.ts`

**Step 1: Write the failing test**

Add or refine tests so the final background result covers:
- final `card` replies;
- final `system` replies wrapped into info cards;
- error handling by updating the original message card with an error card.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: FAIL until final update handling covers all result shapes.

**Step 3: Write minimal implementation**

Add:
- command parsing/classification for risky commands;
- a background command launcher for non-plan actions;
- a helper that turns a `BridgeReply` into the final card payload and patches `existingMessageId`.

Keep query/navigation commands on the existing synchronous path.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/feishu-card-action-service.ts tests/feishu-card-action-service.test.ts
git commit -m "fix: update card actions asynchronously after ack"
```

### Task 3: Update docs

**Files:**
- Modify: `docs/project-full-overview.md`
- Create: `docs/plans/2026-03-30-feishu-card-callback-timeout-design.md`
- Create: `docs/plans/2026-03-30-feishu-card-callback-timeout.md`

**Step 1: Write the doc update**

Document that risky mutating card actions no longer block the Feishu callback and now follow an immediate-ack plus background-update flow.

**Step 2: Verify docs match implementation**

Check that the documented command scope matches the final command classifier in code.

**Step 3: Commit**

```bash
git add docs/project-full-overview.md docs/plans/2026-03-30-feishu-card-callback-timeout-design.md docs/plans/2026-03-30-feishu-card-callback-timeout.md
git commit -m "docs: describe async feishu card command callbacks"
```

### Task 4: Full verification and final commit

**Files:**
- Modify: any files changed by implementation

**Step 1: Run targeted verification**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS.

**Step 2: Run compile verification**

Run: `npx tsc -p tsconfig.json --pretty false`

Expected: exit code 0.

**Step 3: Run full verification**

Run: `npx vitest run`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/feishu-card-action-service.ts tests/feishu-card-action-service.test.ts docs/project-full-overview.md docs/plans/2026-03-30-feishu-card-callback-timeout-design.md docs/plans/2026-03-30-feishu-card-callback-timeout.md
git commit -m "fix: avoid async feishu card callback timeouts"
```
