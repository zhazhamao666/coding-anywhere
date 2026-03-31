# Feishu All Command Callbacks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every `/ca ...` card button command return an immediate confirmation card and complete through a background interactive-card patch.

**Architecture:** Keep `open_plan_form` as an inline form swap and leave plan submit/choice on their existing async path. Remove command-risk classification from `FeishuCardActionService` so every parsed `/ca` command follows the same ack-first, patch-later workflow.

**Tech Stack:** TypeScript, Vitest, Feishu card callbacks, interactive card patching.

---

### Task 1: Lock the new universal `/ca` button model with tests

**Files:**
- Modify: `tests/feishu-card-action-service.test.ts`
- Reference: `src/feishu-card-action-service.ts`

**Step 1: Write the failing test**

Add tests that verify read-only `/ca` command buttons now behave like async buttons:
- `/ca project current` returns an immediate ack card;
- `/ca project current` patches the original interactive card with the final card reply;
- `/ca project current` no longer returns the final card inline.

Keep `open_plan_form` asserting immediate inline form return.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: FAIL because read-only `/ca` command buttons are still synchronous today.

**Step 3: Write minimal implementation**

Change command-button dispatch so all parsed `/ca` commands use the async command launcher.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/feishu-card-action-service.test.ts src/feishu-card-action-service.ts
git commit -m "refactor: unify async handling for feishu card commands"
```

### Task 2: Simplify command dispatch implementation

**Files:**
- Modify: `src/feishu-card-action-service.ts`

**Step 1: Write the failing test**

Add or refine tests so the following still hold:
- invalid non-command actions still return an inline invalid-action card;
- final `system` replies are wrapped into a result card before patching;
- final `card` replies are patched as-is.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: FAIL until the synchronous branch is removed and all `/ca` commands share one background path.

**Step 3: Write minimal implementation**

Update `src/feishu-card-action-service.ts` to:
- remove command-risk classification;
- route every parsed `/ca` command through `launchCommandAction(...)`;
- keep `open_plan_form` inline;
- keep plan submit/choice on their current path.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feishu-card-action-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/feishu-card-action-service.ts tests/feishu-card-action-service.test.ts
git commit -m "refactor: make all feishu card commands async"
```

### Task 3: Update docs

**Files:**
- Modify: `docs/project-full-overview.md`
- Create: `docs/plans/2026-03-31-feishu-all-command-callbacks-design.md`
- Create: `docs/plans/2026-03-31-feishu-all-command-callbacks.md`

**Step 1: Write the doc update**

Document that all `/ca` card command buttons now use immediate confirmation plus background card patching, instead of splitting by command risk.

**Step 2: Verify docs match implementation**

Check that `src/feishu-card-action-service.ts` no longer documents or implements a risk-based split for `/ca` commands.

**Step 3: Commit**

```bash
git add docs/project-full-overview.md docs/plans/2026-03-31-feishu-all-command-callbacks-design.md docs/plans/2026-03-31-feishu-all-command-callbacks.md
git commit -m "docs: describe unified async feishu command callbacks"
```

### Task 4: Full verification and final commit

**Files:**
- Modify: any files touched by Tasks 1-3

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
git add src/feishu-card-action-service.ts tests/feishu-card-action-service.test.ts docs/project-full-overview.md docs/plans/2026-03-31-feishu-all-command-callbacks-design.md docs/plans/2026-03-31-feishu-all-command-callbacks.md
git commit -m "refactor: unify feishu card command callbacks"
```
