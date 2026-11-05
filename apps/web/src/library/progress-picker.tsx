import { useCallback } from 'react';
import { pickText } from '@rezics/composition';
import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { coverOf, coverSubject } from '../media/summary';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { SuggestionResult } from '../search/suggestions';
import { hitYear } from '../search/results';
import type { LibrarySubject } from './reads';
import { displayLibraryTitle } from './title';

export type ProgressPickerSubject = EntityPickerSubject & { type?: string };

export function pickerSubject(subject: LibrarySubject): ProgressPickerSubject {
  return {
    id: subject.id,
    type: subject.type,
    title: displayLibraryTitle(subject.label, getLocale()).text,
    types: subject.types,
    typeLabel: subject.typeLabel ?? '',
    cover: subject.cover,
  };
}

async function search(text: string, signal: AbortSignal, isCurrent: () => boolean): Promise<ProgressPickerSubject[]> {
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new Error('Progress choice search retired');
  };
  check();
  const locale = getLocale();
  const response = await fetch(
    `/api/search/suggestions?q=${encodeURIComponent(text)}&locale=${encodeURIComponent(locale)}`,
    { signal },
  );
  check();
  if (!response.ok) throw new Error('Suggestions unavailable');
  const result = (await response.json()) as SuggestionResult;
  check();
  return result.subjects.map((subject) => ({
    type: subject.type,
    id: subject.id,
    title: pickText(subject.labels, locale).text,
    types: coverSubject(subject.id, pickText(subject.labels, locale).text, subject.summary, subject.type).types,
    typeLabel: pickText(result.types[subject.type] ?? {}, locale).text,
    year: hitYear(subject.facts) ?? null,
    cover: coverOf(subject.summary),
  }));
}

const publicChoice = () => true;

export function ProgressPicker({
  value,
  onValueChange,
  label = m.library_progress_subject(),
  isCurrent = publicChoice,
  disabled = false,
}: {
  value: readonly ProgressPickerSubject[];
  onValueChange: (value: ProgressPickerSubject[]) => void;
  label?: string;
  isCurrent?: () => boolean;
  disabled?: boolean;
}) {
  const guardedSearch = useCallback(
    (text: string, signal: AbortSignal) => search(text, signal, isCurrent),
    [isCurrent],
  );
  return (
    <EntityPicker
      label={label}
      disabled={disabled}
      search={guardedSearch}
      src={coverSrc}
      value={value}
      onValueChange={(next) => {
        if (isCurrent()) onValueChange(next);
      }}
    />
  );
}
