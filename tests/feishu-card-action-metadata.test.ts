import { describe, expect, it } from "vitest";

import {
  hasCardActionElements,
  injectCardActionMetadata,
} from "../src/feishu-card-action-metadata.js";

describe("feishu card action metadata", () => {
  it("injects card metadata into schema 2.0 buttons nested under column_set", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "column_set",
            flex_mode: "flow",
            columns: [
              {
                tag: "column",
                elements: [
                  {
                    tag: "button",
                    text: {
                      tag: "plain_text",
                      content: "当前项目",
                    },
                    value: {
                      command: "/ca project current",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const injected = injectCardActionMetadata(card, {
      cardId: "card-1",
      messageId: "om-1",
    });

    expect(injected).toMatchObject({
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "column_set",
            columns: expect.arrayContaining([
              expect.objectContaining({
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    tag: "button",
                    value: expect.objectContaining({
                      command: "/ca project current",
                      cardId: "card-1",
                      messageId: "om-1",
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      },
    });
  });

  it("recognizes schema 2.0 buttons as actionable card elements", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "column_set",
            columns: [
              {
                tag: "column",
                elements: [
                  {
                    tag: "button",
                    value: {
                      command: "/ca hub",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    expect(hasCardActionElements(card)).toBe(true);
  });
});
