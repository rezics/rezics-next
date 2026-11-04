import { locales } from '../paraglide/runtime.js';

const origin = 'https://rezics.invalid';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const regions = { boards: 'realm-boards-heading', publications: 'realm-published-heading' } as const;
export type RealmReadingNode = keyof typeof regions;
export type RealmReadingSearch = { node?: RealmReadingNode; cursor?: string };

/** Only these two native shelf readers consume a Realm page's node and cursor. */
export function realmReadingSearch(value: Record<string, unknown>): RealmReadingSearch {
  const node = value.node;
  if (node !== 'boards' && node !== 'publications') return {};
  const cursor = value.cursor;
  return {
    node,
    ...(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(cursor)
      ? { cursor }
      : {}),
  };
}

/** Public locators only: no arbitrary query, credentials, grants or retained command state. */
export function realmReadingReturn(value: unknown, locale?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 32768 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(value)) return;
  try {
    const url = new URL(value, origin);
    const parts = url.pathname.split('/');
    if (url.origin !== origin || parts.length !== 4 || !locales.includes(parts[1] as typeof locales[number]) || (locale && locale !== parts[1])) return;
    if (parts[2] !== 'realms' && parts[2] !== 'spaces') return;
    const identity = decodeURIComponent(parts[3]!);
    if (parts[2] === 'realms' ? !uuid.test(identity) : !/^[A-Za-z0-9_-]{1,128}$/u.test(identity)) return;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => key !== 'node' && key !== 'cursor') || new Set(keys).size !== keys.length) return;
    const input = Object.fromEntries(url.searchParams);
    const search = realmReadingSearch(input);
    if ((input.node !== undefined && input.node !== search.node) || (input.cursor !== undefined && input.cursor !== search.cursor)) return;
    const selected = /^#realm-(board|publication)-([0-9a-f-]{36})$/i.exec(url.hash);
    if (url.hash && url.hash !== `#${regions.boards}` && url.hash !== `#${regions.publications}` && !(selected && uuid.test(selected[2]!) && search.node === (selected[1] === 'board' ? 'boards' : 'publications'))) return;
    if (search.node && url.hash && !selected && url.hash !== `#${regions[search.node]}`) return;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return; }
}

/** A row returns to the native page that supplied it, independent of the other shelf. */
export function realmShelfReturn(input: {
  href: string;
  locale: string;
  node: RealmReadingNode;
  cursor?: string | null;
  id?: string;
}): string | undefined {
  const accepted = realmReadingReturn(input.href, input.locale);
  if (!accepted) return;
  const url = new URL(accepted, origin);
  url.search = '';
  url.searchParams.set('node', input.node);
  if (input.cursor) url.searchParams.set('cursor', input.cursor);
  url.hash = input.id && uuid.test(input.id)
    ? `realm-${input.node === 'boards' ? 'board' : 'publication'}-${input.id}`
    : regions[input.node];
  return realmReadingReturn(`${url.pathname}${url.search}${url.hash}`, input.locale);
}

export function realmReadingSelection(href: string | undefined): RealmReadingSearch & { focus?: string } {
  const accepted = realmReadingReturn(href);
  if (!accepted) return {};
  const url = new URL(accepted, origin);
  return { ...realmReadingSearch(Object.fromEntries(url.searchParams)), ...(url.hash ? { focus: url.hash.slice(1) } : {}) };
}
