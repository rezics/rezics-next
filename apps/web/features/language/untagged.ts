import { direction } from '@rezics/main/language';
import type { ZoneText } from '@rezics/zone-sdk';

// Content Main gave no language for (an excerpt, a banner title, a credited
// name). The language stays unknown; looking at the text never assigns one,
// only its base direction.

/** A content value for the Zone SDK: `lang` is the tag Main recorded, or empty. */
export function zoneContentText(value: string, language = ''): ZoneText {
  return { value, lang: language, dir: direction(language, value) };
}

/** A display value for `LocalizedText`: `language` is the tag Main recorded, or empty. */
export function contentText(value: string, language = '') {
  return { value, language, direction: direction(language, value) };
}

/** A `DisplayName` for a name from a source that does not say which language it is in. */
export function untaggedName(value: string) {
  return { ...contentText(value), basis: 'fallback' as const };
}
