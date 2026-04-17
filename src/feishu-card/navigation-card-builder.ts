export function buildBridgeHubCard(input: {
  title?: string;
  summaryLines: string[];
  sections: Array<{
    title: string;
    items: string[];
    monospace?: boolean;
  }>;
  extraElements?: Array<Record<string, unknown>>;
  rows?: Array<{
    title: string;
    lines?: string[];
    buttonLabel?: string;
    value?: Record<string, unknown>;
    type?: "default" | "primary" | "danger";
    buttons?: Array<{
      label: string;
      value: Record<string, unknown>;
      type?: "default" | "primary" | "danger";
    }>;
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
      const buttons = row.buttons && row.buttons.length > 0
        ? row.buttons
        : row.buttonLabel && row.value
          ? [{
              label: row.buttonLabel,
              value: row.value,
              type: row.type,
            }]
          : [];

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
            elements: buttons.map(button => ({
              tag: "button",
              text: {
                tag: "plain_text",
                content: button.label,
              },
              type: button.type ?? "default",
              value: button.value,
            })),
          },
        ],
      });
    }
  }

  if (input.extraElements && input.extraElements.length > 0) {
    elements.push({
      tag: "hr",
    });
    elements.push(...input.extraElements);
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
