# DM Project Switch Design

**Date:** 2026-03-31

## Goal

Allow users in Feishu DM to switch the current project directly from the Codex project list without immediately switching to a thread or creating a new thread.

## Current Problem

In DM, the current project is derived from the current native Codex thread binding. That means:

- the project list can only offer "view threads";
- there is no independent DM-level "current project" selection;
- if a user wants to choose a project first and start a fresh conversation later, the model has no place to store that choice.

## Approved Behavior

The approved behavior is:

1. In DM, users can switch the current project without switching the current thread.
2. If there is no current native thread binding, the selected project becomes the target project for:
   - `/ca project current`
   - `/ca thread list-current`
   - the next ordinary prompt that needs to create a fresh native Codex thread
3. If there is already a current native thread binding, that thread still remains the active conversation context.
4. Project switching is a DM-only feature for now.

## Options Considered

### Option 1: Add a DM project-selection binding separate from DM thread binding

Pros:
- Matches the approved semantics exactly.
- Does not disturb the current thread binding model.
- Keeps "choose project first, create thread later" explicit.

Cons:
- Adds another persisted DM-level state object.

### Option 2: Overload the existing DM thread binding

Pros:
- No new table or binding type.

Cons:
- Incorrect semantics: a project is not a thread.
- Would create ambiguous state and brittle special cases.

### Option 3: Create a new thread immediately when switching project

Pros:
- Reuses existing thread-based context model.

Cons:
- Rejected by the approved requirements because project switching should not create a thread immediately.

## Approved Design

Use Option 1.

### Data Model

Add a new persisted DM-level project selection record:

- `channel`
- `peer_id`
- `project_key`
- `updated_at`

This record is only used for DM contexts and is independent from `codex_window_bindings`.

### Command and Card Behavior

- Extend DM Codex project list rows with two buttons:
  - `查看线程`
  - `切换项目`
- Add `/ca project switch <projectKey>` for DM contexts backed by `codexCatalog`.
- The switch command stores the selected project and returns a "current project switched" card.

### Resolution Priority

For DM contexts:

1. If there is an active native Codex thread binding, it still defines the current project and current thread.
2. Otherwise, if there is a DM project selection binding, that selected project becomes the current project context.
3. Otherwise, DM has no current project.

### First Prompt After Project Switch

When a DM prompt arrives and:

- there is no native Codex thread binding, and
- there is a DM project selection binding,

the bridge creates a fresh native thread under the selected project's `cwd`.

## Scope Boundaries

- Only DM contexts are changed.
- Registered Feishu threads and project groups keep their current semantics.
- This change does not introduce "default thread for a project".
- Switching a project does not clear an existing native thread binding.

## Testing Strategy

Add coverage for:

- session-store persistence for DM project selection;
- `/ca project switch <projectKey>` command behavior;
- DM project list card containing both row actions;
- `/ca project current` and `/ca thread list-current` using the DM project selection when no thread is active;
- first ordinary DM prompt creating a new native thread under the selected project path;
- card action callback for `/ca project switch <projectKey>` patching the result card asynchronously.
