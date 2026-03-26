import { buildBridgeCard, buildStreamingCardMarkdown, buildStreamingShellCard, STREAMING_ELEMENT_ID } from "./card-builder.js";
import type { FeishuApiClientLike, StreamingCardControllerLike } from "../feishu-adapter.js";
import type { ProgressCardState } from "../types.js";

export class StreamingCardController implements StreamingCardControllerLike {
  private mode: "cardkit" | "fallback" | undefined;
  private messageId: string | undefined;
  private cardId: string | undefined;
  private sequence = 1;

  public constructor(
    private readonly dependencies: {
      peerId: string;
      apiClient: FeishuApiClientLike;
      anchorMessageId?: string;
    },
  ) {}

  public async push(snapshot: ProgressCardState): Promise<void> {
    await this.ensureInitialized(snapshot);

    if (snapshot.status === "done" || snapshot.status === "error" || snapshot.status === "canceled") {
      await this.finalize(snapshot);
      return;
    }

    if (this.mode === "cardkit" && this.cardId) {
      try {
        await this.dependencies.apiClient.streamCardElement(
          this.cardId,
          STREAMING_ELEMENT_ID,
          buildStreamingCardMarkdown(snapshot),
          this.nextSequence(),
        );
        return;
      } catch {
        this.mode = "fallback";
      }
    }

    if (this.messageId) {
      await this.dependencies.apiClient.updateInteractiveCard(this.messageId, buildBridgeCard(snapshot));
    }
  }

  public async finalizeError(errorText: string): Promise<void> {
    if (this.dependencies.anchorMessageId && !this.messageId) {
      await this.dependencies.apiClient.replyTextMessage(this.dependencies.anchorMessageId, errorText);
      return;
    }

    const snapshot: ProgressCardState = {
      runId: "error-run",
      rootName: "unknown",
      status: "error",
      stage: "error",
      preview: errorText,
      startedAt: Date.now(),
      elapsedMs: 0,
    };
    await this.ensureInitialized(snapshot);
    await this.finalize(snapshot);
  }

  private async ensureInitialized(snapshot: ProgressCardState): Promise<void> {
    if (this.messageId) {
      return;
    }

    if (this.dependencies.anchorMessageId) {
      this.mode = "fallback";
      this.messageId = await this.dependencies.apiClient.replyInteractiveCard(
        this.dependencies.anchorMessageId,
        buildBridgeCard(snapshot),
      );
      return;
    }

    try {
      this.cardId = await this.dependencies.apiClient.createCardEntity(
        buildStreamingShellCard(buildStreamingCardMarkdown(snapshot)),
      );
      this.messageId = await this.dependencies.apiClient.sendCardKitMessage(
        this.dependencies.peerId,
        this.cardId,
      );
      this.mode = "cardkit";
      return;
    } catch {
      this.mode = "fallback";
    }

    this.messageId = await this.dependencies.apiClient.sendInteractiveCard(
      this.dependencies.peerId,
      buildBridgeCard(snapshot),
    );
  }

  private async finalize(snapshot: ProgressCardState): Promise<void> {
    const card = buildBridgeCard(snapshot);

    if (this.mode === "cardkit" && this.cardId) {
      await this.dependencies.apiClient.setCardStreamingMode(this.cardId, false, this.nextSequence());
      await this.dependencies.apiClient.updateCardKitCard(this.cardId, card, this.nextSequence());
      return;
    }

    if (this.messageId) {
      await this.dependencies.apiClient.updateInteractiveCard(this.messageId, card);
    }
  }

  private nextSequence(): number {
    const current = this.sequence;
    this.sequence += 1;
    return current;
  }
}
