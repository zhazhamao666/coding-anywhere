export function buildBridgeHubCard(input: {
  title?: string;
  summaryLines: string[];
  sections: Array<{
    title: string;
    items: string[];
    monospace?: boolean;
  }>;
  rows?: Array<{
    title: string;
    lines?: string[];
    buttonLabel: string;
    value: Record<string, unknown>;
    type?: "default" | "primary" | "danger";
  }>;
  actions?: Array<{
    label: string;
    value: Record<string, unknown>;
    type?: "default" | "primary" | "danger";
  }>;
}): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: input.summaryLines.join("\n"),
    },
  ];

  for (const section of input.sections) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "markdown",
      content: [
        `**${section.title}**`,
        ...section.items.map(item => section.monospace ? `- \`${item}\`` : `- ${item}`),
      ].join("\n"),
    });
  }

  if (input.rows && input.rows.length > 0) {
    elements.push({
      tag: "hr",
    });

    for (const row of input.rows) {
      elements.push({
        tag: "column_set",
        flex_mode: "none",
        background_style: "default",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 4,
            vertical_align: "center",
            elements: [{
              tag: "markdown",
              content: [
                `**${row.title}**`,
                ...(row.lines ?? []),
              ].join("\n"),
            }],
          },
          {
            tag: "column",
            width: "auto",
            weight: 1,
            vertical_align: "center",
            elements: [{
              tag: "button",
              text: {
                tag: "plain_text",
                content: row.buttonLabel,
              },
              type: row.type ?? "default",
              value: row.value,
            }],
          },
        ],
      });
    }
  }

  if (input.actions && input.actions.length > 0) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      background_style: "default",
      columns: input.actions.map(action => ({
        tag: "column",
        width: "auto",
        weight: 1,
        vertical_align: "top",
        elements: [{
          tag: "button",
          text: {
            tag: "plain_text",
            content: action.label,
          },
          type: action.type ?? "default",
          value: action.value,
        }],
      })),
    });
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: input.summaryLines.join(" ").slice(0, 120),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.title ?? "CA Hub",
      },
      template: "blue",
    },
    body: {
      elements,
    },
  };
}
