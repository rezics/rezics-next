import type { QueryClient } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { catalogueReportsClient } from '../catalogue-reports-client';
import { preparedPrivateReaderOrigin, type PrivateReaderOrigin } from '../private-reader-origin';
import { preparePrivateReaderRead, type PrivateReaderRead } from '../private-reader-lifetime';
import { readModerationAppeals, type Appeal } from '../appeals-read';
import { readModerationReports, type Report } from '../reports-read';
import {
  WORKBENCH_PAGE_SIZE,
  workbenchReadKey,
  workbenchScope,
  workbenchSearch,
  type WorkbenchSearch,
  type WorkbenchScope,
} from './scope';

export { WORKBENCH_PAGE_SIZE, workbenchSearch } from './scope';

export type WorkbenchCase = {
  kind: 'report' | 'appeal';
  id: string;
  createdAt: string;
  outcome: 'actioned' | 'dismissed' | null;
  reason: string | null;
  evidence: string | null;
  statement: string | null;
  decisionId: string | null;
  target: { kind: 'board' | 'thread' | 'post' | 'subject'; id: string };
};
export type WorkbenchDirectoryItem = { id: string; title: string | null };
export type WorkbenchReadState = 'ready' | 'denied' | 'unavailable' | 'stale';
export type WorkbenchRead = PrivateReaderRead & {
  readKey: string;
  generation: string;
  search: WorkbenchSearch;
  state: WorkbenchReadState;
  realms: WorkbenchDirectoryItem[];
  realmsNext: string | null;
  boards: WorkbenchDirectoryItem[];
  boardsNext: string | null;
  cases: WorkbenchCase[];
  next: string | null;
};
export type WorkbenchNativeSource = {
  realms: (cursor?: string) => Promise<{ items: WorkbenchDirectoryItem[]; next: string | null }>;
  boards: (realmId: string, cursor?: string) => Promise<{ items: WorkbenchDirectoryItem[]; next: string | null }>;
  boardReports: (
    boardId: string,
    cursor: string | undefined,
    selection: {
      status: 'pending' | 'resolved';
      targetKind: WorkbenchSearch['targetKind'];
      order: WorkbenchSearch['order'];
    },
  ) => Promise<{ reports: Report[]; next: string | null }>;
  boardAppeals: (boardId: string, cursor?: string) => Promise<{ appeals: Appeal[]; next: string | null }>;
  catalogueReports: (
    cursor: string | undefined,
    selection: { status: 'pending' | 'resolved'; order: WorkbenchSearch['order'] },
  ) => Promise<{
    reports: Array<Omit<Report, 'target'> & { target: { kind: 'subject'; id: string } }>;
    next: string | null;
  }>;
};

class WorkbenchReadFailure extends Error {
  constructor(readonly state: Exclude<WorkbenchReadState, 'ready'>) {
    super(state);
  }
}

function listFailure(status: number, value: unknown): Exclude<WorkbenchReadState, 'ready'> {
  const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
  if ((status === 400 && code === 'invalid_cursor') || (status === 409 && code === 'stale_cursor')) return 'stale';
  if ([401, 403, 404].includes(status)) return 'denied';
  return 'unavailable';
}

function emptyRead(
  search: WorkbenchSearch,
  origin: PrivateReaderOrigin | null,
  state: WorkbenchReadState,
): WorkbenchRead {
  return {
    readKey: workbenchReadKey(search),
    generation: crypto.randomUUID(),
    search,
    state,
    readerOrigin: origin,
    realms: [],
    realmsNext: null,
    boards: [],
    boardsNext: null,
    cases: [],
    next: null,
  };
}

function reportCase(
  report: Report | (Omit<Report, 'target'> & { target: { kind: 'subject'; id: string } }),
): WorkbenchCase {
  return {
    kind: 'report',
    id: report.id,
    createdAt: report.createdAt,
    outcome: report.outcome,
    reason: report.reason,
    evidence: report.evidence,
    statement: null,
    decisionId: null,
    target: report.target,
  };
}

function appealCase(appeal: Appeal): WorkbenchCase | null {
  const target = appeal.decision.target;
  if (!target) return null;
  return {
    kind: 'appeal',
    id: appeal.id,
    createdAt: appeal.createdAt,
    outcome: null,
    reason: null,
    evidence: null,
    statement: appeal.statement,
    decisionId: appeal.decisionId,
    target,
  };
}

function bounded<T>(items: readonly T[], limit = WORKBENCH_PAGE_SIZE): T[] {
  if (items.length > limit) throw new WorkbenchReadFailure('unavailable');
  return [...items];
}

export async function readWorkbench(
  source: WorkbenchNativeSource,
  search: WorkbenchSearch,
): Promise<Omit<WorkbenchRead, keyof PrivateReaderRead | 'generation'>> {
  const scope = workbenchScope(search);
  const identity = { readKey: workbenchReadKey(search), search };
  const idle = {
    realms: [] as WorkbenchDirectoryItem[],
    realmsNext: null as string | null,
    boards: [] as WorkbenchDirectoryItem[],
    boardsNext: null as string | null,
    cases: [] as WorkbenchCase[],
    next: null as string | null,
  };
  if (scope.kind === 'none') {
    const page = await source.realms(search.realmsCursor);
    return { ...identity, state: 'ready', ...idle, realms: bounded(page.items, 50), realmsNext: page.next };
  }
  if (scope.kind === 'realm') {
    const page = await source.boards(scope.realmId, search.boardsCursor);
    return { ...identity, state: 'ready', ...idle, boards: bounded(page.items), boardsNext: page.next };
  }
  if (scope.kind === 'catalogue' && search.queue === 'appeals') {
    return { ...identity, state: 'ready', ...idle };
  }
  // Content owns the private board history reader. It is not exposed by the
  // delivered client yet, so never synthesize a page from report or appeal lists.
  if (scope.kind === 'board' && search.history) {
    return { ...identity, state: 'unavailable', ...idle };
  }
  if (scope.kind === 'catalogue') {
    const page = await source.catalogueReports(search.cursor, {
      status: search.queue === 'resolved' ? 'resolved' : 'pending',
      order: search.order,
    });
    return { ...identity, state: 'ready', ...idle, cases: bounded(page.reports).map(reportCase), next: page.next };
  }
  if (search.queue === 'appeals') {
    const page = await source.boardAppeals(scope.boardId, search.cursor);
    return {
      ...identity,
      state: 'ready',
      ...idle,
      cases: bounded(page.appeals).flatMap((appeal) => {
        const item = appealCase(appeal);
        return item ? [item] : [];
      }),
      next: page.next,
    };
  }
  const page = await source.boardReports(scope.boardId, search.cursor, {
    status: search.queue === 'resolved' ? 'resolved' : 'pending',
    targetKind: search.targetKind,
    order: search.order,
  });
  return { ...identity, state: 'ready', ...idle, cases: bounded(page.reports).map(reportCase), next: page.next };
}

const auth = (authorization: string) => ({ headers: { authorization }, fetch: { cache: 'no-store' as const } });

function nativeSource(client: KernelClient, authorization: string): WorkbenchNativeSource {
  const headers = auth(authorization);
  return {
    async realms(cursor) {
      const result = await client.me.realms.get({ query: cursor ? { cursor } : {}, ...headers });
      if (result.error) throw new WorkbenchReadFailure(listFailure(result.status, result.error.value));
      return {
        items: (result.data?.items ?? []).map((item) => ({ id: item.realmId, title: item.name })),
        next: result.data?.next ?? null,
      };
    },
    async boards(realmId, cursor) {
      const result = await client.realms({ realmId }).boards.get({
        ...headers,
        query: { limit: WORKBENCH_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      if (result.error) throw new WorkbenchReadFailure(listFailure(result.status, result.error.value));
      return {
        items: (result.data?.items ?? []).map((item) => ({ id: item.id, title: item.title })),
        next: result.data?.next ?? null,
      };
    },
    async boardReports(boardId, cursor, selection) {
      const result = await client.boards({ id: boardId }).reports.get({
        ...headers,
        query: { ...selection, limit: WORKBENCH_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      if (result.error) throw new WorkbenchReadFailure(listFailure(result.status, result.error.value));
      if (!result.data) throw new WorkbenchReadFailure('unavailable');
      return readModerationReports(
        {
          boardReports: async () => result.data,
          threadReports: async () => ({ reports: [], next: null }),
          postReports: async () => ({ reports: [], next: null }),
        },
        { boardId, status: selection.status, targetKind: selection.targetKind, order: selection.order },
      );
    },
    async boardAppeals(boardId, cursor) {
      const result = await client.boards({ id: boardId }).appeals.get({
        ...headers,
        query: { limit: WORKBENCH_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      if (result.error) throw new WorkbenchReadFailure(listFailure(result.status, result.error.value));
      if (!result.data) throw new WorkbenchReadFailure('unavailable');
      return readModerationAppeals(
        {
          boardAppeals: async () => result.data as { appeals: Appeal[]; next: string | null },
          threadAppeals: async () => ({ appeals: [], next: null }),
        },
        { boardId },
      );
    },
    async catalogueReports(cursor, selection) {
      const result = await catalogueReportsClient(client).catalogue.reports.get({
        query: {
          limit: WORKBENCH_PAGE_SIZE,
          status: selection.status,
          order: selection.order,
          targetKind: 'subject',
          ...(cursor ? { cursor } : {}),
        } as { limit: number; cursor?: string },
        headers: { authorization },
      });
      if (result.error) throw new WorkbenchReadFailure(listFailure(result.status, result.error.value));
      if (!result.data) throw new WorkbenchReadFailure('unavailable');
      return {
        reports: result.data.reports.flatMap((report) =>
          report.target.kind === 'subject'
            ? [
                {
                  id: report.id,
                  target: { kind: 'subject' as const, id: report.target.id },
                  revisionId: report.revisionId,
                  reason: report.reason,
                  evidence: report.evidence,
                  createdAt: report.createdAt,
                  outcome: report.outcome,
                  resolvedAt: report.resolvedAt,
                },
              ]
            : [],
        ),
        next: result.data.next,
      };
    },
  };
}

export async function readWorkbenchPage(
  client: KernelClient,
  search: WorkbenchSearch,
  authorization: string,
  readerOrigin: PrivateReaderOrigin,
): Promise<WorkbenchRead> {
  try {
    const page = await readWorkbench(nativeSource(client, authorization), search);
    return { ...page, generation: crypto.randomUUID(), readerOrigin };
  } catch (error) {
    return emptyRead(search, readerOrigin, error instanceof WorkbenchReadFailure ? error.state : 'unavailable');
  }
}

export const loadWorkbench = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    workbenchSearch(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
  )
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
    if (!authorization || !readerOrigin) return emptyRead(data, null, 'denied');
    return readWorkbenchPage(kernelClient(), data, authorization, readerOrigin);
  });

export async function prepareWorkbenchRead(
  cache: QueryClient,
  search: WorkbenchSearch,
  read: (search: WorkbenchSearch) => Promise<WorkbenchRead>,
  signal: AbortSignal,
): Promise<WorkbenchRead> {
  const original = workbenchSearch(search);
  const page = await preparePrivateReaderRead(cache, workbenchReadKey(original), () => read(original), signal);
  return page.readerBinding.retired || !page.readerOrigin
    ? {
        ...emptyRead(original, page.readerOrigin ?? null, page.readerBinding.retired ? 'denied' : 'unavailable'),
        readerBinding: page.readerBinding,
      }
    : page;
}

export function workbenchQueueScope(
  search: WorkbenchSearch,
): Extract<WorkbenchScope, { kind: 'board' | 'catalogue' }> | null {
  const scope = workbenchScope(search);
  return scope.kind === 'board' || scope.kind === 'catalogue' ? scope : null;
}
