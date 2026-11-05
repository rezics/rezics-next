import type { SubjectRead } from '@rezics/client';
import type { LibrarySubject } from '../../src/library/reads';

type Summary = NonNullable<SubjectRead['summary']>;

export function subjectSummary({
  id = '019a0000-0000-7000-8000-000000000003',
  label = { value: 'Reading preview', language: 'en' },
}: { id?: Summary['id']; label?: Summary['label'] } = {}): Summary {
  return {
    id,
    type: 'schema:Book',
    types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
    label: label === null ? null : { value: label.value, language: label.language },
    creativeWork: true,
    cover: null,
  };
}

export function librarySubject(native: Summary = subjectSummary()): LibrarySubject {
  return {
    id: native.id,
    type: native.type,
    types: [...native.types],
    label: native.label ? { ...native.label } : native.id,
    ...(native.label ? { labelLanguage: native.label.language } : {}),
    cover: structuredClone(native.cover),
  };
}
