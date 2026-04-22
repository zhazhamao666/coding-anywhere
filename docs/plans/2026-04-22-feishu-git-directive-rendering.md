# Feishu Git Directive Rendering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Hide Codex git directives from Feishu assistant results and replace them with a compact `N 个文件已更改` summary without showing file names or `+/-` stats.

**Architecture:** Add a Feishu-only Codex app directive parser and git summary resolver inside the assistant message delivery layer. Keep bridge reply assembly unchanged; only the Feishu-visible projection is transformed before Markdown-card / plain-text delivery.

**Tech Stack:** TypeScript, Vitest, Node.js child-process git inspection, Feishu JSON 2.0 interactive cards

---

### Task 1: Add directive-parser tests

**Files:**
- Create: `tests/codex-app-directive.test.ts`
- Create: `src/codex-app-directive.ts`

**Step 1: Write the failing test**

Add tests that assert:

- top-level `::git-stage{...}` lines are removed from visible text
- multiple directive lines are parsed as structured metadata
- malformed lines remain visible text

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex-app-directive.test.ts
```

Expected:

- FAIL because `src/codex-app-directive.ts` does not exist yet

**Step 3: Write minimal implementation**

Implement:

- top-level directive line detection
- visible-text reconstruction
- structured git directive extraction

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/codex-app-directive.test.ts
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add tests/codex-app-directive.test.ts src/codex-app-directive.ts
git commit -m "test: add codex app directive parser"
```

### Task 2: Add assistant-delivery tests for hidden git directives

**Files:**
- Create: `tests/feishu-assistant-message.test.ts`
- Modify: `src/feishu-assistant-message.ts`

**Step 1: Write the failing test**

Add tests for:

- Markdown-card delivery hides raw `::git-*` lines
- visible text keeps the natural-language conclusion
- appends `N 个文件已更改`
- does not include file names
- does not include `+/-` stats

Use a temporary git repo fixture:

- initialize repo
- create and commit files for `git-commit` scenarios
- create staged changes for `git-stage` scenarios

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/feishu-assistant-message.test.ts
```

Expected:

- FAIL because delivery helper still returns raw directives

**Step 3: Write minimal implementation**

In `src/feishu-assistant-message.ts`:

- preprocess assistant text through the directive parser
- resolve compact git summary from repo state
- append summary to the visible text
- continue to use existing Markdown-card / plain-text fallback rules

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/feishu-assistant-message.test.ts
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add tests/feishu-assistant-message.test.ts src/feishu-assistant-message.ts
git commit -m "feat: hide git directives in Feishu replies"
```

### Task 3: Add adapter-level regression coverage

**Files:**
- Modify: `tests/feishu-adapter.test.ts`

**Step 1: Write the failing test**

Add an adapter integration test where `BridgeService` returns:

```text
都通过了。当前分支就是 main。
::git-stage{cwd="..."}
::git-commit{cwd="..."}
```

Assert that Feishu receives:

- no raw directive lines
- the visible prose
- `N 个文件已更改`

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/feishu-adapter.test.ts
```

Expected:

- FAIL because adapter delivery still shows raw directives

**Step 3: Write minimal implementation**

If needed, do only small wiring updates so adapter uses the enhanced assistant delivery helper without changing its public behavior.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/feishu-adapter.test.ts
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add tests/feishu-adapter.test.ts src/feishu-adapter.ts
git commit -m "test: cover Feishu git directive rendering"
```

### Task 4: Update project overview

**Files:**
- Modify: `docs/project-full-overview.md`

**Step 1: Update documentation**

Document:

- Feishu assistant final-result rendering now strips hidden Codex git directives
- Feishu may append a compact `N 个文件已更改` summary
- file names and `+/-` stats are intentionally omitted

**Step 2: Review for accuracy**

Check that all references to assistant final-result rendering remain correct after this change.

**Step 3: Commit**

```bash
git add docs/project-full-overview.md
git commit -m "docs: sync Feishu git directive rendering"
```

### Task 5: Run full verification

**Files:**
- No code changes unless verification uncovers issues

**Step 1: Run focused tests**

Run:

```bash
npm test -- tests/codex-app-directive.test.ts tests/feishu-assistant-message.test.ts tests/feishu-adapter.test.ts
```

Expected:

- PASS

**Step 2: Run broader Feishu rendering regressions**

Run:

```bash
npm test -- tests/feishu-card-builder.test.ts tests/bridge-service.test.ts tests/runtime.test.ts
```

Expected:

- PASS

**Step 3: Run build**

Run:

```bash
npm run build
```

Expected:

- PASS

**Step 4: Commit any final fixes**

```bash
git add <updated files>
git commit -m "fix: finalize Feishu git directive rendering"
```

### Task 6: Final verification summary

**Files:**
- No changes expected

**Step 1: Confirm worktree state**

Run:

```bash
git status --short
```

Expected:

- clean worktree

**Step 2: Prepare close-out summary**

Report:

- hidden directives are no longer shown in Feishu
- compact file-change summary is shown when resolvable
- no file names or `+/-` stats are exposed
- tests and build passed
