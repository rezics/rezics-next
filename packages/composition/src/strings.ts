// SPDX-License-Identifier: Apache-2.0
import Type from 'typebox';

// `$` matches before a final newline, so a trailing control character would pass. `(?![\s\S])` is the end.
const END = '(?![\\s\\S])';
const CONTROL = '\\u0000-\\u001F\\u007F-\\u009F';
const HREF_FORBIDDEN = `${CONTROL}\\s\\\\<>"'`;
const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOST = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`;
const PORT = '(?:[0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';

/** Tab and newline stay; every other C0/C1 control, and an HTML-like `<`, do not. */
export const PLAIN_TEXT_PATTERN = `^(?:(?!<[A-Za-z/!?])[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F])*${END}`;

/** A site path, or `https:` with a host, optional in-range port and no user info. */
export const HREF_PATTERN = `^(?:/(?:[^${HREF_FORBIDDEN}/][^${HREF_FORBIDDEN}]*)?|https://${HOST}(?::${PORT})?(?:[/?#][^${HREF_FORBIDDEN}]*)?)${END}`;

/** The search filter's CURIE rule. */
export const CURIE_PATTERN = `^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*${END}`;

export const NODE_ID_PATTERN = `^[A-Za-z0-9_-]{1,64}${END}`;

/** Primary subtag, then optional subtags. The shared end anchor rejects a trailing newline. */
export const LOCALE_KEY_PATTERN = `^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*${END}`;

export const PLAIN_TEXT = new RegExp(PLAIN_TEXT_PATTERN, 'u');
export const HREF = new RegExp(HREF_PATTERN, 'u');
export const CURIE = new RegExp(CURIE_PATTERN, 'u');
export const NODE_ID = new RegExp(NODE_ID_PATTERN, 'u');
export const LOCALE_KEY = new RegExp(LOCALE_KEY_PATTERN, 'u');

/** A localized value holds at most this many locale entries. */
export const MAX_LOCALIZED_ENTRIES = 16;

const SAFETY = '~safety';

export type SafetyKind = 'plainText' | 'href' | 'curie' | 'subjectId' | 'localizedText';

/** Marker TypeBox leaves on the schema object. JSON Schema export drops every `~` key. */
export function safetyKind(schema: object): SafetyKind | undefined {
  const kind = (schema as Record<string, unknown>)[SAFETY];
  if (kind === 'plainText' || kind === 'href' || kind === 'curie' || kind === 'subjectId' || kind === 'localizedText')
    return kind;
  return undefined;
}

export function plainText(options: { maxLength: number }) {
  return Type.String({ maxLength: options.maxLength, pattern: PLAIN_TEXT_PATTERN, [SAFETY]: 'plainText' });
}

export function href() {
  return Type.String({ maxLength: 2_048, pattern: HREF_PATTERN, [SAFETY]: 'href' });
}

export function curie() {
  return Type.String({ maxLength: 128, pattern: CURIE_PATTERN, [SAFETY]: 'curie' });
}

/** A canonical UUID that identifies a subject in a component read descriptor. */
export function subjectId() {
  return Type.String({
    minLength: 36,
    maxLength: 36,
    format: 'uuid',
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\\s\\S])',
    [SAFETY]: 'subjectId',
  });
}

/** Plain text, or 1–16 locale keys mapped to plain text of the same maximum length. */
export function localizedText(options: { maxLength: number }) {
  const text = plainText(options);
  return Type.Union(
    [
      text,
      Type.Object(
        {},
        {
          additionalProperties: text,
          propertyNames: Type.String({ pattern: LOCALE_KEY_PATTERN }),
          minProperties: 1,
          maxProperties: MAX_LOCALIZED_ENTRIES,
        },
      ),
    ],
    { [SAFETY]: 'localizedText' },
  );
}

function primarySubtag(tag: string): string {
  const dash = tag.indexOf('-');
  return (dash === -1 ? tag : tag.slice(0, dash)).toLowerCase();
}

function sameLanguageTag(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchingLanguage(available: Set<string>, preferred: string): string | undefined {
  if (available.has(preferred)) return preferred;
  return [...available].filter((tag) => sameLanguageTag(tag, preferred)).sort()[0];
}

/** Traditional-script Chinese: the script subtag or one of the regions that write it. */
function traditional(tag: string): boolean {
  return /-(?:Hant|TW|HK|MO)(?:-|$)/i.test(tag);
}

/**
 * The reader's fallback list: the locale, its primary language, the other scripts of that language in a fixed order
 * (zh-Hans reads zh-Hant, zh-Hant reads zh-Hans), then English.
 */
export function localeChain(locale: string): string[] {
  const primary = primarySubtag(locale);
  const chain = [locale];
  if (!sameLanguageTag(primary, locale)) chain.push(primary);
  if (primary === 'zh') {
    const scripts = traditional(locale) ? ['zh-Hant', 'zh-Hans'] : ['zh-Hans', 'zh-Hant'];
    for (const script of scripts) if (!chain.some((tag) => sameLanguageTag(tag, script))) chain.push(script);
  }
  if (!chain.some((tag) => sameLanguageTag(tag, 'en'))) chain.push('en');
  return chain;
}

/**
 * The language to read from among `languages`. Walks `localeChain(locale)`, offers other regions or scripts of the
 * reader's language and then `original` (the language the subject was first written in) before English, and ends
 * with the first language in code-unit order.
 */
export function pickLanguage(languages: Iterable<string>, locale: string, original?: string): string | undefined {
  const available = new Set(languages);
  if (available.size === 0) return undefined;
  const chain = localeChain(locale);
  const primary = primarySubtag(locale);
  const english = primary === 'en' ? [] : ['en'];
  const lead = primary === 'en' ? chain : chain.slice(0, -1);
  const related = [...available]
    .filter((tag) => primarySubtag(tag) === primary && !chain.some((preferred) => sameLanguageTag(preferred, tag)))
    .sort();
  const origins =
    original === undefined
      ? []
      : [
          original,
          primarySubtag(original),
          ...[...available].filter((tag) => primarySubtag(tag) === primarySubtag(original)).sort(),
        ];
  for (const tag of [...lead, ...related, ...origins, ...english]) {
    const match = matchingLanguage(available, tag);
    if (match !== undefined) return match;
  }
  return [...available].sort()[0];
}

/** `pickLanguage` over the entries that hold text, with the chosen text and its language. */
export function pickText(
  value: string | Record<string, string>,
  locale: string,
  original?: string,
): { text: string; lang: string | null } {
  if (typeof value === 'string') return { text: value, lang: null };
  const lang = pickLanguage(
    Object.keys(value).filter((tag) => value[tag]),
    locale,
    original,
  );
  if (lang === undefined) return { text: '', lang: null };
  return { text: value[lang] ?? '', lang };
}
