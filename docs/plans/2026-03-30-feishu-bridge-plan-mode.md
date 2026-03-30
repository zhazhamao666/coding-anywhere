# Feishu Bridge Plan Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement bridge-style Feishu plan mode with a one-shot plan form, structured `todo_list` rendering, and clickable plan-choice callbacks that resume the same native Codex thread.

**Architecture:** Keep native Codex threads as the only execution path. Add bridge-managed plan interaction state, extend card rendering with plan sections, and extend Feishu card callbacks to support form submit and plan-choice actions.

**Tech Stack:** TypeScript, Fastify runtime wiring, Feishu card JSON 2.0 callbacks, better-sqlite3, Vitest

---

### Task 1: Add plan interaction types and storage

**Files:**
- Modify: `src/types.ts`
- Modify: `src/workspace/session-store.ts`
- Test: `tests/session-store.test.ts`

**Step 1: Add plan-mode types**

Define structured types for:

- todo checklist items
- pending plan choice view
- persisted pending plan interaction record

Extend `ProgressCardState` and runner event types to carry structured plan data.

**Step 2: Add failing store tests**

Add tests that verify the store can:

- save a pending interaction for a surface
- fetch the latest open interaction for a surface
- resolve or replace the pending interaction

**Step 3: Implement storage and migration**

Add the new SQLite table and typed accessors in `SessionStore`.

**Step 4: Run tests**

Run: `npm.cmd run -s test -- tests/session-store.test.ts`
Expected: PASS

### Task 2: Extend Feishu callback normalization and action routing

**Files:**
- Modify: `src/feishu-ws-client.ts`
- Modify: `src/runtime.ts`
- Modify: `src/feishu-card-action-service.ts`
- Test: `tests/feishu-card-action-service.test.ts`

**Step 1: Add failing callback tests**

Add tests covering:

- form submit with `action.form_value`
- plan-form open action
- plan-choice answer action
- invalid or stale pending interaction fallback card

**Step 2: Extend normalized callback payload**

Preserve:

- `action.value`
- `action.form_value`
- `action.name`

through the WebSocket normalization path and runtime typing.

**Step 3: Extend card action service**

Support bridge actions in addition to `/ca ...` commands:

- open plan form
- submit plan form
- answer plan choice

**Step 4: Run tests**

Run: `npm.cmd run -s test -- tests/feishu-card-action-service.test.ts`
Expected: PASS

### Task 3: Add plan-aware card builders

**Files:**
- Modify: `src/feishu-card/navigation-card-builder.ts`
- Modify: `src/feishu-card/card-builder.ts`
- Test: `tests/feishu-card-builder.test.ts`
- Test: `tests/streaming-card-controller.test.ts`

**Step 1: Add failing card-builder tests**

Cover:

- one-shot `计划模式` button on DM/thread hub cards
- plan form card JSON 2.0 structure
- structured checklist rendering
- plan-choice button rendering on progress cards

**Step 2: Implement card helpers**

Add helper builders for:

- plan form callback card
- checklist blocks
- single-choice button rows

Update hub cards so DM and registered-thread views expose `计划模式`.

**Step 3: Run tests**

Run: `npm.cmd run -s test -- tests/feishu-card-builder.test.ts tests/streaming-card-controller.test.ts`
Expected: PASS

### Task 4: Make bridge progress and run flow plan-aware

**Files:**
- Modify: `src/progress-relay.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/acpx-runner.ts`
- Test: `tests/acpx-runner.test.ts`
- Test: `tests/bridge-real-codex.test.ts`

**Step 1: Add failing runner and bridge tests**

Cover:

- structured `todo_list` survives into progress state
- plan-form submit becomes `/plan ...`
- pending interaction persistence from native plan event
- choice click resumes the same thread and clears/replaces pending interaction

**Step 2: Extend runner normalization**

Preserve structured todo items and actionable plan-choice metadata when present in native transcripts.

**Step 3: Extend progress reduction**

Keep current preview strings, but also populate structured checklist and interaction fields.

**Step 4: Extend bridge service**

Add helpers to:

- build a plan-form action value
- synthesize `/plan ...` prompt on form submit
- store open plan interactions
- resume a thread with the selected plan choice
- clear stale plan interactions when appropriate

**Step 5: Run tests**

Run: `npm.cmd run -s test -- tests/acpx-runner.test.ts tests/bridge-real-codex.test.ts`
Expected: PASS

### Task 5: Sync docs, verify full suite, and commit

**Files:**
- Modify: `docs/project-full-overview.md`

**Step 1: Update the overview**

Document:

- bridge-style plan mode architecture
- new card action paths
- plan interaction storage
- current limitation that this is bridge-managed rather than true interactive CLI plan mode

**Step 2: Run verification**

Run:

- `npm.cmd run -s test`
- `npm.cmd run -s build`

**Step 3: Commit**

Commit message: `feat: add bridge-managed feishu plan mode`
