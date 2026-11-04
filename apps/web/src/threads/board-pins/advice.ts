import { validBoardPinId, type BoardPinThread } from './contract';

export type BoardPinAdviceReference = Readonly<{
  threadId: string;
  placeId: string;
  sourceRevisionId: string;
}>;
export type BoardPinAdviceInput = Readonly<{
  selected: readonly BoardPinAdviceReference[];
  pinRevision?: string;
}>;
export type BoardPinAdviceQuery = BoardPinAdviceInput &
  Readonly<{
    boardId: string;
    viewerId: string;
    signal: AbortSignal;
  }>;
export type BoardPinAdviceResult =
  | Readonly<{
      state: 'ready';
      viewer: Readonly<{ kind: 'account'; id: string }>;
      boardId: string;
      pinRevision: string;
      management: 'allowed' | 'denied';
      threads: readonly BoardPinThread[];
    }>
  | Readonly<{ state: 'stale' | 'denied' | 'unavailable' }>;

/** Minimal public consumer seam pending retained complete-input publication. */
export type BoardPinAdviceWire = Readonly<{
  post(
    input: BoardPinAdviceInput,
    options: {
      headers: { authorization: string };
      fetch: { signal: AbortSignal; cache: 'no-store' };
    },
  ): Promise<{ status: number; data?: unknown; error?: unknown }>;
}>;

const selectionLimit = 25;
const responseBytes = 16 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;

/** Validate and copy before session preparation or transport; duplicates never collapse into a new cohort. */
export function boardPinAdviceInput(boardId: string, input: unknown): BoardPinAdviceInput | undefined {
  if (!validBoardPinId(boardId) || !record(input)) return undefined;
  const expected = Object.hasOwn(input, 'pinRevision') ? ['selected', 'pinRevision'] : ['selected'];
  if (!keys(input, expected) || (expected.length === 2 && !revision(input.pinRevision))) return undefined;
  if (!Array.isArray(input.selected) || input.selected.length > selectionLimit) return undefined;
  const seen = new Set<string>();
  const selected: BoardPinAdviceReference[] = [];
  for (const item of input.selected) {
    if (
      !record(item) ||
      !keys(item, ['threadId', 'placeId', 'sourceRevisionId']) ||
      !validBoardPinId(item.threadId) ||
      !validBoardPinId(item.sourceRevisionId) ||
      item.placeId !== boardId ||
      seen.has(item.threadId)
    )
      return undefined;
    seen.add(item.threadId);
    selected.push(
      Object.freeze({ threadId: item.threadId, placeId: boardId, sourceRevisionId: item.sourceRevisionId }),
    );
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    ...(revision(input.pinRevision) ? { pinRevision: input.pinRevision } : {}),
  });
}

/** Resolve only a published method. There is no path fallback or private producer type. */
export function nativeBoardPinAdvice(board: unknown): BoardPinAdviceWire | undefined {
  if (!record(board)) return undefined;
  const wire = board['pin-advice'];
  return record(wire) && typeof wire.post === 'function' ? (wire as BoardPinAdviceWire) : undefined;
}

function receive(query: BoardPinAdviceQuery, input: BoardPinAdviceInput, body: unknown): BoardPinAdviceResult {
  const unavailable = { state: 'unavailable' } as const;
  if (!record(body)) return unavailable;
  if (body.state === 'stale' && keys(body, ['state'])) return { state: 'stale' };
  if (
    !keys(body, ['state', 'viewer', 'boardId', 'pinRevision', 'management', 'threads']) ||
    body.state !== 'ready' ||
    body.boardId !== query.boardId ||
    !revision(body.pinRevision) ||
    (input.pinRevision !== undefined && body.pinRevision !== input.pinRevision) ||
    !record(body.viewer) ||
    !keys(body.viewer, ['kind', 'id']) ||
    body.viewer.kind !== 'account' ||
    body.viewer.id !== query.viewerId ||
    (body.management !== 'allowed' && body.management !== 'denied') ||
    !Array.isArray(body.threads) ||
    body.threads.length !== input.selected.length
  )
    return unavailable;
  const selected = new Set(input.selected.map((item) => item.threadId));
  const threads: BoardPinThread[] = [];
  for (const row of body.threads) {
    if (
      !record(row) ||
      !keys(row, ['threadId', 'pinned', 'actions']) ||
      typeof row.threadId !== 'string' ||
      !selected.delete(row.threadId) ||
      typeof row.pinned !== 'boolean' ||
      !Array.isArray(row.actions) ||
      row.actions.length > 1 ||
      row.actions.some((action) => action !== (row.pinned ? 'unpin' : 'pin')) ||
      (body.management === 'denied' && row.actions.length !== 0)
    )
      return unavailable;
    threads.push(
      Object.freeze({ threadId: row.threadId, pinned: row.pinned, actions: Object.freeze([...row.actions]) }),
    );
  }
  // Validate the closed shape first so unexpected data cannot cause unbounded serialization here.
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > responseBytes) return unavailable;
  return Object.freeze({
    state: 'ready',
    viewer: Object.freeze({ kind: 'account', id: query.viewerId }),
    boardId: query.boardId,
    pinRevision: body.pinRevision,
    management: body.management,
    threads: Object.freeze(threads),
  });
}

export async function inspectBoardPinAdvice(
  query: BoardPinAdviceQuery,
  wire: BoardPinAdviceWire | undefined,
  authorization: string | undefined,
): Promise<BoardPinAdviceResult> {
  const input = boardPinAdviceInput(query.boardId, {
    selected: query.selected,
    ...(query.pinRevision === undefined ? {} : { pinRevision: query.pinRevision }),
  });
  if (!input || !validBoardPinId(query.viewerId) || !wire || query.signal.aborted) return { state: 'unavailable' };
  if (!authorization) return { state: 'denied' };
  // Capture the expected identity before awaiting a transport that can outlive a visit.
  const bound = Object.freeze({ ...query, selected: input.selected });
  try {
    const response = await wire.post(input, {
      headers: { authorization },
      fetch: { signal: query.signal, cache: 'no-store' },
    });
    if (query.signal.aborted) return { state: 'unavailable' };
    if ([401, 403, 404].includes(response.status)) return { state: 'denied' };
    if (response.status !== 200 || response.error) return { state: 'unavailable' };
    return receive(bound, input, response.data);
  } catch {
    return { state: 'unavailable' };
  }
}
