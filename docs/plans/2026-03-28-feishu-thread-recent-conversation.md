# Feishu Thread Recent Conversation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After a Feishu DM switches to a Codex native thread, show the thread's recent conversation in the switch-success card so the user can immediately recover context.

**Architecture:** Extend the Codex catalog with a rollout-backed recent-conversation reader, then have `BridgeService` include that preview when building the DM thread-switch success card. Keep the behavior scoped to the switch-success card so `/ca session` and `/ca project current` remain concise.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Feishu JSON 2.0 navigation cards

---

### Task 1: Add failing coverage for recent conversation extraction and DM switch card rendering

**Files:**
- Modify: `tests/codex-sqlite-catalog.test.ts`
- Modify: `tests/codex-dm-browser.test.ts`

**Step 1: Write the failing test**

Add or keep assertions that:
- `CodexSqliteCatalog.listRecentConversation(threadId, limit)` returns recent `user` and `assistant` items from a rollout JSONL.
- `/ca thread switch <threadId>` renders a card containing a `最近对话` section with recent messages.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/codex-sqlite-catalog.test.ts tests/codex-dm-browser.test.ts`
Expected: FAIL because `listRecentConversation` is missing and the switch card does not render recent conversation.

**Step 3: Commit**

Skip commit here because the repo already contains the failing assertions and the next task will turn them green in the same development round.

### Task 2: Implement rollout-backed recent conversation reading in the Codex catalog

**Files:**
- Modify: `src/codex-sqlite-catalog.ts`
- Modify: `src/types.ts`

**Step 1: Write minimal implementation**

Add a typed recent-conversation item shape and implement `listRecentConversation(threadId, limit)` by:
- resolving the thread via existing catalog metadata,
- reading the rollout JSONL for that thread,
- extracting recent `response_item` messages for `user` and `assistant`,
- flattening text content from supported item shapes,
- returning the last `limit` items in chronological order.

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/codex-sqlite-catalog.test.ts`
Expected: PASS

### Task 3: Render recent conversation in the DM thread-switch success card

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/types.ts`

**Step 1: Write minimal implementation**

Update the catalog interface used by `BridgeService`, fetch recent conversation during `/ca thread switch`, and include a `最近对话` section in the switch-success card. Keep the preview compact and text-only.

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/codex-dm-browser.test.ts`
Expected: PASS

### Task 4: Sync docs, run verification, and commit

**Files:**
- Modify: `docs/project-full-overview.md`

**Step 1: Update docs**

Document that DM thread switching now returns a recent-conversation preview for the selected Codex thread.

**Step 2: Run focused verification**

Run: `npx vitest run tests/codex-sqlite-catalog.test.ts tests/codex-dm-browser.test.ts`
Expected: PASS

**Step 3: Run broader safety check**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add docs/plans/2026-03-28-feishu-thread-recent-conversation.md src/codex-sqlite-catalog.ts src/bridge-service.ts src/types.ts tests/codex-sqlite-catalog.test.ts tests/codex-dm-browser.test.ts docs/project-full-overview.md
git commit -m "feat: show recent conversation after thread switch"
```
