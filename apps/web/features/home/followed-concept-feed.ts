import { idOf, iriOf, isUuid } from '../discover/scope.ts';
import type { Loaded, MainClient, ReadFailure } from '../feed/types.ts';
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
/** One follows page. The strip shows the topics that fit; More topics asks for the next cursor. */
export const CONCEPT_FOLLOWS_PAGE = 20;

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

/** The first follows page, plus the cursor More topics uses to read the rest. */
export interface ConceptTabList {
  tabs: FollowedConceptTab[];
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

/** One follows page as topic tabs. A cursor stays only while the page says the list continues. */
export function conceptTabList(page: ConceptFollowPage): ConceptTabList {
  const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null;
  const complete = page.complete === true || next === null;
  return { tabs: conceptTabsFromFollows(page.items), nextCursor: complete ? null : next, complete };
}

/**
 * The first follows page only. Home does not walk the rest: More topics asks
 * for each next cursor. A moved first page is read once more. Any other
 * failure is an unread list, not an empty Home.
 */
export async function readFirstConceptPage(readPage: () => Promise<Loaded<ConceptTabList>>): Promise<ConceptTabList | null> {
  const first = await readPage();
  if (first.ok) return first.data;
  if (first.failure !== 'moved') return null;
  const again = await readPage();
  return again.ok ? again.data : null;
}

/** The next follows page, in order, without repeating a topic or asking for the same cursor again. */
export function appendConceptTabs(current: readonly FollowedConceptTab[], page: ConceptTabList, requestedCursor: string):
  { tabs: FollowedConceptTab[]; cursor: string | null } {
  const seen = new Set(current.map(tab => tab.id));
  const tabs = [...current];
  for (const tab of page.tabs) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  const stalled = !page.complete && page.nextCursor === requestedCursor;
  return { tabs, cursor: page.complete || stalled || !page.nextCursor ? null : page.nextCursor };
}

/**
 * How many topic tabs fit beside Following and All, leaving room for More topics
 * when anything remains. Widths are the rendered boxes, in follow order.
 */
export function conceptTabsThatFit(widths: { available: number; prefix: number; more: number; tabs: readonly number[] },
  moreRemains: boolean): number {
  let used = widths.prefix;
  let count = 0;
  for (let index = 0; index < widths.tabs.length; index++) {
    const remains = moreRemains || index < widths.tabs.length - 1;
    if (used + widths.tabs[index]! + (remains ? widths.more : 0) > widths.available) break;
    used += widths.tabs[index]!;
    count++;
  }
  return count;
}

/** The prefix that fits, with the open topic kept on the strip when the prefix had not reached it. */
export function visibleConceptTabs(topics: readonly FollowedConceptTab[], fit: number, current: string | null):
  FollowedConceptTab[] {
  const count = Math.max(0, Math.min(Math.floor(fit), topics.length));
  const head = topics.slice(0, count);
  if (!current || head.some(tab => tab.tab === current)) return head;
  const opened = topics.find(tab => tab.tab === current);
  if (!opened) return head;
  if (count === 0) return [opened];
  return [...head.slice(0, -1), opened];
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

/** A first page replaces the list. A later page appends. `requestedCursor` null is that first page. */
export function applyConceptWorks(current: readonly ConceptWork[], page: ConceptFeedPage, requestedCursor: string | null):
  { items: ConceptWork[]; cursor: string | null } {
  if (requestedCursor === null) return { items: page.items, cursor: page.complete ? null : page.nextCursor };
  return appendConceptWorks(current, page, requestedCursor);
}

/** The empty topic state is only the end of the list. An empty page with a cursor still continues. */
export function conceptWorksExhausted(items: readonly unknown[], cursor: string | null): boolean {
  return items.length === 0 && cursor === null;
}

/** What a failed Show more may do. A moved or rejected cursor is not asked for again. */
export function topicContinuation(failure: ReadFailure): 'restart' | 'retry' {
  return failure === 'moved' || failure === 'invalid' ? 'restart' : 'retry';
}

/**
 * The mode after one attempt. A restart that fails stays a restart, including
 * when the failure is offline or unavailable, so the next try is the first
 * page again and never the cursor that was rejected.
 */
export function nextContinuation(fromStart: boolean, failure: ReadFailure): 'restart' | 'retry' {
  return fromStart ? 'restart' : topicContinuation(failure);
}

/** The cursor one attempt sends. Restart omits it: that is the first page. */
export function continuationRequest(fromStart: boolean, cursor: string | null): string | undefined {
  return fromStart ? undefined : cursor ?? undefined;
}

/**
 * Which page a read is. It is not a hash of the page's fields: the same works
 * and cursor are the same page, and a correction arrives on the read itself.
 */
export function conceptFeedIdentity(read: Loaded<ConceptFeedPage>): string {
  if (!read.ok) return `unread:${read.failure}:${read.reference ?? ''}`;
  return `page:${read.data.nextCursor ?? ''}:${read.data.items.map(item => item.id).join(' ')}`;
}

/**
 * Pages the reader loaded after the server read. They belong to that read
 * only. A restart replaces the server page until the next server read.
 */
export interface TopicClientPages {
  read: Loaded<ConceptFeedPage>;
  appended: readonly ConceptWork[];
  cursor: string | null;
  restart: ConceptFeedPage | null;
}

/** The server read, plus client pages only while that same read is showing. */
export function topicPageShown(read: Loaded<ConceptFeedPage>, client: TopicClientPages | null): {
  items: ConceptWork[]; cursor: string | null;
} {
  if (!client || client.read !== read) {
    const opened = topicFeedFrom(read);
    return { items: opened.items, cursor: opened.cursor };
  }
  const base = client.restart ? client.restart.items : topicFeedFrom(read).items;
  const seen = new Set(base.map(item => item.id));
  return { items: [...base, ...client.appended.filter(item => !seen.has(item.id))], cursor: client.cursor };
}

/** Remember a successful Show more or restart against the server read it belongs to. */
export function rememberTopicPage(read: Loaded<ConceptFeedPage>, client: TopicClientPages | null, page: ConceptFeedPage,
  fromStart: boolean): TopicClientPages {
  const current = client && client.read === read ? client : null;
  const requested = fromStart ? null : current?.cursor ?? topicFeedFrom(read).cursor;
  const base = fromStart ? page.items : current?.restart?.items ?? topicFeedFrom(read).items;
  const applied = applyConceptWorks(fromStart ? base : [...base, ...(current?.appended ?? [])], page, requested);
  const seen = new Set(base.map(item => item.id));
  return {
    read, restart: fromStart ? page : current?.restart ?? null,
    appended: applied.items.filter(item => !seen.has(item.id)), cursor: applied.cursor,
  };
}

/** The list and cursor one read shows, before any Show more. */
export function topicFeedFrom(read: Loaded<ConceptFeedPage>): { items: ConceptWork[]; cursor: string | null } {
  if (!read.ok) return { items: [], cursor: null };
  return { items: read.data.items, cursor: read.data.complete ? null : read.data.nextCursor };
}

/** One follows page. `cursor` omitted is the first page, in the reader's follow order. */
export async function readConceptFollows(main: MainClient, actingSubject: string, cursor?: string):
  Promise<Loaded<ConceptTabList>> {
  const read = await settle(() => main.v1.me.follows.get({ query: {
    actingSubject, kind: 'concept', limit: CONCEPT_FOLLOWS_PAGE, ...(cursor ? { cursor } : {}) } }));
  if (!read.ok) return read;
  const body = read.data as { items?: unknown; nextCursor?: unknown; complete?: unknown };
  return { ok: true, data: conceptTabList({
    items: Array.isArray(body.items) ? body.items : [],
    nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    complete: body.complete === true,
  }) };
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
