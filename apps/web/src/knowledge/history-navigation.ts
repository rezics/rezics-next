/** Coordinates only. Admitted metadata and comparison bodies stay in the mounted panel. */
export type KnowledgeHistoryNavigation = Readonly<{
  cursor: string | null;
  previous: readonly (string | null)[];
  truncated: boolean;
}>;

const CURSOR_WINDOW = 20;

export function firstKnowledgeHistoryPage(): KnowledgeHistoryNavigation {
  return { cursor: null, previous: [], truncated: false };
}

export function nextKnowledgeHistoryPage(
  navigation: KnowledgeHistoryNavigation,
  cursor: string,
): KnowledgeHistoryNavigation {
  const previous = [...navigation.previous, navigation.cursor];
  return {
    cursor,
    previous: previous.slice(-CURSOR_WINDOW),
    truncated: navigation.truncated || previous.length > CURSOR_WINDOW,
  };
}

/** The caller offers Previous only for a successfully admitted page with a retained predecessor. */
export function previousKnowledgeHistoryPage(navigation: KnowledgeHistoryNavigation): KnowledgeHistoryNavigation {
  return {
    cursor: navigation.previous[navigation.previous.length - 1]!,
    previous: navigation.previous.slice(0, -1),
    truncated: navigation.truncated,
  };
}

/** Commit only after a successful read; reserve space for the current request and native continuation. */
export function retainKnowledgeHistoryNavigation(
  request: KnowledgeHistoryNavigation,
  next: string | null,
): KnowledgeHistoryNavigation {
  let remaining = CURSOR_WINDOW - Number(request.cursor !== null) - Number(next !== null);
  let start = request.previous.length;
  while (start > 0 && request.previous.length - start < CURSOR_WINDOW) {
    const cursor = request.previous[start - 1];
    if (cursor !== null && !remaining) break;
    if (cursor !== null) remaining--;
    start--;
  }
  return {
    cursor: request.cursor,
    previous: request.previous.slice(start),
    truncated: request.truncated || start > 0,
  };
}
