import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
import { SubjectInputError, type Item } from './item.ts';

export type Terms = Pick<Item, 'labels' | 'descriptions' | 'aliases'>;
export type TermsPatch = {
  labels?: Record<string, string | null>;
  descriptions?: Record<string, string | null>;
  aliases?: Record<string, string[] | null>;
};
export type TermsResult = { subject: string; revision: number };
export type TermChange = { field: keyof Terms; languages: string[] };

const fields = ['labels', 'descriptions', 'aliases'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** A single strong, quoted Subject revision; wildcard, weak and multi-value tags are not CAS. */
export function termRevision(value: string | undefined): number {
  if (!value || !/^"[1-9][0-9]*"$/.test(value))
    throw new SubjectInputError([{ pointer: '/headers/if-match', code: 'invalid_format' }]);
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision) || revision > 2147483647)
    throw new SubjectInputError([{ pointer: '/headers/if-match', code: 'out_of_range' }]);
  return revision;
}

/** Resolve omission and explicit deletion before applying the native final-term limits.
 * The caller supplies authoritative current terms, never a receipt's old Item.
 */
export function patchTerms(current: Terms, input: unknown): { terms: Terms; changes: TermChange[] } {
  if (!object(input)) throw new SubjectInputError([{ pointer: '', code: 'invalid_type' }]);
  const errors: Violation[] = [];
  for (const field of Object.keys(input))
    if (!fields.includes(field as keyof Terms)) errors.push({ pointer: `/${escape(field)}`, code: 'unknown_field' });
  const terms = structuredClone(current);
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    const entries = input[field];
    if (!object(entries)) {
      errors.push({ pointer: `/${field}`, code: 'invalid_type' });
      continue;
    }
    for (const [language, value] of Object.entries(entries)) {
      // Validate even deletion keys through the same native language validator.
      const probe = checkSubjectStructure({
        type: '',
        labels: { en: 'Validation' },
        [field]: { ...(field === 'labels' ? { en: 'Validation' } : {}), [language]: value ?? (field === 'aliases' ? [] : 'Validation') },
      });
      errors.push(...probe.violations);
      const target = terms[field] as Record<string, unknown>;
      if (value === null) delete target[language];
      else target[language] = structuredClone(value);
    }
  }
  if (errors.length) throw new SubjectInputError(errors.slice(0, 16));
  const checked = checkSubjectStructure({ type: '', ...terms });
  if (checked.violations.length) throw new SubjectInputError(checked.violations);
  const changes = fields.flatMap((field) => {
    const before = current[field] as Record<string, unknown>;
    const after = terms[field] as Record<string, unknown>;
    const languages = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((language) => JSON.stringify(before[language]) !== JSON.stringify(after[language]))
      .sort();
    return languages.length ? [{ field, languages }] : [];
  });
  return { terms, changes };
}
