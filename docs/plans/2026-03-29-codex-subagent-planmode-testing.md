# Codex Sub-Agent And Plan-Mode Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record real Codex JSONL fixtures for native plan mode and sub-agent flows, then expand runner and bridge tests to cover those behaviors without adding routine live-call cost.

**Architecture:** The implementation starts with two minimal live recordings to discover the real protocol shape, then shifts immediately back to fixture-driven tests. Runner tests validate normalization and buffering, while bridge tests verify that transcript playback still produces coherent replies and observability records.

**Tech Stack:** TypeScript, Vitest, Codex CLI JSONL transcripts, `AcpxRunner`, `BridgeService`

---

### Task 1: Record minimal plan-mode and sub-agent transcripts

**Files:**
- Create: `tests/fixtures/codex/plan-mode.jsonl`
- Create: `tests/fixtures/codex/sub-agent.jsonl`
- Modify: `docs/project-full-overview.md`

**Step 1: Prepare minimal recording prompts**

Create one prompt that reliably triggers native plan mode and one prompt that explicitly requests one bounded sub-agent delegation.

**Step 2: Run one real Codex recording for plan mode**

Run a minimal non-interactive Codex call and save the raw JSONL output.

**Step 3: Run one real Codex recording for sub-agent flow**

Run a second minimal Codex call and save the raw JSONL output.

**Step 4: Normalize only recorder-specific noise if needed**

Keep the fixture semantically real. Do not rewrite event structure.

**Step 5: Update overview docs**

Document that sub-agent and plan-mode coverage is transcript-driven and recorded from real Codex output.

**Step 6: Commit**

Commit message: `test: record codex sub-agent and plan-mode transcripts`

### Task 2: Add runner contract coverage for the new transcripts

**Files:**
- Modify: `tests/acpx-runner.test.ts`
- Modify: `src/acpx-runner.ts`

**Step 1: Write failing runner tests against the new fixtures**

Add tests that replay `plan-mode.jsonl` and `sub-agent.jsonl` through `AcpxRunner`.

**Step 2: Run focused tests to verify failure**

Run: `npm run -s test -- tests/acpx-runner.test.ts`
Expected: FAIL until the parser behavior matches the transcript needs.

**Step 3: Extend parser behavior minimally**

Only normalize events that the transcripts prove matter for bridge-visible behavior or terminal completion.

**Step 4: Re-run focused tests**

Run: `npm run -s test -- tests/acpx-runner.test.ts`
Expected: PASS

**Step 5: Commit**

Commit message: `test: cover codex sub-agent and plan-mode runner flows`

### Task 3: Add bridge-level transcript integration tests

**Files:**
- Create: `tests/bridge-subagent-planmode.test.ts`
- Modify: `docs/project-full-overview.md`

**Step 1: Write failing bridge tests**

Add transcript-backed tests using real `BridgeService + AcpxRunner` with mocked `execa`.

Cover:

- DM bootstrap with a plan-mode transcript
- DM bootstrap or resume with a sub-agent transcript

**Step 2: Run focused bridge tests**

Run: `npm run -s test -- tests/bridge-subagent-planmode.test.ts`
Expected: FAIL until assertions and any required parser normalization line up.

**Step 3: Implement minimal bridge-facing fixes if needed**

Keep changes narrow. Prefer parser-side normalization over bridge-specific special cases.

**Step 4: Re-run focused bridge tests**

Run: `npm run -s test -- tests/bridge-subagent-planmode.test.ts`
Expected: PASS

**Step 5: Update overview docs**

Document the new bridge coverage.

**Step 6: Commit**

Commit message: `test: add bridge coverage for codex plan and sub-agent flows`

### Task 4: Final verification

**Files:**
- Verify only

**Step 1: Run focused suites**

Run: `npm run -s test -- tests/acpx-runner.test.ts tests/bridge-subagent-planmode.test.ts`
Expected: PASS

**Step 2: Run full suite**

Run: `npm run -s test`
Expected: PASS

**Step 3: Run build**

Run: `npm run -s build`
Expected: PASS

**Step 4: Commit any final doc or assertion adjustments**

Commit message: `test: finalize codex plan and sub-agent coverage`
