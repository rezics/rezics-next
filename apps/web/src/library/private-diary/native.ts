import type { DiaryAddress } from './address';
import type { KernelClient } from '@rezics/client';
import { isPlatformClosedProblem } from '../../kernel/platform-closed';

export const PRIVATE_DIARY_PAGE_LIMIT = 25;
export const PRIVATE_DIARY_PAGE_BYTES = 65_536;

export type DiaryPage = NonNullable<Awaited<ReturnType<KernelClient['libraryDiary']['get']>>['data']>;
export type ConsumptionSummary = NonNullable<
  Awaited<ReturnType<KernelClient['libraryConsumptionSummary']['get']>>['data']
>;

export type DiaryReadFailure = { kind: 'retired' | 'denied' | 'closed' | 'unavailable' };

function readFailure(status: number, problem: unknown): DiaryReadFailure {
  if (status === 401) return { kind: 'retired' };
  if (isPlatformClosedProblem(status, problem)) return { kind: 'closed' };
  return { kind: status === 403 ? 'denied' : 'unavailable' };
}

export type DiaryRead = { kind: 'ready'; page: DiaryPage } | { kind: 'stale' } | DiaryReadFailure;

export async function readDiaryPage(
  client: KernelClient,
  authorization: string,
  cursor?: string,
  filter: Pick<DiaryAddress, 'year' | 'month'> = {},
): Promise<DiaryRead> {
  const result = await client.libraryDiary.get({
    query: {
      limit: PRIVATE_DIARY_PAGE_LIMIT,
      ...(filter.year === undefined ? {} : { year: filter.year }),
      ...(filter.month === undefined ? {} : { month: filter.month }),
      ...(cursor ? { cursor } : {}),
    },
    headers: { authorization },
  });
  if (!result.error && result.data) return { kind: 'ready', page: result.data };
  return result.status === 409 ? { kind: 'stale' } : readFailure(result.status, result.error?.value);
}

export type SummaryRead = { kind: 'ready'; summary: ConsumptionSummary } | DiaryReadFailure;

export async function readConsumptionSummary(client: KernelClient, authorization: string): Promise<SummaryRead> {
  const result = await client.libraryConsumptionSummary.get({ headers: { authorization } });
  if (!result.error && result.data) return { kind: 'ready', summary: result.data };
  return readFailure(result.status, result.error?.value);
}

export async function cancelDiaryContinuation(
  client: KernelClient,
  authorization: string,
  continuation: string,
): Promise<'cancelled' | 'retired' | 'unavailable'> {
  const result = await client.libraryDiary.$cancel.post({ continuation }, { headers: { authorization } });
  if (result.status === 401) return 'retired';
  return !result.error && result.data?.cancelled ? 'cancelled' : 'unavailable';
}

export const REPORTED_YEAR_SUMMARY_BYTES = 16_384;
export type ReportedYearSummary = NonNullable<
  Awaited<ReturnType<KernelClient['libraryReportedYearSummary']['get']>>['data']
>;
export type ReportedYearRead = { kind: 'ready'; value: ReportedYearSummary } | DiaryReadFailure;

export async function readReportedYearSummary(
  client: KernelClient,
  authorization: string,
  year: number,
): Promise<ReportedYearRead> {
  const result = await client.libraryReportedYearSummary.get({ query: { year }, headers: { authorization } });
  if (!result.error && result.data?.year === year) return { kind: 'ready', value: result.data };
  return readFailure(result.status, result.error?.value);
}
