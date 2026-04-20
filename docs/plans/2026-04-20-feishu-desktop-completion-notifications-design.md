# Feishu Desktop Completion Notifications Design

**Date:** 2026-04-20

## Goal

Add an automatic bridge from locally running Codex desktop/native threads to Feishu so that:

- a Codex thread that finishes on the local machine can notify Feishu without requiring the user to have started that run from Feishu;
- the notification includes the final assistant result and enough context to decide whether to continue;
- clicking continue hands the thread over to Feishu and lands on the normal Codex thread conversation card, not on an intermediate notification UI.

## Problem Summary

Today the bridge only knows about runs that it started itself. If a user starts a Codex session directly in the desktop app, walks away, and the session finishes later, Feishu never learns about that completion event.

This causes three UX gaps:

1. The user does not get notified that the local Codex session finished.
2. The user cannot immediately see the final result from Feishu.
3. The user cannot naturally pick the session up in Feishu without manually browsing projects/threads and switching context.

The project already has strong Feishu-to-Codex routing, but it lacks the reverse direction for desktop-originated completions.

## User Outcomes

### Primary Outcome

When a locally running Codex thread finishes, Feishu receives a new notification message with:

- project name;
- thread title;
- completion status and time;
- a short summary of the result;
- the full final result below the card;
- a direct action to continue the same thread in Feishu.

### DM Outcome

If the completion is delivered to DM and the user clicks `在飞书继续`, the DM immediately switches to the normal Codex thread conversation card for that native `thread_id`. The next plain text message resumes the same thread.

### Group Outcome

If the completion is delivered to a project group timeline and the user clicks continue, the bridge creates or links a Feishu topic for the native thread, posts the normal Codex thread conversation card into that topic, and updates the original notification card to indicate that continuation moved to the topic.

## Non-Goals

- Do not implement generic desktop run streaming into Feishu while the local run is still in progress.
- Do not attempt to identify a distinct "Codex App" source versus "VS Code" source if the local Codex metadata does not expose it reliably.
- Do not build a general-purpose inbox page or thread management UI outside Feishu.
- Do not merge multiple different thread completions into a single digest card in v1.
- Do not support multi-tenant desktop ownership inference without explicit configuration when the Feishu allowlist contains multiple users.

## Existing Capabilities We Must Reuse

- DM can already bind to an existing native Codex thread via `/ca thread switch <threadId>`.
- The bridge can already read native Codex projects, threads, and recent conversation previews from local Codex SQLite state and rollout JSONL files.
- Existing thread/topic bindings already map a Feishu topic surface to a native `thread_id`.
- Project-group bindings already map a Codex project to a Feishu group.
- Current Feishu callback handling already uses the correct immediate-response plus delayed-card-update pattern for slow actions.

These existing pieces mean the main missing capability is not "continuation" itself. The missing capability is "desktop completion observation and routing."

## Constraints

### Product Constraints

- The user explicitly wants the system to work automatically.
- Notification UI quality matters; the result must feel like a notification, not a navigation page disguised as one.
- The continue action must land on the normal Codex thread conversation card.

### Technical Constraints

- The local Codex state currently gives reliable access to:
  - `threads.updated_at`;
  - `threads.rollout_path`;
  - `threads.cwd`;
  - `threads.title`;
  - rollout JSONL events including `response_item.message` and `task_complete`.
- The local Codex state does not currently provide a stable dedicated "desktop app source" marker beyond the existing `source` field values such as `vscode` and `cli`.
- Feishu card callback handling must respond within 3 seconds; long work must happen asynchronously and patch later.
- Updating an existing message card does not create a new bottom-of-thread message, so repeated thread completions must not permanently reuse the same notification card.

## Terminology

- `native thread`: a Codex-native `thread_id` recorded in local Codex state.
- `desktop completion`: a completion event for a native thread that was not initiated by the bridge in the current run pipeline.
- `notification surface`: the Feishu place where a completion notice is delivered.
- `conversation surface`: the Feishu place where subsequent user messages resume the native thread.
- `completion key`: the dedupe key representing one concrete completion event for one thread.

## Options Considered

### Option 1: DM-only notifications for every unbound desktop completion

Pros:

- Simplest routing model.
- Lowest risk of notifying the wrong group.
- Natural fit for personal "I walked away from my computer" usage.

Cons:

- Ignores existing project-group bindings.
- Misses collaborative visibility when a project already has a mapped Feishu group.

### Option 2: Add per-thread route preferences table

Pros:

- Most precise long-term routing control.
- Easy to evolve to mute/snooze/custom destinations later.

Cons:

- Adds a new persistent routing model on top of existing `codex_threads`, `project_chats`, and `codex_window_bindings`.
- Hard to justify for v1 once the user provided a simpler routing rule.

### Option 3: Reuse existing bindings and route by explicit thread binding first, then project group, then DM

Pros:

- Reuses current data model.
- Matches the user's clarified rule: if a project is already bound to a Feishu group, push all thread completions for that project to that group unless a more specific thread-topic binding exists.
- Avoids adding a route preference table in v1.

Cons:

- Requires a small amount of ownership/config logic for the DM fallback path.
- Group timeline continue UX must differ from DM continue UX.

## Approved Design

Use Option 3.

The bridge will observe local Codex rollout updates, detect new native-thread completion events, dedupe them, and route them with this precedence:

1. Existing Feishu topic binding for the exact native `thread_id`.
2. Existing Feishu project group binding for the thread's project.
3. Fallback to a designated owner's Feishu DM.

Repeated completions for the same native thread will create new notification messages when they represent a new completion event. The bridge will only patch an existing notification card for retry/recovery of the same completion event.

## High-Level Architecture

```text
Local Codex thread rollout append
  -> desktop completion observer
  -> completion extractor + dedupe
  -> route resolver
  -> notification publisher
  -> Feishu notification card + full final result
  -> user clicks continue
  -> existing thread switch / thread link flow
  -> normal Codex thread conversation card
```

## Detailed Behavior

### 1. Completion Observation

Runtime adds a new observer service that periodically scans local Codex thread metadata and rollout files.

The observer:

- reads local Codex thread catalog entries;
- tracks the latest seen `rollout_path` and file offset for each `thread_id`;
- incrementally parses new JSONL lines instead of rereading the whole file every time;
- watches for:
  - final assistant `response_item.message` entries in `phase = final_answer` when available;
  - terminal `event_msg.payload.type = task_complete`.

The observer does not attempt to replay bridge-managed streaming state. It only emits a compact "thread completed" event once the native rollout signals completion.

### 2. Completion Event Extraction

For one observed completion, the bridge extracts:

- `thread_id`
- `rollout_path`
- `project cwd`
- `project display name`
- `thread title`
- `completed_at`
- `final assistant text`
- `summary excerpt`
- `source`

The summary excerpt should be derived from the final assistant text by taking the first 3-5 meaningful lines or roughly the first 220-320 visible characters, whichever is clearer.

If no final assistant text is available, the completion event still exists but is marked as "body unavailable."

### 3. Completion Dedupe

Each completion generates:

```text
completion_key = thread_id + task_complete_timestamp + hash(final_assistant_text or "")
```

Rules:

- If `completion_key` equals the most recently delivered key for that thread, do not send a new notification.
- If the same key is being retried because the Feishu send failed, patch or resend only for recovery.
- If the key changes, treat it as a new completion and send a new notification message.

This means:

- different threads => different notification messages;
- same thread, same completion => no duplicate notification;
- same thread, later completion => new notification message.

### 4. Bridge-Originated Run Suppression

The bridge must suppress desktop-completion notifications for runs that it already initiated and already pushed back to Feishu through the normal run pipeline.

Suppression should be based on recent `observability_runs` plus matching `thread_id`, completion timing, and terminal output characteristics.

Practical rule for v1:

- if a recent `observability_runs` record exists for the same `thread_id` and was finished by the bridge within a short correlation window around `completed_at`, skip the desktop-completion notification;
- otherwise treat the completion as desktop-originated and notify.

The exact correlation window can start conservatively at 30 seconds.

### 5. Route Resolution

Route resolution order is fixed:

1. **Exact thread-topic binding**
   If `codex_threads` contains a live Feishu topic binding for the native `thread_id`, notify that Feishu topic.

2. **Project-group binding**
   If the thread's project resolves to a project that is already bound in `project_chats`, notify that project group's main timeline.

3. **Owner DM fallback**
   Notify the configured desktop owner DM.

No "guess the most recently active group" behavior is allowed.

### 6. Owner DM Resolution

The DM fallback needs one deterministic owner open_id.

Design rule:

- if `feishu.allowlist` contains exactly one open_id, use it as the desktop owner automatically;
- if it contains more than one open_id, require a new config field such as `feishu.desktopOwnerOpenId`;
- doctor/config validation should fail early if DM fallback could be needed but the owner cannot be resolved unambiguously.

This keeps the product automatic for the common single-user deployment while remaining explicit for shared setups.

### 7. Notification Message Strategy

Each new completion event sends:

1. a new notification card message;
2. immediately after that, the full final result as a normal assistant reply message/card.

The card is the notification entry point.
The full result message is the readable payload.

We deliberately do **not** hide the full result behind a button because the user may open Feishu only to quickly inspect the outcome.

### 8. Notification Card UX

The card must look like a notification, not like a navigation dashboard.

Required header information:

- project name
- thread name
- completion status
- completion timestamp

Required body sections:

- `你离开前的会话`
  - one-line reminder using the last user message or thread title
- `结果摘要`
  - 3-5 lines from the final answer

Optional notation line:

- source/delivery notes
- fallback warning if the preferred route was unavailable

Action rules:

- one primary action only;
- at most two secondary actions;
- no generic navigation clutter.

Recommended actions:

- DM notification:
  - primary: `在飞书继续`
  - secondary: `查看最近对话`
  - secondary: `静音此线程` if mute is implemented in this phase
- Group timeline notification:
  - primary: `在群里开话题继续`
  - secondary: `查看最近对话`
  - secondary: `静音此线程` if mute is implemented

### 9. Continue Flow in DM

DM continue behavior:

1. bind the DM window to the native `thread_id`;
2. replace the notification card with the normal "current Codex session" conversation card;
3. keep the already-sent full result message below it unchanged;
4. next plain text DM message resumes the same native thread.

This must not leave the user on an intermediate "thread switched" acknowledgement card.

### 10. Continue Flow in Group Timeline

Group timeline continue behavior:

1. create or link a Feishu topic for the native `thread_id` using the existing project-thread service;
2. send the normal Codex thread conversation card into that topic;
3. update the original group-timeline notification card to say continuation moved to the topic.

The group timeline itself should remain a notification surface, not the main conversation surface.

### 11. Post-Takeover Behavior

Once a native thread has been explicitly taken over by Feishu:

- later completions for that thread no longer use standalone notification cards;
- instead, final outputs return directly to the established conversation surface:
  - DM if the thread was taken over in DM;
  - Feishu topic if the thread was taken over in a project group.

This keeps the UX consistent:

- not yet taken over => notify;
- already taken over => continue the conversation.

### 12. Repeated Completion Behavior

Rules:

- same thread, same completion event => no new card;
- same thread, later completion event before takeover => new notification card;
- same thread, later completion event after takeover => return to the conversation surface instead of sending another notification card.

We explicitly reject the earlier idea of always reusing one standing notification card, because updated cards do not reliably surface at the bottom of the conversation and can be buried by newer messages.

## Data Model Changes

### New Table: `codex_thread_watch_state`

Purpose:

- persist observer progress;
- avoid rereading rollout files from the start;
- dedupe completion notifications;
- record the latest delivery state for retries.

Proposed fields:

- `thread_id TEXT PRIMARY KEY`
- `rollout_path TEXT NOT NULL`
- `rollout_mtime TEXT NOT NULL`
- `last_read_offset INTEGER NOT NULL`
- `last_task_complete_at TEXT`
- `last_completion_key TEXT`
- `last_notified_completion_key TEXT`
- `last_delivery_surface_type TEXT`
- `last_delivery_chat_id TEXT`
- `last_delivery_surface_ref TEXT`
- `last_notification_message_id TEXT`
- `updated_at TEXT NOT NULL`

Notes:

- `last_notification_message_id` is only for retry/repair of the same completion event, not for future completion reuse.
- delivery surface fields are observability aids; routing itself still resolves from existing bindings each time.

### No New Route Preference Table in V1

We intentionally do **not** add `codex_thread_route_preferences` in v1 because:

- exact thread routing already exists in `codex_threads`;
- project routing already exists in `project_chats`;
- DM takeover state already exists in `codex_window_bindings`;
- the user provided a simpler explicit routing rule.

### Optional New Config Field

Add:

- `feishu.desktopOwnerOpenId` (optional when allowlist length = 1; required otherwise for DM fallback)

## Files Expected to Change in Implementation

- `src/config.ts`
- `config.example.toml`
- `src/runtime.ts`
- `src/codex-sqlite-catalog.ts`
- `src/bridge-service.ts`
- `src/feishu-card-action-service.ts`
- `src/feishu-adapter.ts`
- `src/workspace/session-store.ts`
- `src/types.ts`
- `src/project-thread-service.ts` if group continue needs a small API expansion
- new observer/service files, likely under `src/`
- tests covering observer, routing, action handling, and runtime wiring
- `docs/project-full-overview.md`

## Observability

Add logs for:

- observer scan start/stop
- completion extracted
- completion suppressed as bridge-originated
- route resolved to topic/group/DM
- notification send success/failure
- continue handoff success/failure

Recommended structured fields:

- `threadId`
- `projectCwd`
- `completionKey`
- `deliveryMode`
- `chatId`
- `surfaceRef`
- `messageId`

## Failure Handling

### Feishu Send Failure

- Keep `last_completion_key`.
- Do not advance `last_notified_completion_key`.
- Retry on the next observer cycle with backoff.

### Invalid Preferred Topic/Group

- Log the failure.
- Fall back to owner DM.
- Add a light warning line in the delivered notification card.

### Missing Final Assistant Text

- Still notify.
- Card summary says the run completed but the final body could not be extracted.
- Do not fabricate content.

### Unresolvable DM Owner

- Log a clear configuration error.
- Skip DM fallback delivery.
- Surface the issue in doctor/runtime logs.

## Security and Privacy

- Only notify routes already allowed by existing Feishu bindings or explicit owner configuration.
- Do not expose raw rollout paths or filesystem details in user-facing cards.
- Keep raw `thread_id` out of primary UI copy whenever a human title exists; include it only in secondary diagnostic lines if needed.
- Continue using existing allowlist checks for interactive follow-up actions.

## Migration Strategy

- Add the new observer table with a normal SQLite migration.
- On first startup after upgrade, initialize watch rows lazily as threads are discovered.
- Do not backfill old historical completions into Feishu; only notify for completions observed after the feature is enabled.

## Testing Strategy

### Unit Tests

- watch state persistence and migration
- completion extraction from rollout JSONL
- dedupe behavior for same completion key
- repeated-completion behavior for changed completion key
- bridge-originated suppression logic
- route resolution priority:
  - exact topic
  - project group
  - DM fallback

### Integration Tests

- runtime wires the observer and notification service
- DM continue swaps to normal current-session card
- group continue creates/links a Feishu topic and posts the current-session card there
- already-taken-over thread later completes and returns to the conversation surface instead of sending a standalone notification card

### Manual Smoke

- start a real local Codex thread outside Feishu
- let it finish
- verify Feishu receives a new notification card and a full result message
- click continue
- verify the normal Codex conversation card appears
- send a follow-up and confirm the same native thread resumes

## Risks and Mitigations

### Risk: False duplicate notifications

Mitigation:

- dedupe on `completion_key`;
- persist watch offsets;
- suppress bridge-originated runs.

### Risk: Notifying the wrong place

Mitigation:

- fixed precedence order only;
- no heuristic routing;
- explicit DM owner resolution.

### Risk: Notification UI becomes another noisy dashboard

Mitigation:

- one primary action;
- strict information budget;
- full result moved to a separate message below the card.

## Rollout Recommendation

Ship in two internal phases:

1. observer + DM fallback notification only;
2. project-group routing + group continue topic handoff.

If implementation cost stays low, both can still land in one branch, but verification should conceptually follow that order because DM fallback is the smallest valid end-to-end slice.
