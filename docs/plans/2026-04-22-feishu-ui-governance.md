# Feishu UI Governance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Feishu card and backend UI stack around a single card contract, a protocol-correct callback model, and aligned state language.

**Architecture:** Add a shared Feishu card model/frame layer, classify callback actions into three explicit update modes, and migrate existing navigation, run, and desktop cards onto that frame. Extend the Feishu API client for delayed card updates, preserve long-run streaming by spawning a fresh progress message, and align `/ops/ui` status vocabulary with the Feishu surface.

**Tech Stack:** TypeScript, Fastify, Vitest, `@larksuiteoapi/node-sdk`, Feishu card JSON 2.0, Feishu `card.action.trigger`

---

### Task 1: Lock The New Callback Contract In Tests

**Files:**
- Modify: `tests/feishu-card-action-service.test.ts`
- Modify: `tests/feishu-ws-client.test.ts`
- Modify: `tests/feishu-adapter.test.ts`

**Step 1: Write the failing tests for three callback modes**

Add targeted cases that prove:

```ts
it("returns a raw card inline for inline_replace actions", async () => {
  expect(result).toMatchObject({
    card: {
      type: "raw",
      data: expect.objectContaining({
        schema: "2.0",
      }),
    },
  });
});

it("returns toast or empty body and uses interaction token for token_finalize actions", async () => {
  expect(result).toMatchObject({
    toast: expect.any(Object),
  });
  expect(apiClient.delayUpdateInteractiveCard).toHaveBeenCalledWith(
    expect.objectContaining({ token: "c-token-demo" }),
  );
});

it("returns toast or empty body and creates a fresh progress card message for spawn_run_message actions", async () => {
  expect(result).toMatchObject({
    toast: expect.any(Object),
  });
  expect(apiClient.updateInteractiveCard).not.toHaveBeenCalledWith(
    "om_clicked_card",
    expect.anything(),
  );
});
```

**Step 2: Run the targeted tests and verify they fail**

Run: `npx vitest run tests/feishu-card-action-service.test.ts tests/feishu-ws-client.test.ts tests/feishu-adapter.test.ts`

Expected: FAIL with missing delayed-update API / missing callback mode behavior / missing normalized fields.

**Step 3: Commit the failing-test checkpoint**

Run:

```bash
git add tests/feishu-card-action-service.test.ts tests/feishu-ws-client.test.ts tests/feishu-adapter.test.ts
git commit -m "test: lock feishu callback governance contract"
```

### Task 2: Add Delayed-Update API Support And Richer Callback Payloads

**Files:**
- Modify: `src/feishu-api-client.ts`
- Modify: `src/feishu-adapter.ts`
- Modify: `src/feishu-ws-client.ts`
- Modify: `src/types.ts`
- Test: `tests/feishu-ws-client.test.ts`
- Test: `tests/feishu-api-client.test.ts`

**Step 1: Implement the delayed-update API in the Feishu API client**

Add a method shaped like:

```ts
public async delayUpdateInteractiveCard(input: {
  token: string;
  card: Record<string, unknown>;
}): Promise<void>
```

The implementation should call:

- `POST /interactive/v1/card/update`
- body `{ token, card }`

Keep JSON 2.0 as the only supported output structure.

**Step 2: Expand the normalized callback payload**

Extend the normalized event shape to preserve:

```ts
open_chat_id?: string;
options?: string[];
checked?: boolean;
input_value?: string;
```

Read those fields from the new `card.action.trigger` payload structure and keep backward-compatible fallbacks where needed.

**Step 3: Run focused tests**

Run: `npx vitest run tests/feishu-ws-client.test.ts tests/feishu-api-client.test.ts`

Expected: PASS

**Step 4: Commit**

Run:

```bash
git add src/feishu-api-client.ts src/feishu-adapter.ts src/feishu-ws-client.ts src/types.ts tests/feishu-ws-client.test.ts tests/feishu-api-client.test.ts
git commit -m "feat: add feishu delayed card update support"
```

### Task 3: Build The Shared Card Frame And Action Contract

**Files:**
- Create: `src/feishu-card/card-model.ts`
- Create: `src/feishu-card/card-frame-builder.ts`
- Create: `src/feishu-card/card-action-contract.ts`
- Modify: `src/feishu-card/navigation-card-builder.ts`
- Modify: `src/feishu-card/card-builder.ts`
- Modify: `src/feishu-card/desktop-completion-card-builder.ts`
- Modify: `src/bridge-service.ts`
- Test: `tests/feishu-card-builder.test.ts`
- Test: `tests/desktop-completion-card-builder.test.ts`

**Step 1: Define the shared view model**

Create a shared model close to:

```ts
export interface FeishuCardModel {
  title: string;
  template?: "blue" | "green" | "orange" | "red" | "grey";
  summary: string;
  facts: Array<{ label: string; value: string }>;
  sections: Array<{ title: string; items: string[] }>;
  controls?: CardControl[];
  actions?: CardAction[];
}
```

**Step 2: Implement a common JSON 2.0 frame renderer**

Move repeated `header / summary / hr / column_set / action row` construction into a single builder.

**Step 3: Migrate builders onto the shared frame**

Refactor:

- navigation cards
- progress / run cards
- desktop lifecycle cards

so they generate `FeishuCardModel` first, JSON second.

**Step 4: Remove duplicated Codex settings control rendering**

Delete the second copy of the Codex settings control builder and route all preference controls through the shared frame layer.

**Step 5: Run focused builder tests**

Run: `npx vitest run tests/feishu-card-builder.test.ts tests/desktop-completion-card-builder.test.ts`

Expected: PASS

**Step 6: Commit**

Run:

```bash
git add src/feishu-card/card-model.ts src/feishu-card/card-frame-builder.ts src/feishu-card/card-action-contract.ts src/feishu-card/navigation-card-builder.ts src/feishu-card/card-builder.ts src/feishu-card/desktop-completion-card-builder.ts src/bridge-service.ts tests/feishu-card-builder.test.ts tests/desktop-completion-card-builder.test.ts
git commit -m "refactor: unify feishu card frame and actions"
```

### Task 4: Rework Card Actions Around Three Explicit Update Modes

**Files:**
- Modify: `src/feishu-card-action-service.ts`
- Modify: `src/feishu-card/streaming-card-controller.ts`
- Modify: `src/feishu-adapter.ts`
- Test: `tests/feishu-card-action-service.test.ts`
- Test: `tests/streaming-card-controller.test.ts`
- Test: `tests/feishu-adapter.test.ts`

**Step 1: Implement callback mode routing**

Add explicit branches for:

```ts
type CardCallbackMode =
  | "inline_replace"
  | "token_finalize"
  | "spawn_run_message";
```

Suggested mapping:

- `open_plan_form`, quick navigation refresh, quick preference changes -> `inline_replace`
- `new`, `thread switch`, `thread create-current`, other bounded async card commands -> `token_finalize`
- `submit_plan_form`, `answer_plan_choice` -> `spawn_run_message`

**Step 2: Stop patching the clicked card for long-running actions**

When the callback mode is `spawn_run_message`:

- return toast or empty body
- create a fresh progress message
- let the progress controller own that new message

Do not call `updateInteractiveCard(clickedMessageId, ...)` for that chain.

**Step 3: Use delayed-update token for bounded async actions**

When the callback mode is `token_finalize`:

- respond first
- finish background work
- call `delayUpdateInteractiveCard({ token, card })`

**Step 4: Run focused tests**

Run: `npx vitest run tests/feishu-card-action-service.test.ts tests/streaming-card-controller.test.ts tests/feishu-adapter.test.ts`

Expected: PASS

**Step 5: Commit**

Run:

```bash
git add src/feishu-card-action-service.ts src/feishu-card/streaming-card-controller.ts src/feishu-adapter.ts tests/feishu-card-action-service.test.ts tests/streaming-card-controller.test.ts tests/feishu-adapter.test.ts
git commit -m "refactor: split feishu card callback update modes"
```

### Task 5: Align `/ops/ui` With Feishu State Language

**Files:**
- Create: `src/ui/runtime-status.ts`
- Modify: `src/app.ts`
- Modify: `src/bridge-service.ts`
- Test: `tests/app.test.ts`

**Step 1: Introduce shared status metadata**

Add a small shared status map:

```ts
export const RUNTIME_STATUS_META = {
  queued: { label: "已接收", tone: "default", terminal: false },
  preparing: { label: "准备中", tone: "default", terminal: false },
  running: { label: "处理中", tone: "default", terminal: false },
  tool_active: { label: "工具执行中", tone: "warn", terminal: false },
  canceling: { label: "停止中", tone: "warn", terminal: false },
  done: { label: "已完成", tone: "success", terminal: true },
  error: { label: "失败", tone: "danger", terminal: true },
  canceled: { label: "已停止", tone: "muted", terminal: true },
};
```

**Step 2: Update `/ops/ui` labels and ordering**

Change the page so it foregrounds:

- 当前项目
- 当前线程
- 当前状态
- 最近摘要

instead of raw internal wording.

**Step 3: Run the targeted test**

Run: `npx vitest run tests/app.test.ts`

Expected: PASS

**Step 4: Commit**

Run:

```bash
git add src/ui/runtime-status.ts src/app.ts src/bridge-service.ts tests/app.test.ts
git commit -m "refactor: align ops ui with feishu status language"
```

### Task 6: Update Docs And Run Full Verification

**Files:**
- Modify: `docs/project-full-overview.md`
- Modify: `docs/feishu-setup.md`
- Modify: `docs/plans/2026-04-22-feishu-ui-governance-design.md` (only if implementation drifted)

**Step 1: Update the project overview**

Document the new callback split explicitly:

- immediate inline card replacement
- delayed final update via interaction token
- long-run actions that spawn a fresh progress message

Also update the UI architecture section to mention the shared card frame.

**Step 2: Update Feishu setup / ops notes if needed**

Keep the callback version and JSON 2.0 assumptions explicit.

**Step 3: Run the full targeted verification set**

Run:

```bash
npx vitest run tests/feishu-card-builder.test.ts tests/desktop-completion-card-builder.test.ts tests/feishu-card-action-service.test.ts tests/feishu-ws-client.test.ts tests/feishu-adapter.test.ts tests/streaming-card-controller.test.ts tests/app.test.ts
npx tsc -p tsconfig.json --pretty false
```

Expected:

- All targeted Vitest suites PASS
- TypeScript compile exits with code 0

**Step 4: Run the broader safety suite**

Run: `npx vitest run`

Expected: PASS

**Step 5: Commit the final implementation**

Run:

```bash
git add docs/project-full-overview.md docs/feishu-setup.md
git commit -m "refactor: govern feishu ui and callback flows"
```

