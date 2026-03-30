# Feishu Codex Runtime Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current runtime-centric product assumptions with an app-server-first architecture that can support Codex-App-like interaction in Feishu, while retaining a small fallback path for simple `exec`-style runs.

**Architecture:** Introduce a runtime abstraction layer, make `codex app-server` the primary backend, keep `exec` as a fallback backend, and add product-owned services for usage/quota, worktree orchestration, and rich plan-mode interaction. Use the design document as the evidence base for all architectural choices and keep source attribution explicit in project docs.

**Tech Stack:** TypeScript, Fastify, Feishu long connection callbacks, Codex CLI / app-server, SQLite, Vitest

---

## Source Basis

This plan is derived from:

- [2026-03-30-feishu-codex-runtime-architecture-design.md](./2026-03-30-feishu-codex-runtime-architecture-design.md)
- OpenAI Codex app-server / SDK / CLI docs
- OpenClaw ACP and usage-tracking docs
- Community ACP adapters (`zed-industries/codex-acp`, `cola-io/codex-acp`)

Implementation work must preserve the distinction between:

- official/runtime facts
- product-layer inference
- community-inspired but non-official behavior

### Task 1: Freeze the runtime decision in project documentation

**Files:**
- Modify: `docs/project-full-overview.md`
- Reference: `docs/plans/2026-03-30-feishu-codex-runtime-architecture-design.md`

**Step 1: Update the runtime section**

- Replace any stale wording that still treats `exec` as the long-term answer.
- Add a new roadmap note that the strategic direction is `app-server` as the rich-client runtime.

**Step 2: Add a documented source policy**

- State that architecture conclusions about Codex runtime behavior must cite either official OpenAI docs or explicitly marked community evidence.

**Step 3: Verify doc consistency**

Run: `Select-String -Path 'docs/project-full-overview.md' -Encoding utf8 -Pattern 'app-server','exec','acpx','quota','worktree'`

**Step 4: Commit**

```bash
git add docs/project-full-overview.md docs/plans/2026-03-30-feishu-codex-runtime-architecture-design.md docs/plans/2026-03-30-feishu-codex-runtime-architecture.md
git commit -m "docs: record codex runtime architecture decision"
```

### Task 2: Introduce a runtime abstraction layer

**Files:**
- Create: `src/codex-runtime/`
- Create: `src/codex-runtime/types.ts`
- Create: `src/codex-runtime/backend.ts`
- Create: `src/codex-runtime/app-server-backend.ts`
- Create: `src/codex-runtime/exec-backend.ts`
- Modify: `src/runtime.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/types.ts`
- Test: `tests/codex-runtime-backend.test.ts`

**Step 1: Write the failing backend-contract tests**

Cover:

- create thread
- resume thread
- interrupt turn
- rollback thread
- list/select models
- request user input handoff

**Step 2: Run the new tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/codex-runtime-backend.test.ts`

**Step 3: Define the backend contract**

Create interfaces for:

- `startThread`
- `resumeThread`
- `startTurn`
- `interruptTurn`
- `rollbackThread`
- `forkThread`
- `listModels`
- `requestUserInput`

**Step 4: Add a minimal exec fallback backend**

- Wrap current `exec` / `resume` behavior behind the contract.
- Clearly mark unsupported operations such as native rollback as unsupported in this backend.

**Step 5: Run tests and commit**

Run: `npm.cmd run -s test -- tests/codex-runtime-backend.test.ts`

```bash
git add src/codex-runtime src/runtime.ts src/bridge-service.ts src/types.ts tests/codex-runtime-backend.test.ts
git commit -m "refactor: add codex runtime backend abstraction"
```

### Task 3: Implement the app-server backend

**Files:**
- Create: `src/codex-runtime/app-server-client.ts`
- Create: `src/codex-runtime/app-server-process.ts`
- Modify: `src/codex-runtime/app-server-backend.ts`
- Modify: `src/runtime.ts`
- Modify: `src/doctor.ts`
- Test: `tests/codex-app-server-backend.test.ts`

**Step 1: Write the failing client tests**

Cover:

- starting the app-server transport
- issuing `thread/start`
- issuing `turn/start`
- issuing `turn/interrupt`
- issuing `thread/rollback`
- issuing `thread/fork`
- issuing `model/list`

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/codex-app-server-backend.test.ts`

**Step 3: Implement stdio-based app-server transport**

- Prefer `stdio://` transport for local same-host integration.
- Do not introduce websocket transport as the default path.

**Step 4: Wire the app-server backend into runtime construction**

- Add config for selecting the primary runtime backend.
- Make app-server the primary default in development docs when the feature is ready.

**Step 5: Add doctor checks**

- Verify `codex app-server` availability.
- Verify minimal runtime prerequisites for the selected backend.

**Step 6: Run tests and commit**

Run: `npm.cmd run -s test -- tests/codex-app-server-backend.test.ts tests/doctor.test.ts`

```bash
git add src/codex-runtime src/runtime.ts src/doctor.ts tests/codex-app-server-backend.test.ts tests/doctor.test.ts
git commit -m "feat: add codex app-server backend"
```

### Task 4: Add model and reasoning-effort selection

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/feishu-card/`
- Modify: `src/types.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/feishu-card-action-service.test.ts`

**Step 1: Write failing tests for model list and effort selection**

Cover:

- reading `model/list`
- rendering available models
- rendering `supportedReasoningEfforts`
- applying a model/effort override for the active surface

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/feishu-card-action-service.test.ts`

**Step 3: Implement runtime-backed model catalog handling**

- Store the chosen model and effort at the surface or thread binding level.
- Ensure the UI only shows efforts actually supported by the selected model.

**Step 4: Run tests and commit**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/feishu-card-action-service.test.ts`

```bash
git add src/bridge-service.ts src/feishu-card-action-service.ts src/feishu-card src/types.ts tests/bridge-service.test.ts tests/feishu-card-action-service.test.ts
git commit -m "feat: add model and effort selection"
```

### Task 5: Add plan-mode interaction backed by runtime request-user-input

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/feishu-card/`
- Modify: `src/workspace/session-store.ts`
- Modify: `src/types.ts`
- Test: `tests/bridge-real-codex.test.ts`
- Test: `tests/feishu-card-action-service.test.ts`

**Step 1: Write failing tests for plan-mode lifecycle**

Cover:

- send one-shot `/plan` prompt
- receive runtime-side request for user input
- render structured options into a Feishu card
- send the chosen option back into the active runtime thread

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/bridge-real-codex.test.ts tests/feishu-card-action-service.test.ts`

**Step 3: Implement pending-interaction persistence**

- Persist pending runtime interactions keyed by active surface and thread.
- Distinguish plan-mode choices from normal navigation-card actions.

**Step 4: Implement plan-mode cards**

- Add one-shot plan-mode button flow.
- Add runtime-choice card rendering based on request-user-input payloads.

**Step 5: Run tests and commit**

Run: `npm.cmd run -s test -- tests/bridge-real-codex.test.ts tests/feishu-card-action-service.test.ts`

```bash
git add src/bridge-service.ts src/feishu-card-action-service.ts src/feishu-card src/workspace/session-store.ts src/types.ts tests/bridge-real-codex.test.ts tests/feishu-card-action-service.test.ts
git commit -m "feat: add runtime-backed plan mode"
```

### Task 6: Add interrupt, rollback, and resend flows

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/command-router.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/types.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/command-router.test.ts`

**Step 1: Write failing tests**

Cover:

- interrupting an in-flight turn
- rolling back the latest completed turn
- resending a replacement prompt

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/command-router.test.ts`

**Step 3: Implement runtime controls**

- Route interrupt to `turn/interrupt`.
- Route replace-last-message to `thread/rollback` plus a new `turn/start`.

**Step 4: Run tests and commit**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/command-router.test.ts`

```bash
git add src/bridge-service.ts src/command-router.ts src/feishu-card-action-service.ts src/types.ts tests/bridge-service.test.ts tests/command-router.test.ts
git commit -m "feat: add interrupt and rollback resend controls"
```

### Task 7: Add quota / usage service

**Files:**
- Create: `src/usage-service.ts`
- Modify: `src/runtime.ts`
- Modify: `src/app.ts`
- Modify: `src/bridge-service.ts`
- Test: `tests/app.test.ts`
- Test: `tests/bridge-service.test.ts`

**Step 1: Write failing tests for status and usage exposure**

Cover:

- thread status card content
- usage fetch success
- usage fetch unavailable fallback

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/app.test.ts tests/bridge-service.test.ts`

**Step 3: Implement usage service**

- Keep runtime status and provider usage logically separate.
- If provider usage is unavailable, show thread/model/last-turn usage only.

**Step 4: Run tests and commit**

Run: `npm.cmd run -s test -- tests/app.test.ts tests/bridge-service.test.ts`

```bash
git add src/usage-service.ts src/runtime.ts src/app.ts src/bridge-service.ts tests/app.test.ts tests/bridge-service.test.ts
git commit -m "feat: add usage and status service"
```

### Task 8: Add worktree orchestration

**Files:**
- Create: `src/worktree-service.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/command-router.ts`
- Modify: `src/types.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/command-router.test.ts`

**Step 1: Write failing tests**

Cover:

- create/select worktree
- move active runtime thread to target `cwd`
- show current worktree in status surfaces

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/command-router.test.ts`

**Step 3: Implement product-owned worktree service**

- Use Git worktrees as a product concern, not a runtime concern.
- Store active worktree selection with the surface/thread binding.

**Step 4: Run tests and commit**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/command-router.test.ts`

```bash
git add src/worktree-service.ts src/bridge-service.ts src/command-router.ts src/types.ts tests/bridge-service.test.ts tests/command-router.test.ts
git commit -m "feat: add worktree orchestration"
```

### Task 9: Add thread fork / branch-off UX

**Files:**
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/feishu-card/`
- Modify: `src/workspace/session-store.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/session-store.test.ts`

**Step 1: Write failing tests**

Cover:

- forking the current thread
- rebinding the current surface to the new thread
- optionally opening a new Feishu thread bound to the forked runtime thread

**Step 2: Run the tests and confirm they fail**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/session-store.test.ts`

**Step 3: Implement runtime fork flow**

- Call runtime `forkThread`.
- Persist the new thread mapping cleanly.

**Step 4: Run tests and commit**

Run: `npm.cmd run -s test -- tests/bridge-service.test.ts tests/session-store.test.ts`

```bash
git add src/bridge-service.ts src/feishu-card-action-service.ts src/feishu-card src/workspace/session-store.ts tests/bridge-service.test.ts tests/session-store.test.ts
git commit -m "feat: add thread fork workflow"
```

### Task 10: Final documentation and verification

**Files:**
- Modify: `docs/project-full-overview.md`
- Modify: `docs/plans/2026-03-30-feishu-codex-runtime-architecture-design.md`
- Modify: `docs/plans/2026-03-30-feishu-codex-runtime-architecture.md`

**Step 1: Sync documentation**

- Make sure the project overview reflects the selected runtime architecture.
- Keep explicit source attribution for architectural conclusions.

**Step 2: Run the full verification suite**

Run:

- `npm.cmd run -s test`
- `npm.cmd run -s build`

**Step 3: Commit**

```bash
git add docs/project-full-overview.md docs/plans/2026-03-30-feishu-codex-runtime-architecture-design.md docs/plans/2026-03-30-feishu-codex-runtime-architecture.md
git commit -m "docs: finalize codex runtime migration plan"
```
