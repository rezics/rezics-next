export interface LanguageTag {
  /** Source spelling for provenance; `tag` is only the comparison form. */
  originalTag: string;
  tag: string;
  language: string | null;
  script: string | null;
}

const unspecified = new Set(['und', 'zxx', 'mul']);
const grandfathered = new Set(['en-gb-oed', 'i-ami', 'i-bnn', 'i-default', 'i-enochian', 'i-hak',
  'i-klingon', 'i-lux', 'i-mingo', 'i-navajo', 'i-pwn', 'i-tao', 'i-tay', 'i-tsu',
  'sgn-be-fr', 'sgn-be-nl', 'sgn-ch-de', 'art-lojban', 'cel-gaulish', 'no-bok', 'no-nyn',
  'zh-guoyu', 'zh-hakka', 'zh-min', 'zh-min-nan', 'zh-xiang']);

/** RFC 5646 §2.1 syntax, including extlang and grandfathered forms that Intl
 * rejects. As with Intl, this does not consult the IANA subtag registry. */
function languageSyntax(value: string): boolean {
  if (/^x(?:-[a-z0-9]{1,8})+$/i.test(value) || grandfathered.has(value.toLowerCase())) return true;
  const match = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?((?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)((?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)(?:-x(?:-[a-z0-9]{1,8})+)?$/i.exec(value);
  if (!match) return false;
  const variants = match[1]!.toLowerCase().split('-').filter(Boolean);
  const singletons = match[2]!.toLowerCase().split('-').filter(part => part.length === 1);
  return new Set(variants).size === variants.length && new Set(singletons).size === singletons.length;
}
// RTL field in https://github.com/unicode-org/cldr/blob/main/common/properties/scriptMetadata.txt
const rtlScripts = new Set(['Adlm', 'Arab', 'Armi', 'Avst', 'Chrs', 'Cprt', 'Elym', 'Gara',
  'Hatr', 'Hebr', 'Hung', 'Khar', 'Lydi', 'Mand', 'Mani', 'Mend', 'Merc', 'Mero', 'Narb',
  'Nbat', 'Nkoo', 'Orkh', 'Ougr', 'Palm', 'Phli', 'Phlp', 'Phnx', 'Prti', 'Rohg', 'Samr', 'Sarb',
  'Sogd', 'Sogo', 'Syrc', 'Thaa', 'Yezi']);
// Engines ship different Unicode versions; an unsupported script must not break module loading.
const rtlLetterPatterns = [...rtlScripts].flatMap(script => {
  try { return [new RegExp(`\\p{Script=${script}}`, 'u').source]; }
  catch { return []; }
});
const rtlLetter = new RegExp(rtlLetterPatterns.join('|') || '(?!)', 'u');

/** RFC 5646 syntax with Intl's canonical aliases where supported.
 * This does not validate subtags against a pinned IANA registry. Empty is not recorded. */
export function parseLanguage(value: string): LanguageTag | null {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  if (!languageSyntax(value)) return null;
  if (/^x(?:-[a-z0-9]{1,8})+$/i.test(value)) {
    return { originalTag: value, tag: value.toLowerCase(), language: null, script: null };
  }
  try {
    const tag = Intl.getCanonicalLocales(value)[0];
    if (!tag) return null;
    const locale = new Intl.Locale(tag);
    return { originalTag: value, tag, language: locale.language,
      script: locale.script ?? (unspecified.has(locale.language) ? null : locale.maximize().script ?? null) };
  } catch {
    // Preserve uncommon recorded forms without inventing likely-script evidence
    // or treating an extlang/grandfathered spelling as its primary language.
    return { originalTag: value, tag: value.toLowerCase(), language: null, script: null };
  }
}

export function canonicalLanguage(value: string): string | null {
  return parseLanguage(value)?.tag ?? null;
}

/** A recorded or likely script wins; otherwise the text's first letter sets base direction.
 * https://www.w3.org/International/questions/qa-html-dir#dirauto
 * Looking at text never assigns a language to an undetermined or unrecorded source. */
export function direction(language: string, text = ''): 'ltr' | 'rtl' {
  const script = parseLanguage(language)?.script;
  if (script) return rtlScripts.has(script) ? 'rtl' : 'ltr';
  const letter = text.match(/\p{Letter}/u)?.[0];
  return letter && rtlLetter.test(letter) ? 'rtl' : 'ltr';
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
