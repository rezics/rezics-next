import { idOf, iriOf, isUuid } from '../discover/scope.ts';
import type { Loaded, MainClient } from '../feed/types.ts';
import { settle } from '../feed/types.ts';
import { languageTag } from '../onboarding/languages.ts';

// A followed topic's Home tab. The follows list says which Concepts the reader
// follows; each tab's works are the public template read, newest first. Saved
// Filters stay a separate, gated surface and are not how this tab is built.

/** Kernel's public template for one followed Concept's works. */
export const CONCEPT_FEED_QUERY = 'https://rezics.com/query/followed-concept-feed';
export const CONCEPT_FEED_REVISION = 1;
/** The template's own default and maximum page sizes (`limit` on the request). */
export const CONCEPT_FEED_PAGE = 20;
export const CONCEPT_FEED_MAX_PAGE = 64;
/**
 * Follows are seek-paged at 20. Home reads a few pages so a reader who follows
 * more than one page still gets those tabs, and stops rather than walking the
 * whole inventory on every Home render. Past this, the open tab is confirmed
 * on its own.
 */
export const MAX_CONCEPT_TAB_PAGES = 4;

const CONCEPT_IRI = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface FollowedConceptTab {
  /** The Concept IRI. */
  id: string;
  /** The UUID `?tab=` carries, so the address stays the feed's existing tab parameter. */
  tab: string;
  name: { value: string; language: string; direction?: 'ltr' | 'rtl' } | null;
  revision: string;
}

export interface ConceptWork {
  id: string;
  concept: string;
  name: { value: string; language: string; direction?: 'ltr' | 'rtl' };
}

export interface ConceptFeedPage {
  items: ConceptWork[];
  nextCursor: string | null;
  complete: boolean;
}

export interface ConceptFollowPage {
  items: readonly unknown[];
  nextCursor: string | null;
  complete: boolean;
}

/** One page of the template. `limit` is omitted at the default of 20; a cursor is seek, not a page object. */
export function conceptFeedQuery(conceptId: string, options: { cursor?: string | null; limit?: number;
  language?: string } = {}): {
  profile: 'template-query-v1'; query: typeof CONCEPT_FEED_QUERY; revision: typeof CONCEPT_FEED_REVISION;
  parameters: { roots: [string] }; presentation?: { language: string }; limit?: number; cursor?: string;
} | null {
  if (!CONCEPT_IRI.test(conceptId)) return null;
  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > CONCEPT_FEED_MAX_PAGE)) return null;
  const cursor = options.cursor ?? undefined;
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 2048)) return null;
  const language = options.language ? languageTag(options.language) ?? undefined : undefined;
  return {
    profile: 'template-query-v1', query: CONCEPT_FEED_QUERY, revision: CONCEPT_FEED_REVISION,
    parameters: { roots: [conceptId] },
    ...(language ? { presentation: { language } } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function conceptName(value: unknown): ConceptWork['name'] | null {
  if (!value || typeof value !== 'object') return null;
  const name = value as { value?: unknown; language?: unknown; direction?: unknown };
  if (typeof name.value !== 'string' || !name.value || typeof name.language !== 'string') return null;
  const direction = name.direction === 'ltr' || name.direction === 'rtl' ? name.direction : undefined;
  return { value: name.value, language: name.language, ...(direction ? { direction } : {}) };
}

function conceptWork(value: unknown): ConceptWork | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as { id?: unknown; concept?: unknown; name?: unknown };
  if (typeof item.id !== 'string' || !CONCEPT_IRI.test(item.id)) return null;
  if (typeof item.concept !== 'string' || !CONCEPT_IRI.test(item.concept)) return null;
  const name = conceptName(item.name);
  return name ? { id: item.id, concept: item.concept, name } : null;
}

/**
 * The template result, or the query envelope around it. Another operation's
 * body is not this page: a missing or disagreeing cursor is a failed read,
 * not an empty success.
 */
export function conceptFeedPage(body: unknown): ConceptFeedPage | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { profile?: unknown; result?: unknown };
  const result = record.profile === 'query-v1' ? record.result : body;
  if (!result || typeof result !== 'object') return null;
  const page = result as { profile?: unknown; query?: unknown; revision?: unknown; items?: unknown;
    nextCursor?: unknown; complete?: unknown };
  if (page.profile !== 'template-result-v1' || page.query !== CONCEPT_FEED_QUERY || page.revision !== CONCEPT_FEED_REVISION)
    return null;
  if (!Array.isArray(page.items)) return null;
  const items: ConceptWork[] = [];
  for (const item of page.items) {
    const work = conceptWork(item);
    if (!work) return null;
    items.push(work);
  }
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') return null;
  if (page.complete !== true && page.complete !== false) return null;
  const nextCursor = page.nextCursor;
  if (page.complete !== (nextCursor === null)) return null;
  return { items, nextCursor, complete: page.complete };
}

/** Tabs for Concept follows, in the list's order. Anything else in the page is not a topic tab. */
export function conceptTabsFromFollows(items: readonly unknown[]): FollowedConceptTab[] {
  const tabs: FollowedConceptTab[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; kind?: unknown; available?: unknown; revision?: unknown; name?: unknown };
    if (row.kind !== 'concept') continue;
    if (typeof row.id !== 'string' || typeof row.revision !== 'string') continue;
    const tab = idOf(row.id);
    if (!tab || seen.has(row.id)) continue;
    seen.add(row.id);
    const name = conceptName(row.name);
    tabs.push({ id: row.id, tab, name, revision: row.revision });
  }
  return tabs;
}

/**
 * Walk the follows list. The first page failing is an unread list, not an empty
 * Home. A later page failing keeps the tabs already read and says the list is
 * incomplete. A moved list is read once more from the start.
 */
export async function collectConceptTabs(readPage: (cursor?: string) => Promise<Loaded<ConceptFollowPage>>):
  Promise<{ tabs: FollowedConceptTab[]; complete: boolean } | null> {
  let retried = false;
  let cursor: string | undefined;
  let tabs: FollowedConceptTab[] = [];
  const seen = () => new Set(tabs.map(tab => tab.id));
  for (let page = 0; page < MAX_CONCEPT_TAB_PAGES; page++) {
    const read = await readPage(cursor);
    if (!read.ok) {
      if (read.failure === 'moved' && !retried) {
        retried = true;
        cursor = undefined;
        tabs = [];
        page = -1;
        continue;
      }
      if (read.failure === 'moved') return null;
      return tabs.length === 0 ? null : { tabs, complete: false };
    }
    const known = seen();
    for (const tab of conceptTabsFromFollows(read.data.items)) {
      if (known.has(tab.id)) continue;
      known.add(tab.id);
      tabs.push(tab);
    }
    if (read.data.complete || !read.data.nextCursor) return { tabs, complete: true };
    if (read.data.nextCursor === cursor) return { tabs, complete: false };
    cursor = read.data.nextCursor;
  }
  return { tabs, complete: false };
}

export type ConceptAddress =
  | { kind: 'selected'; tab: FollowedConceptTab }
  | { kind: 'absent' }
  | { kind: 'unconfirmed' };

/** Whether `?tab=` is one of the followed topics already listed. An incomplete list does not call the rest absent. */
export function addressConceptTab(listed: { tabs: readonly FollowedConceptTab[]; complete: boolean } | null,
  tabUuid: string): ConceptAddress {
  if (!isUuid(tabUuid)) return { kind: 'absent' };
  const found = listed?.tabs.find(tab => tab.tab === tabUuid);
  if (found) return { kind: 'selected', tab: found };
  if (listed?.complete) return { kind: 'absent' };
  return { kind: 'unconfirmed' };
}

/** A follow-state read of the open address, when the list did not already contain it. */
export function tabFromFollowState(body: unknown, tabUuid: string): FollowedConceptTab | null {
  if (!isUuid(tabUuid) || !body || typeof body !== 'object') return null;
  const state = body as { following?: unknown; revision?: unknown; target?: { id?: unknown; kind?: unknown; name?: unknown } };
  if (state.following !== true || state.target?.kind !== 'concept') return null;
  if (typeof state.target.id !== 'string' || idOf(state.target.id) !== tabUuid) return null;
  // Unfollow reads the revision again. A missing one still leaves the topic on the strip.
  const revision = typeof state.revision === 'string' ? state.revision : '';
  return { id: state.target.id, tab: tabUuid, name: conceptName(state.target.name), revision };
}

/** The open topic stays on the strip when the paged list had not reached it yet. */
export function withOpenedConcept(tabs: readonly FollowedConceptTab[], opened: FollowedConceptTab | null):
  FollowedConceptTab[] {
  if (!opened || tabs.some(tab => tab.id === opened.id)) return [...tabs];
  return [...tabs, opened];
}

/**
 * A saved filter that only names a followed topic is that topic's old tab.
 * The topic tab replaces it. A filter with its own conditions stays.
 */
export function filtersBesideTopics<T extends { concept: { id: string } | null }>(filters: readonly T[],
  topics: readonly { id: string }[]): T[] {
  const ids = new Set(topics.map(topic => topic.id));
  return filters.filter(filter => !filter.concept || !ids.has(filter.concept.id));
}

/** Works from the next seek page, without repeating a work or asking for the same cursor again. */
export function appendConceptWorks(current: readonly ConceptWork[], page: ConceptFeedPage, requestedCursor: string):
  { items: ConceptWork[]; cursor: string | null } {
  const seen = new Set(current.map(item => item.id));
  const items = [...current, ...page.items.filter(item => !seen.has(item.id))];
  const stalled = !page.complete && page.nextCursor === requestedCursor;
  return { items, cursor: page.complete || stalled ? null : page.nextCursor };
}

/** The Concept IRI a tab address names, or null when the address is not one. */
export function conceptIri(tabUuid: string): string | null {
  return isUuid(tabUuid) ? iriOf(tabUuid) : null;
}

/** One seek page of a topic's public works. Items are kept in the server's order, which is newest first. */
export async function readConceptFeed(main: MainClient, conceptId: string, language?: string, cursor?: string):
  Promise<Loaded<ConceptFeedPage>> {
  const query = conceptFeedQuery(conceptId, { cursor, language });
  if (!query) return { ok: false, failure: 'invalid' };
  const read = await settle(() => main.v1.query.post(query));
  if (!read.ok) return read;
  const page = conceptFeedPage(read.data);
  if (!page || page.items.some(item => item.concept !== conceptId)) return { ok: false, failure: 'invalid' };
  return { ok: true, data: page };
}
