import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { assertPublicCacheReadAllowed } from '../security/page-cache';
import { locales } from '../paraglide/runtime.js';
import { UUID } from './price';

export const STATEMENT_PAGE_SIZE = 20;
type NativePage = NonNullable<Awaited<ReturnType<KernelClient['payoutStatements']['get']>>['data']>;
type StatementApi = ReturnType<KernelClient['payoutStatements']>;
type NativeLines = NonNullable<Awaited<ReturnType<StatementApi['lines']['get']>>['data']>;
export type CreatorStatement = NativePage['payoutStatements'][number];
export type CreatorStatementLine = NativeLines['lines'][number];
export type StatementFailure = { kind: 'denied' | 'unavailable' | 'error' | 'stale' };
export type CreatorStatementsData = ({ kind: 'ready' } & NativePage) | StatementFailure;
export type CreatorLinesData = ({ kind: 'ready' } & NativeLines) | StatementFailure;
export type CreatorStatementData =
  | { kind: 'ready'; statement: CreatorStatement; lines: CreatorLinesData }
  | StatementFailure;
export type StatementSearch = { cursor?: string };
export type StatementDetailSearch = StatementSearch & { from?: string };

export type CreatorStatementsAddress =
  | { kind: 'list'; locale: string; cursor: string | null }
  | { kind: 'detail'; locale: string; id: string; cursor: string | null; from: string | null };
export type CreatorStatementsCurrentRead<T = CreatorStatementsData> = {
  sessionSubject: string | null;
  requested: CreatorStatementsAddress;
  page: T;
};
export type CreatorStatementCurrentRead = CreatorStatementsCurrentRead<CreatorStatementData>;
type PreparedRead<T> = { sessionSubject: string | null; page: T };

export function sameStatementsAddress(a: CreatorStatementsAddress, b: CreatorStatementsAddress): boolean {
  return (
    a.kind === b.kind &&
    a.locale === b.locale &&
    a.cursor === b.cursor &&
    (a.kind === 'list' || (b.kind === 'detail' && a.id === b.id && a.from === b.from))
  );
}

/** Metadata and rows must describe this same owner-self read, including an empty page. */
export function acceptsStatementsCurrent(
  value: CreatorStatementsCurrentRead<CreatorStatementsData | CreatorStatementData> | undefined,
  subject: string,
  address: CreatorStatementsAddress,
): boolean {
  if (!value || value.sessionSubject !== subject || !sameStatementsAddress(value.requested, address)) return false;
  const page = value.page;
  if (page.kind !== 'ready') return true;
  if (address.kind === 'list')
    return (
      'payoutStatements' in page &&
      page.payoutStatements.length <= STATEMENT_PAGE_SIZE &&
      nextCursor(page.next) &&
      page.payoutStatements.every((row) => validStatement(row) && row.creatorAccountId === subject)
    );
  return (
    'statement' in page &&
    validStatement(page.statement) &&
    page.statement.id === address.id &&
    page.statement.creatorAccountId === subject &&
    page.lines.kind !== 'denied' &&
    (page.lines.kind !== 'ready' ||
      (page.lines.lines.length <= STATEMENT_PAGE_SIZE &&
        nextCursor(page.lines.next) &&
        page.lines.lines.every((line) => validLine(line, page.statement))))
  );
}

function cursor(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096) throw notFound();
  return value;
}

export function statementSearch(search: Record<string, unknown>): StatementSearch {
  const value = cursor(search.cursor);
  return value ? { cursor: value } : {};
}

export function statementDetailSearch(search: Record<string, unknown>): StatementDetailSearch {
  const from = cursor(search.from);
  return { ...statementSearch(search), ...(from ? { from } : {}) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw notFound();
  return value as Record<string, unknown>;
}

function detailInput(value: unknown): { id: string; cursor?: string } {
  const input = object(value);
  if (typeof input.id !== 'string' || !UUID.test(input.id)) throw notFound();
  return { id: input.id, ...statementSearch(input) };
}

function failure(status: number, problem: unknown, paginated = false): StatementFailure {
  if (status === 401 || status === 403 || status === 404) return { kind: 'denied' };
  // Only the API that consumed a cursor can reject it. A point-read failure must
  // never discard the as-yet unread line page or the list return address.
  const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : null;
  if (paginated && status === 400 && code === 'invalid_cursor') return { kind: 'error' };
  if (paginated && status === 409 && code === 'stale_cursor') return { kind: 'stale' };
  return { kind: 'unavailable' };
}

const amounts = ['grossMinor', 'taxMinor', 'feeMinor', 'disputeFeeMinor', 'netReceiptsMinor'] as const;
const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nextCursor = (value: unknown): boolean =>
  value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4096);

function validStatement(row: CreatorStatement): boolean {
  return (
    !!row &&
    UUID.test(row.id) &&
    UUID.test(row.creatorAccountId) &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(row.period) &&
    typeof row.currency === 'string' &&
    row.currency.length > 0 &&
    ([...amounts, 'refundsMinor', 'chargebacksMinor', 'creatorShareMinor', 'rezicsShareMinor'] as const).every((key) =>
      Number.isSafeInteger(row[key]),
    ) &&
    typeof row.weightedNetMinor === 'string' &&
    /^-?\d+$/.test(row.weightedNetMinor) &&
    (row.state === 'open' || row.state === 'paid') &&
    (row.paidAt === null || timestamp(row.paidAt)) &&
    (row.paidReference === null || typeof row.paidReference === 'string') &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 1
  );
}

function validLine(row: CreatorStatementLine, statement: CreatorStatement): boolean {
  return (
    !!row &&
    row.statementId === statement.id &&
    row.creatorAccountId === statement.creatorAccountId &&
    row.currency === statement.currency &&
    row.period === statement.period &&
    typeof row.balanceTransactionId === 'string' &&
    row.balanceTransactionId.length > 0 &&
    UUID.test(row.orderId) &&
    UUID.test(row.offerId) &&
    timestamp(row.created) &&
    timestamp(row.recordedAt) &&
    ['charge', 'refund', 'refund_reversal', 'dispute', 'dispute_reversal'].includes(row.kind) &&
    amounts.every((key) => Number.isSafeInteger(row[key])) &&
    Number.isSafeInteger(row.royaltyBasisPoints)
  );
}

async function prepareStatementRead(request: Request, sessionEnv: Partial<SessionEnv>, current: boolean) {
  if (await prepareSession(request, sessionEnv)) return null;
  const authorization = viewerCredential(request);
  // Explicit bearer reads remain supported by the pure API, but cannot certify a browser session.
  const subject = request.headers.has('authorization') ? null : sessionSubject(request) || null;
  if (!authorization || (current && (!subject?.trim() || !/^Bearer \S+$/.test(authorization)))) return null;
  return { authorization, subject };
}

/** One native owner-self page. No creator selector, earnings calculation or per-row reads. */
export async function loadCreatorStatements(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: StatementSearch,
): Promise<CreatorStatementsData> {
  return (await loadStatementsBody(client, request, sessionEnv, input, false)).page;
}

async function loadStatementsBody(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: StatementSearch,
  current: boolean,
): Promise<PreparedRead<CreatorStatementsData>> {
  let subject: string | null = null;
  const finish = (page: CreatorStatementsData) => ({ sessionSubject: subject, page });
  try {
    const query = statementSearch(input);
    const prepared = await prepareStatementRead(request, sessionEnv, current);
    if (!prepared) return finish({ kind: 'denied' });
    const { authorization } = prepared;
    subject = prepared.subject;
    const result = await client.payoutStatements.get({
      query: { limit: STATEMENT_PAGE_SIZE, ...query },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error) return finish(failure(result.status, result.error.value, true));
    const page = result.data;
    if (
      !page ||
      !Array.isArray(page.payoutStatements) ||
      page.payoutStatements.length > STATEMENT_PAGE_SIZE ||
      !page.payoutStatements.every((row) => validStatement(row) && (!current || row.creatorAccountId === subject)) ||
      !nextCursor(page.next)
    )
      return finish({ kind: 'unavailable' });
    return finish({ kind: 'ready', payoutStatements: page.payoutStatements, next: page.next });
  } catch {
    return finish({ kind: 'unavailable' });
  }
}

/** The native point read and lines route each enforce current creator equality and permission. */
export async function loadCreatorStatement(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; cursor?: string },
): Promise<CreatorStatementData> {
  return (await loadStatementBody(client, request, sessionEnv, input, false)).page;
}

async function loadStatementBody(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; cursor?: string },
  current: boolean,
): Promise<PreparedRead<CreatorStatementData>> {
  let subject: string | null = null;
  const finish = (page: CreatorStatementData) => ({ sessionSubject: subject, page });
  try {
    const { id, ...query } = detailInput(input);
    const prepared = await prepareStatementRead(request, sessionEnv, current);
    if (!prepared) return finish({ kind: 'denied' });
    const { authorization } = prepared;
    subject = prepared.subject;
    const api = client.payoutStatements({ statementId: id });
    const result = await api.get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error) return finish(failure(result.status, result.error.value));
    const statement = result.data?.statement;
    if (
      !statement ||
      !validStatement(statement) ||
      statement.id !== id ||
      (current && statement.creatorAccountId !== subject)
    )
      return finish({ kind: 'unavailable' });
    let lines: CreatorLinesData;
    try {
      const result = await api.lines.get({
        query: { limit: STATEMENT_PAGE_SIZE, ...query },
        headers: { authorization },
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
      if (result.error) {
        lines = failure(result.status, result.error.value, true);
        // A permission change between the two reads must conceal the entire inspector.
        if (lines.kind === 'denied') return finish(lines);
      } else {
        const page = result.data;
        // Unrelated line provenance cannot certify this current inspector.
        if (current && page && Array.isArray(page.lines) && page.lines.some((line) => !validLine(line, statement)))
          return finish({ kind: 'unavailable' });
        lines =
          page &&
          Array.isArray(page.lines) &&
          page.lines.length <= STATEMENT_PAGE_SIZE &&
          page.lines.every((line) => validLine(line, statement)) &&
          nextCursor(page.next)
            ? { kind: 'ready', lines: page.lines, next: page.next }
            : { kind: 'unavailable' };
      }
    } catch {
      lines = { kind: 'unavailable' };
    }
    return finish({ kind: 'ready', statement, lines });
  } catch {
    return finish({ kind: 'unavailable' });
  }
}

export const readCreatorStatements = createServerFn({ method: 'GET' })
  .validator((value: unknown) => statementSearch(object(value)))
  .handler(async ({ data }): Promise<CreatorStatementsData> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    try {
      return await loadCreatorStatements(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    } catch {
      return { kind: 'unavailable' };
    }
  });

export const readCreatorStatement = createServerFn({ method: 'GET' })
  .validator(detailInput)
  .handler(async ({ data }): Promise<CreatorStatementData> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    try {
      return await loadCreatorStatement(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    } catch {
      return { kind: 'unavailable' };
    }
  });

function currentListInput(value: unknown) {
  const input = object(value);
  if (!locales.some((locale) => locale === input.locale)) throw notFound();
  return { locale: String(input.locale), ...statementSearch(input) };
}

function currentDetailInput(value: unknown) {
  const input = object(value);
  return { ...currentListInput(input), ...detailInput(input), ...statementDetailSearch(input) };
}

function freshStatementRequest() {
  const request = getRequest();
  assertPublicCacheReadAllowed(request, 'session');
  // Request-local associations from an earlier preparation cannot attest a new read.
  return new Request(request);
}

export const readCreatorStatementsCurrent = createServerFn({ method: 'GET' })
  .validator(currentListInput)
  .handler(async ({ data }): Promise<CreatorStatementsCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    const requested: CreatorStatementsAddress = { kind: 'list', locale: data.locale, cursor: data.cursor ?? null };
    try {
      const result = await loadStatementsBody(
        kernelClient(data.locale),
        freshStatementRequest(),
        env as Partial<SessionEnv>,
        data,
        true,
      );
      return { ...result, requested };
    } catch {
      return { sessionSubject: null, requested, page: { kind: 'unavailable' } };
    }
  });

export const readCreatorStatementCurrent = createServerFn({ method: 'GET' })
  .validator(currentDetailInput)
  .handler(async ({ data }): Promise<CreatorStatementCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    const requested: CreatorStatementsAddress = {
      kind: 'detail',
      locale: data.locale,
      id: data.id,
      cursor: data.cursor ?? null,
      from: data.from ?? null,
    };
    try {
      const result = await loadStatementBody(
        kernelClient(data.locale),
        freshStatementRequest(),
        env as Partial<SessionEnv>,
        data,
        true,
      );
      return { ...result, requested };
    } catch {
      return { sessionSubject: null, requested, page: { kind: 'unavailable' } };
    }
  });
