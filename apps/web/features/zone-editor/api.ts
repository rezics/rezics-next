import { commandLane, unresolved, type WriteRound } from '../api/command.ts';
import { browserMainApi } from '../api/browser.ts';
import { settle } from '../manage/read.ts';
import { problemCode, type Loaded, type MainClient, type ReadFailure } from '../manage/types.ts';
import { isWideText } from '../search/suggest.ts';
import { normalizePhrase, PHRASE } from '../search/state.ts';
import {
  draftWire, loadedDraft, publicationWire,
  type AuthoringFailure, type AuthoringProblem, type DraftBasis, type DraftChoice, type DraftWire, type LoadedDraft, type PublicationChoice, type PublicationReceipt,
} from './model.ts';
import {
  foldMountPages, NAV_LOAD_BATCH, NAV_PAGE_SIZE, navigationReadTarget, pageNameOf, zoneMountPage,
  type NavigationReadTarget, type NavPosition, type NavWriteFailure, type NavWriteResult, type SiteLink,
} from './navigation.ts';
import { readPresentation, type ZonePresentationBaseline } from './theme.ts';
import { readZoneLifecycleSnapshot } from './lifecycle.ts';

export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: AuthoringFailure; problem?: AuthoringProblem }
  | { ok: false; failure: 'stale'; currentHead: string | null; problem?: AuthoringProblem };

export interface SavedDraft extends DraftBasis { replayed: boolean }
export interface PublishedSite { zoneHead: string; replayed: boolean; receipt?: PublicationReceipt }

/** An accepted change retains its original envelope through a later authority refusal until control is restored. */
export function zoneCommandLane<T, R extends { ok: boolean; failure?: string }>(failed: R) {
  const lane = commandLane<T, R>(failed);
  let accepted = false;
  let intent: T | undefined;
  return {
    submit(choice: T, apply: (choice: T, round: WriteRound) => Promise<R>): Promise<R> {
      if (choice !== intent) { accepted = false; intent = choice; }
      return lane.submit(choice, async (chosen, round) => {
        const result = await apply(chosen, round);
        if (!result.ok && result.failure === 'pending') accepted = true;
        if (result.ok) accepted = false;
        return result;
      });
    },
    needsConfirmation(result: R): boolean { return accepted || unresolved(result); },
  };
}
export interface ZoneHeads { zoneHead: string; navigationRevision: string }
export interface ZoneThemeSnapshot {
  revision: string;
  configuration: Record<string, unknown>;
  /** Main's authorized effective presentation when no presentation has been saved. */
  effectivePresentation?: { revision: string; presentation: ZonePresentationBaseline };
}
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

export type ZoneLifecycleStatus = 'active' | 'retired';
export interface ZoneLifecycleSnapshot { revision: string; status: ZoneLifecycleStatus }
export interface ZoneLifecycleWrite { expectedHead: string; actingSubject: string }
export interface SavedZoneLifecycle { revision: string; replayed: boolean }

export interface ZoneLifecycleClient {
  readConfiguration(zoneId: string, actingSubject: string): Promise<WriteResult<ZoneLifecycleSnapshot>>;
  retire(zoneId: string, body: ZoneLifecycleWrite, key: string): Promise<WriteResult<SavedZoneLifecycle>>;
  recover(zoneId: string, body: ZoneLifecycleWrite, key: string): Promise<WriteResult<SavedZoneLifecycle>>;
}

export interface ZoneRealmAttachmentSnapshot { revision: string; realm: string | null; name: string | null }
export interface ZoneRealmAttachmentWrite { expectedHead: string; actingSubject: string; defaultRealm: string | null }
export type ZoneRealmAttachmentWritten = WriteResult<SavedZoneTheme>
  | { ok: false; failure: 'invalid'; reason: 'attachment-limit' };
export interface ZoneRealmAttachmentClient {
  readConfiguration(zoneId: string, actingSubject: string): Promise<WriteResult<ZoneRealmAttachmentSnapshot>>;
  resolveRealmHandle(handle: string, actingSubject: string): Promise<WriteResult<{ realm: string; name: string }>>;
  saveConfiguration(zoneId: string, body: ZoneRealmAttachmentWrite, key: string): Promise<ZoneRealmAttachmentWritten>;
}

/** Attachment commands capture a configuration head; callers review a stale attachment before changing it. */
export function browserZoneRealmAttachment(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneRealmAttachmentClient {
  const nameOf = async (realm: string, actingSubject: string): Promise<string | null> => {
    const answer = await post(() => main.v1.realms({ realm: realm.slice(-36) }).get({ query: { actingSubject } }));
    return answer.ok ? pageNameOf(answer.data) : null;
  };
  return {
    async readConfiguration(zoneId, actingSubject) {
      const answer = await post(() => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } }));
      if (!answer.ok) return answer;
      const row = record(answer.data);
      const configuration = record(row?.configuration);
      const revision = row?.revision;
      const realm = configuration?.defaultRealm ?? null;
      if (typeof revision !== 'string' || !iriPattern.test(revision) || !configuration
        || realm !== null && (typeof realm !== 'string' || !iriPattern.test(realm))) {
        return { ok: false, failure: 'unavailable' };
      }
      return { ok: true, data: { revision, realm, name: realm ? await nameOf(realm, actingSubject) : null } };
    },
    async resolveRealmHandle(handle, actingSubject) {
      const answer = await post(() => main.v1.addresses.resolve.get({ query: { scope: 'space', key: handle, actingSubject } }));
      if (!answer.ok) return answer;
      const row = record(answer.data);
      const realm = record(row?.capabilities)?.realm;
      if (row?.status !== 'resolved' || typeof realm !== 'string' || !iriPattern.test(realm)) {
        return { ok: false, failure: 'denied' };
      }
      return { ok: true, data: { realm, name: await nameOf(realm, actingSubject) ?? handle } };
    },
    async saveConfiguration(zoneId, body, key) {
      let limited = false;
      const answer = await post(async () => {
        const written = await main.v1.zones({ id: zoneId }).configuration.put(body, { headers: { 'idempotency-key': key } });
        limited = problemCode(written.error?.value) === 'realm_attachment_limit';
        return written;
      });
      if (limited) return { ok: false, failure: 'invalid', reason: 'attachment-limit' };
      return lifecycleWrittenOf(answer);
    },
  };
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
  publish(choice: PublicationChoice, actingSubject: string, key: string, zoneId: string): Promise<WriteResult<PublishedSite>>;
  /** The saved home draft, including the epoch a publish has to name. */
  readDraft(zoneId: string, actingSubject: string): Promise<WriteResult<LoadedDraft>>;
  /** Configuration head and the navigation revision a publish must name for both cuts. */
  readHeads(zoneId: string, actingSubject: string): Promise<WriteResult<ZoneHeads>>;
}

type HttpAnswer = { data: unknown; error: { status: number; value: unknown } | null; response?: { status: number } };

/** Browser writes for the home page. Stories pass their own client. */
export function browserZoneAuthoring(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneAuthoringClient {
  return {
    async saveDraft(body, key) {
      return savedOf(await post(() => main.v1['content-drafts'].post(body, { headers: { 'idempotency-key': key } })));
    },
    async publish(choice, actingSubject, key, zoneId) {
      let problem: AuthoringProblem | undefined;
      const result = publishedOf(await post(async () => {
        const answer = await main.v1.zones({ id: zoneId })['site-publications'].post(
          publicationWire(choice, actingSubject), { headers: { 'idempotency-key': key } });
        const refusal = record(answer.error?.value);
        if (typeof refusal?.title === 'string' && typeof refusal.code === 'string') {
          problem = { title: refusal.title, code: refusal.code };
        }
        return answer;
      }));
      return !result.ok && problem ? { ...result, problem } : result;
    },
    async readDraft(zoneId, actingSubject) {
      const answer = await post(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }));
      if (!answer.ok) return answer;
      const heads = await this.readHeads(zoneId, actingSubject);
      if (!heads.ok) return heads;
      const row = record(answer.data);
      const previewNavigation = record(record(row?.preview)?.navigation);
      if (typeof row?.revision !== 'string' || !iriPattern.test(row.revision)
        || typeof previewNavigation?.revision !== 'string' || !iriPattern.test(previewNavigation.revision)) {
        return { ok: false, failure: 'unavailable' };
      }
      if (row.revision !== heads.data.zoneHead || previewNavigation.revision !== heads.data.navigationRevision) {
        return { ok: false, failure: 'stale', currentHead: heads.data.zoneHead };
      }
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
export function browserZoneTheme(main: ReturnType<typeof browserMainApi> = browserMainApi(),
  shellPresentation?: ZonePresentationBaseline): ZoneThemeClient {
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
      if (readPresentation(configuration).kind !== 'absent') return { ok: true, data: { revision, configuration } };
      if (shellPresentation) return { ok: true, data: { revision, configuration,
        effectivePresentation: { revision, presentation: shellPresentation } } };
      const editor = await post(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }));
      if (!editor.ok) return editor;
      const editorRow = record(editor.data);
      const editorRevision = editorRow?.revision;
      if (typeof editorRevision !== 'string' || !iriPattern.test(editorRevision)) {
        return { ok: false, failure: 'unavailable' };
      }
      if (editorRevision !== revision) return { ok: false, failure: 'stale', currentHead: editorRevision };
      const presentation = readPresentation({ presentation: record(editorRow?.preview)?.presentation });
      if (presentation.kind !== 'ready') return { ok: false, failure: 'unavailable' };
      return { ok: true, data: { revision, configuration,
        effectivePresentation: { revision: editorRevision, presentation: presentation.presentation } } };
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

/** Lifecycle reads are authorized configuration reads, so they remain available without active navigation. */
export function browserZoneLifecycle(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneLifecycleClient {
  return {
    async readConfiguration(zoneId, actingSubject) {
      const answer = await post(() => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } }));
      if (!answer.ok) return answer;
      const row = record(answer.data);
      const snapshot = readZoneLifecycleSnapshot(row?.revision, row?.configuration);
      return snapshot ? { ok: true, data: snapshot } : { ok: false, failure: 'unavailable' };
    },
    async retire(zoneId, body, key) {
      return lifecycleWrittenOf(await post(() => main.v1.zones({ id: zoneId }).retirements.post(
        body, { headers: { 'idempotency-key': key } })));
    },
    async recover(zoneId, body, key) {
      return lifecycleWrittenOf(await post(() => main.v1.zones({ id: zoneId }).recoveries.post(
        body, { headers: { 'idempotency-key': key } })));
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

async function post(call: () => Promise<HttpAnswer>): Promise<WriteResult<unknown>> {
  try {
    const answer = await call();
    if (answer.error || answer.data == null) return failureOf(answer.error, !answer.error);
    if (answer.response?.status === 202) return { ok: false, failure: 'pending' };
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
  const row = record(result.data);
  const revision = row?.revision;
  if (!row || typeof revision !== 'string' || !iriPattern.test(revision)
    || !['themeRevision', 'routesRevision', 'navigationRevision', 'homeDocument', 'homeRevision']
      .every(key => typeof row[key] === 'string' && iriPattern.test(row[key] as string))
    || !Array.isArray(row.pages) || !row.pages.length || !row.pages.every(value => {
      const page = record(value);
      return typeof page?.page === 'string' && iriPattern.test(page.page)
        && typeof page.variantId === 'string' && typeof page.language === 'string'
        && typeof page.revisionId === 'string' && uuid.test(page.revisionId)
        && typeof page.byteDigest === 'string' && digest.test(page.byteDigest);
    })) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: { zoneHead: revision, replayed: row.replayed === true, receipt: row as unknown as PublicationReceipt } };
}

function lifecycleWrittenOf(result: WriteResult<unknown>): WriteResult<SavedZoneLifecycle> {
  if (!result.ok) return result;
  const row = record(result.data);
  const revision = row?.revision;
  if (typeof revision !== 'string' || !iriPattern.test(revision)) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: { revision, replayed: row?.replayed === true } };
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

export interface PageSearchData { choices: PageChoice[]; hasMore: boolean }
export type PageSearchResult = WriteResult<PageSearchData> | { ok: false; failure: 'partial' };

export interface ZoneCollectionLookupClient {
  findCollection(resourceLink: string, actingSubject: string): Promise<WriteResult<PageChoice>>;
}

/** Resolve a Collection's resource link through its authorized typed identity and public name reads. */
export function browserZoneCollectionLookup(main: ReturnType<typeof browserMainApi> = browserMainApi()): ZoneCollectionLookupClient {
  return {
    async findCollection(resourceLink, actingSubject) {
      const target = resourceLink.trim();
      const id = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(target)?.[1];
      if (!id) return { ok: false, failure: 'invalid' };
      const identity = await post(() => main.v1.collections({ id }).get({ query: { actingSubject, limit: 1 } }));
      if (!identity.ok) return identity;
      if (record(identity.data)?.collection !== target) return { ok: false, failure: 'unavailable' };
      const named = await post(() => main.v1.collections({ id }).name.get());
      if (!named.ok) return named;
      const name = pageNameOf(named.data);
      if (record(named.data)?.collection !== target || !name) return { ok: false, failure: 'unavailable' };
      return { ok: true, data: { target, name } };
    },
  };
}

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
  findPages(query: string, locale: string): Promise<PageSearchResult>;
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
  if (!batch.ok) return { ok: false, failure: readFailure ?? (batch.failure === 'stale' ? 'moved' : 'unavailable') };
  return {
    ok: true,
    data: {
      ...batch.data,
      links: await withPageNames(main, batch.data.links, actingSubject),
    },
  };
}

/** Preview needs the entire saved inventory, pinned to its authorized configuration and navigation heads. */
export function loadCompleteZoneNavigation(
  main: MainClient,
  zoneId: string,
  actingSubject: string,
  expected: ZoneHeads,
): Promise<Loaded<NavigationSnapshot>> {
  return completeNavigation<Extract<Loaded<NavigationSnapshot>, { ok: false }>>(
    resume => loadZoneNavigation(main, zoneId, actingSubject, resume),
    () => ({ ok: false, failure: 'unavailable' }),
    () => ({ ok: false, failure: 'moved' }),
    expected,
  );
}

/** Publication review follows the same continuation contract as the authorized server preview. */
export function readCompleteZoneNavigation(
  zoneId: string,
  actingSubject: string,
  client: Pick<ZoneNavigationClient, 'readNavigation' | 'continueNavigation'>,
): Promise<WriteResult<NavigationSnapshot>> {
  return completeNavigation<Extract<WriteResult<NavigationSnapshot>, { ok: false }>>(
    resume => resume ? client.continueNavigation(zoneId, actingSubject, resume) : client.readNavigation(zoneId, actingSubject),
    () => ({ ok: false, failure: 'unavailable' }),
    currentHead => ({ ok: false, failure: 'stale', currentHead }),
  );
}

async function completeNavigation<Failure extends { ok: false }>(
  read: (resume?: NavigationResume) => Promise<{ ok: true; data: NavigationSnapshot } | Failure>,
  unavailable: () => Failure,
  changed: (currentHead: string | null) => Failure,
  expected?: ZoneHeads,
): Promise<{ ok: true; data: NavigationSnapshot } | Failure> {
  const initial = await read();
  if (!initial.ok) return initial;
  const first = initial.data;
  if (expected && (first.head !== expected.navigationRevision || first.zoneHead !== expected.zoneHead)) {
    return changed(first.zoneHead);
  }
  const links = [...first.links];
  const cursors = new Set<string>();
  let page = first;
  while (true) {
    if (page.complete) {
      if (page.after !== null) return unavailable();
      return { ok: true, data: { ...first, links, complete: true, after: null } };
    }
    if (!page.after || cursors.has(page.after)) return unavailable();
    cursors.add(page.after);
    const continued = await read({ head: first.head, after: page.after });
    if (!continued.ok) return continued;
    page = continued.data;
    if (page.head !== first.head || page.navigation !== first.navigation || page.zoneHead !== first.zoneHead) {
      return changed(page.zoneHead);
    }
    links.push(...page.links);
  }
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
  if (!batch.ok) return writeFailure ?? batch;
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
): Promise<{ ok: true; data: MountBatch }
  | { ok: false; failure: 'unavailable' }
  | { ok: false; failure: 'stale'; currentHead: string | null }> {
  const pages: NonNullable<ReturnType<typeof zoneMountPage>>[] = [];
  const cursors = new Set<string>(resume ? [resume.after] : []);
  let pinned: string | null = resume?.head ?? null;
  let after: string | undefined = resume?.after;
  for (let page = 0; page < NAV_LOAD_BATCH; page += 1) {
    const target = navigationReadTarget(pinned, after);
    if (resume && page === 0 && target.kind !== 'revision') return { ok: false, failure: 'unavailable' };
    const answer = await readPage(target);
    if (!answer.ok) {
      return answer.failure === 'stale'
        ? { ok: false, failure: 'stale', currentHead: null }
        : { ok: false, failure: 'unavailable' };
    }
    const parsed = zoneMountPage(answer.data);
    if (!parsed) return { ok: false, failure: 'unavailable' };
    if (pinned && parsed.head !== pinned) return { ok: false, failure: 'stale', currentHead: parsed.zoneHead };
    const first = pages[0];
    if (first && (parsed.navigation !== first.navigation || parsed.zoneHead !== first.zoneHead)) {
      return { ok: false, failure: 'stale', currentHead: parsed.zoneHead };
    }
    pinned = parsed.head;
    pages.push(parsed);
    if (!parsed.next) break;
    if (cursors.has(parsed.next)) return { ok: false, failure: 'unavailable' };
    cursors.add(parsed.next);
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

async function findZonePages(main: MainClient, query: string, locale: string): Promise<PageSearchResult> {
  const prefix = pagePrefix(query);
  if (!prefix) return { ok: true, data: { choices: [], hasMore: false } };
  const answer = await post(() => main.v1.search.typeahead.get({ query: { prefix, language: locale } }));
  if (!answer.ok) return answer;
  const row = record(answer.data);
  if (!Array.isArray(row?.items) || typeof row.hasMore !== 'boolean') {
    return { ok: false, failure: 'partial' };
  }
  if (row.complete === false || row.partial === true) return { ok: false, failure: 'partial' };
  const seen = new Set<string>();
  const choices: PageChoice[] = [];
  for (const value of row.items) {
    const item = record(value);
    if (!item || typeof item.matchedField !== 'string') return { ok: false, failure: 'partial' };
    if (item.matchedField !== 'title') continue;
    const name = pageNameOf(item.title);
    if (typeof item.work !== 'string' || !iriPattern.test(item.work) || !name) {
      return { ok: false, failure: 'partial' };
    }
    if (seen.has(item.work)) continue;
    seen.add(item.work);
    choices.push({ target: item.work, name });
  }
  return { ok: true, data: { choices, hasMore: row.hasMore } };
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
