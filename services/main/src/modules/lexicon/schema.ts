import { canonicalLanguage } from '../display-language/select.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import { hash } from '../work/activate.ts';

export const PRESENTATION_PROFILE = 'definition-presentation-v1';
export const PRESENTATION_PROFILE_IRI = `https://rezics.com/definition/${PRESENTATION_PROFILE}`;
export const PRESENTATION_FAMILY = 'lexicon-presentation-change';
export const LEXICON_LIMITS = {
  definitionsPerBatch: 64,
  requestBytes: 65_536,
  labelLength: 512,
  grammaticalForms: 32,
} as const;
export const pluralCategories = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof pluralCategories)[number];
export interface GrammaticalForm {
  case?: string;
  number?: string;
  gender?: string;
  value: string;
}
export interface PresentationState {
  definition: string;
  meaningRevision: string;
  fromRole: string;
  toRole: string;
  language: string;
  noun: string;
  heading: string;
  plurals: Partial<Record<PluralCategory, string>> & { other: string };
  grammaticalForms: GrammaticalForm[];
  source: string;
  licence: string;
  reviewStatus: 'draft' | 'reviewed';
}

function invalid(message: string): never {
  throw new SemanticChangeRejected('invalid', message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('presentation object is invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number = LEXICON_LIMITS.labelLength): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return invalid('presentation text is invalid');
  }
  return value;
}
function native(value: unknown): string {
  if (typeof value !== 'string') return invalid('presentation reference is invalid');
  try {
    return checkedNativeIri(value);
  } catch {
    return invalid('presentation reference is invalid');
  }
}
function uri(value: unknown): string {
  const result = text(value, 2048);
  if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/u.test(result))
    return invalid('presentation provenance URI is invalid');
  return result;
}
function role(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(value))
    return invalid('viewing role is invalid');
  return value;
}

/** One bounded language revision, with no cap on languages stored for a definition. */
export function checkedPresentation(input: unknown): PresentationState {
  const row = record(input);
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'definition',
          'meaningRevision',
          'fromRole',
          'toRole',
          'language',
          'noun',
          'heading',
          'plurals',
          'grammaticalForms',
          'source',
          'licence',
          'reviewStatus',
        ].includes(key),
    )
  ) {
    return invalid('presentation has unsupported fields');
  }
  const language =
    typeof row.language === 'string' && row.language.length <= 255
      ? canonicalLanguage(row.language)
      : null;
  if (!language) return invalid('presentation language is invalid');
  const fromRole = role(row.fromRole),
    toRole = role(row.toRole);
  if (fromRole === toRole) return invalid('a viewing direction needs distinct roles');
  const plurals = record(row.plurals);
  if (
    Object.keys(plurals).some((key) => !pluralCategories.includes(key as PluralCategory)) ||
    !plurals.other
  ) {
    return invalid('plural forms need CLDR categories and an other form');
  }
  const forms = row.grammaticalForms ?? [];
  if (!Array.isArray(forms) || forms.length > LEXICON_LIMITS.grammaticalForms)
    return invalid('too many grammatical forms');
  const grammaticalForms = forms
    .map((item) => {
      const form = record(item);
      if (
        Object.keys(form).some((key) => !['case', 'number', 'gender', 'value'].includes(key)) ||
        !['case', 'number', 'gender'].some((key) => form[key] !== undefined)
      )
        return invalid('grammatical form is invalid');
      return {
        ...Object.fromEntries(
          ['case', 'number', 'gender'].flatMap((key) =>
            form[key] === undefined ? [] : [[key, text(form[key], 64)]],
          ),
        ),
        value: text(form.value),
      } as GrammaticalForm;
    })
    .sort((a, b) => grammarKey(a).localeCompare(grammarKey(b)));
  if (new Set(grammaticalForms.map(grammarKey)).size !== grammaticalForms.length)
    return invalid('grammatical form repeats');
  if (row.reviewStatus !== 'draft' && row.reviewStatus !== 'reviewed')
    return invalid('review status is invalid');
  const result: PresentationState = {
    definition: native(row.definition),
    meaningRevision: native(row.meaningRevision),
    fromRole,
    toRole,
    language,
    noun: text(row.noun),
    heading: text(row.heading),
    plurals: Object.fromEntries(
      pluralCategories.flatMap((key) =>
        plurals[key] === undefined ? [] : [[key, text(plurals[key])]],
      ),
    ) as PresentationState['plurals'],
    grammaticalForms,
    source: uri(row.source),
    licence: uri(row.licence),
    reviewStatus: row.reviewStatus,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > LEXICON_LIMITS.requestBytes)
    return invalid('presentation exceeds request bound');
  return result;
}
function grammarKey(form: GrammaticalForm): string {
  return JSON.stringify([form.case, form.number, form.gender]);
}
export function presentationDigest(
  target: string | undefined,
  expectedHead: string | null,
  state: PresentationState,
): string {
  if (target !== undefined) native(target);
  if (expectedHead !== null) native(expectedHead);
  if ((target === undefined) !== (expectedHead === null))
    return invalid('a create has no head; an edit names one');
  return hash(
    JSON.stringify({
      family: PRESENTATION_FAMILY,
      target: target ?? null,
      expectedHead,
      state: checkedPresentation(state),
    }),
  );
}
