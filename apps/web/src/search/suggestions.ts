import type { KernelClient } from '@rezics/client';
import { kernelClient, requestLocale } from '../kernel/client.ts';

type SuggestResult = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;

export async function suggestSubjects(query: string, request: Request): Promise<SuggestResult> {
  const result = await kernelClient(
    new URL(request.url).searchParams.get('locale') ?? requestLocale(request),
  ).subjects.$suggest.get({ query: { q: query, limit: 8 } });
  if (result.error) throw new Error('Suggestions failed');
  return result.data as SuggestResult;
}
