import type { Release } from '../../subject/definitions';
import {
  admittedFieldCount,
  libraryDescriptor,
  libraryStateLabel,
  libraryStateOptions,
  singleManualProgress,
  storedStateIsHistorical,
  type LibraryChoices,
  type LibraryStateChoice,
  type ManualProgressMeasure,
} from '../profiles';
import { copyProfileState, type CopyProfile } from '../copies-profiles';
import { progressInputRules, type ProgressInputRules } from '../progress-profile';

export const MANGA_SERIES_TYPE = 'schema:ComicSeries';
export const MANGA_VOLUME_TYPE = 'schema:PublicationVolume';

export type MangaLibraryIdentity = 'series' | 'volume';

/** Series and volume keep distinct accepting types; a catalogue parent is never a volume profile. */
export function mangaLibraryIdentity(type: string): MangaLibraryIdentity | null {
  if (type === MANGA_SERIES_TYPE) return 'series';
  if (type === MANGA_VOLUME_TYPE) return 'volume';
  return null;
}

export function isMangaLibrarySubject(type: string): boolean {
  return mangaLibraryIdentity(type) !== null;
}

export type ConfiguredProfileCapabilities =
  | { state: 'unavailable' }
  | { state: 'unsupported'; identity: MangaLibraryIdentity | null }
  | {
      state: 'ready';
      identity: MangaLibraryIdentity | null;
      admittedFields: number;
      states: LibraryStateChoice[];
      copies: CopyProfile;
      measure: ManualProgressMeasure | undefined;
      measureRules: ProgressInputRules;
    };

function measureRules(release: Release, type: string, measure: ManualProgressMeasure | undefined): ProgressInputRules {
  return measure ? progressInputRules(release, type, measure.mode, measure.unit.id) : undefined;
}

/** Read the current released descriptor before any state, copy or progress control is offered. */
export function readConfiguredProfileCapabilities(
  release: Release | undefined,
  type: string,
  locale: string,
): ConfiguredProfileCapabilities {
  const identity = mangaLibraryIdentity(type);
  const descriptor = libraryDescriptor(release, type);
  if (descriptor.state === 'unavailable' || !release) return { state: 'unavailable' };
  if (descriptor.state === 'unsupported') return { state: 'unsupported', identity };
  const copies = copyProfileState(release, type, locale);
  if (copies.state !== 'ready')
    return {
      state: 'ready',
      identity,
      admittedFields: admittedFieldCount(descriptor.choices),
      states: libraryStateOptions(release, type, locale),
      copies: { kinds: [] },
      measure: singleManualProgress(descriptor.choices),
      measureRules: measureRules(release, type, singleManualProgress(descriptor.choices)),
    };
  const measure = singleManualProgress(descriptor.choices);
  return {
    state: 'ready',
    identity,
    admittedFields: admittedFieldCount(descriptor.choices),
    states: libraryStateOptions(release, type, locale),
    copies: copies.profile,
    measure,
    measureRules: measureRules(release, type, measure),
  };
}

export function historicalEntryLabel(
  release: Release,
  type: string,
  stateId: string,
  locale: string,
  fallback: string,
): string {
  return libraryStateLabel(release, type, stateId, locale)?.text ?? fallback;
}

export function entryMeaning(
  choices: LibraryChoices | undefined,
  stateId: string | undefined,
): 'absent' | 'historical' | 'current' {
  if (!stateId) return 'absent';
  if (!choices || storedStateIsHistorical(choices, stateId)) return 'historical';
  return 'current';
}
