import type { KernelClient } from '@rezics/client';
import { kernelClient, requestLocale } from '../kernel/client.ts';
import { requestLanguages } from '../kernel/languages.ts';
import { readRelease } from '../subject/definitions.ts';
import type { SubjectHit } from './results.tsx';

type Suggested = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
type SuggestQuery = { q: string; limit: number; languages: string[] };

/**
 * The kernel's suggestions with the names of the types they carry, so the typeahead can print each suggestion's type
 * without reading the definitions release in the browser.
 */
export type SuggestionResult = Omit<Suggested, 'subjects'> & {
  subjects: (Suggested['subjects'][number] & Pick<SubjectHit, 'summary' | 'facts'>)[];
  types: Record<string, Record<string, string>>;
};

export async function suggestSubjects(query: string, request: Request): Promise<SuggestionResult> {
  const locale = new URL(request.url).searchParams.get('locale') ?? requestLocale(request);
  const languages = requestLanguages(locale ?? 'en');
  // The release is cached by digest; a failed read leaves the suggestions without type names.
  const [result, release] = await Promise.all([
    kernelClient(locale).subjects.$suggest.get({
      query: { q: query, limit: 8, languages } satisfies SuggestQuery as never,
    }),
    readRelease().catch(() => undefined),
  ]);
  if (result.error) throw new Error('Suggestions failed');
  const types: SuggestionResult['types'] = {};
  for (const subject of result.data.subjects)
    if (release && Object.hasOwn(release.types, subject.type))
      types[subject.type] = release.types[subject.type]?.labels ?? {};
  return { ...(result.data as Suggested), types } as SuggestionResult;
}
