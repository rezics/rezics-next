import type { QueryClient } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { preparedPrivateReaderOrigin, type PrivateReaderOrigin } from './private-reader-origin';
import { preparePrivateReaderRead, type PrivateReaderRead } from './private-reader-lifetime';

export const CATALOGUE_REPORTS_LIMIT = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CatalogueReport = {
  id: string;
  target: { kind: 'subject'; id: string };
  revisionId: string | null;
  reason: string;
  evidence: string | null;
  createdAt: string;
  outcome: 'actioned' | 'dismissed' | null;
  resolvedAt: string | null;
};
export type CatalogueReportsResult =
  | { state: 'loaded'; reports: CatalogueReport[]; next: string | null }
  | { state: 'denied' | 'error' | 'stale'; reports: []; next: null };
export type CatalogueReportsRead = PrivateReaderRead & {
  cursor: string | null;
  readerOrigin: PrivateReaderOrigin | null;
  result: CatalogueReportsResult;
};
export type CatalogueReportInput = { cursor?: string };
export type CatalogueReportsReader = (input: CatalogueReportInput) => Promise<CatalogueReportsRead>;

export const catalogueReportsReadKey = (cursor?: string) => JSON.stringify(['catalogue-reports', cursor ?? '']);

function codeOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function pageFailure(status: number, error: unknown): CatalogueReportsResult['state'] {
  const code = codeOf(error);
  if ((status === 400 && code === 'invalid_cursor') || (status === 409 && code === 'stale_cursor')) return 'stale';
  if ([401, 403, 404].includes(status)) return 'denied';
  return 'error';
}

function emptyRead(cursor: string | undefined, readerOrigin: PrivateReaderOrigin | null, state: 'denied' | 'error' | 'stale'):
  CatalogueReportsRead {
  return { cursor: cursor ?? null, readerOrigin, result: { state, reports: [], next: null } };
}

/** Use the native Global catalogue page and retain only the report fields the moderator needs. */
export async function readCatalogueReports(
  client: KernelClient,
  input: CatalogueReportInput,
  authorization: string | null,
  readerOrigin: PrivateReaderOrigin | null,
): Promise<CatalogueReportsRead> {
  if (!authorization || !readerOrigin) return emptyRead(input.cursor, null, 'denied');
  try {
    const result = await client.catalogue.reports.get({
      query: { limit: CATALOGUE_REPORTS_LIMIT, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
      headers: { authorization },
    });
    if (result.error) return emptyRead(input.cursor, readerOrigin, pageFailure(result.status, result.error.value));
    if (!result.data) return emptyRead(input.cursor, readerOrigin, 'error');
    const reports = result.data.reports.flatMap((report): CatalogueReport[] =>
      report.target.kind === 'subject'
        ? [
            {
              id: report.id,
              target: { kind: 'subject', id: report.target.id },
              revisionId: report.revisionId,
              reason: report.reason,
              evidence: report.evidence,
              createdAt: report.createdAt,
              outcome: report.outcome,
              resolvedAt: report.resolvedAt,
            },
          ]
        : [],
    );
    return {
      cursor: input.cursor ?? null,
      readerOrigin,
      result: { state: 'loaded', reports, next: result.data.next },
    };
  } catch {
    return emptyRead(input.cursor, readerOrigin, 'error');
  }
}

/** Current Subject content comes from its ordinary exact read; redirects and refusals stay unavailable. */
export type CatalogueSubjectResult =
  | { state: 'loaded'; subject: { id: string; title: string; type: string }; report?: CatalogueReport | null }
  | { state: 'unavailable' | 'error' };
export type CatalogueSubjectRead = PrivateReaderRead & {
  subjectId: string;
  readerOrigin: PrivateReaderOrigin | null;
  result: CatalogueSubjectResult;
};
export type CatalogueSubjectReader = (subjectId: string, reportId: string) => Promise<CatalogueSubjectRead>;

export async function readCatalogueSubject(
  client: KernelClient,
  subjectId: string,
  reportId: string,
  authorization: string | null,
  readerOrigin: PrivateReaderOrigin | null,
): Promise<CatalogueSubjectRead> {
  if (!uuid.test(subjectId) || !uuid.test(reportId) || !authorization || !readerOrigin)
    return { subjectId, readerOrigin: null, result: { state: 'unavailable' } };
  try {
    const [subjectResult, reportsResult] = await Promise.all([
      client.subjects({ id: subjectId }).get({
        headers: { authorization },
        fetch: { redirect: 'manual' },
      }),
      client.subjects({ id: subjectId }).reports.get({
        query: { limit: CATALOGUE_REPORTS_LIMIT, order: 'newest', status: 'all', targetKind: 'subject' },
        headers: { authorization },
      }),
    ]);
    if (reportsResult.error) {
      return {
        subjectId,
        readerOrigin,
        result: { state: [401, 403, 404].includes(reportsResult.status) ? 'unavailable' : 'error' },
      };
    }
    const subject = subjectResult.data?.subject;
    if (subjectResult.status === 200 && !subjectResult.error && subject?.id === subjectId && reportsResult.data) {
      const selectedReport = reportsResult.data.reports.find(
        (report) => report.id === reportId && report.target.kind === 'subject' && report.target.id === subjectId,
      );
      return {
        subjectId,
        readerOrigin,
        result: {
          state: 'loaded',
          subject: { id: subject.id, title: subject.title, type: subject.type },
          report: selectedReport
            ? {
                id: selectedReport.id,
                target: { kind: 'subject', id: subjectId },
                revisionId: selectedReport.revisionId,
                reason: selectedReport.reason,
                evidence: selectedReport.evidence,
                createdAt: selectedReport.createdAt,
                outcome: selectedReport.outcome,
                resolvedAt: selectedReport.resolvedAt,
              }
            : null,
        },
      };
    }
    return {
      subjectId,
      readerOrigin,
      result: { state: subjectResult.status >= 500 ? 'error' : 'unavailable' },
    };
  } catch {
    return { subjectId, readerOrigin, result: { state: 'error' } };
  }
}

function validateCatalogueReportInput(input: unknown): CatalogueReportInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { cursor: '\u0000invalid' };
  const cursor = (input as Record<string, unknown>).cursor;
  if (cursor === undefined) return {};
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4096 ? { cursor } : { cursor: '\u0000invalid' };
}

async function catalogueReportsForRequest(data: CatalogueReportInput): Promise<CatalogueReportsRead> {
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
  if (data.cursor === '\u0000invalid') return emptyRead(undefined, readerOrigin, 'stale');
  return readCatalogueReports(kernelClient(), data, authorization, readerOrigin);
}

export const loadCatalogueReports = createServerFn({ method: 'GET' })
  .validator(validateCatalogueReportInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return catalogueReportsForRequest(data);
  });

function validateSubjectRead(input: unknown): { subjectId: string; reportId: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Subject');
  const { subjectId, reportId } = input as Record<string, unknown>;
  if (typeof subjectId !== 'string' || !uuid.test(subjectId) || typeof reportId !== 'string' || !uuid.test(reportId))
    throw new Error('Invalid Subject report');
  return { subjectId, reportId };
}

export const loadCatalogueSubject = createServerFn({ method: 'GET' })
  .validator(validateSubjectRead)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
    return readCatalogueSubject(kernelClient(), data.subjectId, data.reportId, authorization, readerOrigin);
  });

export async function prepareCatalogueReportsRead(
  cache: QueryClient,
  cursor: string | undefined,
  read: CatalogueReportsReader,
  signal?: AbortSignal,
): Promise<CatalogueReportsRead & { readerBinding: NonNullable<CatalogueReportsRead['readerBinding']> }> {
  return preparePrivateReaderRead(cache, catalogueReportsReadKey(cursor), () => read(cursor ? { cursor } : {}), signal);
}
