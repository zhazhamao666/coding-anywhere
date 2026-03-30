# Codex Sub-Agent And Plan-Mode Testing Design

**Date:** 2026-03-29

## Goal

Add trustworthy test coverage for two Codex-native behaviors that are not currently represented in this repo:

- sub-agent lifecycle activity
- native plan-mode event flow

The design prioritizes one-time real transcript capture and then shifts back to fixture-driven regression tests.

## Why

The current Codex coverage only exercises these JSONL shapes:

- `thread.started`
- `item.started` / `item.completed` for `command_execution`
- `item.completed` for `agent_message`
- `turn.completed`

That is enough for basic create/resume flows, but it does not tell us what happens when Codex:

- enters native planning behavior
- emits sub-agent-related events
- mixes those events with ordinary tool calls and final assistant text

Without real samples, any parser change here would be guesswork.

## Constraints

### 1. Real Codex calls are expensive

Recent real smoke runs already showed that even narrow tasks can consume large token budgets. The new work should not expand live verification into the normal test path.

### 2. The protocol must be discovered, not invented

We do not currently have fixture evidence for sub-agent or native plan-mode event shapes. The first step must therefore be minimal real recording.

### 3. Bridge behavior matters as much as parser behavior

It is not enough to prove that `AcpxRunner` can parse the events. We also need to confirm that the bridge:

- does not stall
- persists run observability coherently
- still produces sensible replies

## Non-Goals

This work does not try to:

- evaluate the quality of Codex planning
- force a full live end-to-end Feishu test
- add broad live smoke coverage for sub-agent or plan mode

The target is protocol and bridge compatibility.

## Proposed Approach

### Step 1: Record Two Minimal Real Transcripts

Capture exactly two new JSONL fixtures:

- `plan-mode.jsonl`
- `sub-agent.jsonl`

The capture prompts should be intentionally narrow:

- one prompt that reliably triggers native plan behavior
- one prompt that explicitly asks Codex to delegate one small bounded side task

These recordings are not for repeated live regression; they are for establishing the actual protocol shape.

### Step 2: Expand Runner Contract Tests

Use the new fixtures to answer three questions:

1. Which events are currently ignored?
2. Which events should become normalized bridge-visible events?
3. Which events should remain ignored but must not break buffering or completion?

The parser should only be extended where the transcript proves a stable need.

### Step 3: Expand Bridge Integration Tests

Add transcript-backed bridge tests using the real `BridgeService + AcpxRunner` path with mocked `execa`.

Focus:

- plan-mode transcripts do not wedge the bridge lifecycle
- sub-agent transcripts preserve final user-facing reply behavior
- run persistence and event persistence stay coherent

## Event Handling Strategy

The default posture is conservative:

- if a new Codex event does not affect user-visible behavior, it may remain ignored
- if a new event represents meaningful progress that should surface to the bridge, normalize it minimally
- do not build a generalized event taxonomy until the recorded samples justify it

## Testing Layers

### Layer 1: Recorded Transcript Fixtures

Always-on tests for:

- parser buffering
- event normalization
- terminal completion behavior

### Layer 2: Bridge Transcript Replay

Always-on tests for:

- DM bootstrap path
- existing-thread resume path
- observability persistence

### Layer 3: Manual Recording-Only Live Runs

Used only to acquire or refresh fixtures when protocol shape changes.

These runs remain explicit and cost-bearing.

## Acceptance Criteria

- real transcript fixtures exist for native plan mode and sub-agent flows
- `AcpxRunner` tests cover those fixtures
- bridge-level integration tests cover those fixtures
- default CI remains fixture-driven and does not require real Codex calls
- docs reflect the new coverage and recording-only live strategy
