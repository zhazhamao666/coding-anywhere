# Feishu Card Callback Timeout Design

**Date:** 2026-03-30

## Problem

Feishu `card.action.trigger` callbacks must return quickly. The current card action path synchronously waits for `bridgeService.handleMessage(...)` for ordinary `/ca` command buttons. For commands that create native Codex threads or create/link Feishu threads, that synchronous wait can exceed the callback time limit and Feishu reports `目标回调服务超时未响应`.

## Root Cause

- `src/feishu-card-action-service.ts` treats plan-mode actions as asynchronous, but ordinary command buttons are still synchronous.
- `src/bridge-service.ts` implements `/ca new` by awaiting `runner.createThread(...)`.
- `src/bridge-service.ts` implements some `thread` subcommands by awaiting `projectThreadService.createThread(...)` or `projectThreadService.linkThread(...)`.
- Those operations cross process or network boundaries and are not safe to run inside the callback response window.

## Scope

Keep fast, read-only commands synchronous:

- `/ca`
- `/ca hub`
- `/ca status`
- `/ca session`
- `/ca stop`
- `/ca project list`
- `/ca project current`
- `/ca project threads <projectKey>`
- `/ca thread list`
- `/ca thread list-current`

Move risky mutating commands to asynchronous callback handling:

- `/ca new`
- `/ca thread switch <threadId>`
- `/ca thread create <projectId> <title>`
- `/ca thread create-current <title>`
- `/ca project bind <projectId> <chatId> <cwd> [name]`
- `/ca project bind-current <projectId> <cwd> [name]`

The implementation may cover a superset of currently button-reachable commands if that reduces future regressions.

## Proposed Design

1. Extend `FeishuCardActionService` with a command classification step.
2. If a command is classified as asynchronous:
   - return an immediate raw JSON 2.0 info card acknowledging the request;
   - launch the command in the background;
   - when the background command finishes, update the original interactive card with the final card reply or a wrapped info card;
   - if the background command fails, update the original card with an error card.
3. Keep existing synchronous handling for fast query/navigation commands so those cards still refresh immediately.

## Why This Design

- Fixes the proven timeout path without turning the whole card command surface into delayed updates.
- Reuses the existing interactive-card update channel already used by streaming cards.
- Covers the same risk class for future button additions: commands that create or bind remote state should not block `card.action.trigger`.

## Testing Strategy

- Add regression tests in `tests/feishu-card-action-service.test.ts` that prove:
  - `/ca new` returns an immediate ack card and does not wait for completion;
  - the final system result from `/ca new` updates the interactive card asynchronously;
  - a risky `thread` command follows the same path;
  - synchronous query commands still return their card inline.
- Run targeted tests first, then TypeScript compilation, then the full test suite.
