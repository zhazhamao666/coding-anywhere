# One-Click Startup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add double-click Windows launchers so the project can be built, started, and stopped from the repo root with one action.

**Architecture:** Keep the existing runtime model unchanged and add thin Windows launcher scripts at the repo root. Reuse the shared `scripts/startup-cleanup.mjs` cleanup behavior by introducing a small `scripts/stop.mjs` entrypoint and an `npm run stop` script.

**Tech Stack:** Windows `.cmd`, Node.js ESM scripts, npm scripts, Vitest, TypeScript documentation workflow

---

### Task 1: Lock the launcher behavior with tests

**Files:**
- Create: `tests/windows-launcher-scripts.test.ts`

**Step 1: Write the failing test**

Add tests that assert:

- `start-coding-anywhere.cmd` exists in the repo root
- it switches to `%~dp0`
- it runs `npm run build` before `npm run start`
- `stop-coding-anywhere.cmd` exists in the repo root
- it switches to `%~dp0`
- it delegates to `npm run stop`

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/windows-launcher-scripts.test.ts`
Expected: FAIL because the launcher files do not exist yet.

**Step 3: Write minimal implementation**

Create the `.cmd` launcher files so they satisfy the assertions without changing runtime behavior.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/windows-launcher-scripts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/windows-launcher-scripts.test.ts start-coding-anywhere.cmd stop-coding-anywhere.cmd
git commit -m "test: cover Windows one-click launchers"
```

### Task 2: Add a reusable stop entrypoint

**Files:**
- Modify: `package.json`
- Create: `scripts/stop.mjs`

**Step 1: Write the failing test**

Extend the launcher test to assert:

- `package.json` defines `scripts.stop`
- `scripts/stop.mjs` exists
- `scripts/stop.mjs` imports and calls the shared cleanup helper

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/windows-launcher-scripts.test.ts`
Expected: FAIL because the stop entrypoint does not exist yet.

**Step 3: Write minimal implementation**

Add `npm run stop` and a small Node script that reuses `cleanupBeforeStartup()` and logs the cleaned process ids.

**Step 4: Run test to verify it passes**

Run: `npm run test -- tests/windows-launcher-scripts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json scripts/stop.mjs tests/windows-launcher-scripts.test.ts
git commit -m "feat: add reusable Windows stop entrypoint"
```

### Task 3: Sync docs and verify

**Files:**
- Modify: `docs/project-full-overview.md`

**Step 1: Update docs**

Document the new launcher files, the new `npm run stop` command, and the intended stop behavior.

**Step 2: Run verification**

Run:

- `npm run test -- tests/windows-launcher-scripts.test.ts`
- `npm run build`

Expected: both commands succeed.

**Step 3: Commit**

```bash
git add docs/project-full-overview.md
git commit -m "docs: document one-click startup and stop flow"
```
