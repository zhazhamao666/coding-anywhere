# Feishu Codex Image Bridge Design

**Date:** 2026-03-31

## Goal

Support image interaction between Feishu and Codex in both directions:

- users can send image messages from Feishu DM or registered Feishu threads into Codex runs;
- Codex can return generated or processed image files back to Feishu as native image messages.

## Current Context

- `src/feishu-adapter.ts` only accepts inbound `text` messages and ignores all other `message_type` values.
- `src/feishu-api-client.ts` only wraps outbound `text` and `interactive` message APIs.
- `src/acpx-runner.ts` currently calls `codex exec --json` and `codex exec resume --json` without image arguments.
- `src/bridge-service.ts` assumes a prompt is a single text string and has no asset staging model.
- `docs/project-full-overview.md` still documents the bridge as text-only.
- Local CLI verification confirms both `codex exec` and `codex exec resume` support `-i, --image <FILE>`.

On the Feishu side, the latest official docs confirm:

- image messages are sent with `msg_type=image` and `content={"image_key":"..."}`;
- outbound images must be uploaded first to obtain `image_key`;
- inbound user images should be fetched through the message-resource API, not the robot-owned image-download API;
- JSON 2.0 cards render images via `img_key`.

## Options Considered

### Option 1: OCR or caption-first fallback

Convert every inbound image to text first, then keep the bridge text-only.

Pros:
- Smallest surface-area change.
- Avoids attachment persistence and outbound media handling.

Cons:
- Throws away Codex's native multimodal input path.
- Loses detail on screenshots, charts, layouts, and visual diffs.
- Still does not solve Codex-to-Feishu image replies.

### Option 2: Native image ingress plus directive-based image egress

Download inbound Feishu images locally, pass them to `codex exec/resume --image`, and let Codex request outbound images through a bridge-only directive block.

Pros:
- Uses Codex's existing native image input support.
- Keeps the bridge's current thread/run architecture intact.
- Gives us a clear, auditable contract for outbound images.
- Extends naturally from the existing bridge plan-directive parsing pattern.

Cons:
- Requires asset persistence, path validation, and cleanup.
- Adds a new bridge-private output protocol for image replies.

### Option 3: General attachment bus for image, file, audio, and video

Build a single attachment framework for every Feishu media type before shipping image support.

Pros:
- Best long-term architecture.
- One abstraction for all future media work.

Cons:
- Too much scope for the current requirement.
- Slows down image support on a path where Feishu and Codex already have enough primitives.

## Approved Design

Use Option 2, but keep the first deliverable narrow: image-only media support, no generic file/audio abstraction yet.

### 1. Inbound model

- Accept Feishu `image` messages in DM and registered thread surfaces.
- Parse image-message content to extract the Feishu image resource key.
- Download the binary through the official message-resource API using the inbound `message_id` and `type=image`.
- Store the downloaded file in a bridge-managed asset directory outside the repo working tree.
- Persist metadata in SQLite so the bridge can survive process restarts and clean up stale assets.

### 2. Pending-image staging

Feishu users commonly send images and text as separate messages. We should not auto-run Codex on every image-only message.

For v1:

- an image-only inbound message becomes a pending asset on the current surface;
- the bridge replies with a lightweight acknowledgment telling the user to send the follow-up text prompt;
- the next normal text message on the same surface consumes all pending images and submits one Codex run containing:
  - the user text;
  - the image files passed through `--image`;
  - a small bridge attachment manifest in the prompt envelope.

This keeps the UX aligned with real Feishu chat behavior and avoids accidental token waste.

### 3. Codex execution contract

- Extend `AcpxRunner.createThread(...)` and `submitVerbatim(...)` to accept `images?: string[]`.
- When images exist, map them to repeated `codex exec/resume -i <file>` arguments.
- Keep the existing JSONL parsing path unchanged.
- Add attachment metadata into the bridge prompt envelope so Codex knows how many images were provided and what they represent.

### 4. Outbound image contract

Codex has native image input support, but the current bridge only consumes assistant text. To support Codex-to-Feishu images safely, introduce a bridge-private directive block in the final assistant text:

```text
[bridge-image]
{"images":[{"path":"D:/.../artifact/result.png","caption":"处理后的示意图"}]}
[/bridge-image]
```

The bridge will:

- parse and strip the directive from the visible assistant message;
- validate that each referenced path exists and is allowed to leave the machine;
- upload each image to Feishu to get an `image_key`;
- send native image messages back to the original Feishu surface;
- continue sending visible text output using the current summary-card plus text-message model.

For v1, only files under the current run `cwd` or the bridge-managed asset directory are eligible for outbound image replies.

### 5. Storage and lifecycle

Add a surface-scoped pending-asset model with statuses such as:

- `pending`
- `consumed`
- `sent`
- `failed`
- `expired`

Each stored asset should record:

- owning surface (`channel`, `peerId`, `chatId`, `surfaceType`, `surfaceRef`)
- source `message_id`
- Feishu resource key
- local file path
- mime type or extension
- file size
- related `run_id` when consumed
- timestamps and expiry

Cleanup should run on startup and on a timer, similar in spirit to thread idle cleanup.

### 6. Delivery behavior

- DM output still sends directly to the user.
- Thread output still replies inside the original thread.
- Image replies are sent as native image messages, not embedded in progress cards.
- Existing progress/status cards remain text-only in v1.

### 7. Scope cuts for v1

These stay out of the first implementation:

- generic file/audio/video bridge support;
- image selection buttons or inline card actions for pending attachments;
- automatic OCR preprocessing;
- card-embedded image previews for progress cards;
- multi-image albums with custom layout logic.

V1 should prefer predictable native image messages over decorative card behavior.

## Why This Design

- It aligns with Codex's existing CLI capability instead of building a lossy text-only workaround.
- It matches Feishu's official media model: upload-first for outbound images, message-resource fetch for inbound images.
- It reuses established bridge patterns:
  - surface-scoped persistence;
  - assistant text post-processing;
  - asynchronous final delivery after a run completes.
- It avoids the biggest UX trap: triggering full Codex runs on attachment-only chat messages.

## Impact

- `src/feishu-adapter.ts` will become a multimodal ingress layer instead of a text gate.
- `src/feishu-api-client.ts` will need explicit image upload and message-resource download support.
- `src/bridge-service.ts` will gain pending-asset orchestration and outbound attachment delivery.
- `src/acpx-runner.ts` will become image-aware for both create and resume execution.
- `src/workspace/session-store.ts` will need new persistence for pending bridge assets.
- `docs/project-full-overview.md` and `docs/feishu-setup.md` must be updated after implementation.

## Risks and Controls

### Arbitrary file exfiltration

Risk:
- Codex could emit a bridge-image directive pointing at unrelated local files.

Control:
- only allow outbound image paths under the current run `cwd` or the bridge asset directory;
- reject all other paths with a visible fallback text warning.

### Repo pollution

Risk:
- inbound images or generated artifacts end up inside the repository and get picked up by git.

Control:
- keep downloaded inbound assets in a dedicated bridge storage directory outside repo roots;
- only allow repo-local outbound paths when the file is intentionally generated by the task.

### Oversized media

Risk:
- Feishu upload rejects images over 10 MB.

Control:
- validate size before upload;
- optionally downscale in a later iteration;
- for v1, fail fast with a readable error and leave the text response intact.

### Surface confusion

Risk:
- pending images from one DM/thread get consumed by another surface.

Control:
- key all pending assets by the same surface identity model already used by the bridge.

## Testing Strategy

- Add storage tests for pending asset persistence and consumption.
- Add adapter tests for image-message intake without regressing text routing.
- Add runner tests proving `--image` arguments are forwarded to both create and resume.
- Add bridge tests for:
  - image-only message staging;
  - next-text consumption;
  - outbound bridge-image directive parsing and validation.
- Add API client tests for image upload and message-resource download wrappers.
- Run targeted tests first, then full `vitest`, then `tsc`.
