export function buildFeishuCardFrame(input: {
  summary: string;
  elements: Array<Record<string, unknown>>;
  title?: string;
  template?: string;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      ...input.config,
      summary: {
        content: input.summary.slice(0, 120),
      },
    },
    body: {
      elements: input.elements,
    },
  };

  if (input.title) {
    card.header = {
      title: {
        tag: "plain_text",
        content: input.title,
      },
      template: input.template ?? "blue",
    };
  }

  return card;
}
