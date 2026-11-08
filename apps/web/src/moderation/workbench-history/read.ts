import { SESSION_HEADER, type KernelClient } from '@rezics/client';
import type { ModerationDecision } from '../decision-read';
import type { WorkbenchSearch } from '../workbench-queue/scope';

type NativePage = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['boards']>['moderation-history']['get']>>['data']
>;
/** Retain only the installed moderator list fields used by the bounded receiver. */
export type HistoryEntry = Pick<
  NativePage['entries'][number],
  'id' | 'targetId' | 'targetKind' | 'action' | 'statement' | 'decidedAt' | 'history'
>;
type Result = { status: number; data?: unknown; error?: { value: unknown } | null; source?: string | null };
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

/** Both installed operations share the prepared credential and request lifetime. */
export function historySource(client: KernelClient, authorization: string, signal?: AbortSignal): HistorySource {
  const options = {
    headers: { authorization },
    fetch: { cache: 'no-store' as const, ...(signal ? { signal } : {}) },
  };
  return {
    async page(boardId, query) {
      signal?.throwIfAborted();
      const result = await client.boards({ id: boardId })['moderation-history'].get({ ...options, query });
      signal?.throwIfAborted();
      return { ...result, source: new Headers(result.headers).get(SESSION_HEADER) };
    },
    async exact(id) {
      signal?.throwIfAborted();
      const result = await client['moderation-decisions']({ id }).get(options);
      signal?.throwIfAborted();
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
    !(
      value['nextCursor'] === null ||
      (typeof value['nextCursor'] === 'string' && value['nextCursor'].length > 0 && value['nextCursor'].length <= 4096)
    )
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
  if (!record(value)) return false;
  const viewer = value['viewer'];
  const target = value['targetContext'];
  if (!decisionIdentity(value)) return false;
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
export async function readWorkbenchHistory(
  source: HistorySource,
  search: WorkbenchSearch,
  signal?: AbortSignal,
): Promise<HistoryRead> {
  signal?.throwIfAborted();
  const empty = { entries: [], next: null };
  if (!search.history || !search.board) return { ...empty, state: 'unavailable' };
  try {
    const result = await source.page(search.board, {
      limit: 20,
      targetKind: search.historyTargetKind ?? 'all',
      ...(search.historyCursor ? { cursor: search.historyCursor } : {}),
    });
    signal?.throwIfAborted();
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
        signal?.throwIfAborted();
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
    const sourceFingerprint = await fingerprint(sources);
    signal?.throwIfAborted();
    return {
      state: 'ready',
      entries: data.entries,
      next: data.nextCursor,
      sourceFingerprint,
      ...(selected ? { selected } : {}),
    };
  } catch {
    signal?.throwIfAborted();
    return { ...empty, state: 'unavailable' };
  }
}
