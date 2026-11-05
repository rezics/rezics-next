import { pickText } from '@rezics/composition';
import type {
  LibraryCountForms,
  LibraryLabels,
  LibraryProgressMode,
  LibraryProfile,
  LibraryProgressUnit,
} from '@rezics/definitions';
import type { Release } from '../subject/definitions.ts';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';

type ProfileState = NonNullable<LibraryProfile['entryStateSet']>['states'][number];
type ProfileKind = NonNullable<LibraryProfile['copies']>['kinds'][number];
type ProfileStatus = ProfileKind['statuses'][number];
type ProfileUnit = LibraryProgressUnit;

export type LibraryLabel = { text: string; lang: string };
export type LibraryUnitPresentation = {
  label?: LibraryLabel;
  labelLanguage?: string;
  countForms?: LibraryCountForms;
  dimension?: string;
};
export type LibraryStateRole = NonNullable<ProfileState['role']>;
export type LibraryStateChoice = { id: string; label: LibraryLabel };

export type LibraryChoices = {
  states: { id: string; role?: LibraryStateRole }[];
  copyKinds: { id: string; statuses: string[] }[];
  progress: {
    mode: LibraryProgressMode;
    units: {
      id: string;
      minimum?: string;
      maximum?: string;
      precision?: number;
      totalPolicy?: NonNullable<LibraryProgressUnit['totalPolicy']>;
    }[];
  }[];
};

type ProfileIndex = {
  states: Map<string, ProfileState>;
  units: Map<LibraryProgressMode, Map<string, ProfileUnit>>;
  kinds: Map<string, ProfileKind>;
  statuses: Map<string, Map<string, ProfileStatus>>;
};

const indexes = new WeakMap<LibraryProfile, ProfileIndex>();

/** Return the exact profile named by the accepting type in this release. */
export function libraryProfile(release: Release, type: string): LibraryProfile | undefined {
  const definition = Object.hasOwn(release.types, type) ? release.types[type] : undefined;
  const profileId = definition?.library?.profileId;
  const registry = release.libraryProfiles;
  if (typeof profileId !== 'string' || !registry || !Object.hasOwn(registry, profileId)) return undefined;
  return registry[profileId];
}

/** The choices enabled by the accepting type's current profile, in the order the release declares them. */
export function libraryChoices(release: Release, type: string): LibraryChoices | undefined {
  const profile = libraryProfile(release, type);
  if (!profile) return undefined;
  return {
    states: (profile.entryStateSet?.states ?? []).map(({ id, role }) => ({
      id,
      ...(role === undefined ? {} : { role }),
    })),
    copyKinds: (profile.copies?.kinds ?? []).map((kind) => ({
      id: kind.id,
      statuses: kind.statuses.map((status) => status.id),
    })),
    progress: (profile.progress?.allowed ?? []).map((mode) => ({
      mode: mode.mode,
      units: mode.units.map((unit) => ({
        id: unit.id,
        ...(unit.minimum === undefined ? {} : { minimum: unit.minimum }),
        ...(unit.maximum === undefined ? {} : { maximum: unit.maximum }),
        ...(unit.precision === undefined ? {} : { precision: unit.precision }),
        ...(unit.totalPolicy === undefined ? {} : { totalPolicy: unit.totalPolicy }),
      })),
    })),
  };
}

/** The accepting type's writable entry states, in the order declared by its current profile. */
export function libraryStateOptions(release: Release, type: string, locale: string): LibraryStateChoice[] {
  const states = libraryProfile(release, type)?.entryStateSet?.states ?? [];
  return states.map((state) => ({
    id: state.id,
    label:
      localizedLabel(state.labels, locale) ??
      libraryStateLabel(release, type, state.id, locale) ??
      ({ text: m.library_other({}, { locale: locale as Locale }), lang: locale } satisfies LibraryLabel),
  }));
}

/** Resolve one profile's ordered declarations to constant-time ID lookups. */
function index(profile: LibraryProfile): ProfileIndex {
  const remembered = indexes.get(profile);
  if (remembered) return remembered;

  const result: ProfileIndex = {
    states: new Map<string, ProfileState>(
      (profile.entryStateSet?.states ?? []).map((state) => [state.id, state] as const),
    ),
    units: new Map<LibraryProgressMode, Map<string, ProfileUnit>>(
      (profile.progress?.allowed ?? []).map(
        (mode) =>
          [mode.mode, new Map<string, ProfileUnit>(mode.units.map((unit) => [unit.id, unit] as const))] as const,
      ),
    ),
    kinds: new Map<string, ProfileKind>((profile.copies?.kinds ?? []).map((kind) => [kind.id, kind] as const)),
    statuses: new Map<string, Map<string, ProfileStatus>>(
      (profile.copies?.kinds ?? []).map(
        (kind) =>
          [
            kind.id,
            new Map<string, ProfileStatus>(kind.statuses.map((status) => [status.id, status] as const)),
          ] as const,
      ),
    ),
  };
  indexes.set(profile, result);
  return result;
}

function legacyProfile(release: Release): LibraryProfile | undefined {
  const registry = release.libraryProfiles;
  return registry && Object.hasOwn(registry, 'legacy-fixed-v1') ? registry['legacy-fixed-v1'] : undefined;
}

function currentThenLegacy<T>(
  release: Release,
  type: string,
  lookup: (profile: LibraryProfile) => T | undefined,
): T | undefined {
  const current = libraryProfile(release, type);
  const value = current ? lookup(current) : undefined;
  if (value !== undefined) return value;
  const legacy = legacyProfile(release);
  return legacy ? lookup(legacy) : undefined;
}

function localizedLabel(labels: Record<string, string> | undefined, locale: string): LibraryLabel | undefined {
  if (!labels) return undefined;
  const selected = pickText(labels, locale);
  if (!selected.text || selected.lang === null) return undefined;
  return { text: selected.text, lang: selected.lang };
}

/** Resolve a stored state ID against the current profile and then the fixed legacy vocabulary. */
export function libraryStateLabel(
  release: Release,
  type: string,
  stateId: string,
  locale: string,
): LibraryLabel | undefined {
  const state = currentThenLegacy(release, type, (profile) => index(profile).states.get(stateId));
  return state ? localizedLabel(state.labels, locale) : undefined;
}

/** Resolve a filter title without a subject type by searching released profiles, then the fixed legacy vocabulary. */
export function libraryAnyStateLabel(release: Release, stateId: string, locale: string): LibraryLabel | undefined {
  const profiles = release.libraryProfiles;
  if (!profiles) return undefined;
  for (const [id, profile] of Object.entries(profiles)) {
    if (id === 'legacy-fixed-v1') continue;
    const state = index(profile).states.get(stateId);
    const label = state ? localizedLabel(state.labels, locale) : undefined;
    if (label) return label;
  }
  const legacy = profiles['legacy-fixed-v1'];
  const state = legacy ? index(legacy).states.get(stateId) : undefined;
  return state ? localizedLabel(state.labels, locale) : undefined;
}

/** Resolve a legacy value when its subject type is unavailable. */
export function libraryLegacyStateLabel(release: Release, stateId: string, locale: string): LibraryLabel | undefined {
  const profile = legacyProfile(release);
  const state = profile ? index(profile).states.get(stateId) : undefined;
  return state ? localizedLabel(state.labels, locale) : undefined;
}

/** Return the declared semantic role for a stored state ID; IDs without a role remain roleless. */
export function libraryStateRole(release: Release, type: string, stateId: string): LibraryStateRole | undefined {
  const state = currentThenLegacy(release, type, (profile) => index(profile).states.get(stateId));
  return state?.role;
}

/** Resolve one exact mode/unit pair and preserve the language selected by the reader's locale chain. */
export function libraryUnitLabel(
  release: Release,
  type: string,
  mode: LibraryProgressMode,
  unitId: string,
  locale: string,
): LibraryLabel | undefined {
  return libraryUnitPresentation(release, type, mode, unitId, locale)?.label;
}

/** Resolve a unit descriptor once so its label language and count forms stay from the same profile unit. */
export function libraryUnitPresentation(
  release: Release,
  type: string,
  mode: LibraryProgressMode,
  unitId: string,
  locale: string,
): LibraryUnitPresentation | undefined {
  const unit = currentThenLegacy(release, type, (profile) => index(profile).units.get(mode)?.get(unitId));
  if (!unit) return undefined;
  const label = localizedLabel(unit.labels, locale);
  const labelLanguage = label?.lang;
  const supportedLanguage = labelLanguage
    ? (Object.keys(unit.labels) as (keyof LibraryLabels)[]).find((language) => language === labelLanguage)
    : undefined;
  const countForms = supportedLanguage ? unit.countForms?.[supportedLanguage] : undefined;
  return {
    ...(label ? { label } : {}),
    ...(labelLanguage ? { labelLanguage } : {}),
    ...(countForms ? { countForms } : {}),
    ...(unit.dimension === undefined ? {} : { dimension: unit.dimension }),
  };
}

/** Resolve a copy kind label from the current profile, followed by the fixed legacy vocabulary. */
export function libraryCopyKindLabel(
  release: Release,
  type: string,
  kindId: string,
  locale: string,
): LibraryLabel | undefined {
  const kind = currentThenLegacy(release, type, (profile) => index(profile).kinds.get(kindId));
  return kind ? localizedLabel(kind.labels, locale) : undefined;
}

/** Resolve a status only within the requested kind, then retry that same pair in legacy-fixed-v1. */
export function libraryCopyStatusLabel(
  release: Release,
  type: string,
  kindId: string,
  statusId: string,
  locale: string,
): LibraryLabel | undefined {
  const status = currentThenLegacy(release, type, (profile) => index(profile).statuses.get(kindId)?.get(statusId));
  return status ? localizedLabel(status.labels, locale) : undefined;
}

export type LibraryDescriptor =
  | { state: 'unavailable' }
  | { state: 'unsupported' }
  | { state: 'ready'; profile: LibraryProfile; choices: LibraryChoices };

/** Inspect the current released profile before presenting a choice. A type id is not permission. */
export function libraryDescriptor(release: Release | undefined, type: string): LibraryDescriptor {
  if (!release) return { state: 'unavailable' };
  const profile = libraryProfile(release, type);
  const choices = libraryChoices(release, type);
  if (!profile || !choices) return { state: 'unsupported' };
  return { state: 'ready', profile, choices };
}

/** Count admitted state, copy kind/status and progress mode/unit fields in one descriptor. */
export function admittedFieldCount(choices: LibraryChoices): number {
  return (
    choices.states.length +
    choices.copyKinds.reduce((count, kind) => count + 1 + kind.statuses.length, 0) +
    choices.progress.reduce((count, mode) => count + 1 + mode.units.length, 0)
  );
}

export type ManualProgressMeasure = {
  mode: 'scalar_amount';
  unit: LibraryChoices['progress'][number]['units'][number];
};

/** The first admitted scalar amount unit, when the profile offers a single manual measure. */
export function singleManualProgress(choices: LibraryChoices): ManualProgressMeasure | undefined {
  const mode = choices.progress.find((item) => item.mode === 'scalar_amount' && item.units.length > 0);
  const unit = mode?.units[0];
  return unit ? { mode: 'scalar_amount', unit } : undefined;
}

/** A stored state is historical when the current profile no longer admits that exact id. */
export function storedStateIsHistorical(choices: LibraryChoices, stateId: string): boolean {
  return !choices.states.some((state) => state.id === stateId);
}
