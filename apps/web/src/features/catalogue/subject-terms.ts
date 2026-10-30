import type { SubjectRead } from '@rezics/client';
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';

export const termFields = ['labels', 'descriptions', 'aliases'] as const;
export type TermField = (typeof termFields)[number];
export type Terms = Pick<SubjectRead['subject'], TermField>;
/** Temporary declared producer body. Replace with the generated PATCH body when Semantic publishes it. */
export type TermsPatch = {
  labels?: Record<string, string | null>;
  descriptions?: Record<string, string | null>;
  aliases?: Record<string, string[] | null>;
};
export type TermsSnapshot = {
  subject: Pick<SubjectRead['subject'], 'id' | 'type' | 'revision' | TermField>;
  etag: string;
  href: string;
  profileHref?: string;
  session?: string;
};
export type TermsRead = { state: 'ready'; snapshot: TermsSnapshot } | { state: 'concealed' | 'denied' | 'unavailable' };
export type TermsCommand = { id: string; etag: string; key: string; patch: TermsPatch; session?: string };
export type TermsFailure = {
  ok: false;
  reason: 'signed-out' | 'denied' | 'concealed' | 'invalid' | 'stale' | 'conflict' | 'unavailable';
  errors?: Violation[];
  detail?: string;
};
export type TermsResult =
  | TermsFailure
  | { ok: true; id: string; revision: number; reader: TermsRead; session?: string };
export type TermsTransport = {
  read: (id: string, session?: string) => Promise<TermsRead>;
  submit: (command: TermsCommand) => Promise<TermsResult>;
};
export type TermEdit = { mode: 'keep' | 'set' | 'remove'; value: string };
export type LanguageDraft = Record<TermField, TermEdit>;
export type TermsDraft = Record<string, LanguageDraft>;

export function languageDraft(terms: Terms, language: string): LanguageDraft {
  return {
    labels: { mode: 'keep', value: terms.labels[language] ?? '' },
    descriptions: { mode: 'keep', value: terms.descriptions[language] ?? '' },
    aliases: { mode: 'keep', value: (terms.aliases[language] ?? []).join('\n') },
  };
}

export function patchedTerms(terms: Terms, patch: TermsPatch): Terms {
  const next = structuredClone({ labels: terms.labels, descriptions: terms.descriptions, aliases: terms.aliases });
  for (const field of termFields) {
    for (const [language, value] of Object.entries(patch[field] ?? {})) {
      if (value === null) delete next[field][language];
      else
        Object.defineProperty(next[field], language, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  return next;
}

/** Only explicit edits enter the patch. Empty inputs never mean deletion. */
export function termsPatch(terms: Terms, drafts: TermsDraft): { patch: TermsPatch; errors: Violation[] } {
  const patch: TermsPatch = {};
  for (const [language, draft] of Object.entries(drafts)) {
    for (const field of termFields) {
      const edit = draft[field];
      if (edit.mode === 'keep') continue;
      const value = edit.mode === 'remove' ? null : field === 'aliases' ? edit.value.split('\n') : edit.value;
      const map = (patch[field] ??= Object.create(null));
      Object.defineProperty(map, language, { value, enumerable: true, configurable: true });
    }
  }
  return { patch, errors: checkSubjectStructure(patchedTerms(terms, patch)).violations };
}

export function hasTermsPatch(patch: TermsPatch): boolean {
  return termFields.some((field) => Object.keys(patch[field] ?? {}).length > 0);
}

/** Closed declared wire shape; current eligibility and resulting-state validation remain native. */
export function isTermsCommand(value: TermsCommand): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !value ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    typeof value.key !== 'string' ||
    !uuid.test(value.key) ||
    typeof value.etag !== 'string' ||
    !/^"[1-9][0-9]*"$/.test(value.etag)
  )
    return false;
  if (value.session !== undefined && (typeof value.session !== 'string' || value.session.length > 16384)) return false;
  if (!value.patch || Array.isArray(value.patch) || typeof value.patch !== 'object' || !hasTermsPatch(value.patch))
    return false;
  return Object.entries(value.patch).every(
    ([field, map]) =>
      termFields.includes(field as TermField) &&
      map !== null &&
      typeof map === 'object' &&
      !Array.isArray(map) &&
      Object.entries(map).every(
        ([language, term]) =>
          /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language) &&
          (term === null ||
            (field === 'aliases'
              ? Array.isArray(term) && term.length <= 32 && new Set(term).size === term.length && term.every(validText)
              : validText(term))),
      ),
  );
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 250 && value.trim() === value;
}
