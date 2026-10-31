import { pickText } from '@rezics/composition';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { coverOf, coverSubject } from '../media/summary';
import { getLocale } from '../paraglide/runtime.js';
import { hitYear } from '../search/results';
import type { SuggestionResult } from '../search/suggestions';

export class ContentSubjectSearchError extends Error {
  constructor(readonly reason: 'unavailable' | 'forbidden' | 'closed') {
    super('Suggestions unavailable');
  }
}

/** Discussions and reviews use the same bounded, authenticated suggestion route. */
export async function searchContentSubjects(text: string, signal: AbortSignal): Promise<EntityPickerSubject[]> {
  signal.throwIfAborted();
  const locale = getLocale();
  const response = await fetch(
    `/api/search/suggestions?q=${encodeURIComponent(text)}&locale=${encodeURIComponent(locale)}`,
    { signal },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new ContentSubjectSearchError(
      response.status === 403 && body?.code === 'platform_closed'
        ? 'closed'
        : response.status === 401 || response.status === 403
          ? 'forbidden'
          : 'unavailable',
    );
  }
  const result = (await response.json()) as SuggestionResult;
  signal.throwIfAborted();
  return result.subjects.map((subject) => {
    const title = pickText(subject.labels, locale).text;
    return {
      id: subject.id,
      title,
      types: coverSubject(subject.id, title, subject.summary, subject.type).types,
      typeLabel: pickText(result.types[subject.type] ?? {}, locale).text,
      year: hitYear(subject.facts) ?? null,
      cover: coverOf(subject.summary),
    };
  });
}

/** A query title is only a display hint; creation validates the reference natively. */
export function contentSubjectPreset(id: string, title: string): EntityPickerSubject {
  return { id, title, types: [], typeLabel: '', cover: null };
}
