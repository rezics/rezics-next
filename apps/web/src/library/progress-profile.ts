import { progressView } from './progress-label';
import type { LibraryProgressMode } from '@rezics/definitions';
import type { Release } from '../subject/definitions.ts';
import { libraryChoices, libraryProfile, libraryUnitLabel } from './profiles.ts';

export type ProgressPair = { mode: LibraryProgressMode; unit: string };

export function progressChoicesForType(release: Release, type: string, locale: string) {
  const choices = libraryChoices(release, type)?.progress.filter((choice) => choice.units.length > 0);
  if (!choices?.length) return undefined;
  return choices.map(({ mode, units }) => ({
    mode,
    units: units.map((unit) => ({
      id: unit.id,
      label: libraryUnitLabel(release, type, mode, unit.id, locale)?.text ?? '',
    })),
  }));
}

export function progressInputRules(release: Release, type: string, mode: LibraryProgressMode, unit: string) {
  const pair = libraryChoices(release, type)
    ?.progress.find((choice) => choice.mode === mode)
    ?.units.find((item) => item.id === unit);
  if (!pair) return undefined;
  return {
    ...(pair.minimum === undefined ? {} : { min: pair.minimum }),
    ...(pair.maximum === undefined ? {} : { max: pair.maximum }),
    step: pair.precision === undefined ? 'any' : String(10 ** -pair.precision),
    total: pair.totalPolicy ?? 'optional',
  };
}

export function progressPairLabel(
  release: Release,
  type: string,
  mode: LibraryProgressMode,
  unit: string,
  locale: string,
) {
  return libraryUnitLabel(release, type, mode, unit, locale)?.text;
}

export function progressDisplay(
  release: Release,
  type: string,
  progress: { mode: LibraryProgressMode; unit: string; amount: string | null; total: string | null },
  locale: string,
) {
  return progressView(
    {
      ...progress,
      ...progressSessionProfile(release, type, progress.mode, progress.unit, locale),
      locator: null,
      position: progress.mode === 'cursor_position' ? progress.amount : null,
      completedUnitCount: Number(progress.amount ?? 0),
    },
    locale,
  )!;
}

export function progressFormChoices(release: Release, type: string, locale: string) {
  return progressChoicesForType(release, type, locale)?.map((choice) => ({
    ...choice,
    units: choice.units.map((unit) => ({ ...unit, ...progressInputRules(release, type, choice.mode, unit.id) })),
  }));
}
export type ProgressChoices = ReturnType<typeof progressFormChoices>;
export type ProgressInputRules = ReturnType<typeof progressInputRules>;

/** Resolve only the presentation of this stored pair; legacy labels never enable a write. */
export function progressSessionProfile(
  release: Release,
  type: string,
  mode: LibraryProgressMode,
  unit: string,
  locale: string,
) {
  const pair = (profile: ReturnType<typeof libraryProfile>) =>
    profile?.progress?.allowed.find((item) => item.mode === mode)?.units.find((item) => item.id === unit);
  const unitLabel = progressPairLabel(release, type, mode, unit, locale);
  const dimension = (pair(libraryProfile(release, type)) ?? pair(release.libraryProfiles?.['legacy-fixed-v1']))
    ?.dimension;
  const inputRules = progressInputRules(release, type, mode, unit);
  return {
    ...(unitLabel === undefined ? {} : { unitLabel }),
    ...(dimension === undefined ? {} : { dimension }),
    ...(inputRules === undefined ? {} : { inputRules }),
  };
}
