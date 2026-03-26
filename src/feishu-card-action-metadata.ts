export function injectCardActionMetadata(
  card: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const keys = Object.keys(metadata).filter(key => metadata[key] !== undefined && metadata[key] !== "");
  if (keys.length === 0) {
    return undefined;
  }

  const [nextCard, changed] = visitNode(card, value => injectButtonMetadata(value, metadata, keys));
  if (!changed) {
    return undefined;
  }

  return nextCard as Record<string, unknown>;
}

export function hasCardActionElements(card: Record<string, unknown>): boolean {
  return hasActionableButton(card);
}

function injectButtonMetadata(
  node: unknown,
  metadata: Record<string, unknown>,
  keys: string[],
): { changed: boolean; value: unknown } {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return {
      changed: false,
      value: node,
    };
  }

  const candidate = node as Record<string, unknown>;
  if (candidate.tag !== "button" || !candidate.value || typeof candidate.value !== "object" || Array.isArray(candidate.value)) {
    return {
      changed: false,
      value: node,
    };
  }

  const currentValue = candidate.value as Record<string, unknown>;
  const needsUpdate = keys.some(key => currentValue[key] !== metadata[key]);
  if (!needsUpdate) {
    return {
      changed: false,
      value: node,
    };
  }

  return {
    changed: true,
    value: {
      ...candidate,
      value: {
        ...currentValue,
        ...metadata,
      },
    },
  };
}

function hasActionableButton(node: unknown): boolean {
  if (!node) {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some(item => hasActionableButton(item));
  }

  if (typeof node !== "object") {
    return false;
  }

  const candidate = node as Record<string, unknown>;
  if (
    candidate.tag === "button" &&
    candidate.value &&
    typeof candidate.value === "object" &&
    !Array.isArray(candidate.value)
  ) {
    return true;
  }

  return Object.values(candidate).some(value => hasActionableButton(value));
}

function visitNode(
  node: unknown,
  visitor: (node: unknown) => { changed: boolean; value: unknown },
): [unknown, boolean] {
  const visited = visitor(node);
  let current = visited.value;
  let changed = visited.changed;

  if (Array.isArray(current)) {
    let arrayChanged = false;
    const nextArray = current.map(item => {
      const [nextItem, itemChanged] = visitNode(item, visitor);
      arrayChanged ||= itemChanged;
      return nextItem;
    });
    return [arrayChanged ? nextArray : current, changed || arrayChanged];
  }

  if (!current || typeof current !== "object") {
    return [current, changed];
  }

  let objectChanged = false;
  const nextRecord: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
    if ((current as Record<string, unknown>).tag === "button" && key === "value") {
      continue;
    }

    const [nextValue, valueChanged] = visitNode(value, visitor);
    if (valueChanged) {
      nextRecord[key] = nextValue;
      objectChanged = true;
    }
  }

  if (!changed && !objectChanged) {
    return [current, false];
  }

  return [objectChanged ? nextRecord : current, true];
}
