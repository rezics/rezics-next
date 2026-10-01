import { Type } from 'typebox';
import { canonicalLanguage } from './tag.ts';
import { DISPLAY_LANGUAGE_BASES } from './select.ts';

/** Keep string bounds on the refined schema itself: a TypeBox intersection's
 * request normalization can replace primitive strings with empty objects. */
export function languageTagSchema(maxLength?: number) {
  return Type.Refine(Type.String({ minLength: 1, ...(maxLength === undefined ? {} : { maxLength }) }),
    value => canonicalLanguage(value) !== null);
}

/** API syntax validation accepts source casing; comparison uses canonicalLanguage. */
export const languageTag = languageTagSchema();

export const displayLanguageBasis = Type.Enum(DISPLAY_LANGUAGE_BASES);
