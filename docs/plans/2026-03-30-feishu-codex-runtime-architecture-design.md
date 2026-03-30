# Feishu Codex Runtime Architecture Design

**Date:** 2026-03-30

**Goal:** Decide which runtime path should power a Feishu client that aims to provide a Codex-App-like interaction model, and record the evidence behind each conclusion.

## Scope

This document compares four runtime paths:

1. `codex exec` / `codex exec resume`
2. `acpx` / ACP-style external harness control
3. `codex app-server` / Codex SDK
4. Real interactive Codex CLI terminal hosting

The target product experience includes:

- image input
- plan mode
- model switching
- reasoning-effort selection
- quota / usage visibility
- cancel current request and resend
- worktree handoff
- thread/session derivation

## Source Policy

This document separates:

- **Evidence**: directly supported by official or community source material
- **Inference**: a reasoned conclusion drawn from those sources when no source states the answer verbatim

The source index is at the end of the document.

## Route Definitions

### 1. `codex exec` / `codex exec resume`

This is the official non-interactive Codex CLI path. It supports one-shot execution, JSONL events, `resume`, image attachments, model override, and output shaping.

**Evidence**

- OpenAI documents `codex exec` as non-interactive mode with JSONL output and `resume` support. `[S1]`
- Local CLI help on 2026-03-30 confirms `codex exec --json`, `codex exec resume`, `--image`, and `-m/--model` are available.

### 2. `acpx` / ACP external harness control

This is the community pattern used by tools such as OpenClaw and `codex-acp`: keep a long-lived session, then control it through a session protocol instead of only sending one-shot prompts.

**Evidence**

- OpenClaw ACP agents expose `spawn`, `cancel`, `steer`, `status`, `set-mode`, `cwd`, `model`, `sessions`, and session loading. `[S6]`
- Community Codex ACP adapters expose capabilities such as session creation/loading, cancel, status, TODO lists, images, and selected slash commands. `[S9]` `[S10]`

### 3. `codex app-server` / Codex SDK

This is the official rich-client integration path. `app-server` exposes thread, turn, model, and request-user-input primitives; the SDK is the programmatic API surface built for Codex integrations.

**Evidence**

- OpenAI describes `codex app-server` as the interface used to power rich clients and documents `thread/*`, `turn/*`, `model/list`, `tool/requestUserInput`, and `collaborationMode/list`. `[S2]`
- OpenAI describes the Codex SDK as a more comprehensive and flexible option than non-interactive mode. `[S3]`

### 4. Real interactive Codex CLI terminal hosting

This path runs the real interactive Codex CLI in a persistent terminal or tmux session and automates it externally.

**Evidence**

- Official Codex CLI slash commands include `/plan`, `/status`, and model-related controls in the interactive client. `[S4]` `[S5]`
- Community projects such as `codex-cli-farm` manage long-lived Codex CLI sessions in tmux and rely on prompt parsing / best-effort readiness detection. `[S12]`

## Capability Matrix

Ratings:

- **Strong**: directly supported and well aligned with the target UX
- **Partial**: possible, but adapter-specific, incomplete, or mismatched with Codex App semantics
- **Weak**: only approximated through wrappers or one-off workarounds

| Capability | `exec` / `resume` | `acpx` / ACP | `app-server` / SDK | Interactive terminal hosting |
| --- | --- | --- | --- | --- |
| Basic multi-turn conversation | Strong | Strong | Strong | Strong |
| Image input | Strong | Strong | Strong | Strong |
| Status panel / `/status`-like output | Partial | Strong | Partial | Strong |
| Plan mode with follow-up interaction | Weak | Partial | Strong | Strong |
| Model switching | Weak | Partial | Strong | Strong |
| Reasoning-effort selection | Weak | Partial | Strong | Partial |
| Quota / usage visibility | Weak | Partial to Strong | Weak | Partial |
| Cancel in-flight turn | Weak | Strong | Strong | Strong |
| Roll back last completed turn and resend | Weak | Weak | Strong | Weak |
| Worktree handoff | Weak | Partial | Partial | Partial |
| Native thread/session fork | Weak | Weak to Partial | Strong | Partial |
| Alignment with official Codex App semantics | Low | Medium | High | Medium |
| Operational stability | High | Medium | High | Low |

## Requirement-by-Requirement Conclusions

### Image Input

**Conclusion:** `exec`, ACP, and `app-server` can all support user-to-Codex image input. Returning an image back to Feishu is primarily a bridge/media concern, not a runtime-path differentiator.

**Evidence**

- Official `codex exec` supports `--image`. `[S1]`
- `zed-industries/codex-acp` explicitly lists image support. `[S9]`
- OpenClaw CLI backends document image passthrough for supported providers. `[S8]`
- Official model metadata in the Codex docs include image input modalities. `[S2]`

### Plan Mode

**Conclusion:** ACP can provide a plan-mode experience, but the strongest official substrate for Codex-App-like plan mode is `app-server`.

**Evidence**

- `/plan` is an official interactive Codex CLI slash command. `[S4]`
- OpenClaw ACP agents support `set-mode plan`. `[S6]`
- OpenClaw ACP bridge compatibility marks session modes as partial and session plans / thought streaming as unsupported. `[S7]`
- `zed-industries/codex-acp` supports TODO lists but does not advertise `/plan` as a standard exposed slash command. `[S9]`
- `app-server` exposes `tool/requestUserInput` and collaboration modes, which are the official primitives most closely matching rich plan-mode interaction. `[S2]`

**Inference**

- No source states verbatim that `collaborationMode/list + tool/requestUserInput` is "the implementation of Codex plan mode", but it is the strongest official rich-client control surface currently documented.
- No mainstream ACP adapter in the reviewed sources clearly documents a full-fidelity passthrough of native Codex `/plan`.

### Model Switching

**Conclusion:** ACP can support model switching in some stacks, but `app-server` is the only reviewed path with a clean, official, model-catalog-oriented answer.

**Evidence**

- OpenClaw ACP agents expose a `model` command. `[S6]`
- `cola-io/codex-acp` exposes `session/setModel`, but its README says OpenAI builtin providers do not support model switching there; it is intended for custom providers. `[S10]`
- `app-server` exposes `model/list`. `[S2]`
- Codex App settings and commands expose model-related controls in the official client. `[S5]`

### Reasoning Effort

**Conclusion:** ACP can express some mode/thinking controls, but `app-server` is the clearest path for a proper model-aware reasoning-effort picker.

**Evidence**

- OpenClaw documents slash-command controls such as `/think` and `/reasoning`, and ACP mode controls include plan/auto/manual style behavior. `[S6]` `[S11]`
- `cola-io/codex-acp` status output includes reasoning-effort information. `[S10]`
- `app-server` model metadata include `supportedReasoningEfforts`. `[S2]`
- Codex App settings document agent configuration including model and effort. `[S5]`

**Inference**

- ACP can expose "reasoning-like" controls, but those controls are not consistently documented as the same canonical model capability surface that `app-server` provides.

### Quota / Usage Visibility

**Conclusion:** ACP/OpenClaw is stronger for provider-usage visibility today. Official `app-server` is stronger for thread/turn control, but the reviewed official docs do not expose an equivalent provider-quota API.

**Evidence**

- OpenClaw usage tracking docs state that quota/usage data is collected from provider usage endpoints, including OpenAI Codex OAuth. `[S13]`
- OpenClaw CLI docs expose `/status` and `status --usage`. `[S11]`
- `cola-io/codex-acp` `/status` includes account/model/token usage fields. `[S10]`
- Official Codex App exposes `/status` in the UI. `[S5]`
- The reviewed `app-server` docs enumerate thread, turn, model, and tool APIs, but do not document a dedicated quota/status endpoint. `[S2]`

**Inference**

- If "remaining quota" is a hard requirement, an `app-server`-based product will likely still need a separate usage/quota service inspired by OpenClaw's provider-usage approach.

### Cancel Current Request and Resend

**Conclusion:** ACP is good at canceling an in-flight turn; `app-server` is the strongest path for both interrupting a running turn and rolling back a completed turn before resending.

**Evidence**

- OpenClaw ACP agents expose `cancel` and `steer`. `[S6]`
- `cola-io/codex-acp` exposes `session/cancel`. `[S10]`
- `app-server` exposes `turn/interrupt` and `thread/rollback`. `[S2]`

### Worktree / Handoff

**Conclusion:** No reviewed path gives a complete "worktree handoff" product feature for free. `app-server` and ACP can both participate, but the product still needs its own Git worktree orchestration.

**Evidence**

- Codex App documents worktrees and handoff as a product feature. `[S14]`
- OpenClaw ACP agents expose `cwd`. `[S6]`
- The reviewed `app-server` API overview does not document a dedicated worktree-create or handoff endpoint. `[S2]`

**Inference**

- A Feishu product can support worktrees by combining product-owned Git worktree management with runtime-side `cwd` control; this is not a built-in runtime-only feature in the reviewed sources.

### Thread / Session Derivation

**Conclusion:** Official native fork/derivation semantics belong to `app-server`. ACP is stronger at session spawn/load/bind than at native Codex thread fork.

**Evidence**

- `app-server` exposes `thread/fork`. `[S2]`
- Interactive Codex CLI exposes `fork`. Local CLI help on 2026-03-30 confirms `codex fork`.
- OpenClaw ACP agents expose session spawn/load and thread binding, but the reviewed ACP sources do not document native Codex thread fork as a first-class standard capability. `[S6]` `[S7]` `[S10]`

## Final Architecture Recommendation

### Primary Path

Use `codex app-server` as the runtime truth source for the Feishu product.

**Why**

- It is the official rich-client interface. `[S2]`
- It is the only reviewed path that cleanly covers thread lifecycle, turn lifecycle, model catalog, reasoning effort, request-user-input, interrupt, rollback, and native fork. `[S2]`
- It aligns most closely with the stated product goal: "Codex App in Feishu."

### Secondary / Optional Paths

- Keep `codex exec` / `resume` only as a fallback path for simple batch or compatibility scenarios.
- Add a separate usage/quota service if the product must surface provider quota or remaining allowance. This service can borrow the OpenClaw provider-usage pattern. `[S11]` `[S13]`
- Add ACP compatibility later only if the product expands toward multi-provider external harness orchestration.

### Non-Recommendations

- Do not make pure `exec` / `resume` the long-term product core.
- Do not make real terminal hosting the mainline path unless literal slash-command passthrough outweighs stability, observability, and maintenance costs.

## Phased Rollout Direction

### Phase 1: Runtime Abstraction and App-Server Backbone

- Introduce a runtime abstraction around thread, turn, model, and interrupt controls.
- Implement an `app-server` backend as the primary runtime.
- Keep `exec` as a fallback backend.

### Phase 2: Product Parity Features

- Add model picker and reasoning-effort picker.
- Add status card based on thread/turn/model state plus a separate usage/quota service.
- Add plan-mode card flow backed by runtime-side request-user-input handling.
- Add image attachments end to end.

### Phase 3: Advanced Workspace Controls

- Add product-owned worktree management.
- Add thread fork / branch-off actions in Feishu.
- Add rollback-and-resend workflows.

## Source Index

- **[S1]** OpenAI, Codex non-interactive mode and CLI reference  
  https://developers.openai.com/codex/noninteractive  
  https://developers.openai.com/codex/cli/reference
- **[S2]** OpenAI, Codex app-server  
  https://developers.openai.com/codex/app-server
- **[S3]** OpenAI, Codex SDK  
  https://developers.openai.com/codex/sdk
- **[S4]** OpenAI, Codex CLI slash commands  
  https://developers.openai.com/codex/cli/slash-commands
- **[S5]** OpenAI, Codex app commands and settings  
  https://developers.openai.com/codex/app/commands  
  https://developers.openai.com/codex/app/settings
- **[S6]** OpenClaw, ACP Agents  
  https://docs.openclaw.ai/tools/acp-agents
- **[S7]** OpenClaw, `openclaw acp` bridge compatibility  
  https://docs.openclaw.ai/cli/acp
- **[S8]** OpenClaw, CLI backends  
  https://docs.openclaw.ai/gateway/cli-backends
- **[S9]** `zed-industries/codex-acp`  
  https://github.com/zed-industries/codex-acp
- **[S10]** `cola-io/codex-acp`  
  https://github.com/cola-io/codex-acp
- **[S11]** OpenClaw, CLI slash commands and status  
  https://docs.openclaw.ai/tools/slash-commands  
  https://docs.openclaw.ai/zh-CN/cli
- **[S12]** `waskosky/codex-cli-farm`  
  https://github.com/waskosky/codex-cli-farm
- **[S13]** OpenClaw, usage tracking  
  https://docs.openclaw.ai/concepts/usage-tracking
- **[S14]** OpenAI, Codex App worktrees  
  https://developers.openai.com/codex/app/worktrees
