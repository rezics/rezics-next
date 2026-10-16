import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';

export type MangaLibraryPersona = Exclude<AnswerPersona, 'visitor'>;

export function mangaCollectionSample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const samples = record.personas[persona].filter(sample => sample.label === label);
  if (samples.length !== 1) throw new Error(`Expected one Manga answer: ${persona}/${label}`);
  return samples[0]!;
}

/** The Library route's completed visit, followed by the chapter control's reached command chain. */
export function mangaCollectionSelections(record: AnswerRecord, persona: MangaLibraryPersona, loading = false): RecordedSelection[] {
  const seen = new Set<string>();
  const library = record.personas[persona].filter(sample => {
    if (!sample.label.startsWith('library-')) return false;
    // React request caching coalesces these reads in the route. Outside a server request,
    // the recorder sees both calls; either unchanged answer supplies that exact request.
    const key = JSON.stringify([sample.method, sample.path, sample.body]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [
    ...library.map(sample => ({ label: sample.label,
      state: loading && sample.path.startsWith('/v1/me/shelves?') ? 'loading' as const : 'populated' as const })),
    ...['work-header-1', 'chapter-standing-1', 'chapter-inventory-1', 'chapter-selected-1',
      'chapter-mark-1', 'chapter-mark-2', 'chapter-after-mark-1', 'chapter-clear-1', 'chapter-clear-2',
      'chapter-after-clear-1', 'status-change-1', 'status-return-1'].map(label => ({
      label: mangaCollectionSample(record, persona, label).label, state: 'populated' as const })),
  ];
}

export type MangaWorkSurface = 'work-overview' | 'inventory-series' | 'inventory-volume1' | 'inventory-volume2';

/** Only answers reached by this actual Work frame and tab, with all request values retained. */
export function mangaWorkSelections(record: AnswerRecord, persona: AnswerPersona, surface: MangaWorkSurface): RecordedSelection[] {
  const samples = record.personas[persona].filter(sample => sample.label.startsWith(`${surface}-`));
  if (!samples.length) throw new Error(`Missing Manga Work visit: ${persona}/${surface}`);
  return samples.map(sample => ({ label: sample.label, state: sample.status >= 400 ? 'error' as const : 'populated' as const }));
}
