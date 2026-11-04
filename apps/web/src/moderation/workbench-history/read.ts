import { SESSION_HEADER, type KernelClient } from '@rezics/client';
import type { ModerationDecision } from '../decision-read';
import type { WorkbenchSearch } from '../workbench-queue/scope';

/** Minimal mounted-history consumer seam. Replace with the shared publisher's
 * public declaration when installed; no private producer types enter Web. */
export type HistoryEntry = Pick<
  ModerationDecision,
  'id' | 'targetId' | 'targetKind' | 'action' | 'statement' | 'decidedAt'
> & {
  history: {
    reasonState: 'retained' | 'retired';
    decider: 'withheld' | 'retired';
    receipt: 'permitted' | 'unavailable';
    target: 'unavailable';
  };
};
type NativePage = {
  entries: HistoryEntry[];
  nextCursor: string | null;
  viewer: { kind: 'board-moderator' };
};
type Result = { status: number; data?: unknown; error?: { value: unknown }; source?: string | null };
export type HistorySource = {
  page: (boardId: string, query: { limit: number; targetKind: HistoryTargetKind; cursor?: string }) => Promise<Result>;
  exact: (id: string) => Promise<Result>;
};
export type HistoryTargetKind = 'all' | 'board' | 'thread' | 'post';
export type HistoryRead = {
  state: 'ready' | 'denied' | 'unavailable' | 'stale';
  entries: HistoryEntry[];
  next: string | null;
  sourceFingerprint?: string;
  selected?: { state: 'ready'; decision: ModerationDecision } | { state: 'unavailable' };
};

type MountedHistoryClient = {
  'moderation-history': {
    get: (options: {
      query: Parameters<HistorySource['page']>[1];
      headers: { authorization: string };
      fetch: { cache: 'no-store' };
    }) => Promise<Result & { headers?: HeadersInit }>;
  };
};

/** Eden's runtime resolves this existing mounted path. This seam adds no method
 * to the public package and never treats an older unprojected response as ready. */
export function historySource(client: KernelClient, authorization: string): HistorySource {
  const options = { headers: { authorization }, fetch: { cache: 'no-store' as const } };
  return {
    async page(boardId, query) {
      const board = client.boards({ id: boardId }) as unknown as MountedHistoryClient;
      const result = await board['moderation-history'].get({ ...options, query });
      return { ...result, source: new Headers(result.headers).get(SESSION_HEADER) };
    },
    async exact(id) {
      const result = await client['moderation-decisions']({ id }).get(options);
      return { ...result, source: new Headers(result.headers).get(SESSION_HEADER) };
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function decisionIdentity(value: unknown): value is HistoryEntry {
  return (
    record(value) &&
    typeof value['id'] === 'string' &&
    typeof value['targetId'] === 'string' &&
    ['board', 'thread', 'post'].includes(String(value['targetKind'])) &&
    value['action'] === 'takedown' &&
    typeof value['statement'] === 'string' &&
    [...value['statement']].length <= 1024 &&
    typeof value['decidedAt'] === 'string' &&
    Number.isFinite(Date.parse(value['decidedAt']))
  );
}
function pageValue(value: unknown): value is NativePage {
  if (
    !record(value) ||
    !record(value['viewer']) ||
    value['viewer']['kind'] !== 'board-moderator' ||
    !Array.isArray(value['entries']) ||
    value['entries'].length > 20 ||
    !(value['nextCursor'] === null || typeof value['nextCursor'] === 'string')
  )
    return false;
  return value['entries'].every((entry: unknown) => {
    if (!decisionIdentity(entry) || !record(entry.history)) return false;
    return (
      ['retained', 'retired'].includes(String(entry.history.reasonState)) &&
      ['withheld', 'retired'].includes(String(entry.history.decider)) &&
      ['permitted', 'unavailable'].includes(String(entry.history.receipt)) &&
      entry.history.target === 'unavailable'
    );
  });
}
function exactValue(value: unknown): value is ModerationDecision {
  if (!decisionIdentity(value) || !record(value)) return false;
  const viewer = value['viewer'];
  const target = value['targetContext'];
  if (
    !record(viewer) ||
    typeof viewer['affectedAuthor'] !== 'boolean' ||
    typeof viewer['observedAt'] !== 'string' ||
    !record(viewer['appeal']) ||
    !record(target)
  )
    return false;
  if (target['state'] === 'concealed' || target['state'] === 'unavailable') return true;
  if (target['state'] !== 'available' || typeof target['boardId'] !== 'string') return false;
  if (target['kind'] === 'board') return value.targetKind === 'board' && target['boardId'] === value.targetId;
  return (
    target['kind'] === 'thread' &&
    typeof target['threadId'] === 'string' &&
    (target['postId'] === null || typeof target['postId'] === 'string') &&
    (value.targetKind === 'thread'
      ? target['threadId'] === value.targetId
      : value.targetKind === 'post' && target['postId'] === value.targetId)
  );
}
function failure(result: Result): HistoryRead['state'] {
  const problem = result.error?.value;
  const code = record(problem) ? problem['code'] : null;
  if ((result.status === 400 && code === 'invalid_cursor') || (result.status === 409 && code === 'stale_cursor'))
    return 'stale';
  return [401, 403, 404].includes(result.status) ? 'denied' : 'unavailable';
}
async function fingerprint(sources: string[]) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sources)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One raw native page and at most one exact selection. Never refill or accumulate
 * withheld rows, and never use a queue cursor or browser time as a history input. */
export async function readWorkbenchHistory(source: HistorySource, search: WorkbenchSearch): Promise<HistoryRead> {
  const empty = { entries: [], next: null };
  if (!search.history || !search.board) return { ...empty, state: 'unavailable' };
  try {
    const result = await source.page(search.board, {
      limit: 20,
      targetKind: search.historyTargetKind ?? 'all',
      ...(search.historyCursor ? { cursor: search.historyCursor } : {}),
    });
    if (result.error || result.status !== 200) return { ...empty, state: failure(result) };
    if (!result.source || !pageValue(result.data)) return { ...empty, state: 'unavailable' };
    const data = result.data;
    const sources = [result.source];
    let selected: HistoryRead['selected'];
    if (search.historyDecision) {
      const row = data.entries.find((entry) => entry.id === search.historyDecision);
      selected = { state: 'unavailable' };
      if (row?.history.receipt === 'permitted') {
        const exact = await source.exact(row.id);
        if (exact.error || exact.status !== 200) {
          if (failure(exact) === 'denied') return { ...empty, state: 'denied' };
        } else if (
          exact.source &&
          exactValue(exact.data) &&
          exact.data.id === row.id &&
          exact.data.targetId === row.targetId &&
          exact.data.targetKind === row.targetKind
        ) {
          sources.push(exact.source);
          selected = { state: 'ready', decision: exact.data };
        }
      }
    }
    return {
      state: 'ready',
      entries: data.entries,
      next: data.nextCursor,
      sourceFingerprint: await fingerprint(sources),
      ...(selected ? { selected } : {}),
    };
  } catch {
    return { ...empty, state: 'unavailable' };
  }
}
