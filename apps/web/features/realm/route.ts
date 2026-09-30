// Realm addresses: `/{locale}/r/{realm}/{tab}`. `{realm}` is a Realm UUID or
// an official Zone's route segment (`fiction`). Pure functions shared by the
// routes, the components and their tests.

import { type UiLocale } from '../../i18n/define.ts';
import { withoutLocale } from '../../i18n/locale.ts';

/** The Realm's views in the tab bar, in order. Each is its own URL. */
export const realmTabs = ['home', 'browse', 'discussions', 'decisions', 'about'] as const;
/** Every view with a URL: `works`, the adopted Works a page at a time, now opens Browse's grid. */
export type RealmTab = (typeof realmTabs)[number] | 'works';

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

/**
 * Whether a Zone navigation link only repeats one of the Realm's own tabs
 * (`/r/fiction`, `/zh-Hans/r/fiction/about`); the tab row already has it.
 */
export function repeatsTab(href: string, ref: string): boolean {
  const path = withoutLocale(href.split(/[?#]/)[0] ?? '').replace(/\/+$/, '');
  return [...realmTabs, 'works'].some(tab => path === `/r/${ref}${tab === 'home' ? '' : `/${tab}`}`);
}

/** The in-page anchor of a Decision on the Decisions tab. */
export const decisionAnchor = (decision: string) => `decision-${idOf(decision) ?? decision.slice(-36)}`;

export function decisionHref(locale: UiLocale, ref: string, decision: string): string {
  const id = idOf(decision);
  return `${realmHref(locale, ref, 'decisions', id ? { decision: id } : {})}#${decisionAnchor(decision)}`;
}

export function parseDecision(params: SearchParams): string | null {
  return typeof params.decision === 'string' && uuid.test(params.decision) ? params.decision : null;
}

/** The tab a pathname shows, for the tab bar's current item; none on a page of the Zone's own site. */
export function tabOf(pathname: string): RealmTab | null {
  const part = withoutLocale(pathname).split('/')[3];
  return part === undefined || part === '' ? 'home' : realmTabs.find(tab => tab === part) ?? null;
}

/**
 * A Work page inside the Zone's site, so ratings and classification stay the Zone's Realm's: `/r/{ref}/w/{work}`
 * for a Work its Realm adopted, or `/r/{ref}/{mount}/{work}` for a member of a mounted Collection. Without a
 * tab it opens the Work's overview.
 */
export function realmWorkHref(ref: string, work: string, mount: string | null = null, tab?: 'discussion'): string {
  const id = idOf(work) ?? work;
  return `/r/${encodeURIComponent(ref)}/${mount ? encodeURIComponent(mount) : 'w'}/${id}${tab ? `/${tab}` : ''}`;
}

/** A Work page in a Realm's scope for a Realm with no Zone site to open it in. */
export function scopedWorkHref(work: string, realm: string): string {
  const id = idOf(work) ?? work;
  return `/w/${id}?${new URLSearchParams({ scope: 'realm', realm })}`;
}

/** A page of the Zone's site: a mounted document or Collection (`/r/{ref}/{segment}`), or a page under it. */
export function siteHref(locale: UiLocale, ref: string, path: readonly string[],
  query: Record<string, string | undefined> = {}): string {
  const entries = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined);
  const base = `/${locale}/r/${encodeURIComponent(ref)}/${path.map(encodeURIComponent).join('/')}`;
  return entries.length ? `${base}?${new URLSearchParams(entries)}` : base;
}

type SearchParams = Record<string, string | string[] | undefined>;

/** A Main cursor from the URL, or undefined when absent or malformed. */
export function parseCursor(params: SearchParams): string | undefined {
  const cursor = params.cursor;
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048 ? cursor : undefined;
}
