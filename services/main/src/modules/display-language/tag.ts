export interface LanguageTag {
  /** Source spelling for provenance; `tag` is only the comparison form. */
  originalTag: string;
  tag: string;
  language: string | null;
  script: string | null;
}

const unspecified = new Set(['und', 'zxx', 'mul']);
// RTL field in https://github.com/unicode-org/cldr/blob/main/common/properties/scriptMetadata.txt
const rtlScripts = new Set(['Adlm', 'Arab', 'Armi', 'Avst', 'Chrs', 'Cprt', 'Elym', 'Gara',
  'Hatr', 'Hebr', 'Hung', 'Khar', 'Lydi', 'Mand', 'Mani', 'Mend', 'Merc', 'Mero', 'Narb',
  'Nbat', 'Nkoo', 'Ougr', 'Palm', 'Phli', 'Phlp', 'Phnx', 'Prti', 'Rohg', 'Samr', 'Sarb',
  'Sogd', 'Sogo', 'Syrc', 'Thaa', 'Yezi']);

/** Intl's structural validation and aliases, plus RFC 5646 §2.2.7 private-only tags.
 * This does not validate subtags against a pinned IANA registry. Empty is not recorded. */
export function parseLanguage(value: string): LanguageTag | null {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  if (/^x(?:-[a-z0-9]{1,8})+$/i.test(value)) {
    return { originalTag: value, tag: value.toLowerCase(), language: null, script: null };
  }
  try {
    const tag = Intl.getCanonicalLocales(value)[0];
    if (!tag) return null;
    const locale = new Intl.Locale(tag);
    return { originalTag: value, tag, language: locale.language,
      script: locale.script ?? (unspecified.has(locale.language) ? null : locale.maximize().script ?? null) };
  } catch { return null; }
}

export function canonicalLanguage(value: string): string | null {
  return parseLanguage(value)?.tag ?? null;
}

/** Likely script is a presentation hint; it never rewrites the recorded language. */
export function direction(language: string): 'ltr' | 'rtl' {
  return rtlScripts.has(parseLanguage(language)?.script ?? '') ? 'rtl' : 'ltr';
}

export type LanguageMatch = 'requested' | 'same-script' | 'other-script';

/** Missing, private-only and special language states match only an exact recorded tag. */
export function languageMatch(content: LanguageTag, reader: LanguageTag): LanguageMatch | null {
  if (content.tag === reader.tag) return 'requested';
  if (!content.language || content.language !== reader.language || unspecified.has(content.language)) return null;
  if (content.script && content.script === reader.script) return 'same-script';
  return content.script && reader.script ? 'other-script' : null;
}

/** Feed membership excludes the explicitly marked other-script display fallback. */
export function languageSatisfies(content: string | null | undefined, readers: readonly string[]): boolean {
  const language = parseLanguage(content ?? '');
  return !!language && readers.some(value => {
    const reader = parseLanguage(value);
    const match = reader && languageMatch(language, reader);
    return match === 'requested' || match === 'same-script';
  });
}
