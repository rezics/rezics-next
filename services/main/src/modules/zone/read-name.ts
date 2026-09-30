import { Type } from 'typebox';
import { canonicalLanguage, direction } from '../display-language/select.ts';
import { languageTag } from '../display-language/schema.ts';
import { InvalidZoneConfiguration } from './config-format.ts';

export const ZoneName = Type.Object({
  name: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
  language: languageTag,
  direction: Type.Union([Type.Literal('ltr'), Type.Literal('rtl')]),
});

/** Missing writer language is undetermined, independent of reader preferences.
 * Old unnamed Zone manifests remain readable; new names use the same owner bounds. */
export function readZoneName(name: unknown, recordedLanguage: unknown) {
  const language = canonicalLanguage(
    recordedLanguage === undefined
      ? 'und'
      : typeof recordedLanguage === 'string'
        ? recordedLanguage
        : '',
  );
  if (
    !language ||
    language.length > 35 ||
    (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 300)) ||
    (recordedLanguage !== undefined && name === undefined)
  ) {
    throw new InvalidZoneConfiguration('Zone name or language is invalid');
  }
  const value = typeof name === 'string' ? name : null;
  return { name: value, language, direction: direction(language, value ?? '') };
}
