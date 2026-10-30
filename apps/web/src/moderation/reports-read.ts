import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { notFound } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export const MODERATION_REPORTS_PAGE_SIZE = 20;
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
export type ReportPage = { reports: Report[]; next: string | null };
export type ReportReadSource = {
  boardReports: (id: string, cursor?: string) => Promise<ReportPage>;
  threadReports: (id: string, cursor?: string) => Promise<ReportPage>;
  postReports: (id: string, cursor?: string) => Promise<ReportPage>;
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
  | ReportTargetValue[]
  | { [key: string]: ReportTargetValue };
export type ResolvedReportTarget = { key: string; kind: Report['target']['kind']; value: ReportTargetValue | null };

/** Keeps report records private and resolves repeated target identities with one existing read each. */
export async function readModerationReports(
  source: ReportReadSource,
  input: { boardId: string; threadId?: string; postId?: string; cursor?: string },
): Promise<ReportPage> {
  const page = input.postId
    ? await source.postReports(input.postId, input.cursor)
    : input.threadId
      ? await source.threadReports(input.threadId, input.cursor)
      : await source.boardReports(input.boardId, input.cursor);
  return {
    next: page.next,
    reports: page.reports.map(({ id, target, revisionId, reason, evidence, createdAt, outcome, resolvedAt }) => ({
      id,
      target,
      revisionId,
      reason,
      evidence,
      createdAt,
      outcome,
      resolvedAt,
    })),
  };
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

type Client = {
  boards: (params: { id: string }) => {
    reports: { get: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
    get: (options?: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  };
  threads: (params: { id: string }) => {
    reports: { get: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
    get: (options?: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  };
  posts: (params: { id: string }) => {
    reports: { get: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
    get: (options?: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  };
};
const auth = (authorization: string) => ({ headers: { authorization } });

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
    return {
      boardId: value.boardId,
      ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
      ...(typeof value.postId === 'string' ? { postId: value.postId } : {}),
      ...(typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }): Promise<{ reports: Report[]; next: string | null; targets: ResolvedReportTarget[] }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw notFound();
    const client = kernelClient() as unknown as Client;
    const headers = auth(authorization);
    const page = await readModerationReports(
      {
        boardReports: async (id, cursor) => {
          const result = await client
            .boards({ id })
            .reports.get({ ...headers, query: { limit: MODERATION_REPORTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
          if (result.error || !result.data) throw notFound();
          return result.data as ReportPage;
        },
        threadReports: async (id, cursor) => {
          const result = await client
            .threads({ id })
            .reports.get({ ...headers, query: { limit: MODERATION_REPORTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
          if (result.error || !result.data) throw notFound();
          return result.data as ReportPage;
        },
        postReports: async (id, cursor) => {
          const result = await client
            .posts({ id })
            .reports.get({ ...headers, query: { limit: MODERATION_REPORTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
          if (result.error || !result.data) throw notFound();
          return result.data as ReportPage;
        },
      },
      data,
    );
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
    return { ...page, targets };
  });
