# Native Thread Single-Path Design

**Date:** 2026-03-28

**Goal:** Replace CA-owned execution sessions with Codex native threads as the only execution truth for DM, project groups, and Feishu topic threads.

## Why

The current system has two first-class execution models:

- CA-managed `sessionName` for default DM and registered Feishu threads
- Codex-managed `codex_thread_id` for DM windows that explicitly switch to a native thread

This split leaks into routing, lifecycle, observability, and command semantics. Once project groups and Feishu topic threads are allowed to switch to arbitrary Codex native threads, keeping both models alive as equal peers would create ongoing ambiguity about which object owns execution truth.

## Target State

The target state is:

- Every executable Feishu surface resolves to a Codex native `thread_id`
- All normal prompt execution uses `codex exec --json` or `codex exec resume --json`
- CA remains the control plane for surface binding, delivery target persistence, run serialization, and observability
- `acpx` no longer executes user prompts or owns long-lived session lifecycle

## Scope

This design intentionally changes four user-visible semantics:

1. `/ca new`
   - No longer means "reset CA session"
   - Means "create and switch to a new native Codex thread"
2. `/ca stop`
   - No longer maps to `acpx cancel`
   - Returns unavailable until a native-thread cancellation model exists
3. Project thread creation
   - Creates a Feishu topic and a real native Codex thread together
4. Group/thread switching
   - Project groups and registered Feishu threads can switch to native Codex threads for the same project

## Technical Strategy

### 1. Make native thread creation a first-class runner operation

`codex exec --json` emits `thread.started` before the first turn completes. The runner should parse this event and expose the created `thread_id` in the run outcome. This becomes the bootstrap path for:

- first DM prompt in an unbound window
- `/ca new`
- project-thread creation bootstrap

`codex exec resume --json <thread_id>` remains the continuation path for already-bound surfaces.

### 2. Redefine runtime context around native threads

Execution contexts should become:

- existing native thread: `threadId + cwd`
- create-new native thread: `cwd` plus an instruction seed

Legacy `sessionName` should stop driving execution. It may temporarily remain in persistence or observability as a derived compatibility field, but it is no longer authoritative.

### 3. Unify surface binding

There are currently two surface-binding models:

- `thread_bindings` for DM -> CA session
- `codex_threads(chat_id, feishu_thread_id)` for Feishu thread -> CA thread/session

The new model should bind executable surfaces to a native Codex `thread_id`:

- DM window -> native thread id
- Feishu topic thread -> native thread id

The persisted record for project-created Feishu topics should still keep delivery metadata such as:

- project id
- Feishu chat id
- Feishu topic id
- anchor/latest message ids
- owner open id
- status and last run id

But its `thread_id` now means the real Codex native thread id, not a CA-generated logical id.

### 4. Keep CA as orchestration, not execution truth

The bridge still owns:

- routing from Feishu surface to execution target
- progress relay and observability run/event rows
- concurrency keys
- project/group metadata
- Feishu delivery target selection

The bridge no longer owns:

- prompt-session bootstrap via `acpx sessions ensure`
- prompt execution via `acpx prompt`
- session close/reset semantics

## Command Semantics

### `/ca`

- DM without binding: show root plus "no current thread yet"
- DM with binding: show current native thread
- Project group or registered Feishu thread: show current native thread bound to that surface

### `/ca new`

- DM: create a fresh native thread in the root cwd, bind current DM window to it
- Project group or registered Feishu thread: create a fresh native thread in the current project cwd, bind that surface to it

### `/ca thread list-current`

- DM: list native threads from the currently selected native project
- Project group or registered Feishu thread: list native threads for the current project by resolving the local project cwd to the Codex catalog project

### `/ca thread switch <threadId>`

- DM: bind current window to the chosen native thread
- Project group: create/update the project-thread mapping so future messages in the selected Feishu topic or group-scoped create flow run on that native thread
- Registered Feishu thread: rebind that thread surface to the chosen native thread

### `/ca stop`

- Return unavailable for now
- Do not pretend to cancel native runs unless a real implementation exists

## Thread Creation Model

Project-thread creation becomes a two-sided provisioning flow:

1. Send the Feishu topic root message to obtain `messageId` and `feishuThreadId`
2. Run a bootstrap native Codex turn in the project cwd
3. Capture `thread.started.thread_id`
4. Persist a thread record whose `thread_id` is that native id

The bootstrap prompt should be minimal and explicit that this is a bridge-created thread seed. The assistant reply should be ignored for Feishu delivery unless the command explicitly needs it.

## Migration Notes

- Existing SQLite rows that store CA-generated thread ids will need migration or rewrite logic
- Existing `session_name` values may be retained temporarily to avoid breaking observability queries, but should no longer drive runtime behavior
- Idle reaping should stop trying to `acpx sessions close`; it should only update local state or be disabled until a meaningful native-thread idle policy exists

## Risks

- Hard-cutting to native threads changes `/ca new`, `/ca stop`, and thread-creation semantics at once
- Existing persisted rows may contain non-native thread ids
- Some ops views currently assume `session_name` remains meaningful
- Codex state DB consistency is external to CA, so catalog refresh timing matters after creating a new thread

## Acceptance Criteria

- Plain DM prompts execute through native Codex thread creation/resume only
- Registered Feishu thread prompts execute through native thread resume only
- `/ca new` creates a real native thread and rebinds the current surface
- Project-thread creation persists a real native thread id
- Project groups and registered Feishu threads can switch to arbitrary native threads within the same project
- No normal user prompt path invokes `acpx prompt`
