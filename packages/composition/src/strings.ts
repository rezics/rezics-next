// SPDX-License-Identifier: Apache-2.0
import Type from 'typebox';

// `$` matches before a final newline, so a trailing control character would pass. `(?![\s\S])` is the end.
const END = '(?![\\s\\S])';
const CONTROL = '\\u0000-\\u001F\\u007F-\\u009F';
const HREF_FORBIDDEN = `${CONTROL}\\s\\\\<>"'`;
const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOST = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`;

/** Tab and newline stay; every other C0/C1 control, and an HTML-like `<`, do not. */
export const PLAIN_TEXT_PATTERN = `^(?:(?!<[A-Za-z/!?])[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F])*${END}`;

/** A site path, or `https:` with a host and optional port and no user info. */
export const HREF_PATTERN = `^(?:/(?:[^${HREF_FORBIDDEN}/][^${HREF_FORBIDDEN}]*)?|https://${HOST}(?::[0-9]{1,5})?(?:[/?#][^${HREF_FORBIDDEN}]*)?)${END}`;

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
  return dash === -1 ? tag : tag.slice(0, dash);
}

/** Locale, then a related primary subtag, then English, then the first key in code-unit order. */
export function pickText(
  value: string | Record<string, string>,
  locale: string,
): { text: string; lang: string | null } {
  if (typeof value === 'string') return { text: value, lang: null };
  if (Object.hasOwn(value, locale)) return { text: value[locale] ?? '', lang: locale };
  const primary = primarySubtag(locale);
  let bare: string | undefined;
  let related: string | undefined;
  let english: string | undefined;
  let first: string | undefined;
  for (const key of Object.keys(value)) {
    if (first === undefined || key < first) first = key;
    if (key === 'en') english = key;
    if (primarySubtag(key) !== primary) continue;
    if (key === primary) bare = key;
    else if (related === undefined || key < related) related = key;
  }
  const lang = bare ?? related ?? english ?? first;
  if (lang === undefined) return { text: '', lang: null };
  return { text: value[lang] ?? '', lang };
}
