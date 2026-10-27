import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';

export type LibraryLabels = { en: string } & Partial<
  Record<'de' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant', string>
>;
export type LibraryProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type LibraryProgressUnit = {
  id: string;
  labels: LibraryLabels;
  dimension?: string;
  minimum?: string;
  maximum?: string;
  precision?: number;
  totalPolicy?: 'optional' | 'required' | 'forbidden';
  identity: { kind: 'none' } | { kind: 'session_local' };
  structure: { kind: 'none' };
};
export type LibraryProfile = {
  id: string;
  entryStateSet?: {
    id: string;
    states: {
      id: string;
      labels: LibraryLabels;
      role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped';
    }[];
  };
  progress?: { allowed: { mode: LibraryProgressMode; units: LibraryProgressUnit[] }[] };
  copies?: { kinds: { id: string; labels: LibraryLabels; statuses: { id: string; labels: LibraryLabels }[] }[] };
  importSources?: { id: string; mappingVersion: string; recordKinds: string[] }[];
};
export type LibraryProfileReference = { profileId: string };
export type LibraryProfilePin =
  | { provenance: 'profile'; releaseDigest: string; acceptingType: string; profileId: string }
  | {
      provenance: 'legacy';
      releaseDigest: string;
      acceptingType: string | null;
      profileId: 'legacy-fixed-v1';
    };

type WithoutLabels<T> = T extends (infer U)[]
  ? WithoutLabels<U>[]
  : T extends object
    ? { [K in keyof T as K extends 'labels' ? never : K]: WithoutLabels<T[K]> }
    : T;
export type LibraryProfileSource = WithoutLabels<LibraryProfile>;

export const libraryAt = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// Source and release share the exact structural schema. Only presentation owns labels.
const sourceDefinitions = structuredClone(schema.$defs);
for (const leaf of [
  sourceDefinitions.libraryState,
  sourceDefinitions.libraryUnit,
  sourceDefinitions.libraryCopyKind,
  sourceDefinitions.libraryStatus,
]) {
  Reflect.deleteProperty(leaf.properties, 'labels');
  leaf.required = leaf.required.filter((key) => key !== 'labels');
}
const sourceValidator = Compile({ $ref: '#/$defs/libraryProfile', $defs: sourceDefinitions });

/** Validate before constructing typed source data; reports precise closed-object pointers. */
export function validateLibraryProfileSource(
  value: unknown,
  add: (pointer: string) => void,
): value is LibraryProfileSource {
  libraryProgressSemantics(value, add);
  if (!sourceValidator.Check(value)) {
    const [, errors] = sourceValidator.Errors(value);
    for (const error of errors) {
      if (error.keyword === 'required')
        for (const key of error.params.requiredProperties) add(libraryAt(error.instancePath, key));
      else if (error.keyword === 'additionalProperties')
        for (const key of error.params.additionalProperties) add(libraryAt(error.instancePath, key));
      else add(error.instancePath);
    }
    return false;
  }
  // The schema above has established the source shape, not its cross-field semantics.
  let valid = true;
  libraryProfileSemantics(value as LibraryProfileSource, (pointer) => {
    valid = false;
    add(pointer);
  });
  return valid;
}

/** Report dependent descriptor errors even when a different required member is missing. */
export function libraryProgressSemantics(value: unknown, add: (pointer: string) => void): void {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(value) || !record(value.progress) || !Array.isArray(value.progress.allowed)) return;
  value.progress.allowed.forEach((mode: unknown, i: number) => {
    if (!record(mode) || !Array.isArray(mode.units)) return;
    if (typeof mode.mode !== 'string' || !['scalar_amount', 'cursor_position', 'completed_units'].includes(mode.mode))
      return;
    mode.units.forEach((unit: unknown, j: number) => {
      if (!record(unit)) return;
      const home = `/progress/allowed/${i}/units/${j}`;
      if (record(unit.identity) && unit.identity.kind !== (mode.mode === 'completed_units' ? 'session_local' : 'none'))
        add(`${home}/identity`);
      if (mode.mode !== 'scalar_amount' && unit.totalPolicy !== undefined && unit.totalPolicy !== 'forbidden')
        add(`${home}/totalPolicy`);
    });
  });
}

/** Linear validation shared by source and release; callers first establish structural validity. */
export function libraryProfileSemantics(profile: LibraryProfileSource, add: (pointer: string) => void): void {
  libraryProgressSemantics(profile, add);
  const duplicates = <T>(values: readonly T[], key: (value: T) => string, pointer: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const id = key(value);
      if (seen.has(id)) add(libraryAt(pointer, index));
      seen.add(id);
    });
  };
  if (profile.entryStateSet) duplicates(profile.entryStateSet.states, (s) => s.id, '/entryStateSet/states');
  if (profile.progress) {
    duplicates(profile.progress.allowed, (m) => m.mode, '/progress/allowed');
    profile.progress.allowed.forEach((mode, i) => {
      const pointer = `/progress/allowed/${i}/units`;
      duplicates(mode.units, (u) => u.id, pointer);
      mode.units.forEach((unit, j) => {
        const home = libraryAt(pointer, j);
        if (unit.minimum !== undefined && unit.maximum !== undefined) {
          // Fixed-width digit strings preserve exact order up to the parser's maximum.
          const digits = (text: string) => {
            const [whole, fraction = ''] = text.split('.');
            return whole!.padStart(12, '0') + fraction.padEnd(6, '0');
          };
          if (digits(unit.minimum) > digits(unit.maximum)) add(home);
        }
      });
    });
  }
  if (profile.copies) {
    duplicates(profile.copies.kinds, (k) => k.id, '/copies/kinds');
    profile.copies.kinds.forEach((kind, i) => duplicates(kind.statuses, (s) => s.id, `/copies/kinds/${i}/statuses`));
  }
  if (profile.importSources) {
    duplicates(profile.importSources, (s) => s.id, '/importSources');
    profile.importSources.forEach((source, i) =>
      duplicates(source.recordKinds, (id) => id, `/importSources/${i}/recordKinds`),
    );
  }
}
