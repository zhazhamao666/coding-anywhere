# Feishu Bridge Plan Mode Design

**Date:** 2026-03-30

**Goal:** Add a Feishu-facing bridge-style plan mode that lets users start a one-shot `/plan ...` request from DM or registered Feishu threads, view structured `todo_list` progress on cards, and answer plan follow-up choices through card actions that resume the same native Codex thread.

## Why

The runtime now uses native Codex threads as the single execution source of truth, but Feishu card interactions are still limited to:

- `/ca ...` command buttons
- generic progress preview text
- no persisted plan interaction state

That gap makes three user-facing flows incomplete:

1. Users cannot start plan mode from cards without typing `/plan ...`
2. `todo_list` only appears as flattened waiting text
3. native plan follow-up choices cannot be answered from Feishu cards

## Official Feishu Constraints

The implementation must follow current Feishu card JSON 2.0 behavior:

- Card callback type is `card.action.trigger`
- Callback payload schema is `2.0`
- The server must respond within 3 seconds
- Developer payload is returned under `event.action.value`
- Submitted form data is returned under `event.action.form_value`
- Form item `name` values are required and unique inside the card, otherwise callback error `200530`
- A JSON 2.0 card must be updated with another JSON 2.0 card, otherwise callback error `200830`
- Input components used with buttons must be nested inside a `form` container
- Form submit/reset buttons in JSON 2.0 use `form_action_type`

These points were verified against the latest Feishu docs on 2026-03-30 before implementation.

## Non-Goal

This design does not claim to implement Codex CLI's true interactive slash-command `/plan` protocol. The CLI path in production is still non-interactive `codex exec` / `codex exec resume`.

Instead, we build a bridge-managed plan workflow:

- launch a planning request by prepending `/plan `
- render native planning progress on Feishu cards
- persist pending bridge questions
- resume the same Codex thread with a synthesized follow-up prompt when the user clicks a choice

This gives Feishu users a practical plan-mode experience without changing the core native-thread execution model.

## User Experience

### 1. Start planning from cards

In DM and in registered Feishu threads, cards gain a one-shot `计划模式` button.

When clicked:

- the callback returns a JSON 2.0 card containing a form
- the form includes a multiline input box for the planning request
- the form submit callback carries a bridge action payload

When submitted:

- bridge reads `action.form_value`
- bridge turns the text into `/plan ${text}`
- bridge routes it as a normal prompt into the active native Codex thread

### 2. View structured todo progress

When native Codex emits `todo_list`, bridge keeps the existing waiting signal for generic progress, but also stores a structured todo snapshot in the progress state.

The final card rendering shows:

- base run metadata
- latest preview
- a structured checklist for plan items

### 3. Answer plan follow-up choices

When Codex asks a bridge-actionable plan question, bridge persists a pending interaction keyed by Feishu surface.

The progress/final card renders:

- the question
- each option as a single card button

When the user clicks one option:

- bridge loads the pending interaction
- bridge synthesizes a concise follow-up user message from the selected option
- bridge resumes the same native Codex thread with `codex exec resume --json <thread_id>`
- bridge clears or supersedes the old pending interaction

## Bridge Interpretation Rules

Because `codex exec` is non-interactive, the bridge must decide which waiting events are actionable.

### Actionable plan interaction

A waiting event becomes a persisted plan interaction only when the bridge has structured choice metadata.

Primary source:

- structured runner event parsed from native transcript, if available

Fallback source:

- deterministic bridge-side heuristics over native waiting text only when a stable choice set is present

### Non-actionable waiting state

If bridge only has free-form waiting text and no stable choice set:

- render it as waiting text
- do not create clickable plan actions
- user can still continue by sending a normal message manually

This avoids inventing unsafe buttons from ambiguous model text.

## Data Model Changes

### Progress state

`ProgressCardState` needs structured plan data:

- `planTodos?: PlanTodoItem[]`
- `planInteraction?: PendingPlanInteractionView`

### Runner event model

`AcpxEvent` needs native-plan-friendly variants:

- `waiting` should optionally carry structured plan metadata
- `todo_list` should be preserved as structured items rather than only flattened text

### Session store

Add a new persisted table for pending plan interactions, scoped by delivery surface:

- run id
- codex thread id
- channel / peer / chat / surface ref
- question text
- normalized choices
- message/card context
- status timestamps

This table allows card callbacks to resume the correct thread even after process restarts.

## Callback and Card Changes

### Card action payloads

Extend card callbacks beyond `/ca ...` commands with explicit bridge actions, for example:

- `bridgeAction: "open_plan_form"`
- `bridgeAction: "submit_plan_form"`
- `bridgeAction: "answer_plan_choice"`

The callback service remains responsible for returning a raw JSON 2.0 card immediately.

### Plan form card

The returned form card should:

- remain JSON 2.0
- use a root-level `form`
- include a multiline `input`
- use `form_action_type: "submit"` and `form_action_type: "reset"`
- carry bridge routing metadata in the submit button payload

### Progress card rendering

`buildBridgeCard` should support three plan-related sections:

- checklist section for `todo_list`
- question section for pending plan interaction
- choice button row for the current pending interaction

## Message Flow

### Start plan mode

1. User clicks `计划模式`
2. Callback returns plan form card
3. User submits planning text
4. Callback service routes synthesized `/plan ...` prompt into bridge
5. Bridge runs against current native thread
6. Progress card shows checklist / waiting / final reply

### Answer follow-up choice

1. Native run emits an actionable plan interaction
2. Bridge persists pending interaction
3. Card renders single-choice buttons
4. User clicks a choice
5. Callback service loads interaction and synthesizes answer prompt
6. Bridge resumes same native Codex thread
7. Pending interaction is marked resolved or replaced

## Testing Strategy

### Runner / contract

- transcript fixtures that include structured `todo_list`
- transcript fixtures with actionable plan choices

### Card and callback

- plan form card builder tests
- checklist rendering tests
- callback tests for `form_value`
- callback tests for choice-button answers

### Bridge integration

- one-shot plan form submit in DM
- one-shot plan form submit in registered thread
- pending interaction persistence and answer flow
- resumed run clears or replaces stale plan interaction

## Risks

### 1. Native waiting structure may drift

Mitigation:

- keep transcript fixtures from real Codex runs
- only make choice buttons from structured/native evidence

### 2. Card callback must finish inside 3 seconds

Mitigation:

- callback only returns the updated card or dispatches a normal bridge run quickly
- do not do slow Feishu patch/update work inside the same callback path

### 3. JSON 2.0 compatibility

Mitigation:

- all new cards stay in JSON 2.0
- form cards use `form`, `input`, and button fields verified against current Feishu docs

## Final Shape

After this work:

- DM and registered threads both support a one-shot `计划模式` card action
- plan requests run on native Codex threads
- `todo_list` is displayed structurally on Feishu cards
- actionable plan questions can be answered by card buttons
- the bridge remains the control plane while native Codex threads remain the execution truth
