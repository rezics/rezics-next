import type { KernelClient } from '@rezics/client';
import { kernelClient } from '../kernel/client.ts';

type SuggestResult = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;

export async function suggestSubjects(query: string): Promise<SuggestResult> {
  const result = await kernelClient().subjects.$suggest.get({ query: { q: query, limit: 8 } });
  if (result.error) throw new Error('Suggestions failed');
  return result.data as SuggestResult;
}
