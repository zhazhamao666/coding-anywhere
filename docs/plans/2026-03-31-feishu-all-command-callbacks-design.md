# Feishu All Command Callbacks Design

**Date:** 2026-03-31

## Goal

Unify Feishu card button handling for all `/ca ...` command buttons so every command callback returns immediately, then completes in the background and patches the same interactive card with the final result.

## Current Context

- `src/feishu-card-action-service.ts` already treats plan-mode submit/choice actions as asynchronous background work.
- The previous timeout fix only moved a subset of risky `/ca` commands to the asynchronous path.
- Fast read-only command buttons still execute synchronously and return their final card inline.

## Options Considered

### Option 1: Keep only risky `/ca` commands asynchronous

Pros:
- Fastest visible refresh for read-only commands.
- Smaller code change.

Cons:
- Two mental models for `/ca` command buttons.
- Easy to regress when a new command is added and misclassified.
- Button behavior remains inconsistent for users.

### Option 2: Make every `/ca ...` command button asynchronous

Pros:
- One execution model for all command buttons.
- Removes command-risk classification logic.
- Easier to reason about callback latency and future command additions.

Cons:
- Navigation and query cards become a two-step interaction: ack first, result second.
- Slightly slower perceived refresh for cheap commands.

### Option 3: Make every button asynchronous, including `open_plan_form`

Pros:
- Absolute uniformity across all card actions.

Cons:
- Bad fit for `open_plan_form`, which is not background work.
- Adds pointless delay before showing the plan form.
- Degrades UX without reducing risk.

## Approved Design

Use Option 2 for `/ca ...` command buttons and keep `open_plan_form` as an immediate form swap.

Specifically:

- Any card action carrying `value.command` and parsing to a `/ca` command will:
  - immediately return a raw JSON 2.0 confirmation card;
  - execute `bridgeService.handleMessage(...)` in the background;
  - patch the original interactive card with the final card reply, wrapped system reply, or error card.
- `open_plan_form` remains synchronous and returns the form card immediately.
- `submit_plan_form` and `answer_plan_choice` keep their current asynchronous execution model.

## Why This Design

- It matches the user's requested interaction model for all `/ca` commands.
- It removes the fragile command-risk classifier introduced by the previous fix.
- It stays aligned with Feishu's current card interaction model, where callback handling and subsequent card updates are both valid patterns.

## Impact

- `src/feishu-card-action-service.ts` becomes the single place that decides:
  - immediate ack rendering for `/ca` buttons;
  - background execution;
  - final card patching.
- Existing synchronous `/ca` command button tests need to be split:
  - plan-form still inline;
  - all `/ca` command buttons now ack first and patch later.
- `docs/project-full-overview.md` must be updated to reflect the new universal `/ca` command callback model.

## Testing Strategy

- Add failing tests that prove read-only `/ca` command buttons now ack immediately and patch later.
- Keep existing tests for plan-form immediate return and plan submit/choice background execution.
- Run:
  - `npx vitest run tests/feishu-card-action-service.test.ts`
  - `npx tsc -p tsconfig.json --pretty false`
  - `npx vitest run`
