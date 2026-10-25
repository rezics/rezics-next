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

export const PLAIN_TEXT = new RegExp(PLAIN_TEXT_PATTERN, 'u');
export const HREF = new RegExp(HREF_PATTERN, 'u');
export const CURIE = new RegExp(CURIE_PATTERN, 'u');
export const NODE_ID = new RegExp(NODE_ID_PATTERN, 'u');

const SAFETY = '~safety';

export type SafetyKind = 'plainText' | 'href' | 'curie';

/** Marker TypeBox leaves on the schema object. JSON Schema export drops every `~` key. */
export function safetyKind(schema: object): SafetyKind | undefined {
  const kind = (schema as Record<string, unknown>)[SAFETY];
  return kind === 'plainText' || kind === 'href' || kind === 'curie' ? kind : undefined;
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
