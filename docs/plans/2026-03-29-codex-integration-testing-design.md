# Codex Integration Testing Design

**Date:** 2026-03-29

**Goal:** Add a practical Codex-side integration testing strategy that validates the real CLI protocol and thread-resume behavior without turning every PR into an expensive live-model run.

## Why

The bridge now executes through native Codex threads, so the real integration boundary is no longer `acpx prompt`; it is:

- `codex exec --json`
- `codex exec resume --json <thread_id>`

Current tests already cover most bridge logic with doubles, but they do not fully prove:

- the real JSONL event stream shape emitted by the installed Codex CLI
- native thread bootstrap behavior
- native thread resume behavior
- cost/cleanup discipline around real model calls

This matters because a real smoke run on this machine showed that even a tiny prompt produced a larger-than-expected event stream and non-trivial token usage.

## Observed Constraints

### 1. Real Codex output is richer than the current handcrafted mocks

A real `codex exec --json` run emitted at least:

- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`
- `command_execution`
- `turn.completed`

Therefore parser coverage cannot rely only on idealized two-line fixtures.

### 2. Real Codex calls are expensive enough to require budgeting

A minimal smoke prompt on 2026-03-29 produced usage roughly in this range:

- `input_tokens`: 37220
- `cached_input_tokens`: 20480
- `output_tokens`: 440

So real Codex calls must be tightly scoped, selectively enabled, and explicitly budgeted.

### 3. Resume tests create persistent state and can pollute the developer environment

`--ephemeral` is appropriate for create-only smoke tests, but resume tests require persisted session state. That means isolation and cleanup are mandatory.

## Non-Goals

This design does not attempt to test:

- model quality on open-ended coding tasks
- long multi-turn behavior with subjective natural-language assertions
- broad repository edits driven by real Codex in PR CI

The purpose is protocol confidence and bridge compatibility, not model eval.

## Test Pyramid

### Layer 1: Transcript Contract Tests

Always-on PR tests should use recorded real Codex JSONL transcripts as fixtures.

Examples:

- thread bootstrap transcript
- resume transcript
- command execution transcript
- failing command transcript

These tests validate:

- `parseCodexExecLine`
- buffer flushing across chunk boundaries
- event coalescing
- error detection

This layer gives high confidence without any model calls.

### Layer 2: Real CLI Create Smoke

This is the smallest true Codex integration test.

Characteristics:

- temporary workspace
- `--ephemeral`
- `--skip-git-repo-check`
- `--sandbox read-only`
- tiny deterministic prompt

The test should assert only:

- process exits successfully
- `thread.started.thread_id` exists
- final completion exists
- final structured output matches expectation

The test should not assert the exact sequence of all intermediate text/tool messages.

### Layer 3: Real CLI Resume Smoke

This is the most important live integration test because production execution depends on `codex exec resume`.

Flow:

1. Create a thread in an isolated test state directory
2. Store a known token or fact in that thread
3. Resume the thread
4. Ask for the known token in a structured format
5. Verify the answer

This layer proves that:

- created `thread_id` is usable
- the CLI persists the session correctly
- the bridge can depend on native-thread continuity

### Layer 4: Fake Feishu + Real Codex Bridge Test

For high-value integration coverage, the Feishu side should remain synthetic while the Codex side becomes real.

That test should:

- inject a fake normalized Feishu envelope
- let `BridgeService` and `AcpxRunner` execute normally
- run a real Codex CLI call
- assert outbound Feishu API calls through doubles
- assert `/ops` state or database state

This gives much more confidence than runner-only smoke while staying cheaper and more stable than real-Feishu end-to-end.

### Layer 5: Real Feishu + Real Codex Nightly Smoke

This stays outside the main Codex design for PR CI. It is a separate platform-level smoke layer and should not be used as the primary confidence mechanism.

## Determinism Strategy

Real Codex tests must use narrow tasks.

Recommended pattern:

- create a tiny fixture workspace
- add a single sentinel file such as `TOKEN.txt`
- ask Codex to read that file
- require a structured final answer

Preferred assertion tools:

- `--output-last-message`
- `--output-schema`

Avoid asserting free-form prose.

## Budget Policy

### PR Budget

- Default: `0` real Codex calls
- Real Codex smoke only runs when relevant files change
- Maximum: `1` real create-smoke call

Relevant files include:

- `src/acpx-runner.ts`
- `src/bridge-service.ts`
- `src/types.ts`
- real-Codex test-support files

### Nightly Budget

- Maximum: `2` real Codex calls
- `1` create smoke
- `1` resume smoke

### Budget Enforcement

The test harness must:

- count real Codex invocations
- parse `turn.completed.usage`
- fail if the suite exceeds the configured call count
- fail if a single test exceeds its configured token budget

The budget values should live in one place so engineers do not silently add more live calls.

## Isolation and Cleanup

### Create Smoke

Cleanup requirements:

- use `--ephemeral`
- write any output artifacts to a temp directory
- delete the temp directory after the test

### Resume Smoke

Cleanup requirements:

- run with an isolated Codex state directory or isolated user/home profile
- run in an isolated temp workspace
- delete both the workspace and state directory after the test

If isolation cannot be guaranteed, resume smoke must not run in regular PR CI.

## Configuration Model

Real Codex tests should be opt-in by environment variable.

Suggested controls:

- `TEST_CODEX_REAL=1`
- `TEST_CODEX_RESUME=1`
- `TEST_CODEX_MAX_CALLS=1`
- `TEST_CODEX_MAX_INPUT_TOKENS=45000`
- `TEST_CODEX_MAX_OUTPUT_TOKENS=800`

The defaults should be safe and cheap.

## Supporting Code Changes

The implementation should introduce:

- a transcript-fixture directory for real JSONL captures
- a small real-Codex test harness
- a single budget/accounting helper
- cleanup helpers for temp workspaces and Codex state directories

Optional but recommended:

- extend health checks so Codex readiness can be probed beyond binary existence

## Acceptance Criteria

- Contract tests use recorded real Codex transcripts and run in normal PR CI
- At least one real create smoke test can be run on demand with a strict budget
- At least one real resume smoke test can be run in an isolated environment and leaves no persistent residue
- A bridge-level test can combine fake Feishu input with a real Codex CLI call
- Real Codex tests enforce call-count and token-usage budgets
- Cleanup is automatic and verified by the test harness
