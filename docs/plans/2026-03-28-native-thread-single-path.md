# Native Thread Single-Path Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make native Codex threads the only execution truth for DM, project groups, and Feishu topic threads.

**Architecture:** The bridge continues to own Feishu routing, concurrency, and observability, but execution moves entirely to `codex exec` / `codex exec resume`. Native thread creation becomes a first-class runner capability, and persisted surface bindings point to real Codex `thread_id` values instead of CA-managed session names.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, execa, Feishu bot APIs, Codex CLI JSONL

---

### Task 1: Capture native thread creation in the runner

**Files:**
- Modify: `src/types.ts`
- Modify: `src/acpx-runner.ts`
- Test: `tests/acpx-runner.test.ts`

**Step 1: Write the failing test**

Add a test proving `codex exec --json` parses `thread.started` and returns the created `threadId` in `RunOutcome`.

**Step 2: Run test to verify it fails**

Run: `npm run -s test -- tests/acpx-runner.test.ts`
Expected: FAIL because the outcome does not yet expose the created native thread id.

**Step 3: Write minimal implementation**

Extend the runner outcome to carry `threadId`, add native create-vs-resume execution branches, and parse `thread.started`.

**Step 4: Run test to verify it passes**

Run: `npm run -s test -- tests/acpx-runner.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `feat: capture native thread ids from codex exec`

### Task 2: Redefine runtime context around native threads only

**Files:**
- Modify: `src/types.ts`
- Modify: `src/bridge-service.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/bridge-surface-resolution.test.ts`

**Step 1: Write the failing tests**

Add tests showing:

- DM without an existing binding creates a native thread on first prompt
- registered Feishu threads always resolve to native-thread execution
- no normal prompt path uses bridge-session execution context anymore

**Step 2: Run tests to verify they fail**

Run: `npm run -s test -- tests/bridge-service.test.ts tests/bridge-surface-resolution.test.ts`
Expected: FAIL because contexts still resolve to CA sessions.

**Step 3: Write minimal implementation**

Replace session-driven prompt routing with native-thread create/resume routing and persist created thread ids back into surface bindings.

**Step 4: Run tests to verify they pass**

Run: `npm run -s test -- tests/bridge-service.test.ts tests/bridge-surface-resolution.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `feat: route bridge prompts through native threads`

### Task 3: Change project-thread persistence to store real native thread ids

**Files:**
- Modify: `src/types.ts`
- Modify: `src/workspace/session-store.ts`
- Modify: `src/project-thread-service.ts`
- Test: `tests/project-thread-service.test.ts`
- Test: `tests/session-store-project-thread.test.ts`

**Step 1: Write the failing tests**

Add tests showing project-thread creation persists a native Codex thread id and that reloaded thread records expose native ids as execution truth.

**Step 2: Run tests to verify they fail**

Run: `npm run -s test -- tests/project-thread-service.test.ts tests/session-store-project-thread.test.ts`
Expected: FAIL because creation still stores CA-generated logical thread ids/session names.

**Step 3: Write minimal implementation**

Create native threads during project-thread provisioning and persist the real `thread_id` into `codex_threads`.

**Step 4: Run tests to verify they pass**

Run: `npm run -s test -- tests/project-thread-service.test.ts tests/session-store-project-thread.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `feat: persist native thread ids for project threads`

### Task 4: Rework command semantics for native-only execution

**Files:**
- Modify: `src/bridge-service.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/feishu-card-action-service.test.ts`

**Step 1: Write the failing tests**

Add tests proving:

- `/ca new` creates and rebinds a new native thread
- `/ca stop` returns unavailable instead of pretending to cancel
- command cards reflect native-thread session info

**Step 2: Run tests to verify they fail**

Run: `npm run -s test -- tests/bridge-service.test.ts tests/feishu-card-action-service.test.ts`
Expected: FAIL because commands still speak in CA-session terms.

**Step 3: Write minimal implementation**

Update command handlers and card summaries to use native-thread semantics only.

**Step 4: Run tests to verify they pass**

Run: `npm run -s test -- tests/bridge-service.test.ts tests/feishu-card-action-service.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `feat: align bridge commands with native thread semantics`

### Task 5: Enable project-group and Feishu-thread native switching

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/codex-sqlite-catalog.ts`
- Modify: `src/workspace/session-store.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/feishu-group-routing.test.ts`
- Test: `tests/codex-dm-browser.test.ts`

**Step 1: Write the failing tests**

Add tests proving:

- project groups can list native threads for the current project
- project groups can switch to a chosen native thread
- registered Feishu topic threads can rebind to a chosen native thread

**Step 2: Run tests to verify they fail**

Run: `npm run -s test -- tests/bridge-service.test.ts tests/feishu-group-routing.test.ts tests/codex-dm-browser.test.ts`
Expected: FAIL because thread switch currently only works in DM and group lists only local CA thread records.

**Step 3: Write minimal implementation**

Resolve project->catalog mapping by cwd, surface-bind groups/threads to native ids, and enable thread switching outside DM.

**Step 4: Run tests to verify they pass**

Run: `npm run -s test -- tests/bridge-service.test.ts tests/feishu-group-routing.test.ts tests/codex-dm-browser.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `feat: support native thread switching in project groups`

### Task 6: Remove acpx-owned idle-session behavior from runtime

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/workspace/session-store.ts`
- Test: `tests/thread-idle-reap.test.ts`
- Test: `tests/runtime.test.ts`

**Step 1: Write the failing tests**

Add tests proving idle reaping no longer closes `acpx` sessions and instead updates local thread metadata according to native-thread semantics.

**Step 2: Run tests to verify they fail**

Run: `npm run -s test -- tests/thread-idle-reap.test.ts tests/runtime.test.ts`
Expected: FAIL because runtime still calls `runner.close()` with session names.

**Step 3: Write minimal implementation**

Remove `acpx sessions close` assumptions from idle reaping and keep only native-thread-safe state transitions.

**Step 4: Run tests to verify they pass**

Run: `npm run -s test -- tests/thread-idle-reap.test.ts tests/runtime.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `refactor: drop acpx session reaping semantics`

### Task 7: Update docs and run end-to-end verification

**Files:**
- Modify: `docs/project-full-overview.md`
- Modify: `docs/plans/2026-03-28-native-thread-single-path-design.md`
- Modify: `docs/plans/2026-03-28-native-thread-single-path.md`

**Step 1: Update documentation**

Document the native-only execution path, changed command semantics, thread creation flow, and updated known limitations.

**Step 2: Run focused verification**

Run: `npm run -s test -- tests/acpx-runner.test.ts tests/bridge-service.test.ts tests/bridge-surface-resolution.test.ts tests/project-thread-service.test.ts tests/session-store-project-thread.test.ts tests/feishu-group-routing.test.ts tests/thread-idle-reap.test.ts`
Expected: PASS

**Step 3: Run broad verification**

Run: `npm run -s test`
Expected: PASS

**Step 4: Run build verification**

Run: `npm run -s build`
Expected: PASS

**Step 5: Commit**

Commit message: `feat: switch bridge execution to native codex threads`
