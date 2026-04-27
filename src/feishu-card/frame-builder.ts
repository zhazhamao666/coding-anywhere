export type StableCardMode = "session" | "completed" | "failed" | "stopped";

export interface PlanModeState {
  enabled: boolean;
  singleUse: true;
}

export interface DiagnosticViewModel {
  contextRows: string[];
  recentRunRows: string[];
  nextRunRows: string[];
}

export function buildFeishuCardElementsFromSections(
  sections: Array<Array<Record<string, unknown>> | null | undefined>,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];

  for (const section of sections) {
    if (!section || section.length === 0) {
      continue;
    }

    if (elements.length > 0) {
      elements.push({ tag: "hr" });
    }

    elements.push(...section);
  }

  return elements;
}

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
      width_mode: "fill",
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
