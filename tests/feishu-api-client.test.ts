import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FeishuApiClient } from "../src/feishu-api-client.js";

describe("FeishuApiClient", () => {
  it("logs one outbound line for a continuous CardKit push sequence", async () => {
    const sdk = createSdkDouble();
    const logger = {
      info: vi.fn(),
    };
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
      {
        logger,
        now: () => 1_000,
        pushLogWindowMs: 60_000,
      },
    );

    const messageId = await client.sendCardKitMessage("ou_demo", "card-1");
    await client.streamCardElement("card-1", "streaming_content", "处理中", 2);
    await client.setCardStreamingMode("card-1", false, 3);
    await client.updateCardKitCard("card-1", { schema: "2.0" }, 4);

    expect(messageId).toBe("msg-cardkit-1");
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("feishu send"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_id=msg-cardkit-1"),
    );
  });

  it("logs a standalone interactive card patch once", async () => {
    const sdk = createSdkDouble();
    const logger = {
      info: vi.fn(),
    };
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
      {
        logger,
        now: () => 1_000,
        pushLogWindowMs: 60_000,
      },
    );

    await client.updateInteractiveCard("om_existing_1", {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "Updated Card",
        },
      },
    });
    await client.updateInteractiveCard("om_existing_1", {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "Updated Card",
        },
      },
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("feishu send"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("message_id=om_existing_1"),
    );
  });

  it("delay-updates interactive cards with the callback token path", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    await client.delayUpdateInteractiveCard({
      token: "c-token-1",
      card: {
        schema: "2.0",
        header: {
          title: {
            tag: "plain_text",
            content: "Delayed Update",
          },
        },
      },
    });

    expect(sdk.request).toHaveBeenCalledWith({
      method: "POST",
      url: "https://open.feishu.cn/open-apis/interactive/v1/card/update",
      data: {
        token: "c-token-1",
        card: {
          schema: "2.0",
          header: {
            title: {
              tag: "plain_text",
              content: "Delayed Update",
            },
          },
        },
      },
    });
  });

  it("sends interactive cards with the IM create API", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const messageId = await client.sendInteractiveCard("ou_demo", {
      schema: "2.0",
      body: { elements: [] },
    });

    expect(messageId).toBe("msg-card-1");
    expect(sdk.im.message.create).toHaveBeenCalledWith({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: "ou_demo",
        msg_type: "interactive",
        content: JSON.stringify({
          schema: "2.0",
          body: { elements: [] },
        }),
      },
    });
  });

  it("sends interactive cards to a group chat timeline with the IM create API", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const result = await client.sendInteractiveCardToChat("oc_group_1", {
      schema: "2.0",
      body: { elements: [] },
    });

    expect(result).toEqual({
      messageId: "msg-card-1",
      threadId: "omt-chat-1",
    });
    expect(sdk.im.message.create).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_group_1",
        msg_type: "interactive",
        content: JSON.stringify({
          schema: "2.0",
          body: { elements: [] },
        }),
      },
    });
  });

  it("creates a CardKit entity and streams element content", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const cardId = await client.createCardEntity({
      schema: "2.0",
      body: { elements: [] },
    });
    await client.streamCardElement(cardId, "streaming_content", "处理中", 2);

    expect(cardId).toBe("card-1");
    expect(sdk.cardkit.v1.card.create).toHaveBeenCalled();
    expect(sdk.cardkit.v1.cardElement.content).toHaveBeenCalledWith({
      path: {
        card_id: "card-1",
        element_id: "streaming_content",
      },
      data: {
        content: "处理中",
        sequence: 2,
      },
    });
  });

  it("sends messages by card_id and finalizes CardKit cards", async () => {
    const sdk = createSdkDouble();
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    const messageId = await client.sendCardKitMessage("ou_demo", "card-1");
    await client.setCardStreamingMode("card-1", false, 3);
    await client.updateCardKitCard("card-1", { schema: "2.0" }, 4);

    expect(messageId).toBe("msg-cardkit-1");
    expect(sdk.im.message.create).toHaveBeenCalledWith({
      params: {
        receive_id_type: "open_id",
      },
      data: {
        receive_id: "ou_demo",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "card-1",
          },
        }),
      },
    });
    expect(sdk.cardkit.v1.card.settings).toHaveBeenCalledWith({
      path: {
        card_id: "card-1",
      },
      data: {
        settings: JSON.stringify({
          streaming_mode: false,
        }),
        sequence: 3,
      },
    });
    expect(sdk.cardkit.v1.card.update).toHaveBeenCalledWith({
      path: {
        card_id: "card-1",
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
          }),
        },
        sequence: 4,
      },
    });
  });

  it("downloads image resources from message.resource into a managed directory", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-resource-download-"));
    const sdk = createSdkDouble();
    sdk.im.v1.messageResource.get = vi.fn(async () => ({
      headers: {
        "content-type": "image/png",
        "content-disposition": 'attachment; filename="from-feishu.png"',
      },
      writeFile: vi.fn(async (filePath: string) => {
        writeFileSync(filePath, "png");
        return filePath;
      }),
      getReadableStream: vi.fn(),
    }));
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    try {
      const result = await client.downloadMessageResource({
        messageId: "om_image_1",
        fileKey: "img_dm_1",
        type: "image",
        downloadDir: rootDir,
      });

      expect(sdk.im.v1.messageResource.get).toHaveBeenCalledWith({
        params: {
          type: "image",
        },
        path: {
          message_id: "om_image_1",
          file_key: "img_dm_1",
        },
      });
      expect(result).toMatchObject({
        resourceKey: "img_dm_1",
        localPath: path.join(rootDir, "from-feishu.png"),
        fileName: "from-feishu.png",
        mimeType: "image/png",
        fileSize: 3,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("downloads file resources from message.resource with the file resource type", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-file-resource-download-"));
    const sdk = createSdkDouble();
    sdk.im.v1.messageResource.get = vi.fn(async () => ({
      headers: {
        "content-type": "text/markdown",
        "content-disposition": 'attachment; filename="notes.md"',
      },
      writeFile: vi.fn(async (filePath: string) => {
        writeFileSync(filePath, "# notes\n");
        return filePath;
      }),
      getReadableStream: vi.fn(),
    }));
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    try {
      const result = await client.downloadMessageResource({
        messageId: "om_file_1",
        fileKey: "file_dm_1",
        type: "file",
        downloadDir: rootDir,
      });

      expect(sdk.im.v1.messageResource.get).toHaveBeenCalledWith({
        params: {
          type: "file",
        },
        path: {
          message_id: "om_file_1",
          file_key: "file_dm_1",
        },
      });
      expect(result).toMatchObject({
        resourceKey: "file_dm_1",
        localPath: path.join(rootDir, "notes.md"),
        fileName: "notes.md",
        mimeType: "text/markdown",
        fileSize: 8,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("falls back to a safe filename when Content-Disposition names a parent directory", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-file-dangerous-name-"));
    const sdk = createSdkDouble();
    const writtenPaths: string[] = [];
    sdk.im.v1.messageResource.get = vi.fn(async () => ({
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename=".."',
      },
      writeFile: vi.fn(async (filePath: string) => {
        writtenPaths.push(filePath);
        writeFileSync(filePath, "bin");
        return filePath;
      }),
      getReadableStream: vi.fn(),
    }));
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    try {
      const result = await client.downloadMessageResource({
        messageId: "om_file_parent_1",
        fileKey: "file_parent_1",
        type: "file",
        downloadDir: rootDir,
        preferredFileName: "safe.md",
      });

      expect(result.fileName).toBe("download.bin");
      expect(result.localPath).toBe(path.join(rootDir, "download.bin"));
      expect(writtenPaths).toEqual([path.join(rootDir, "download.bin")]);
      expect(path.dirname(result.localPath)).toBe(rootDir);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("falls back to a safe filename when the preferred filename is a Windows device name", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-file-device-name-"));
    const sdk = createSdkDouble();
    const writtenPaths: string[] = [];
    sdk.im.v1.messageResource.get = vi.fn(async () => ({
      headers: {
        "content-type": "application/octet-stream",
      },
      writeFile: vi.fn(async (filePath: string) => {
        writtenPaths.push(filePath);
        writeFileSync(filePath, "bin");
        return filePath;
      }),
      getReadableStream: vi.fn(),
    }));
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    try {
      const result = await client.downloadMessageResource({
        messageId: "om_file_device_1",
        fileKey: "file_device_1",
        type: "file",
        downloadDir: rootDir,
        preferredFileName: "CON.txt",
      });

      expect(result.fileName).toBe("download.bin");
      expect(result.localPath).toBe(path.join(rootDir, "download.bin"));
      expect(writtenPaths).toEqual([path.join(rootDir, "download.bin")]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("falls back to plain filename when encoded filename is malformed", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-file-malformed-name-"));
    const sdk = createSdkDouble();
    sdk.im.v1.messageResource.get = vi.fn(async () => ({
      headers: {
        "content-type": "text/markdown",
        "content-disposition": 'attachment; filename*=UTF-8\'\'%E0%A4%A; filename="plain.md"',
      },
      writeFile: vi.fn(async (filePath: string) => {
        writeFileSync(filePath, "# plain\n");
        return filePath;
      }),
      getReadableStream: vi.fn(),
    }));
    const client = new FeishuApiClient(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        apiBaseUrl: "https://open.feishu.cn/open-apis",
      },
      sdk as any,
    );

    try {
      const result = await client.downloadMessageResource({
        messageId: "om_file_malformed_1",
        fileKey: "file_malformed_1",
        type: "file",
        downloadDir: rootDir,
        preferredFileName: "preferred.md",
      });

      expect(result).toMatchObject({
        fileName: "plain.md",
        localPath: path.join(rootDir, "plain.md"),
        fileSize: 8,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uploads local images and sends native image messages", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "feishu-image-upload-"));
    const imagePath = path.join(rootDir, "reply.png");
    writeFileSync(imagePath, "png");

    try {
      const sdk = createSdkDouble();
      (sdk.im.v1.image.create as any) = vi.fn(async () => ({
        image_key: "img_uploaded_1",
      }));
      const client = new FeishuApiClient(
        {
          appId: "cli_xxx",
          appSecret: "secret",
          apiBaseUrl: "https://open.feishu.cn/open-apis",
        },
        sdk as any,
      );

      const imageKey = await client.uploadImage({
        imagePath,
      });
      const createMessageId = await client.sendImageMessage("ou_demo", imageKey);
      const replyMessageId = await client.replyImageMessage("om_anchor_1", imageKey);

      expect(imageKey).toBe("img_uploaded_1");
      expect(sdk.im.v1.image.create).toHaveBeenCalledWith({
        data: {
          image_type: "message",
          image: expect.anything(),
        },
      });
      expect(createMessageId).toBe("msg-image-1");
      expect(sdk.im.message.create).toHaveBeenCalledWith({
        params: {
          receive_id_type: "open_id",
        },
        data: {
          receive_id: "ou_demo",
          msg_type: "image",
          content: JSON.stringify({
            image_key: "img_uploaded_1",
          }),
        },
      });
      expect(replyMessageId).toBe("msg-reply-image-1");
      expect(sdk.im.message.reply).toHaveBeenCalledWith({
        path: {
          message_id: "om_anchor_1",
        },
        data: {
          msg_type: "image",
          content: JSON.stringify({
            image_key: "img_uploaded_1",
          }),
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

function createSdkDouble(): any {
  return {
    im: {
      message: {
        create: vi.fn(async ({ data }: { data: { content: string; msg_type?: string } }) => {
          const content = JSON.parse(data.content);
          return {
            data: {
              message_id:
                data.msg_type === "image"
                  ? "msg-image-1"
                  : content.type === "card"
                    ? "msg-cardkit-1"
                    : "msg-card-1",
              thread_id: data.msg_type === "interactive" ? "omt-chat-1" : undefined,
            },
          };
        }),
        reply: vi.fn(async ({ data }: { data?: { msg_type?: string } }) => ({
          data: {
            message_id: data?.msg_type === "image" ? "msg-reply-image-1" : "msg-reply-1",
            thread_id: "omt-1",
          },
        })),
        patch: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      v1: {
        image: {
          create: vi.fn(async () => ({
            image_key: "img-upload-default",
          })),
        },
        messageResource: {
          get: vi.fn(async () => ({
            headers: {},
            writeFile: vi.fn(async (_filePath: string) => undefined),
            getReadableStream: vi.fn(),
          })),
        },
      },
    },
    request: vi.fn(async () => ({
      code: 0,
      msg: "ok",
    })),
    cardkit: {
      v1: {
        card: {
          create: vi.fn(async () => ({
            code: 0,
            data: {
              card_id: "card-1",
            },
          })),
          settings: vi.fn(async () => ({
            code: 0,
          })),
          update: vi.fn(async () => ({
            code: 0,
          })),
        },
        cardElement: {
          content: vi.fn(async () => ({
            code: 0,
          })),
        },
      },
    },
  };
}
