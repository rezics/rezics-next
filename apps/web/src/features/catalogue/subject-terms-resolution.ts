import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
import {
  patchedTerms,
  termFields,
  type TermEdit,
  type TermField,
  type Terms,
  type TermsPatch,
} from './subject-terms';

export type TermPresence = { present: false } | { present: true; value: string | readonly string[] };
export type ResolutionKind = 'current' | 'draft' | 'replacement';
export type TermFieldChange = {
  language: string;
  field: TermField;
  original: TermPresence;
  current: TermPresence;
  intended: TermPresence;
  currentUnchanged: boolean;
  userUnchanged: boolean;
  sameResult: boolean;
  overlap: boolean;
};

export function resolutionKey(language: string, field: TermField): string {
  return `${language}/${field}`;
}

export function termPresence(terms: Terms, field: TermField, language: string): TermPresence {
  if (!Object.hasOwn(terms[field], language)) return { present: false };
  const value = terms[field][language];
  return { present: true, value: field === 'aliases' ? [...(value as string[])] : (value as string) };
}

export function sameTermPresence(field: TermField, left: TermPresence, right: TermPresence): boolean {
  if (!left.present && !right.present) return true;
  if (!left.present || !right.present) return false;
  if (field === 'aliases') {
    if (!Array.isArray(left.value) || !Array.isArray(right.value) || left.value.length !== right.value.length)
      return false;
    return left.value.every((item, index) => item === right.value[index]);
  }
  return left.value === right.value;
}

export function intentPresence(original: Terms, intent: TermsPatch, field: TermField, language: string): TermPresence {
  const map = intent[field];
  if (!map || !Object.hasOwn(map, language)) return termPresence(original, field, language);
  const value = map[language];
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0))
    return { present: false };
  return { present: true, value };
}

export function formatTermPresence(presence: TermPresence): string {
  if (!presence.present) return '';
  return Array.isArray(presence.value) ? presence.value.join('\n') : String(presence.value);
}

function validText(value: string): boolean {
  return value.length >= 1 && value.length <= 250 && value.trim() === value;
}

export function replacementPresence(field: TermField, edit: TermEdit | undefined): TermPresence | undefined {
  if (!edit || edit.mode !== 'set') return;
  if (field === 'aliases') {
    const aliases = edit.value.split('\n');
    if (aliases.length === 0 || aliases.length > 32 || new Set(aliases).size !== aliases.length) return;
    if (aliases.some((alias) => !validText(alias))) return;
    return { present: true, value: aliases };
  }
  if (!validText(edit.value)) return;
  return { present: true, value: edit.value };
}

function languagesOf(original: Terms, current: Terms, intent: TermsPatch): string[] {
  return [
    ...new Set([
      ...termFields.flatMap((field) => Object.keys(original[field])),
      ...termFields.flatMap((field) => Object.keys(current[field])),
      ...termFields.flatMap((field) => Object.keys(intent[field] ?? {})),
    ]),
  ];
}

/** Finite language/field rows whose current or intended value differs from the admitted original. */
export function partitionTermChanges(original: Terms, current: Terms, intent: TermsPatch): TermFieldChange[] {
  const changes: TermFieldChange[] = [];
  for (const language of languagesOf(original, current, intent)) {
    for (const field of termFields) {
      const originalValue = termPresence(original, field, language);
      const currentValue = termPresence(current, field, language);
      const intended = intentPresence(original, intent, field, language);
      const currentUnchanged = sameTermPresence(field, originalValue, currentValue);
      const userUnchanged = sameTermPresence(field, originalValue, intended);
      if (currentUnchanged && userUnchanged) continue;
      const sameResult = sameTermPresence(field, currentValue, intended);
      changes.push({
        language,
        field,
        original: originalValue,
        current: currentValue,
        intended,
        currentUnchanged,
        userUnchanged,
        sameResult,
        overlap: !currentUnchanged && !userUnchanged && !sameResult,
      });
    }
  }
  return changes;
}

function patchValue(field: TermField, presence: TermPresence): string | string[] | null {
  if (!presence.present) return null;
  return field === 'aliases' ? [...(presence.value as readonly string[])] : (presence.value as string);
}

function writePatch(patch: TermsPatch, field: TermField, language: string, presence: TermPresence) {
  const map = (patch[field] ??= Object.create(null)) as Record<string, string | string[] | null>;
  Object.defineProperty(map, language, {
    value: patchValue(field, presence),
    enumerable: true,
    configurable: true,
  });
}

export function applyTermResolutions(
  changes: readonly TermFieldChange[],
  current: Terms,
  choices: Readonly<Record<string, ResolutionKind>>,
  replacements: Readonly<Record<string, TermEdit>>,
): {
  patch: TermsPatch;
  errors: Violation[];
  unresolved: TermFieldChange[];
  omittedLanguages: string[];
  removals: { language: string; field: TermField }[];
} {
  const patch: TermsPatch = {};
  const unresolved: TermFieldChange[] = [];
  for (const change of changes) {
    const key = resolutionKey(change.language, change.field);
    let next: TermPresence | undefined;
    if (change.overlap) {
      const kind = choices[key];
      if (kind === 'current') next = change.current;
      else if (kind === 'draft') next = change.intended;
      else if (kind === 'replacement') next = replacementPresence(change.field, replacements[key]);
      if (!next) {
        unresolved.push(change);
        continue;
      }
    } else if (change.userUnchanged || change.sameResult) continue;
    else next = change.intended;
    if (sameTermPresence(change.field, next, change.current)) continue;
    writePatch(patch, change.field, change.language, next);
  }
  const patchedLanguages = new Set(termFields.flatMap((field) => Object.keys(patch[field] ?? {})));
  const stored = new Set([
    ...termFields.flatMap((field) => Object.keys(current[field])),
    ...changes.map((change) => change.language),
  ]);
  const removals = termFields.flatMap((field) =>
    Object.entries(patch[field] ?? {}).flatMap(([language, value]) =>
      value === null || (field === 'aliases' && Array.isArray(value) && value.length === 0)
        ? [{ language, field }]
        : [],
    ),
  );
  return {
    patch,
    errors: checkSubjectStructure(patchedTerms(current, patch)).violations,
    unresolved,
    omittedLanguages: [...stored].filter((language) => !patchedLanguages.has(language)),
    removals,
  };
}

export function reviewFingerprint(
  etag: string,
  revision: number,
  patch: TermsPatch,
  choices: Readonly<Record<string, ResolutionKind>>,
  replacements: Readonly<Record<string, TermEdit>>,
): string {
  return JSON.stringify({ etag, revision, patch, choices, replacements });
}
