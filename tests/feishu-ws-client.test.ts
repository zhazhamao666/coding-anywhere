import { describe, expect, it, vi } from "vitest";

import { createSdkLogger, FeishuWsClient } from "../src/feishu-ws-client.js";

describe("FeishuWsClient", () => {
  it("normalizes multi-argument sdk logs into single messages", () => {
    const baseLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const sdkLogger = createSdkLogger(baseLogger);
    sdkLogger?.info?.("[ws]", "persistent connection ready", {
      mode: "p2p",
    });

    expect(baseLogger.info).toHaveBeenCalledWith(
      '[ws] persistent connection ready {"mode":"p2p"}',
    );
  });

  it("flattens the SDK logger proxy array payload into a readable message", () => {
    const baseLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const sdkLogger = createSdkLogger(baseLogger);
    sdkLogger?.info?.([
      "[ws]",
      "Developer Console(开发者后台)",
    ]);

    expect(baseLogger.info).toHaveBeenCalledWith(
      "[ws] Developer Console(开发者后台)",
    );
  });

  it("uses the official SDK WSClient and registers im.message.receive_v1", async () => {
    const register = vi.fn().mockReturnThis();
    const invoke = vi.fn(async (data: unknown) => {
      const handlers = register.mock.calls[0]?.[0] ?? {};
      const eventType = (data as { __eventType?: string }).__eventType;
      if (eventType && handlers[eventType]) {
        return handlers[eventType](data);
      }
      return "no undefined event handle";
    });
    const start = vi.fn();
    const close = vi.fn();
    const onEnvelope = vi.fn(async () => undefined);
    const onCardAction = vi.fn(async () => ({
      header: {
        title: {
          tag: "plain_text",
          content: "Updated Card",
        },
      },
      elements: [],
    }));

    class EventDispatcherStub {
      public register = register;
      public invoke = invoke;
    }

    class WSClientStub {
      public start = start;
      public close = close;
    }

    const client = new FeishuWsClient(
      {
        appId: "cli_demo",
        appSecret: "secret_demo",
        onEnvelope,
        onCardAction,
      },
      {
        EventDispatcher: EventDispatcherStub,
        WSClient: WSClientStub,
        LoggerLevel: {
          info: 3,
        },
      },
    );

    await client.start();

    expect(register).toHaveBeenCalledWith({
      "im.message.receive_v1": expect.any(Function),
    });
    expect(start).toHaveBeenCalledWith({
      eventDispatcher: expect.objectContaining({
        invoke: expect.any(Function),
      }),
    });

    const messageHandler = register.mock.calls[0]?.[0]?.["im.message.receive_v1"];
    await messageHandler({
      sender: {
        sender_id: {
          open_id: "ou_demo",
        },
      },
      message: {
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });

    expect(onEnvelope).toHaveBeenCalledWith({
      event: {
        sender: {
          sender_id: {
            open_id: "ou_demo",
          },
        },
        message: {
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    });

    const actionDispatcher = start.mock.calls[0]?.[0]?.eventDispatcher;
    await expect(
      actionDispatcher.invoke({
        open_id: "ou_demo",
        open_message_id: "om_card_1",
        tenant_key: "tenant_demo",
        token: "token_demo",
        action: {
          tag: "button",
          value: {
            command: "/ca hub",
            chatId: "oc_chat_1",
          },
        },
      }),
    ).resolves.toEqual({
      header: {
        title: {
          tag: "plain_text",
          content: "Updated Card",
        },
      },
      elements: [],
    });
    expect(onCardAction).toHaveBeenCalledWith({
      open_id: "ou_demo",
      open_message_id: "om_card_1",
      tenant_key: "tenant_demo",
      token: "token_demo",
      action: {
        tag: "button",
        value: {
          command: "/ca hub",
          chatId: "oc_chat_1",
        },
      },
    });
    expect(invoke).not.toHaveBeenCalled();

    await client.stop();
    expect(close).toHaveBeenCalledWith({ force: true });
  });

  it("falls back to card action handling when the dispatcher reports no card.action.trigger handle", async () => {
    const register = vi.fn().mockReturnThis();
    const invoke = vi.fn(async (data: unknown) => {
      const eventType = (data as { __eventType?: string }).__eventType;
      if (eventType === "card.action.trigger") {
        return "no card.action.trigger event handle";
      }
      return undefined;
    });
    const start = vi.fn();
    const close = vi.fn();
    const onCardAction = vi.fn(async () => ({
      header: {
        title: {
          tag: "plain_text",
          content: "Handled By Fallback",
        },
      },
      elements: [],
    }));

    class EventDispatcherStub {
      public register = register;
      public invoke = invoke;
    }

    class WSClientStub {
      public start = start;
      public close = close;
    }

    const client = new FeishuWsClient(
      {
        appId: "cli_demo",
        appSecret: "secret_demo",
        onEnvelope: vi.fn(async () => undefined),
        onCardAction,
      },
      {
        EventDispatcher: EventDispatcherStub,
        WSClient: WSClientStub,
        LoggerLevel: {
          info: 3,
        },
      },
    );

    await client.start();

    const actionDispatcher = start.mock.calls[0]?.[0]?.eventDispatcher;
    await expect(
      actionDispatcher.invoke({
        event: {
          type: "card.action.trigger",
          open_message_id: "om_card_2",
          token: "token_demo",
          tenant_key: "tenant_demo",
          operator: {
            operator_id: {
              open_id: "ou_demo",
            },
          },
          action: {
            tag: "button",
            value: {
              command: "/ca project current",
              chatId: "oc_chat_2",
            },
          },
        },
      }),
    ).resolves.toEqual({
      header: {
        title: {
          tag: "plain_text",
          content: "Handled By Fallback",
        },
      },
      elements: [],
    });

    expect(onCardAction).toHaveBeenCalledWith(
      {
        open_id: "ou_demo",
        open_message_id: "om_card_2",
        tenant_key: "tenant_demo",
        token: "token_demo",
        action: {
          tag: "button",
          value: {
            command: "/ca project current",
            chatId: "oc_chat_2",
          },
        },
      },
    );
    expect(invoke).not.toHaveBeenCalled();

    await client.stop();
    expect(close).toHaveBeenCalledWith({ force: true });
  });

  it("preserves form_value and action name for JSON 2.0 card callbacks", async () => {
    const register = vi.fn().mockReturnThis();
    const invoke = vi.fn(async () => "no card.action.trigger event handle");
    const start = vi.fn();
    const close = vi.fn();
    const onCardAction = vi.fn(async () => ({
      card: {
        type: "raw",
        data: {
          schema: "2.0",
        },
      },
    }));

    class EventDispatcherStub {
      public register = register;
      public invoke = invoke;
    }

    class WSClientStub {
      public start = start;
      public close = close;
    }

    const client = new FeishuWsClient(
      {
        appId: "cli_demo",
        appSecret: "secret_demo",
        onEnvelope: vi.fn(async () => undefined),
        onCardAction,
      },
      {
        EventDispatcher: EventDispatcherStub,
        WSClient: WSClientStub,
        LoggerLevel: {
          info: 3,
        },
      },
    );

    await client.start();

    const actionDispatcher = start.mock.calls[0]?.[0]?.eventDispatcher;
    await actionDispatcher.invoke({
      schema: "2.0",
      header: {
        event_type: "card.action.trigger",
      },
      event: {
        context: {
          open_message_id: "om_form_1",
        },
        operator: {
          open_id: "ou_demo",
        },
        token: "card-token",
        tenant_key: "tenant-demo",
        action: {
          tag: "button",
          name: "Button_submit",
          value: {
            bridgeAction: "submit_plan_form",
          },
          form_value: {
            plan_prompt: "请先梳理方案",
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledWith({
      open_id: "ou_demo",
      open_message_id: "om_form_1",
      tenant_key: "tenant-demo",
      token: "card-token",
      action: {
        tag: "button",
        name: "Button_submit",
        value: {
          bridgeAction: "submit_plan_form",
        },
        form_value: {
          plan_prompt: "请先梳理方案",
        },
      },
    });

    await client.stop();
    expect(close).toHaveBeenCalledWith({ force: true });
  });

  it("does not block the websocket ack on background envelope processing", async () => {
    const register = vi.fn().mockReturnThis();
    const invoke = vi.fn(async () => undefined);
    const start = vi.fn();
    const close = vi.fn();
    let resolveEnvelope: (() => void) | undefined;
    const onEnvelope = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveEnvelope = resolve;
        }),
    );

    class EventDispatcherStub {
      public register = register;
      public invoke = invoke;
    }

    class WSClientStub {
      public start = start;
      public close = close;
    }

    const client = new FeishuWsClient(
      {
        appId: "cli_demo",
        appSecret: "secret_demo",
        onEnvelope,
      },
      {
        EventDispatcher: EventDispatcherStub,
        WSClient: WSClientStub,
        LoggerLevel: {
          info: 3,
        },
      },
    );

    const messageHandler = register.mock.calls[0]?.[0]?.["im.message.receive_v1"];
    const ackPromise = messageHandler({
      sender: {
        sender_id: {
          open_id: "ou_demo",
        },
      },
      message: {
        message_id: "om_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });

    await expect(ackPromise).resolves.toBeUndefined();
    expect(onEnvelope).toHaveBeenCalledTimes(1);

    resolveEnvelope?.();
    await client.stop();
    expect(close).toHaveBeenCalledWith({ force: true });
  });
});
