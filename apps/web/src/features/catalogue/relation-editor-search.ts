import { pickText } from '@rezics/composition';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import type { SuggestionResult } from '../../search/suggestions';
import { coverOf, coverSubject } from '../../media/summary';
import { hitYear } from '../../search/results';

/** The existing public suggestion BFF supplies summaries in one response. Native proposal validation owns targets. */
export async function relationTargetSearch(
  text: string,
  signal: AbortSignal,
  locale: string,
): Promise<EntityPickerSubject[]> {
  const response = await fetch(
    `/api/search/suggestions?q=${encodeURIComponent(text)}&locale=${encodeURIComponent(locale)}`,
    { signal },
  );
  if (!response.ok) throw new Error('Suggestions unavailable');
  const result = (await response.json()) as SuggestionResult;
  return result.subjects.map((subject) => {
    const title = pickText(subject.labels, locale).text;
    return {
      id: subject.id,
      title,
      types: [
        subject.type,
        ...coverSubject(subject.id, title, subject.summary, subject.type).types.filter((type) => type !== subject.type),
      ],
      typeLabel: pickText(result.types[subject.type] ?? {}, locale).text,
      year: hitYear(subject.facts) ?? null,
      cover: coverOf(subject.summary),
    };
  });
}
