# Codex Integration Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add budgeted Codex-side integration testing that validates real CLI protocol handling and native-thread resume behavior without polluting the developer environment.

**Architecture:** The implementation should keep transcript-fixture tests as the PR default, add a small real-Codex harness for opt-in smoke tests, and isolate any persistent Codex state used for resume tests. The bridge stays unchanged at first; the initial focus is runner confidence, cost control, and cleanup discipline.

**Tech Stack:** TypeScript, Vitest, execa, Node.js filesystem/temp helpers, Codex CLI JSONL

---

### Task 1: Add real transcript fixtures for Codex JSONL

**Files:**
- Create: `tests/fixtures/codex/create-thread.jsonl`
- Create: `tests/fixtures/codex/resume-thread.jsonl`
- Create: `tests/fixtures/codex/command-failure.jsonl`
- Test: `tests/acpx-runner.test.ts`

**Step 1: Capture or curate the fixture transcripts**

Store real Codex JSONL transcripts that include `thread.started`, `turn.started`, `item.started`, `item.completed`, and `turn.completed`.

**Step 2: Write the failing parser tests**

Add tests that replay these fixture lines through the runner parser/flush logic and assert the normalized event sequence.

**Step 3: Run the tests to verify they fail**

Run: `npm run -s test -- tests/acpx-runner.test.ts`
Expected: FAIL because current tests only cover minimal handcrafted event streams.

**Step 4: Update the tests to use the fixture coverage**

Keep the parser assertions structural:

- thread id captured
- command execution converted to tool/error events
- final completion emitted once

**Step 5: Run the tests to verify they pass**

Run: `npm run -s test -- tests/acpx-runner.test.ts`
Expected: PASS

**Step 6: Commit**

Commit message: `test: replay real codex jsonl transcripts`

### Task 2: Add a reusable real-Codex smoke harness

**Files:**
- Create: `tests/helpers/codex-real-harness.ts`
- Test: `tests/codex-real-smoke.test.ts`

**Step 1: Write the failing smoke-harness test**

Add a test that is skipped unless `TEST_CODEX_REAL=1`, and expects the harness to:

- create a temp workspace
- run Codex with `--json`, `--ephemeral`, `--skip-git-repo-check`, and `--sandbox read-only`
- collect raw JSONL lines
- expose usage/accounting information

**Step 2: Run the test to verify it fails**

Run: `npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: FAIL because the harness does not exist yet.

**Step 3: Implement the minimal harness**

The harness should:

- create temp directories
- spawn `codex`
- collect raw stdout lines
- parse `turn.completed.usage`
- delete temp artifacts in `finally`

**Step 4: Run the test with live Codex disabled**

Run: `npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: PASS with the test skipped when `TEST_CODEX_REAL` is unset.

**Step 5: Run the test with live Codex enabled**

Run: `$env:TEST_CODEX_REAL='1'; npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: PASS with exactly one real Codex call.

**Step 6: Commit**

Commit message: `test: add real codex smoke harness`

### Task 3: Enforce call-count and token-usage budgets

**Files:**
- Modify: `tests/helpers/codex-real-harness.ts`
- Modify: `tests/codex-real-smoke.test.ts`

**Step 1: Write the failing budget tests**

Add tests proving the harness:

- counts live Codex invocations
- reads usage from `turn.completed`
- fails if the configured call/token budget is exceeded

**Step 2: Run the tests to verify they fail**

Run: `npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: FAIL because no budget guard exists yet.

**Step 3: Implement the budget guard**

Read budget from environment variables such as:

- `TEST_CODEX_MAX_CALLS`
- `TEST_CODEX_MAX_INPUT_TOKENS`
- `TEST_CODEX_MAX_OUTPUT_TOKENS`

Fail immediately when limits are exceeded.

**Step 4: Run the tests to verify they pass**

Run: `npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `test: enforce codex smoke budgets`

### Task 4: Add a deterministic create-thread live smoke

**Files:**
- Modify: `tests/codex-real-smoke.test.ts`
- Create: `tests/fixtures/codex/workspaces/create/TOKEN.txt`

**Step 1: Write the failing live smoke**

Add a real test that:

- creates a tiny workspace with `TOKEN.txt`
- asks Codex to read the file
- requires a structured final answer
- asserts `thread.started.thread_id` exists

**Step 2: Run the test to verify it fails**

Run: `$env:TEST_CODEX_REAL='1'; npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: FAIL until the live assertion path is implemented.

**Step 3: Implement the deterministic smoke**

Use:

- minimal prompt
- `read-only` sandbox
- `--output-last-message` or equivalent structured assertion path

**Step 4: Run the test to verify it passes**

Run: `$env:TEST_CODEX_REAL='1'; npm run -s test -- tests/codex-real-smoke.test.ts`
Expected: PASS with one live Codex call inside budget.

**Step 5: Commit**

Commit message: `test: add deterministic codex create smoke`

### Task 5: Add an isolated resume smoke

**Files:**
- Modify: `tests/helpers/codex-real-harness.ts`
- Create: `tests/codex-real-resume.test.ts`
- Create: `tests/fixtures/codex/workspaces/resume/TOKEN.txt`

**Step 1: Write the failing resume test**

Add a test that is skipped unless both `TEST_CODEX_REAL=1` and `TEST_CODEX_RESUME=1`, and expects:

- create call returns a real `thread_id`
- second call resumes the same thread
- resumed answer returns the stored sentinel token

**Step 2: Run the test to verify it fails**

Run: `$env:TEST_CODEX_REAL='1'; $env:TEST_CODEX_RESUME='1'; npm run -s test -- tests/codex-real-resume.test.ts`
Expected: FAIL because isolated persistent state support is not implemented yet.

**Step 3: Implement isolated state support**

The harness should run the two calls against an isolated Codex state directory or isolated home/profile and delete that directory afterward.

**Step 4: Run the test to verify it passes**

Run: `$env:TEST_CODEX_REAL='1'; $env:TEST_CODEX_RESUME='1'; npm run -s test -- tests/codex-real-resume.test.ts`
Expected: PASS with two total live Codex calls and clean teardown.

**Step 5: Commit**

Commit message: `test: add isolated codex resume smoke`

### Task 6: Add a bridge-level fake-Feishu + real-Codex test

**Files:**
- Create: `tests/bridge-real-codex.test.ts`
- Modify: `tests/helpers/codex-real-harness.ts`
- Modify: `tests/bridge-service.test.ts`

**Step 1: Write the failing bridge integration test**

Add a test that:

- injects a fake Feishu text envelope or equivalent bridge input
- uses the real Codex harness underneath the runner
- asserts bridge reply shape and stored run/thread observability data

**Step 2: Run the test to verify it fails**

Run: `$env:TEST_CODEX_REAL='1'; npm run -s test -- tests/bridge-real-codex.test.ts`
Expected: FAIL because no real-Codex bridge harness exists yet.

**Step 3: Implement the minimal bridge integration**

Do not involve real Feishu. Reuse existing doubles for outbound Feishu API and keep assertions focused on:

- thread creation/resume path
- reply normalization
- run persistence

**Step 4: Run the test to verify it passes**

Run: `$env:TEST_CODEX_REAL='1'; npm run -s test -- tests/bridge-real-codex.test.ts`
Expected: PASS within the configured live-call budget.

**Step 5: Commit**

Commit message: `test: add bridge integration coverage with real codex`

### Task 7: Improve health and developer guidance for real Codex tests

**Files:**
- Modify: `src/doctor.ts`
- Modify: `src/doctor-cli.ts`
- Modify: `docs/project-full-overview.md`
- Modify: `package.json`

**Step 1: Write the failing environment tests**

Add or extend doctor tests to show that binary existence alone is not sufficient for real Codex smoke prerequisites.

**Step 2: Run the tests to verify they fail**

Run: `npm run -s test -- tests/doctor.test.ts`
Expected: FAIL because doctor guidance does not yet mention real-Codex test prerequisites.

**Step 3: Implement minimal guidance**

Document:

- live-test env flags
- budget variables
- cleanup expectations
- which suites are PR-only vs nightly

Optionally add a doctor message describing that real Codex smoke is opt-in and cost-bearing.

**Step 4: Run the tests to verify they pass**

Run: `npm run -s test -- tests/doctor.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `docs: add codex integration test guidance`

### Task 8: Final verification

**Files:**
- Modify: `docs/plans/2026-03-29-codex-integration-testing-design.md`
- Modify: `docs/plans/2026-03-29-codex-integration-testing.md`

**Step 1: Run focused default verification**

Run: `npm run -s test -- tests/acpx-runner.test.ts tests/codex-real-smoke.test.ts tests/codex-real-resume.test.ts tests/bridge-real-codex.test.ts`
Expected: PASS, with live suites skipped when env vars are unset.

**Step 2: Run broad default verification**

Run: `npm run -s test`
Expected: PASS

**Step 3: Run build verification**

Run: `npm run -s build`
Expected: PASS

**Step 4: Run live verification explicitly**

Run: `$env:TEST_CODEX_REAL='1'; $env:TEST_CODEX_RESUME='1'; npm run -s test -- tests/codex-real-smoke.test.ts tests/codex-real-resume.test.ts tests/bridge-real-codex.test.ts`
Expected: PASS, budget respected, cleanup confirmed.

**Step 5: Commit**

Commit message: `test: add codex integration testing`
