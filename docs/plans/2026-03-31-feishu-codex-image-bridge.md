# Feishu Codex Image Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add image support to the Feishu-to-Codex bridge so inbound Feishu images can be passed to Codex runs and outbound Codex-generated images can be returned to Feishu safely.

**Architecture:** Treat inbound images as surface-scoped pending assets rather than immediately executing runs on image-only messages. Extend the bridge execution path to pass pending images into `codex exec/resume --image`, then add a small bridge-private assistant directive for outbound image replies that are uploaded and sent back as native Feishu image messages.

**Tech Stack:** TypeScript, Vitest, SQLite (`better-sqlite3`), Feishu OpenAPI via `@larksuiteoapi/node-sdk`, Codex CLI `exec/resume`.

---

### Task 1: Add persistent pending-image asset storage

**Files:**
- Modify: `src/types.ts`
- Modify: `src/workspace/session-store.ts`
- Test: `tests/session-store.test.ts`
- Test: `tests/session-store-project-thread.test.ts`

**Step 1: Write the failing test**

Add tests that lock the storage contract for pending image assets:
- save a pending inbound image asset for a DM surface;
- list pending assets for that exact surface only;
- mark assets as consumed when a run starts;
- ignore assets from other surfaces;
- expire stale assets during cleanup.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session-store.test.ts tests/session-store-project-thread.test.ts`

Expected: FAIL because no pending image asset table or storage API exists yet.

**Step 3: Write minimal implementation**

Update `src/types.ts` and `src/workspace/session-store.ts` to add:
- a `BridgeAssetRecord` type;
- migration(s) for a pending asset table;
- helpers to save, list, consume, fail, and expire surface-scoped assets.

Do not add generic file/audio support yet; keep the schema image-focused but future-safe.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session-store.test.ts tests/session-store-project-thread.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/types.ts src/workspace/session-store.ts tests/session-store.test.ts tests/session-store-project-thread.test.ts
git commit -m "feat: persist pending feishu image assets"
```

### Task 2: Accept Feishu image messages and download their binaries

**Files:**
- Modify: `src/feishu-adapter.ts`
- Modify: `src/feishu-api-client.ts`
- Modify: `src/types.ts`
- Test: `tests/feishu-adapter.test.ts`
- Test: `tests/feishu-api-client.test.ts`
- Test: `tests/feishu-group-routing.test.ts`

**Step 1: Write the failing test**

Add tests for three behaviors:
- inbound `message_type=image` is no longer dropped;
- the adapter asks the API client to download the message resource for that image;
- image-only messages do not launch a Codex run immediately and instead produce a lightweight acknowledgment.

Keep existing text-message behavior unchanged.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/feishu-adapter.test.ts tests/feishu-api-client.test.ts tests/feishu-group-routing.test.ts`

Expected: FAIL because the adapter currently hard-rejects non-text messages and the API client has no image/resource methods.

**Step 3: Write minimal implementation**

Update `src/feishu-api-client.ts` to add explicit wrappers for:
- downloading a message resource with `type=image`;
- uploading outbound images;
- sending or replying with native image messages.

Update `src/feishu-adapter.ts` so image events:
- parse the image key from Feishu content;
- download the image to a bridge-managed asset path;
- persist it as a pending surface asset;
- send a short acknowledgment instead of triggering a run.

Keep v1 acknowledgment simple; do not add card buttons yet.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/feishu-adapter.test.ts tests/feishu-api-client.test.ts tests/feishu-group-routing.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/feishu-adapter.ts src/feishu-api-client.ts src/types.ts tests/feishu-adapter.test.ts tests/feishu-api-client.test.ts tests/feishu-group-routing.test.ts
git commit -m "feat: accept inbound feishu image messages"
```

### Task 3: Pass pending images into Codex create and resume runs

**Files:**
- Modify: `src/acpx-runner.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/types.ts`
- Test: `tests/acpx-runner.test.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/run-delivery-targets.test.ts`

**Step 1: Write the failing test**

Add tests that verify:
- `AcpxRunner.createThread(...)` forwards repeated `-i` flags to `codex exec`;
- `AcpxRunner.submitVerbatim(...)` forwards repeated `-i` flags to `codex exec resume`;
- `BridgeService` consumes pending surface images when the next text prompt arrives;
- once consumed, those pending images are not reused by later prompts.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/acpx-runner.test.ts tests/bridge-service.test.ts tests/run-delivery-targets.test.ts`

Expected: FAIL because the runner and bridge currently only know about text prompts.

**Step 3: Write minimal implementation**

Update `src/acpx-runner.ts` to accept `images?: string[]` in create/resume execution helpers and map them to CLI `-i` arguments.

Update `src/bridge-service.ts` to:
- read pending image assets for the current surface before routing a text prompt;
- add a small bridge attachment manifest to the prompt envelope;
- consume those assets when the run is accepted for execution;
- leave text-only flows unchanged when there are no pending images.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/acpx-runner.test.ts tests/bridge-service.test.ts tests/run-delivery-targets.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/acpx-runner.ts src/bridge-service.ts src/types.ts tests/acpx-runner.test.ts tests/bridge-service.test.ts tests/run-delivery-targets.test.ts
git commit -m "feat: pass staged images into codex runs"
```

### Task 4: Add outbound bridge-image directives and Feishu image replies

**Files:**
- Create: `src/bridge-image-directive.ts`
- Modify: `src/bridge-service.ts`
- Modify: `src/feishu-api-client.ts`
- Modify: `src/feishu-adapter.ts`
- Test: `tests/bridge-service.test.ts`
- Test: `tests/feishu-api-client.test.ts`
- Test: `tests/feishu-adapter.test.ts`

**Step 1: Write the failing test**

Add tests that verify:
- the bridge parses `[bridge-image] ... [/bridge-image]` blocks from assistant output;
- the visible assistant text no longer contains the raw directive;
- only allowed paths are uploaded and sent;
- invalid or disallowed paths degrade to a readable text fallback instead of silently failing.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge-service.test.ts tests/feishu-api-client.test.ts tests/feishu-adapter.test.ts`

Expected: FAIL because outbound image directives are not parsed or delivered today.

**Step 3: Write minimal implementation**

Create `src/bridge-image-directive.ts` to parse and strip the bridge-private directive block.

Update `src/bridge-service.ts` so final assistant output can produce:
- zero or more outbound image replies;
- the cleaned assistant text reply.

Update `src/feishu-api-client.ts` and `src/feishu-adapter.ts` so those image replies are uploaded and delivered as native Feishu image messages in DM and thread contexts.

Validate all outbound file paths against:
- the current run `cwd`;
- the bridge-managed asset directory.

Reject everything else.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bridge-service.test.ts tests/feishu-api-client.test.ts tests/feishu-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/bridge-image-directive.ts src/bridge-service.ts src/feishu-api-client.ts src/feishu-adapter.ts tests/bridge-service.test.ts tests/feishu-api-client.test.ts tests/feishu-adapter.test.ts
git commit -m "feat: return codex images to feishu"
```

### Task 5: Wire cleanup, docs, and full verification

**Files:**
- Modify: `src/runtime.ts`
- Modify: `docs/project-full-overview.md`
- Modify: `docs/feishu-setup.md`
- Create: `docs/plans/2026-03-31-feishu-codex-image-bridge-design.md`
- Create: `docs/plans/2026-03-31-feishu-codex-image-bridge.md`
- Test: `tests/runtime.test.ts`

**Step 1: Write the failing test**

Add runtime-level coverage that proves any required cleanup hooks or injected dependencies for asset expiration are wired correctly.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime.test.ts`

Expected: FAIL until runtime wiring covers the new image-asset lifecycle.

**Step 3: Write minimal implementation**

Update `src/runtime.ts` to initialize any image-asset cleanup path needed by the new storage model.

Update docs so they accurately describe:
- image support scope;
- staging behavior for image-only messages;
- new Feishu API usage and permissions expectations;
- recommended validation steps.

**Step 4: Run targeted verification**

Run: `npx vitest run tests/session-store.test.ts tests/feishu-adapter.test.ts tests/feishu-api-client.test.ts tests/acpx-runner.test.ts tests/bridge-service.test.ts tests/runtime.test.ts`

Expected: PASS.

**Step 5: Run compile verification**

Run: `npx tsc -p tsconfig.json --pretty false`

Expected: exit code 0.

**Step 6: Run full verification**

Run: `npx vitest run`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/runtime.ts docs/project-full-overview.md docs/feishu-setup.md docs/plans/2026-03-31-feishu-codex-image-bridge-design.md docs/plans/2026-03-31-feishu-codex-image-bridge.md tests/runtime.test.ts
git commit -m "feat: add feishu codex image bridge"
```
