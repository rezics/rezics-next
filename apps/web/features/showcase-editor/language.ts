import { NEUTRAL_LANGUAGE } from './art.ts';

/** A language's name in the interface language, from the browser's own data; the tag itself when it has none. */
export function languageName(tag: string, locale: string, neutral?: string): string {
  if (tag === NEUTRAL_LANGUAGE && neutral) return neutral;
  try {
    return new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
