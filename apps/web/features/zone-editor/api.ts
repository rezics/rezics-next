import type { WriteRound } from '../api/command.ts';
import { browserMainApi } from '../api/browser.ts';
import { settle } from '../manage/read.ts';
import { problemCode, type Loaded, type MainClient, type ReadFailure } from '../manage/types.ts';
import { isWideText } from '../search/suggest.ts';
import { normalizePhrase, PHRASE } from '../search/state.ts';
import {
  draftWire, loadedDraft, publicationWire,
  type AuthoringFailure, type DraftBasis, type DraftChoice, type DraftWire, type LoadedDraft, type PublicationChoice,
} from './model.ts';
import {
  foldMountPages, NAV_LOAD_BATCH, NAV_PAGE_SIZE, navigationReadTarget, pageNameOf, zoneMountPage,
  type NavigationReadTarget, type NavPosition, type NavWriteFailure, type NavWriteResult, type SiteLink,
} from './navigation.ts';
import type { ZonePresentationBaseline } from './theme.ts';

export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: AuthoringFailure }
  | { ok: false; failure: 'stale'; currentHead: string | null };

export interface SavedDraft extends DraftBasis { replayed: boolean }
export interface PublishedSite { zoneHead: string; replayed: boolean }
export interface ZoneHeads { zoneHead: string; navigationRevision: string }
export interface ZoneThemeSnapshot { revision: string; configuration: Record<string, unknown> }
export interface SavedZoneTheme { revision: string; replayed: boolean }
export interface ZoneThemeWrite {
  expectedHead: string;
  actingSubject: string;
  presentation: ZonePresentationBaseline;
}

export interface ZoneThemeClient {
  readConfiguration(zoneId: string, actingSubject: string): Promise<WriteResult<ZoneThemeSnapshot>>;
  saveConfiguration(zoneId: string, body: ZoneThemeWrite, key: string): Promise<WriteResult<SavedZoneTheme>>;
}

/**
 * One command, retried once when the response is lost. The same Idempotency-Key
 * replays a commit that landed. A stale head is a definitive refusal: the text stays.
 */
export async function commitCommand<T>(round: WriteRound, write: (key: string) => Promise<WriteResult<T>>): Promise<WriteResult<T>> {
  const once = async () => {
    try { return await write(round.key); }
    catch { return { ok: false as const, failure: 'unavailable' as const }; }
  };
  let written = await once();
  if (!written.ok && written.failure === 'unavailable' && !round.superseded()) written = await once();
  return written;
}

export interface ZoneAuthoringClient {
  saveDraft(body: DraftWire, key: string): Promise<WriteResult<SavedDraft>>;
  publish(choice: PublicationChoice, actingSubject: string, key: string): Promise<WriteResult<PublishedSite>>;
  /** The saved home draft, including the epoch a publish has to name. */
  readDraft(zoneId: string, actingSubject: string): Promise<WriteResult<LoadedDraft>>;
  /** Configuration head and the navigation revision a publish must name for both cuts. */
  readHeads(zoneId: string, actingSubject: string): Promise<WriteResult<ZoneHeads>>;
}

type HttpAnswer = { data: unknown; error: { status: number; value: unknown } | null };

/** Browser writes for the home page. Stories pass their own client. */
export function browserZoneAuthoring(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneAuthoringClient {
  return {
    async saveDraft(body, key) {
      return savedOf(await post(() => main.v1['content-drafts'].post(body, { headers: { 'idempotency-key': key } })));
    },
    async publish(choice, actingSubject, key) {
      return publishedOf(await post(() => main.v1.zones({ id: zoneUuid(choice.page) })['site-publications'].post(
        publicationWire(choice, actingSubject), { headers: { 'idempotency-key': key } })));
    },
    async readDraft(zoneId, actingSubject) {
      const answer = await post(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }));
      if (!answer.ok) return answer;
      const heads = await this.readHeads(zoneId, actingSubject);
      if (!heads.ok) return heads;
      const draft = loadedDraft(answer.data, { revision: heads.data.navigationRevision, ownerRevision: heads.data.zoneHead });
      return draft ? { ok: true, data: draft } : { ok: false, failure: 'unavailable' };
    },
    async readHeads(zoneId, actingSubject) {
      const answer = await post(() => main.v1.zones({ id: zoneId }).get({ query: { actingSubject } }));
      if (!answer.ok) return answer;
      return headsOf(answer.data) ?? { ok: false, failure: 'unavailable' };
    },
  };
}

/** Browser access to the public Zone configuration, which applies zone.edit on both operations. */
export function browserZoneTheme(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneThemeClient {
  return {
    async readConfiguration(zoneId, actingSubject) {
      const answer = await post(() => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } }));
      if (!answer.ok) return answer;
      const row = record(answer.data);
      const revision = row?.revision;
      const configuration = record(row?.configuration);
      if (typeof revision !== 'string' || !iriPattern.test(revision) || !configuration) {
        return { ok: false, failure: 'unavailable' };
      }
      return { ok: true, data: { revision, configuration } };
    },
    async saveConfiguration(zoneId, body, key) {
      const answer = await post(() => main.v1.zones({ id: zoneId }).configuration.put(
        body, { headers: { 'idempotency-key': key } },
      ));
      if (!answer.ok) return answer;
      const row = record(answer.data);
      const revision = row?.revision;
      if (typeof revision !== 'string' || !iriPattern.test(revision)) return { ok: false, failure: 'unavailable' };
      return { ok: true, data: { revision, replayed: row?.replayed === true } };
    },
  };
}

/** The choice the lane keys, without the fields that never go on the wire. */
export function choiceWire(choice: DraftChoice): DraftWire {
  return draftWire(choice);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const iriPattern = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/;

function zoneUuid(page: string): string {
  return iriPattern.exec(page)?.[1] ?? page;
}

async function post(call: () => Promise<HttpAnswer>): Promise<WriteResult<unknown>> {
  try {
    const answer = await call();
    if (answer.error || answer.data == null) return failureOf(answer.error, !answer.error);
    if (typeof answer.data === 'object' && answer.data !== null && 'operationId' in answer.data) {
      return { ok: false, failure: 'unavailable' };
    }
    return { ok: true, data: answer.data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

function savedOf(result: WriteResult<unknown>): WriteResult<SavedDraft> {
  if (!result.ok) return result;
  const row = record(result.data);
  const position = record(row?.sourcePosition);
  const revisionId = row?.revisionId;
  const byteDigest = row?.byteDigest;
  const epoch = position?.dataEpoch;
  if (typeof revisionId !== 'string' || !uuid.test(revisionId)
    || typeof byteDigest !== 'string' || !digest.test(byteDigest)
    || typeof epoch !== 'string' || !uuid.test(epoch)) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: { revisionId, byteDigest, contentEpoch: epoch, replayed: row?.replayed === true } };
}

function publishedOf(result: WriteResult<unknown>): WriteResult<PublishedSite> {
  if (!result.ok) return result;
  const revision = record(result.data)?.revision;
  if (typeof revision !== 'string' || !iriPattern.test(revision)) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: { zoneHead: revision, replayed: record(result.data)?.replayed === true } };
}

function headsOf(data: unknown): WriteResult<ZoneHeads> | null {
  const row = record(data);
  const navigation = row?.revision;
  const zoneHead = row?.ownerRevision;
  if (typeof navigation !== 'string' || typeof zoneHead !== 'string' || !iriPattern.test(navigation) || !iriPattern.test(zoneHead)) {
    return null;
  }
  return { ok: true, data: { zoneHead, navigationRevision: navigation } };
}

function failureOf(error: { status: number; value: unknown } | null, thrown: boolean): WriteResult<never> {
  if (thrown || !error || !(error.status >= 100)) return { ok: false, failure: 'unavailable' };
  const code = problemCode(error.value);
  // Zone mount writes report zone_conflict; composition moves report stale_composition_head.
  if (error.status === 409 && (code === 'stale_head' || code === 'stale_zone_head'
    || code === 'zone_conflict' || code === 'stale_composition_head')) {
    const head = record(error.value)?.currentHead;
    return { ok: false, failure: 'stale', currentHead: typeof head === 'string' ? head : null };
  }
  if (error.status === 409) return { ok: false, failure: 'conflict' };
  if (error.status === 401) return { ok: false, failure: 'sign-in' };
  if (error.status === 403 || error.status === 404) return { ok: false, failure: 'denied' };
  if (error.status === 400 || error.status === 413 || error.status === 422) return { ok: false, failure: 'invalid' };
  if (error.status === 408 || error.status === 429 || error.status >= 500) return { ok: false, failure: 'unavailable' };
  return { ok: false, failure: 'unavailable' };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export interface PageChoice { target: string; name: string }

export interface NavigationSnapshot {
  head: string;
  navigation: string;
  links: SiteLink[];
  complete: boolean;
  /** Outstanding continuation cursor when the inventory is incomplete. */
  after: string | null;
  zoneHead: string | null;
}

export interface NavigationResume {
  head: string;
  after: string;
}

export interface ZoneNavigationClient {
  readNavigation(zoneId: string, actingSubject: string): Promise<WriteResult<NavigationSnapshot>>;
  /** Next burst after an incomplete read, pinned to the revision already loaded. */
  continueNavigation(zoneId: string, actingSubject: string, resume: NavigationResume): Promise<WriteResult<NavigationSnapshot>>;
  insertMount(zoneId: string, body: MountBody, key: string): Promise<NavWriteResult | NavWriteFailure>;
  removeMount(zoneId: string, occurrenceId: string, body: { expectedHead: string; actingSubject: string }, key: string): Promise<NavWriteResult | NavWriteFailure>;
  moveMount(navigation: string, body: MoveBody, key: string): Promise<NavWriteResult | NavWriteFailure>;
  findPages(query: string, locale: string): Promise<PageChoice[]>;
}

export interface MountBody {
  expectedHead: string;
  target: string;
  routeSegment: string;
  disclosure: 'public' | 'private';
  position: NavPosition;
  actingSubject: string;
}

export interface MoveBody {
  expectedHead: string;
  occurrence: string;
  position: 'first' | { after: string };
  actingSubject: string;
}

/** Browser commands for the Zone's navigation. Stories pass their own client. */
export function browserZoneNavigation(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneNavigationClient {
  return {
    readNavigation(zoneId, actingSubject) {
      return collectBrowserNavigation(main, zoneId, actingSubject);
    },
    continueNavigation(zoneId, actingSubject, resume) {
      return collectBrowserNavigation(main, zoneId, actingSubject, resume);
    },
    async insertMount(zoneId, body, key) {
      return mountOf(await post(() => main.v1.zones({ id: zoneId }).mounts.post(body, { headers: { 'idempotency-key': key } })));
    },
    async removeMount(zoneId, occurrenceId, body, key) {
      return mountOf(await post(() => main.v1.zones({ id: zoneId }).mounts({ occurrence: occurrenceId }).delete(
        body, { headers: { 'idempotency-key': key } })));
    },
    async moveMount(navigation, body, key) {
      return mountOf(await post(() => main.v1.compositions({ id: navigation.slice(-36) }).changes.post({
        profile: 'zone-navigation',
        expectedHead: body.expectedHead,
        actingSubject: body.actingSubject,
        operations: [{
          op: 'move',
          occurrence: body.occurrence,
          parent: navigation,
          position: body.position,
        }],
      } as never, { headers: { 'idempotency-key': key } })));
    },
    findPages(query, locale) {
      return findZonePages(main, query, locale);
    },
  };
}

/**
 * Server-side Zone navigation read that follows continuation pages.
 * A filled burst keeps `after` so the editor can resume without discarding the cursor.
 */
export async function loadZoneNavigation(
  main: MainClient,
  zoneId: string,
  actingSubject: string,
  resume?: NavigationResume,
): Promise<Loaded<NavigationSnapshot>> {
  let readFailure: ReadFailure | null = null;
  const batch = await collectMountPages(async target => {
    const read = await settle(() => zonePageCall(main, zoneId, actingSubject, target), {
      management: true, cursor: target.kind === 'revision' ? target.after : undefined,
    });
    if (!read.ok) {
      readFailure = read.failure;
      return { ok: false as const, failure: read.failure };
    }
    return { ok: true as const, data: read.data };
  }, resume);
  if (!batch.ok) return { ok: false, failure: readFailure ?? 'unavailable' };
  return {
    ok: true,
    data: {
      ...batch.data,
      links: await withPageNames(main, batch.data.links, actingSubject),
    },
  };
}

async function collectBrowserNavigation(
  main: MainClient,
  zoneId: string,
  actingSubject: string,
  resume?: NavigationResume,
): Promise<WriteResult<NavigationSnapshot>> {
  let writeFailure: WriteResult<NavigationSnapshot> | null = null;
  const batch = await collectMountPages(async target => {
    const answer = await post(() => zonePageCall(main, zoneId, actingSubject, target));
    if (!answer.ok) {
      writeFailure = answer as WriteResult<NavigationSnapshot>;
      return answer;
    }
    return { ok: true as const, data: answer.data };
  }, resume);
  if (!batch.ok) return writeFailure ?? { ok: false, failure: 'unavailable' };
  return {
    ok: true,
    data: {
      ...batch.data,
      links: await withPageNames(main, batch.data.links, actingSubject),
    },
  };
}

function zonePageCall(
  main: MainClient,
  zoneId: string,
  actingSubject: string,
  target: NavigationReadTarget,
) {
  const query = { actingSubject, limit: NAV_PAGE_SIZE, ...(target.kind === 'revision' ? { after: target.after } : {}) };
  if (target.kind === 'revision') {
    return main.v1.zones({ id: zoneId }).revisions({ revision: target.revision.slice(-36) }).get({ query });
  }
  return main.v1.zones({ id: zoneId }).get({ query });
}

type MountBatch = {
  head: string;
  navigation: string;
  links: SiteLink[];
  complete: boolean;
  after: string | null;
  zoneHead: string | null;
};

async function collectMountPages(
  readPage: (target: NavigationReadTarget) => Promise<
    { ok: true; data: unknown } | { ok: false; failure: string } | WriteResult<unknown>
  >,
  resume?: NavigationResume,
): Promise<{ ok: true; data: MountBatch } | { ok: false; failure: 'unavailable' | 'stale' }> {
  const pages: NonNullable<ReturnType<typeof zoneMountPage>>[] = [];
  let pinned: string | null = resume?.head ?? null;
  let after: string | undefined = resume?.after;
  for (let page = 0; page < NAV_LOAD_BATCH; page += 1) {
    const target = navigationReadTarget(pinned, after);
    if (resume && page === 0 && target.kind !== 'revision') return { ok: false, failure: 'unavailable' };
    const answer = await readPage(target);
    if (!answer.ok) {
      return { ok: false, failure: answer.failure === 'stale' ? 'stale' : 'unavailable' };
    }
    const parsed = zoneMountPage(answer.data);
    if (!parsed) return { ok: false, failure: 'unavailable' };
    if (pinned && parsed.head !== pinned) return { ok: false, failure: 'unavailable' };
    pinned = parsed.head;
    pages.push(parsed);
    if (!parsed.next) break;
    if (parsed.next === after) return { ok: false, failure: 'unavailable' };
    after = parsed.next;
  }
  const folded = foldMountPages(pages);
  if (!folded) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: folded };
}

/** The page's name, when either read has one. A mount stores no name of its own. */
export async function withPageNames(main: MainClient, links: readonly SiteLink[], actingSubject: string): Promise<SiteLink[]> {
  return Promise.all(links.map(async link => {
    const id = link.target.slice(-36);
    const [collection, work] = await Promise.all([
      settle(() => main.v1.collections({ id }).name.get()),
      settle(() => main.v1.works({ id }).get({ query: { actingSubject } })),
    ]);
    const name = (collection.ok ? pageNameOf(collection.data) : null) ?? (work.ok ? pageNameOf(work.data) : null);
    return name ? { ...link, name } : link;
  }));
}

/** A page search is ready at two letters, or one character of a wide script. */
export function pageSearchReady(value: string): boolean {
  return pagePrefix(value) !== null;
}

function pagePrefix(value: string): string | null {
  const phrase = normalizePhrase(value);
  const length = [...phrase].length;
  if (!length || length > PHRASE.max) return null;
  return length >= (isWideText(phrase) ? 1 : 2) ? phrase : null;
}

async function findZonePages(main: MainClient, query: string, locale: string): Promise<PageChoice[]> {
  const prefix = pagePrefix(query);
  if (!prefix) return [];
  try {
    const { data } = await main.v1.search.typeahead.get({ query: { prefix, language: locale } });
    const seen = new Set<string>();
    const pages: PageChoice[] = [];
    for (const item of data?.items ?? []) {
      if (item.matchedField !== 'title' || seen.has(item.work)) continue;
      const name = pageNameOf(item.title);
      if (!name) continue;
      seen.add(item.work);
      pages.push({ target: item.work, name });
    }
    return pages;
  } catch {
    return [];
  }
}

function mountOf(result: WriteResult<unknown>): NavWriteResult | NavWriteFailure {
  if (!result.ok) return result;
  const row = record(result.data);
  const revision = row?.revision;
  if (typeof revision !== 'string' || !iriPattern.test(revision)) return { ok: false, failure: 'unavailable' };
  const occurrences = Array.isArray(row?.occurrences) ? row.occurrences : [];
  const occurrence = occurrences.find(item => typeof item === 'string' && iriPattern.test(item));
  return { ok: true, head: revision, occurrence: typeof occurrence === 'string' ? occurrence : null, replayed: row?.replayed === true };
}
