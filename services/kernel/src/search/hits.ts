import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import type { IndexedSubject } from './source.ts';

export type HitOptions = { descriptions: boolean; languages?: readonly string[] };
export type SearchHit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  descriptions?: Record<string, string>;
};

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const DESCRIPTION_LIMIT = 200;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function invalid(pointer: string, code: FieldErrorCode): never {
  throw new ProblemError('invalid_request', { errors: [{ pointer, code }] });
}

/** Checks the opt-in hit fields; reports the first failing element only. */
export function validateHitOptions(request: { descriptions?: unknown; languages?: unknown }): HitOptions {
  const { descriptions, languages } = request;
  if (descriptions !== undefined && typeof descriptions !== 'boolean') invalid('/descriptions', 'invalid_type');
  if (languages === undefined) return { descriptions: descriptions === true };
  if (!Array.isArray(languages)) invalid('/languages', 'invalid_type');
  if (languages.length < 1 || languages.length > 8) invalid('/languages', 'out_of_range');
  const seen = new Set<string>();
  languages.forEach((tag: unknown, index) => {
    if (typeof tag !== 'string') invalid(`/languages/${index}`, 'invalid_type');
    if (tag.length > 35 || !LANGUAGE.test(tag) || seen.has(tag)) invalid(`/languages/${index}`, 'invalid_format');
    seen.add(tag);
  });
  return { descriptions: descriptions === true, languages: languages as string[] };
}

/** At most 200 grapheme clusters: a longer text keeps 199, drops trailing white space and ends with an ellipsis. */
function cut(value: string): string {
  if (value.length <= DESCRIPTION_LIMIT) return value;
  let count = 0;
  let keep = 0;
  for (const { index } of graphemes.segment(value)) {
    if (count === DESCRIPTION_LIMIT) return `${value.slice(0, keep).trimEnd()}…`;
    if (count === DESCRIPTION_LIMIT - 1) keep = index;
    count++;
  }
  return value;
}

export function projectHit(subject: IndexedSubject, { descriptions, languages }: HitOptions): SearchHit {
  const wanted = languages && new Set(languages);
  const texts = (list: IndexedSubject['labels'], map: (value: string) => string = (value) => value) =>
    Object.fromEntries(
      list
        .filter(({ language }) => !wanted || wanted.has(language))
        .map(({ language, value }) => [language, map(value)]),
    );
  return {
    id: subject.id,
    type: subject.type,
    labels: texts(subject.labels),
    ...(descriptions ? { descriptions: texts(subject.descriptions, cut) } : {}),
  };
}
