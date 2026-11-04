import { chooseLabel } from '../semantic/language.ts';
import { sortName } from '../semantic/link-keys.ts';

export const SHELF_TITLE_KEY_POLICY = 'semantic-sort-name-v1';
const KEY_CODEPOINT_LIMIT = 256;

export type ShelfTitleKey =
  | { coverage: 'labelled'; language: string; bytes: Uint8Array }
  | { coverage: 'missing'; language: string | null; bytes: null };

/** Derive only from labels already disclosed by Semantic, using its existing language-selection rule. */
export function shelfTitleKey(
  labels: Readonly<Record<string, string>>,
  languages: readonly string[],
  originalLanguage?: string | null,
): ShelfTitleKey {
  const label = chooseLabel(labels, languages, originalLanguage);
  if (!label || label.value.length === 0)
    return { coverage: 'missing', language: label?.language ?? null, bytes: null };
  const prefix = [...sortName(label.value)].slice(0, KEY_CODEPOINT_LIMIT).join('');
  return { coverage: 'labelled', language: label.language, bytes: Buffer.from(prefix, 'utf8') };
}
