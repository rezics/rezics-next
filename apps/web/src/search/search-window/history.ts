/** Addresses only: never persist rows, labels, totals or viewer advice. */
export const SEARCH_WINDOW_LIMIT = 12;
export const SEARCH_CURSOR_LIMIT = 4864;
export const SEARCH_ADDRESS_LIMIT = 131072;
export const SEARCH_WINDOW_STATE = 'rezicsSearchWindows';

export type SearchWindowAddress = Readonly<{ cursor: string | null; number: number | null }>;
export type SearchWindowHistory = Readonly<{
  version: 1;
  request: string;
  windows: readonly SearchWindowAddress[];
}>;

export function emptySearchWindows(request: string): SearchWindowHistory {
  return { version: 1, request, windows: [] };
}

/** Browser state is untrusted. Admit a bounded address list for exactly this query and locale. */
export function restoreSearchWindows(value: unknown, request: string): SearchWindowHistory {
  const empty = emptySearchWindows(request);
  if (!value || typeof value !== 'object' || request.length > SEARCH_ADDRESS_LIMIT) return empty;
  const history = value as Partial<SearchWindowHistory>;
  if (
    history.version !== 1 ||
    history.request !== request ||
    !Array.isArray(history.windows) ||
    history.windows.length > SEARCH_WINDOW_LIMIT
  )
    return empty;
  const seen = new Set<string | null>();
  const windows: SearchWindowAddress[] = [];
  for (const entry of history.windows) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      (entry.cursor !== null &&
        (typeof entry.cursor !== 'string' || !entry.cursor || entry.cursor.length > SEARCH_CURSOR_LIMIT)) ||
      (entry.number !== null && (!Number.isSafeInteger(entry.number) || entry.number < 1)) ||
      (entry.cursor === null && entry.number !== 1) ||
      (entry.cursor !== null && entry.number === 1) ||
      (windows.length > 0 && entry.number !== (windows.at(-1)!.number === null ? null : windows.at(-1)!.number! + 1)) ||
      seen.has(entry.cursor)
    )
      return empty;
    seen.add(entry.cursor);
    windows.push({ cursor: entry.cursor, number: entry.number });
  }
  return { version: 1, request, windows };
}

/** Only a successful native response can add an address. Unknown deep links have no invented predecessor. */
export function admitSearchWindow(
  history: SearchWindowHistory,
  cursor: string | undefined,
  from?: string | null,
): SearchWindowHistory {
  const address = cursor ?? null;
  if (history.windows.some((entry) => entry.cursor === address)) return history;
  if (address === null) return { ...history, windows: [{ cursor: null, number: 1 }] };
  if (address.length === 0 || address.length > SEARCH_CURSOR_LIMIT) return history;
  const parent = from === undefined ? -1 : history.windows.findIndex((entry) => entry.cursor === from);
  // A direct cursor visit can be current, but its absolute page number is unknown.
  if (parent < 0) return { ...history, windows: [{ cursor: address, number: null }] };
  const number = history.windows[parent]!.number;
  if (number !== null && number >= Number.MAX_SAFE_INTEGER - 1) return history;
  const windows = [
    ...history.windows.slice(0, parent + 1),
    { cursor: address, number: number === null ? null : number + 1 },
  ];
  return { ...history, windows: windows.slice(-SEARCH_WINDOW_LIMIT) };
}

export function searchWindowPosition(history: SearchWindowHistory, cursor: string | undefined) {
  const index = history.windows.findIndex((entry) => entry.cursor === (cursor ?? null));
  return {
    current: index < 0 ? undefined : history.windows[index],
    previous: index > 0 ? history.windows[index - 1] : undefined,
    clipped:
      (history.windows[0]?.number ?? 1) > 1 ||
      (history.windows[0]?.number === null && history.windows.length === SEARCH_WINDOW_LIMIT),
    index,
  };
}

/** Do not follow a repeated native token back into an already visited ancestor. */
export function searchWindowNextAllowed(
  history: SearchWindowHistory,
  cursor: string | undefined,
  next: string | null | undefined,
) {
  if (!next || next.length > SEARCH_CURSOR_LIMIT || next === cursor) return false;
  const current = searchWindowPosition(history, cursor).index;
  const target = history.windows.findIndex((entry) => entry.cursor === next);
  return target < 0 || (current >= 0 && target > current);
}
