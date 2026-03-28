# Current Session Recent Messages Design

## Goal

When a Feishu DM has already switched to a Codex native thread, clicking `当前会话` should show the current thread context together with recent messages, so the user can recover context without going back through the thread switch card.

## Scope

This change is intentionally narrow.

- Only `DM + Codex 原生线程绑定` is affected.
- `/ca session` in ordinary DM session mode stays lightweight.
- `/ca session` in registered Feishu thread mode stays unchanged.
- The existing message selection rule is reused:
  - last `1` user message
  - last `4` assistant messages
  - ignore developer/system content
  - no truncation

## Approach

`BridgeService` already knows when a DM is bound to a Codex native thread via `lookupDmCodexSelection`. For that branch, `/ca session` will stop returning plain text and instead return a JSON 2.0 card. The card will include:

- project name/path
- current thread id/title
- session id
- recent message section

The recent messages continue to come from `CodexSqliteCatalog.listRecentConversation(...)`, and the final display subset continues to be selected inside `BridgeService`, matching the existing thread-switch preview behavior.

## Tradeoffs

### Recommended

Return a card only for the `DM + Codex thread` case.

Why:

- Reuses an already-supported data source.
- Keeps the UI consistent with the thread-switch confirmation card.
- Avoids inventing “recent messages” behavior for contexts that do not have a reliable Codex rollout source.

### Rejected

Return a card for all `/ca session` calls.

Why not:

- Ordinary bridge sessions do not have the same message history source.
- Registered Feishu threads would need a different retrieval path and a broader product decision.
- The change would spread beyond the user’s request.

## Feishu Notes

This change does not alter the callback model. It keeps the existing JSON 2.0 card rendering path and the current `card.action.trigger` immediate-response model already used by the project.
