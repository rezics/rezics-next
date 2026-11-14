import { canonicalLanguageKey } from '@rezics/definitions/language';

export function isHostedReadingBodyLanguage(value: unknown): value is string {
  return typeof value === 'string' && canonicalLanguageKey(value) === value;
}
