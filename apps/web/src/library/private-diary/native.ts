import type { KernelClient } from '@rezics/client';

export const PRIVATE_DIARY_PAGE_LIMIT = 25;
export const PRIVATE_DIARY_PAGE_BYTES = 65_536;

export type DiaryPage = NonNullable<
  Awaited<ReturnType<KernelClient['libraryDiary']['get']>>['data']
>;
export type ConsumptionSummary = NonNullable<
  Awaited<ReturnType<KernelClient['libraryConsumptionSummary']['get']>>['data']
>;

export type DiaryRead =
  | { kind: 'ready'; page: DiaryPage }
  | { kind: 'stale' | 'retired' | 'unavailable' };

export async function readDiaryPage(
  client: KernelClient,
  authorization: string,
  cursor?: string,
): Promise<DiaryRead> {
  const result = await client.libraryDiary.get({
    query: { limit: PRIVATE_DIARY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    headers: { authorization },
  });
  if (!result.error && result.data) return { kind: 'ready', page: result.data };
  if (result.status === 401) return { kind: 'retired' };
  return result.status === 409 ? { kind: 'stale' } : { kind: 'unavailable' };
}

export type SummaryRead = { kind: 'ready'; summary: ConsumptionSummary } | { kind: 'retired' | 'unavailable' };

export async function readConsumptionSummary(
  client: KernelClient,
  authorization: string,
): Promise<SummaryRead> {
  const result = await client.libraryConsumptionSummary.get({ headers: { authorization } });
  if (!result.error && result.data) return { kind: 'ready', summary: result.data };
  if (result.status === 401) return { kind: 'retired' };
  return { kind: 'unavailable' };
}

export async function cancelDiaryContinuation(
  client: KernelClient,
  authorization: string,
  continuation: string,
): Promise<'cancelled' | 'retired' | 'unavailable'> {
  const result = await client.libraryDiary.$cancel.post(
    { continuation },
    { headers: { authorization } },
  );
  if (result.status === 401) return 'retired';
  return !result.error && result.data?.cancelled ? 'cancelled' : 'unavailable';
}
