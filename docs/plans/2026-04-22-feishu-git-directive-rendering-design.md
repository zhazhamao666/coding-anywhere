# Feishu Git Directive Rendering Design

## Background

Feishu currently renders assistant final replies by passing the raw assistant text through the standard assistant delivery pipeline:

1. `BridgeService` returns a `BridgeReply` with `kind: "assistant"`.
2. `FeishuAdapter.replyAssistant(...)` calls `resolveFeishuAssistantMessageDelivery(text)`.
3. The delivery helper chooses either:
   - a JSON 2.0 Markdown card titled `完整回复`, or
   - a plain-text fallback when the card is too large.

This works for normal natural-language answers, but it leaks Codex desktop app directives such as:

- `::git-stage{...}`
- `::git-commit{...}`
- `::git-push{...}`
- `::git-create-branch{...}`
- `::git-create-pr{...}`

In CodexApp these directives are interpreted as hidden UI metadata. In Feishu they are currently shown as visible text, which is noisy and misleading.

The user wants Feishu to behave more like CodexApp:

- hide the raw git directives
- keep the natural-language conclusion visible
- append a compact summary such as `12 个文件已更改`
- do **not** show the concrete file list
- do **not** show `+1341 -464`

## Non-goals

- Do not reproduce the full CodexApp expandable file diff panel in Feishu.
- Do not expose per-file names.
- Do not change desktop lifecycle cards in this task.
- Do not alter the semantics of assistant prose beyond removing hidden directives.
- Do not redesign generic Feishu run-state cards or `/ca status` cards here.

## Requirements

### User-facing requirements

1. Any top-level Codex git directive lines must be hidden from Feishu-visible assistant output.
2. If hidden git directives indicate repository actions, Feishu should append a compact summary:
   - `12 个文件已更改`
3. The summary must not include:
   - file names
   - line additions/deletions
   - raw directive payloads
4. If there is no usable git summary, Feishu should still show the cleaned assistant prose without the directive lines.
5. The final result should continue to use the existing assistant delivery model:
   - Markdown card when suitable
   - plain-text fallback when oversized

### Technical requirements

1. The directive stripping logic must be structure-based, not a fragile natural-language text cleanup pass.
2. Git summary generation must be derived from directive metadata and actual repository state, not from parsing natural-language prose.
3. The change must remain scoped to Feishu assistant message delivery and must not affect CodexApp rendering or bridge-internal final text.
4. The existing 30 KB Feishu interactive-card payload guard must continue to hold.

## Current implementation analysis

### Where the leak happens

- `src/feishu-adapter.ts`
  - `replyAssistant(...)` delegates the whole final text to `resolveFeishuAssistantMessageDelivery(...)`
- `src/feishu-assistant-message.ts`
  - decides Markdown card vs plain text
  - currently treats the entire assistant text as user-visible content

That means the leak is not caused by Feishu APIs themselves; it is caused by the delivery helper not understanding Codex app directives.

### Why delivery-layer handling is the right scope

This bug is Feishu-specific presentation logic:

- CodexApp already understands these directives
- the backend still benefits from retaining the original final text internally
- only the Feishu-visible projection should suppress the directives

So the transformation should happen in the assistant-delivery layer, immediately before rendering the Feishu-visible payload.

## Approaches considered

### Approach 1: Delivery-layer directive interpretation

Add a small Codex app directive parser in the Feishu assistant delivery path.

Flow:

1. Parse top-level directive lines from the assistant final text.
2. Remove those lines from the visible text.
3. If git directives are present, inspect the referenced repository/repositories and generate a compact summary such as `12 个文件已更改`.
4. Append that summary to the visible text.
5. Feed the cleaned visible text into the existing Markdown-card / plain-text fallback pipeline.

Pros:

- smallest blast radius
- keeps original bridge reply text intact
- directly models the CodexApp behavior the user expects
- easy to test in isolation

Cons:

- requires a small amount of git inspection logic in the message-delivery layer

**Recommendation:** yes

### Approach 2: Bridge-layer final reply rewriting

Strip directives in `BridgeService.buildFinalBridgeReplies(...)` before the reply becomes `kind: "assistant"`.

Pros:

- one place earlier in the pipeline

Cons:

- broader scope than necessary
- changes all downstream consumers, not just Feishu
- mixes UI projection concerns into bridge reply assembly

**Recommendation:** no

### Approach 3: Minimal strip-only fix

Hide directive lines but do not add any replacement summary.

Pros:

- simplest implementation

Cons:

- loses useful signal that code actually changed
- does not match the user’s desired compact CodexApp-like feedback

**Recommendation:** no

## Chosen design

Use **Approach 1**: add a Feishu-only directive interpretation layer inside `resolveFeishuAssistantMessageDelivery(...)`.

## Detailed design

### 1. Directive parsing model

Add a new helper module dedicated to Codex app directives used in assistant final text.

Suggested file:

- `src/codex-app-directive.ts`

Responsibilities:

1. Parse top-level directive lines of the form:
   - `::name{...}`
2. Distinguish:
   - visible prose lines
   - hidden directive lines
3. Return structured directive objects for known git directives

Suggested parser output:

- `visibleText: string`
- `directives: ParsedCodexDirective[]`

Known directives for this task:

- `git-stage`
- `git-commit`
- `git-push`
- `git-create-branch`
- `git-create-pr`

Parser rules:

1. Only treat a line as a directive when the **trimmed whole line** matches the directive form.
2. Do not scan inside prose paragraphs or code blocks.
3. Preserve all non-directive prose exactly, aside from the normal existing Markdown-to-text normalization already done later by the delivery layer.

This keeps the logic structure-based and avoids heuristic cleanup of natural-language content.

### 2. Hidden directive policy

For Feishu-visible assistant output:

- hide all parsed git directive lines

For now, only git directives will drive summary generation.

If in the future other Codex app directives appear, the parser can recognize them as hidden metadata without forcing this task to invent user-facing summaries for them.

### 3. Git summary generation

After parsing the directives, group git directives by `cwd`.

For each affected repository, derive a compact summary from actual git state.

Rules:

1. If the hidden directives include `git-commit` for a repo:
   - inspect the current `HEAD`
   - count the number of files touched in `HEAD`
   - summary format:
     - `12 个文件已更改`

2. Else if the directives include `git-stage` but no `git-commit`:
   - inspect the staged index (`git diff --cached --name-only`)
   - count staged files
   - same summary format

3. Else if only `git-push` / `git-create-pr` / `git-create-branch` are present:
   - do not synthesize a file-change summary unless a file count can still be resolved from the same repo’s current state in a safe, deterministic way
   - for v1, prefer **no summary** over a risky guess

4. If the file count is zero or the repo cannot be inspected safely:
   - omit the summary

### 4. Multi-repo handling

Most runs touch only one repository. For v1:

- if exactly one repository produces a valid summary:
  - append `12 个文件已更改`
- if multiple repositories produce valid summaries:
  - append one line per repository using the repo basename:
    - `coding-anywhere：12 个文件已更改`
    - `obsidian：3 个文件已更改`

This avoids ambiguous aggregation across multiple repos.

### 5. Placement in the visible result

The compact summary should be appended **after** the cleaned assistant prose, separated by one blank line.

Example visible result:

```text
都通过了。当前分支就是 main，提交是 24e5edd，工作区干净；这轮已经合入主干，但还没有推远端。

12 个文件已更改
```

This keeps the conclusion first and the mechanical metadata second.

### 6. Delivery rendering behavior

Do not create a special card component just for the git summary.

Instead:

1. Build the cleaned visible text
2. Append the compact git summary text if available
3. Feed that final visible text into the existing assistant delivery pipeline

That means:

- Markdown card still works as today
- plain-text fallback still works as today
- the only difference is the user-visible content

### 7. Payload and truncation behavior

The compact summary adds only a tiny amount of text, so the current payload guard remains valid.

No special truncation is needed for the summary itself.

If the assistant result is already near the Feishu payload ceiling:

- the existing fallback rules in `src/feishu-assistant-message.ts` remain authoritative

### 8. Error handling

Git inspection must never break message delivery.

If git summary resolution fails because of:

- invalid `cwd`
- non-git directory
- missing repository
- git command failure

then:

1. log nothing user-facing
2. omit the summary
3. still send the cleaned visible assistant result

This keeps the feature additive and low-risk.

## Files to modify

### New

- `src/codex-app-directive.ts`
- `tests/codex-app-directive.test.ts`
- `tests/feishu-assistant-message.test.ts`

### Existing

- `src/feishu-assistant-message.ts`
- `src/feishu-adapter.ts` if needed for small wiring changes only
- `docs/project-full-overview.md`
- `tests/feishu-adapter.test.ts`

## Testing strategy

### Unit tests: directive parser

Verify:

1. top-level git directive lines are parsed and removed from visible text
2. non-directive prose remains unchanged
3. mixed prose + multiple directives preserves visible ordering
4. malformed directive lines are treated as plain text

### Unit tests: assistant delivery helper

Verify:

1. Markdown-card delivery hides git directives
2. cleaned visible content still renders as `完整回复`
3. single-repo `git-commit` yields `N 个文件已更改`
4. staged-only `git-stage` yields `N 个文件已更改`
5. invalid repo omits the summary but still returns cleaned text/card
6. no `+/-` stats appear
7. no file names appear

### Integration tests: Feishu adapter

Verify:

1. an assistant reply containing visible prose plus hidden git directives sends a cleaned Feishu card/text
2. the Feishu-visible result does not contain raw `::git-*` lines
3. the visible result does contain the compact change summary line when resolvable

## Rollout safety

This is a presentation-only Feishu change:

- no database migration
- no API contract change
- no change to Codex execution
- no change to desktop lifecycle state machines

The risk is low and localized to assistant final-result rendering.

## Acceptance criteria

The task is done when all of the following are true:

1. Feishu no longer shows raw `::git-*` directive lines in assistant final results.
2. When applicable, Feishu shows a compact summary such as `12 个文件已更改`.
3. Feishu does not show file names.
4. Feishu does not show `+1341 -464`.
5. Existing assistant Markdown-card / plain-text fallback behavior still passes tests.
