import type { QueryClient } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { getLocale } from '../../paraglide/runtime.js';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { catalogueReportsClient } from '../catalogue-reports-client';
import { preparedPrivateReaderOrigin, type PrivateReaderOrigin } from '../private-reader-origin';
import {
  preparePrivateReaderRead,
  privateReaderSessionSource,
  type PrivateReaderRead,
} from '../private-reader-lifetime';
import { readModerationAppealPage, type Appeal, type AppealPage, type AppealProvenance } from '../appeals-read';
import { readModerationReports, type Report, type ResolvedReportTarget } from '../reports-read';
import { historySource, readWorkbenchHistory, type HistoryRead, type HistorySource } from '../workbench-history/read';
import {
  moderationDirectoryPage,
  nativeModerationDirectoryUnavailable,
  type ModerationDirectoryPage,
  type ModerationDirectorySource,
} from './directory';
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
  locale?: string;
  generation: string;
  search: WorkbenchSearch;
  state: WorkbenchReadState;
  realms: WorkbenchDirectoryItem[];
  realmsNext: string | null;
  boards: WorkbenchDirectoryItem[];
  boardsNext: string | null;
  directory?: ModerationDirectoryPage | undefined;
  cases: WorkbenchCase[];
  next: string | null;
  /** Original board reports from this read generation. Catalogue and appeals leave this empty. */
  reports: Report[];
  /** Original board appeals from this read generation. */
  appeals: Appeal[];
  selectedAppeal?: Appeal | null;
  provenance?: AppealProvenance;
  nativeSession?: string;
  /** Legacy presentation input; native appeal reads never hydrate current targets. */
  selectedTarget: ResolvedReportTarget | null;
  unavailableReason?: 'native-appeal-inspect';
  history?: HistoryRead | undefined;
};
export type WorkbenchReader = (search: WorkbenchSearch, signal?: AbortSignal) => Promise<WorkbenchRead>;

export type WorkbenchNativeSource = {
  history?: HistorySource;
  directory?: ModerationDirectorySource;
  /** Compatibility for older callers; discovery never calls either membership-derived source. */
  realms?: (cursor?: string) => Promise<{ items: WorkbenchDirectoryItem[]; next: string | null }>;
  boards?: (realmId: string, cursor?: string) => Promise<{ items: WorkbenchDirectoryItem[]; next: string | null }>;
  boardReports: (
    boardId: string,
    cursor: string | undefined,
    selection: {
      status: 'pending' | 'resolved';
      targetKind: WorkbenchSearch['targetKind'];
      order: WorkbenchSearch['order'];
    },
  ) => Promise<{ reports: Report[]; next: string | null }>;
  boardAppeals: (boardId: string, cursor?: string, inspect?: string) => Promise<AppealPage>;
  catalogueReports: (
    cursor: string | undefined,
    selection: { status: 'pending' | 'resolved'; order: WorkbenchSearch['order'] },
  ) => Promise<{
    reports: Array<Omit<Report, 'target'> & { target: { kind: 'subject'; id: string } }>;
    next: string | null;
  }>;
};

class WorkbenchReadFailure extends Error {
  constructor(
    readonly state: Exclude<WorkbenchReadState, 'ready'>,
    readonly reason?: 'native-appeal-inspect',
  ) {
    super(state);
  }
}

function boundedQueueContinuation(cursor: string | null): string | null {
  if (cursor !== null && (cursor.length === 0 || cursor.length > 4096)) throw new WorkbenchReadFailure('unavailable');
  return cursor;
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
    reports: [],
    appeals: [],
    selectedTarget: null,
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
  signal?: AbortSignal,
): Promise<Omit<WorkbenchRead, keyof PrivateReaderRead | 'generation'>> {
  signal?.throwIfAborted();
  const scope = workbenchScope(search);
  const identity = { readKey: workbenchReadKey(search), search };
  const idle = {
    realms: [] as WorkbenchDirectoryItem[],
    realmsNext: null as string | null,
    boards: [] as WorkbenchDirectoryItem[],
    boardsNext: null as string | null,
    cases: [] as WorkbenchCase[],
    next: null as string | null,
    reports: [] as Report[],
    appeals: [] as Appeal[],
    selectedTarget: null as ResolvedReportTarget | null,
  };
  if (scope.kind === 'none' || scope.kind === 'realm') {
    try {
      const page = await (source.directory ?? nativeModerationDirectoryUnavailable)(
        {
          limit: WORKBENCH_PAGE_SIZE,
          ...(search.directoryCursor ? { cursor: search.directoryCursor } : {}),
          ...(scope.kind === 'realm' ? { realmId: scope.realmId } : {}),
        },
        signal,
      );
      signal?.throwIfAborted();
      const directory = moderationDirectoryPage(page);
      signal?.throwIfAborted();
      return { ...identity, state: 'ready', ...idle, directory };
    } catch {
      signal?.throwIfAborted();
      return { ...identity, state: 'ready', ...idle, directory: { state: 'unavailable', items: [], next: null } };
    }
  }
  if (scope.kind === 'catalogue' && search.queue === 'appeals') {
    return { ...identity, state: 'unavailable', ...idle };
  }
  if (scope.kind === 'board' && search.history) {
    const history = source.history
      ? await readWorkbenchHistory(source.history, search)
      : { state: 'unavailable' as const, entries: [], next: null };
    return { ...identity, ...idle, state: history.state, history };
  }
  if (scope.kind === 'catalogue') {
    const page = await source.catalogueReports(search.cursor, {
      status: search.queue === 'resolved' ? 'resolved' : 'pending',
      order: search.order,
    });
    return { ...identity, state: 'ready', ...idle, cases: bounded(page.reports).map(reportCase), next: page.next };
  }
  if (search.queue === 'appeals') {
    const page = await source.boardAppeals(scope.boardId, search.cursor, search.case);
    const listed = bounded(page.appeals).flatMap((appeal) => {
      const item = appealCase(appeal);
      return item ? [{ item, appeal }] : [];
    });
    return {
      ...identity,
      state: 'ready',
      ...idle,
      cases: listed.map((entry) => entry.item),
      appeals: listed.map((entry) => entry.appeal),
      ...(page.selectedAppeal?.id === search.case ? { selectedAppeal: page.selectedAppeal } : {}),
      ...(page.provenance ? { provenance: page.provenance } : {}),
      ...(page.nativeSession ? { nativeSession: page.nativeSession } : {}),
      next: page.next,
    };
  }
  const page = await source.boardReports(scope.boardId, search.cursor, {
    status: search.queue === 'resolved' ? 'resolved' : 'pending',
    targetKind: search.targetKind,
    order: search.order,
  });
  const reports = bounded(page.reports);
  return {
    ...identity,
    state: 'ready',
    ...idle,
    cases: reports.map(reportCase),
    reports,
    next: page.next,
  };
}

const auth = (authorization: string, signal?: AbortSignal) => ({
  headers: { authorization },
  fetch: { cache: 'no-store' as const, ...(signal ? { signal } : {}) },
});

function nativeSource(
  client: KernelClient,
  authorization: string,
  origin: PrivateReaderOrigin | null,
  signal?: AbortSignal,
): WorkbenchNativeSource {
  const headers = auth(authorization, signal);
  return {
    history: historySource(client, authorization),
    directory: nativeModerationDirectoryUnavailable,
    async boardReports(boardId, cursor, selection) {
      const result = await client.boards({ id: boardId }).reports.get({
        ...headers,
        query: { ...selection, limit: WORKBENCH_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      if (result.error) throw new WorkbenchReadFailure(listFailure(result.status, result.error.value));
      if (!result.data) throw new WorkbenchReadFailure('unavailable');
      const page = await readModerationReports(
        {
          boardReports: async () => result.data,
          threadReports: async () => ({ reports: [], next: null }),
          postReports: async () => ({ reports: [], next: null }),
        },
        { boardId, status: selection.status, targetKind: selection.targetKind, order: selection.order },
      );
      return { ...page, next: boundedQueueContinuation(page.next) };
    },
    async boardAppeals(boardId, cursor, inspect) {
      const page = await readModerationAppealPage(
        client,
        { boardId, ...(cursor ? { cursor } : {}), ...(inspect ? { inspect } : {}) },
        authorization,
        origin?.subject ?? '',
        origin,
        signal,
      );
      if (page.state !== 'ready')
        throw new WorkbenchReadFailure(
          page.state === 'closed' ? 'denied' : page.state === 'stale' ? 'stale' : 'unavailable',
        );
      return page;
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
        ...headers,
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
        next: boundedQueueContinuation(result.data.next),
      };
    },
  };
}

export async function readWorkbenchPage(
  client: KernelClient,
  search: WorkbenchSearch,
  authorization: string,
  readerOrigin: PrivateReaderOrigin,
  signal?: AbortSignal,
): Promise<WorkbenchRead> {
  try {
    signal?.throwIfAborted();
    const page = await readWorkbench(nativeSource(client, authorization, readerOrigin, signal), search, signal);
    signal?.throwIfAborted();
    return { ...page, generation: crypto.randomUUID(), readerOrigin, locale: getLocale() };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...emptyRead(search, readerOrigin, error instanceof WorkbenchReadFailure ? error.state : 'unavailable'),
      ...(error instanceof WorkbenchReadFailure && error.reason ? { unavailableReason: error.reason } : {}),
    };
  }
}

export const loadWorkbench = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    workbenchSearch(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
  )
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    request.signal.throwIfAborted();
    await prepareSession(request, env as Partial<SessionEnv>);
    request.signal.throwIfAborted();
    const authorization = viewerCredential(request);
    const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
    request.signal.throwIfAborted();
    if (!authorization || !readerOrigin) return emptyRead(data, null, 'denied');
    return readWorkbenchPage(kernelClient(), data, authorization, readerOrigin, request.signal);
  });

export async function prepareWorkbenchRead(
  cache: QueryClient,
  search: WorkbenchSearch,
  read: WorkbenchReader,
  signal: AbortSignal,
): Promise<WorkbenchRead> {
  const original = Object.freeze(workbenchSearch(search));
  const locale = getLocale();
  // Observe successful replacements synchronously, before dispatch. A fetch-start event
  // leaves this incarnation intact; even an equal successful replacement retires it.
  const session = privateReaderSessionSource(cache);
  const revision = session.snapshot();
  const retired = new AbortController();
  const requestSignal = AbortSignal.any([signal, retired.signal]);
  const stop = session.subscribe(() => {
    if (session.snapshot() !== revision) retired.abort();
  });
  try {
    const page = await preparePrivateReaderRead(
      cache,
      workbenchReadKey(original),
      () => read(original, requestSignal),
      requestSignal,
    );
    requestSignal.throwIfAborted();
    const wrongLocale = getLocale() !== locale || (page.locale !== undefined && page.locale !== locale);
    return page.readerBinding.retired || !page.readerOrigin || wrongLocale
      ? {
          ...emptyRead(
            original,
            page.readerOrigin ?? null,
            page.readerBinding.retired || wrongLocale ? 'denied' : 'unavailable',
          ),
          locale,
          readerBinding: { ...page.readerBinding, retired: page.readerBinding.retired || wrongLocale },
        }
      : { ...page, locale };
  } finally {
    stop();
  }
}

export function workbenchQueueScope(
  search: WorkbenchSearch,
): Extract<WorkbenchScope, { kind: 'board' | 'catalogue' }> | null {
  const scope = workbenchScope(search);
  return scope.kind === 'board' || scope.kind === 'catalogue' ? scope : null;
}
