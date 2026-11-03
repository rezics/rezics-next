import type { QueryClient } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { notFound } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { preparedPrivateReaderOrigin, type PrivateReaderOrigin } from './private-reader-origin';
import {
  preparePrivateReaderRead,
  privateReaderSessionSource,
  type PrivateReaderRead,
} from './private-reader-lifetime';

import { enrichModerationTargets, type ModerationEvidence } from './target-context';

export const MODERATION_REPORTS_PAGE_SIZE = 20;
export type ReportSelection = {
  status: 'all' | 'pending' | 'resolved';
  targetKind: 'all' | 'board' | 'thread' | 'post';
  order: 'newest' | 'oldest';
};
export const DEFAULT_REPORT_SELECTION: ReportSelection = { status: 'all', targetKind: 'all', order: 'newest' };
export function reportSelection(input: Record<string, unknown>): ReportSelection {
  return {
    status: input.status === 'pending' || input.status === 'resolved' ? input.status : 'all',
    targetKind:
      input.targetKind === 'board' || input.targetKind === 'thread' || input.targetKind === 'post'
        ? input.targetKind
        : 'all',
    order: input.order === 'oldest' ? 'oldest' : 'newest',
  };
}
export type ReportReadInput = Partial<ReportSelection> & {
  boardId: string;
  threadId?: string;
  postId?: string;
  cursor?: string;
};
export function moderationReportInput(boardId: string, search: Record<string, unknown>): ReportReadInput {
  return {
    boardId,
    ...reportSelection(search),
    ...(typeof search.thread === 'string' && search.thread.length <= 128 ? { threadId: search.thread } : {}),
    ...(typeof search.post === 'string' && search.post.length <= 128 ? { postId: search.post } : {}),
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 && search.cursor
      ? { cursor: search.cursor }
      : {}),
  };
}
/** A response may render only for the route generation that requested it. */
export function reportPageIsCurrent(page: { readKey: string }, input: ReportReadInput): boolean {
  return page.readKey === reportReadKey(input);
}
/** The route uses the same normalized identity as the read, including empty/sparse pages. */
export function reportReadKey(input: ReportReadInput): string {
  const selection = reportSelection(input);
  return JSON.stringify([
    input.boardId,
    input.threadId ?? '',
    input.postId ?? '',
    input.cursor ?? '',
    selection.status,
    selection.targetKind,
    selection.order,
  ]);
}
export type ReportReadState = 'ready' | 'loading' | 'denied' | 'error' | 'stale';
class ReportReadFailure extends Error {
  constructor(readonly state: 'denied' | 'error' | 'stale') {
    super(state);
  }
}
function reportResult(result: {
  data?: NativeReportList | null;
  error?: { status: number; value: unknown } | null;
}): ReportPage {
  if (result.error) {
    const { status, value } = result.error;
    if (
      value &&
      typeof value === 'object' &&
      'code' in value &&
      ((status === 400 && value.code === 'invalid_cursor') || (status === 409 && value.code === 'stale_cursor'))
    )
      throw new ReportReadFailure('stale');
    throw new ReportReadFailure([401, 403, 404].includes(status) ? 'denied' : 'error');
  }
  if (!result.data) throw new ReportReadFailure('error');
  return { next: result.data.next, reports: publishedReports(result.data.reports) };
}
export type Report = {
  id: string;
  target: { kind: 'board' | 'thread' | 'post'; id: string };
  revisionId: string | null;
  reason: string;
  evidence: string | null;
  createdAt: string;
  outcome: 'actioned' | 'dismissed' | null;
  resolvedAt: string | null;
};
type ReportRecord = Omit<Report, 'target'> & { target: { kind: string; id: string } };
export type ReportPage = { reports: Report[]; next: string | null };
type NativeReportList = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['boards']>['reports']['get']>>['data']
>;
type ReportSourcePage = { reports: readonly ReportRecord[]; next: string | null };
export type ReportReadSource = {
  boardReports: (id: string, cursor?: string, selection?: ReportSelection) => Promise<ReportSourcePage>;
  threadReports: (id: string, cursor?: string, selection?: ReportSelection) => Promise<ReportSourcePage>;
  postReports: (id: string, cursor?: string, selection?: ReportSelection) => Promise<ReportSourcePage>;
};
export type ReportTargetReads = {
  post: (id: string) => Promise<ReportTargetValue | null>;
  thread: (id: string) => Promise<ReportTargetValue | null>;
  board: (id: string) => Promise<ReportTargetValue | null>;
};
export type ReportTargetValue =
  | null
  | string
  | number
  | boolean
  | DocumentSnapshot
  | ModerationEvidence
  | readonly ReportTargetValue[]
  | { readonly [key: string]: ReportTargetValue | undefined };
export type ResolvedReportTarget = { key: string; kind: Report['target']['kind']; value: ReportTargetValue | null };

/** Board/thread/post queues keep those kinds; subject reports stay on the catalogue reports surface. */
function publishedReports(reports: readonly ReportRecord[]): Report[] {
  return reports.flatMap(({ id, target, revisionId, reason, evidence, createdAt, outcome, resolvedAt }) =>
    target.kind === 'board' || target.kind === 'thread' || target.kind === 'post'
      ? [{ id, target, revisionId, reason, evidence, createdAt, outcome, resolvedAt }]
      : [],
  );
}

/** Keeps report records private and resolves repeated target identities with one existing read each. */
export async function readModerationReports(source: ReportReadSource, input: ReportReadInput): Promise<ReportPage> {
  const selection = reportSelection(input);
  const page = input.postId
    ? await source.postReports(input.postId, input.cursor, selection)
    : input.threadId
      ? await source.threadReports(input.threadId, input.cursor, selection)
      : await source.boardReports(input.boardId, input.cursor, selection);
  return { next: page.next, reports: publishedReports(page.reports) };
}

export async function resolveReportTargets(
  reports: Report[],
  reads: ReportTargetReads,
): Promise<ResolvedReportTarget[]> {
  const unique = new Map<string, Report['target']>();
  for (const report of reports) unique.set(`${report.target.kind}:${report.target.id}`, report.target);
  return Promise.all(
    [...unique].map(async ([key, target]) => ({
      key,
      kind: target.kind,
      value: await reads[target.kind](target.id).catch(() => null),
    })),
  );
}

export type ReportedRevision = { reportId: string; value: ReportTargetValue | null };

/** Exact revision reads are deduplicated, never inferred from a revision's route or ID. */
export async function resolveReportedRevisions(
  reports: Report[],
  read: (postId: string, revisionId: string) => Promise<ReportTargetValue | null>,
): Promise<ReportedRevision[]> {
  const reads = new Map<string, Promise<ReportTargetValue | null>>();
  return Promise.all(
    reports.map(async (report) => {
      if (!report.revisionId || report.target.kind !== 'post') return { reportId: report.id, value: null };
      const key = `${report.target.id}:${report.revisionId}`;
      let result = reads.get(key);
      if (!result) {
        result = read(report.target.id, report.revisionId).catch(() => null);
        reads.set(key, result);
      }
      return { reportId: report.id, value: await result };
    }),
  );
}

const auth = (authorization: string) => ({ headers: { authorization }, fetch: { cache: 'no-store' as const } });

export const loadModerationReports = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw notFound();
    const value = input as Record<string, unknown>;
    if (typeof value.boardId !== 'string' || value.boardId.length > 128) throw notFound();
    if (value.threadId !== undefined && (typeof value.threadId !== 'string' || value.threadId.length > 128))
      throw notFound();
    if (value.postId !== undefined && (typeof value.postId !== 'string' || value.postId.length > 128)) throw notFound();
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096))
      throw notFound();
    const selection = reportSelection(value);
    for (const key of ['status', 'targetKind', 'order'] as const)
      if (value[key] !== undefined && value[key] !== selection[key]) throw notFound();
    return {
      ...selection,
      boardId: value.boardId,
      ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
      ...(typeof value.postId === 'string' ? { postId: value.postId } : {}),
      ...(typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadModerationReportsRequest(getRequest(), env as Partial<SessionEnv>, data);
  });

/** Once-prepared production boundary; tests defer only the native/session transport. */
export async function loadModerationReportsRequest(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: ReportReadInput,
  client: () => KernelClient = kernelClient,
) {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
  if (!authorization || !readerOrigin) throw notFound();
  return readModerationReportPage(client(), data, authorization, readerOrigin.subject, readerOrigin);
}

/** Default native composition, also used by the focused transport-to-render regression. */
export async function readModerationReportPage(
  nativeClient: KernelClient,
  data: ReportReadInput,
  authorization: string,
  viewerId: string,
  readerOrigin?: PrivateReaderOrigin | null,
) {
  const client = nativeClient;
  const identity = {
    readerOrigin: readerOrigin ?? null,
    readKey: reportReadKey(data),
    viewerId,
    generation: crypto.randomUUID(),
    input: { ...data, ...reportSelection(data) },
  };
  try {
    const headers = auth(authorization);
    const page = await readModerationReports(
      {
        boardReports: async (id, cursor, selection) => {
          const result = await client.boards({ id }).reports.get({
            ...headers,
            query: { ...selection, limit: MODERATION_REPORTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          });
          return reportResult(result);
        },
        threadReports: async (id, cursor, selection) => {
          const result = await client.threads({ id }).reports.get({
            ...headers,
            query: { ...selection, limit: MODERATION_REPORTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          });
          return reportResult(result);
        },
        postReports: async (id, cursor, selection) => {
          const result = await client.posts({ id }).reports.get({
            ...headers,
            query: { ...selection, limit: MODERATION_REPORTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          });
          return reportResult(result);
        },
      },
      data,
    );
    if (page.reports.length > MODERATION_REPORTS_PAGE_SIZE) throw new ReportReadFailure('error');
    const targets = await resolveReportTargets(page.reports, {
      post: async (id) => {
        const result = await client.posts({ id }).get(headers);
        return result.error ? null : ((result.data as ReportTargetValue | null | undefined) ?? null);
      },
      thread: async (id) => {
        const result = await client.threads({ id }).get(headers);
        return result.error ? null : ((result.data as ReportTargetValue | null | undefined) ?? null);
      },
      board: async (id) => {
        const result = await client.boards({ id }).get(headers);
        return result.error ? null : ((result.data as ReportTargetValue | null | undefined) ?? null);
      },
    });
    const revisions = await resolveReportedRevisions(page.reports, async (postId, revisionId) => {
      const result = await nativeClient.posts({ id: postId }).revisions({ revisionId }).get(headers);
      return result.error ? null : (result.data ?? null);
    });
    const enriched = await enrichModerationTargets(
      nativeClient,
      targets,
      revisions,
      page.reports,
      authorization,
      viewerId,
    );
    return { ...page, ...enriched, ...identity, state: 'ready' as const };
  } catch (error) {
    return {
      reports: [],
      next: null,
      targets: [],
      revisions: [],
      ...identity,
      state: error instanceof ReportReadFailure ? error.state : ('error' as const),
    };
  }
}

export type PrivateReportPage = Awaited<ReturnType<typeof readModerationReportPage>> &
  PrivateReaderRead & {
    browserRevision?: number;
  };
type ReportSession = { state: string; subject?: string | null; csrfToken?: string | null };

/** Compatibility facade for callers observing the original Reports cache. */
export const reportSessionSource = privateReaderSessionSource;
export function reportViewerIsReady(session: ReportSession | undefined, viewerId: string): boolean {
  return !!viewerId && session?.state === 'signed-in' && session.subject === viewerId;
}

export async function prepareModerationReportRead(
  client: QueryClient,
  input: ReportReadInput,
  read: (input: ReportReadInput) => Promise<PrivateReportPage>,
  signal: AbortSignal,
): Promise<PrivateReportPage> {
  const original = Object.freeze({ ...input, ...reportSelection(input) });
  const page = await preparePrivateReaderRead(client, reportReadKey(original), () => read(original), signal);
  return page.readerBinding.retired || !page.readerOrigin
    ? {
        ...page,
        reports: [],
        targets: [],
        revisions: [],
        next: null,
        state: page.readerBinding.retired ? 'denied' : 'error',
      }
    : page;
}
