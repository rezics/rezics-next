import type { KernelClient, SubjectRead } from '@rezics/client';
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';

export const termFields = ['labels', 'descriptions', 'aliases'] as const;
export type TermField = (typeof termFields)[number];
export type Terms = Pick<SubjectRead['subject'], TermField>;
export type TermsPatch = Parameters<ReturnType<KernelClient['subjects']>['terms']['patch']>[0];
export type TermsViewerState = 'signed-in' | 'signed-out' | 'unavailable';
export type TermsViewerActions =
  | { state: 'ready'; actions: { action: string; operations: string[] }[] }
  | { state: 'unavailable' };
export type TermsPageAuthority = { viewer: TermsViewerState; actions: TermsViewerActions };
export const unavailableTermsAuthority: TermsPageAuthority = {
  viewer: 'unavailable',
  actions: { state: 'unavailable' },
};
export type TermsSnapshot = {
  subject: Pick<SubjectRead['subject'], 'id' | 'type' | 'revision' | TermField>;
  etag: string;
  href: string;
  profileHref?: string;
  session?: string;
  authority?: TermsPageAuthority;
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
  readAuthority?: () => Promise<TermsPageAuthority>;
  submit: (command: TermsCommand) => Promise<TermsResult>;
};
export type TermEdit = { mode: 'keep' | 'set' | 'remove'; value: string };
export type LanguageDraft = Record<TermField, TermEdit>;
export type TermsDraft = Record<string, LanguageDraft>;

/** Match the installed mounted operation and its native action exactly. */
export function termsCorrectionAllowed(authority: TermsPageAuthority, snapshot: TermsSnapshot): boolean {
  return (
    !snapshot.profileHref &&
    authority.viewer === 'signed-in' &&
    authority.actions.state === 'ready' &&
    authority.actions.actions.some(
      (entry) => entry.action === 'statement:propose' && entry.operations.includes('subject.terms'),
    )
  );
}

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
      if (value === null || (Array.isArray(value) && value.length === 0)) delete next[field][language];
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

/** A draft is dirty only when its patch changes the stored term map. */
export function hasEffectiveTermsPatch(terms: Terms, drafts: TermsDraft): boolean {
  const { patch } = termsPatch(terms, drafts);
  return termFields.some((field) =>
    Object.entries(patch[field] ?? {}).some(([language, value]) => {
      const exists = Object.hasOwn(terms[field], language);
      if (value === null || (field === 'aliases' && Array.isArray(value) && value.length === 0)) return exists;
      return !exists || JSON.stringify(terms[field][language]) !== JSON.stringify(value);
    }),
  );
}

/** Closed native wire shape; current eligibility and resulting-state validation remain native. */
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
