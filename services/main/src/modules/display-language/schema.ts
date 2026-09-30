import { Type } from 'typebox';
import { canonicalLanguage } from './tag.ts';
import { DISPLAY_LANGUAGE_BASES } from './select.ts';

/** API syntax validation accepts source casing; comparison uses canonicalLanguage. */
export const languageTag = Type.Refine(Type.String({ minLength: 1 }),
  value => canonicalLanguage(value) !== null);

export const displayLanguageBasis = Type.Enum(DISPLAY_LANGUAGE_BASES);
