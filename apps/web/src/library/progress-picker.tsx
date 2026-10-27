import { pickText } from '@rezics/composition';
import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { coverOf, coverSubject } from '../media/summary';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { SuggestionResult } from '../search/suggestions';
import { hitYear } from '../search/results';
import type { LibrarySubject } from './reads';

export function pickerSubject(subject: LibrarySubject): EntityPickerSubject {
  return {
    id: subject.id,
    title: subject.label,
    types: subject.types,
    typeLabel: subject.typeLabel ?? '',
    cover: subject.cover,
  };
}

async function search(text: string, signal: AbortSignal): Promise<EntityPickerSubject[]> {
  const locale = getLocale();
  const response = await fetch(
    `/api/search/suggestions?q=${encodeURIComponent(text)}&locale=${encodeURIComponent(locale)}`,
    { signal },
  );
  if (!response.ok) throw new Error('Suggestions unavailable');
  const result = (await response.json()) as SuggestionResult;
  return result.subjects.map((subject) => ({
    id: subject.id,
    title: pickText(subject.labels, locale).text,
    types: coverSubject(subject.id, pickText(subject.labels, locale).text, subject.summary, subject.type).types,
    typeLabel: pickText(result.types[subject.type] ?? {}, locale).text,
    year: hitYear(subject.facts) ?? null,
    cover: coverOf(subject.summary),
  }));
}

export function ProgressPicker({
  value,
  onValueChange,
}: {
  value: readonly EntityPickerSubject[];
  onValueChange: (value: EntityPickerSubject[]) => void;
}) {
  return (
    <EntityPicker
      label={m.library_progress_subject()}
      search={search}
      src={coverSrc}
      value={value}
      onValueChange={onValueChange}
    />
  );
}
