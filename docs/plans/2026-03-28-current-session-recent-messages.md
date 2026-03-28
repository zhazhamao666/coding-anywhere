# Current Session Recent Messages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show recent messages in `/ca session` when a DM is bound to a Codex native thread.

**Architecture:** Keep `/ca session` as plain text for ordinary contexts, but for `DM + Codex thread binding` return a JSON 2.0 card built by `BridgeService`. Reuse the existing catalog conversation reader and the existing “last 1 user + last 4 assistant” selection rule.

**Tech Stack:** TypeScript, Vitest, Feishu JSON 2.0 cards, better-sqlite3

---

### Task 1: Add failing tests for DM Codex-thread `/ca session`

**Files:**
- Modify: `tests/codex-dm-browser.test.ts`

**Step 1: Write the failing test**

Add assertions showing that after switching a DM to a Codex thread, `/ca session` returns a card containing:

- current thread/session info
- a `最近对话` section
- the existing “last 1 user + last 4 assistant” message selection

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/codex-dm-browser.test.ts`
Expected: FAIL because `/ca session` still returns plain text.

### Task 2: Implement the DM Codex-thread session card

**Files:**
- Modify: `src/bridge-service.ts`

**Step 1: Write minimal implementation**

Update the `session` command branch so that:

- ordinary contexts still return plain text
- `DM + Codex native thread` returns a card
- the card includes recent messages using the existing selection helper

**Step 2: Run targeted tests**

Run: `npx vitest run tests/codex-dm-browser.test.ts tests/codex-sqlite-catalog.test.ts`
Expected: PASS

**Step 3: Run type check**

Run: `npx tsc -p tsconfig.json --pretty false`
Expected: PASS

### Task 3: Sync docs and verify the full suite

**Files:**
- Modify: `docs/project-full-overview.md`

**Step 1: Update docs**

Document that in DM Codex-thread mode, `/ca session` now shows a session card with recent messages.

**Step 2: Run full verification**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add docs/plans/2026-03-28-current-session-recent-messages-design.md docs/plans/2026-03-28-current-session-recent-messages.md tests/codex-dm-browser.test.ts src/bridge-service.ts docs/project-full-overview.md
git commit -m "feat: show recent messages in current session card"
```
