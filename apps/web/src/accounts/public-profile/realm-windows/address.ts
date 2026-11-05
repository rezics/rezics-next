import { accountHref, keepSearch } from '../../../subject/subject-href';

/** Only cursor fields change; unrelated encoded names, values, duplicates and fragments remain verbatim. */
export function realmsWindowHref(handle: string, locale: string, search: string, hash: string, cursor?: string) {
  const fields = search
    .replace(/^\?/, '')
    .split('&')
    .filter((field) => !new URLSearchParams(field).has('cursor'));
  if (!search) fields.length = 0;
  if (cursor !== undefined) fields.push(`cursor=${encodeURIComponent(cursor)}`);
  return keepSearch(accountHref(locale, handle, 'realms'), fields.join('&'), hash);
}
