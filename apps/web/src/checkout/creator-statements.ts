import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { UUID } from './price';
import type { StripeMoneyUnit } from './money-schema';

export const STATEMENT_PAGE_SIZE = 20;
type NativePage = NonNullable<Awaited<ReturnType<KernelClient['payoutStatements']['get']>>['data']>;
type StatementApi = ReturnType<KernelClient['payoutStatements']>;
type NativeLines = NonNullable<Awaited<ReturnType<StatementApi['lines']['get']>>['data']>;
export type CreatorStatement = NativePage['payoutStatements'][number] & { moneyUnit?: StripeMoneyUnit | null };
export type CreatorStatementLine = NativeLines['lines'][number] & { moneyUnit?: StripeMoneyUnit | null };
export type StatementFailure = { kind: 'denied' | 'unavailable' | 'error' | 'stale' };
export type CreatorStatementsData = ({ kind: 'ready' } & NativePage) | StatementFailure;
export type CreatorLinesData = ({ kind: 'ready' } & NativeLines) | StatementFailure;
export type CreatorStatementData =
  | { kind: 'ready'; statement: CreatorStatement; lines: CreatorLinesData }
  | StatementFailure;
export type StatementSearch = { cursor?: string };
export type StatementDetailSearch = StatementSearch & { from?: string };

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

function failure(status: number): StatementFailure {
  if (status === 401 || status === 403 || status === 404) return { kind: 'denied' };
  if (status === 409) return { kind: 'stale' };
  if (status >= 500) return { kind: 'unavailable' };
  return { kind: 'error' };
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

/** One native owner-self page. No creator selector, earnings calculation or per-row reads. */
export async function loadCreatorStatements(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: StatementSearch,
): Promise<CreatorStatementsData> {
  try {
    const query = statementSearch(input);
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    const result = await client.payoutStatements.get({
      query: { limit: STATEMENT_PAGE_SIZE, ...query },
      headers: { authorization },
    });
    if (result.error) return failure(result.status);
    const page = result.data;
    if (
      !page ||
      !Array.isArray(page.payoutStatements) ||
      page.payoutStatements.length > STATEMENT_PAGE_SIZE ||
      !page.payoutStatements.every(validStatement) ||
      !nextCursor(page.next)
    )
      return { kind: 'unavailable' };
    return { kind: 'ready', payoutStatements: page.payoutStatements, next: page.next };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The native point read and lines route each enforce current creator equality and permission. */
export async function loadCreatorStatement(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; cursor?: string },
): Promise<CreatorStatementData> {
  try {
    const { id, ...query } = detailInput(input);
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    const api = client.payoutStatements({ statementId: id });
    const result = await api.get({ headers: { authorization } });
    if (result.error) return failure(result.status);
    const statement = result.data?.statement;
    if (!statement || !validStatement(statement) || statement.id !== id) return { kind: 'unavailable' };
    let lines: CreatorLinesData;
    try {
      const result = await api.lines.get({
        query: { limit: STATEMENT_PAGE_SIZE, ...query },
        headers: { authorization },
      });
      if (result.error) {
        lines = failure(result.status);
        // A permission change between the two reads must conceal the entire inspector.
        if (lines.kind === 'denied') return lines;
      } else {
        const page = result.data;
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
    return { kind: 'ready', statement, lines };
  } catch {
    return { kind: 'unavailable' };
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
