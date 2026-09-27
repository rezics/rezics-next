// Realm addresses: `/{locale}/r/{realm}/{tab}`. `{realm}` is a Realm UUID or
// an official Zone's route segment (`fiction`). Pure functions shared by the
// routes, the components and their tests.

import { type UiLocale } from '../../i18n/define.ts';
import { withoutLocale } from '../../i18n/locale.ts';

/** The Realm's views, in tab order. Each is its own URL. */
export const realmTabs = ['home', 'works', 'discussions', 'decisions', 'about'] as const;
export type RealmTab = (typeof realmTabs)[number];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Main's official route segment (`services/main/src/routes/zones.ts`).
const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPrefix = 'https://rezics.com/id/';

export type RealmRef = { kind: 'id'; id: string } | { kind: 'segment'; segment: string };

/** A `/r/{ref}` segment. A UUID is always an ID; anything else must be an official Zone's segment. */
export function parseRealmRef(ref: string): RealmRef | null {
  if (uuid.test(ref)) return { kind: 'id', id: ref };
  if (ref.length <= 64 && segment.test(ref)) return { kind: 'segment', segment: ref };
  return null;
}

/** The UUID of a native IRI, or null. */
export function idOf(iri: string): string | null {
  const id = iri.startsWith(idPrefix) ? iri.slice(idPrefix.length) : '';
  return uuid.test(id) ? id : null;
}

/** A Realm view's address in the page's locale, which may differ from the shell's until the next request. */
export function realmHref(locale: UiLocale, ref: string, tab: RealmTab = 'home',
  query: Record<string, string | undefined> = {}): string {
  const path = `/${locale}/r/${encodeURIComponent(ref)}${tab === 'home' ? '' : `/${tab}`}`;
  const entries = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length ? `${path}?${new URLSearchParams(entries)}` : path;
}

/** The in-page anchor of a Decision on the Decisions tab. */
export const decisionAnchor = (decision: string) => `decision-${idOf(decision) ?? decision.slice(-36)}`;

export function decisionHref(locale: UiLocale, ref: string, decision: string): string {
  return `${realmHref(locale, ref, 'decisions')}#${decisionAnchor(decision)}`;
}

/** The tab a pathname shows, for the tab bar's current item. */
export function tabOf(pathname: string): RealmTab {
  const part = withoutLocale(pathname).split('/')[3];
  return realmTabs.find(tab => tab === part) ?? 'home';
}

/** A Work page address in this Realm's scope, so ratings and classification stay the Realm's. */
export function realmWorkHref(work: string, realm: string): string {
  const id = idOf(work) ?? work;
  return `/w/${id}?${new URLSearchParams({ scope: 'realm', realm })}`;
}

type SearchParams = Record<string, string | string[] | undefined>;

/** A Main cursor from the URL, or undefined when absent or malformed. */
export function parseCursor(params: SearchParams): string | undefined {
  const cursor = params.cursor;
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048 ? cursor : undefined;
}
