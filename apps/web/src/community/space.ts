import type { KernelClient } from '@rezics/client';
import type { CoverSummary } from '@rezics/ui/cover';
import { notFound } from '@tanstack/react-router';
import { isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { realmClaimSnapshot, type RealmClaimSnapshot } from './realm-claim';
import { readRealmHomePresentation, type RealmHomePresentation } from './realm-home-presentation-native';
import { nativeMembershipEffect, nativeRealmLeaveOwnerReason } from './realm-leave-recovery';

/** Boards listed on a Realm page. The kernel allows at most 100. */
export const BOARD_ROW_LIMIT = 20;
/** Published subjects shown in the cover row; one subject summary read each. */
export const COVER_ROW_LIMIT = 12;

export type MemberState = 'none' | 'pending' | 'member' | 'banned';

export type RealmBoard = {
  id: string;
  title: string | null;
  description?: string | null;
  purpose: 'discussion' | 'reviews';
  visibility: 'published' | 'draft' | 'protected' | 'taken_down';
};

export type PublishedSubject = {
  id: string;
  /** Native publication head; used only for Realm shelf decisions. */
  publicationId?: string;
  types: string[];
  typeName?: string;
  labels: Record<string, string>;
  /** The kernel's preferred label, used when no label matches the viewer's language. */
  label: string | null;
  cover: CoverSummary | null;
};

export type RealmHome = {
  id: string;
  title: string;
  summary?: string;
  visibility: 'public' | 'protected';
  /** Current native ownership continuity; absence never admits a claim request. */
  continuity?: RealmClaimSnapshot | null;
  /** One current native presentation, independent of Space identity and personal membership. */
  presentation?: RealmHomePresentation;
  boards: RealmBoard[];
  /** Boards the native page reports as unavailable, rather than the genuinely empty list. */
  unavailableBoards?: number;
  published: PublishedSubject[];
  /** Published IDs among this page's twelve-row cover window whose public subject read was hidden or missing. */
  unavailablePublished?: number;
  boardNext?: string | null;
  publicationNext?: string | null;
  /** Native cursors are bound to the reader that obtained them. */
  credentialMode?: ReadCredentialMode;
  /** Null when signed out. */
  viewer: { state: MemberState; idempotencyKey: string } | null;
};

export type SpacePageData = {
  space: { id: string; title: string; summary: string; banner?: CoverSummary | null };
  /** Null when the Space carries no Realm, or the viewer may not read the one it carries. */
  realm: RealmHome | null;
};

/** Attach localized names for the first semantic type shown beneath each published subject. */
export async function namePublishedTypes(page: SpacePageData, locale: string): Promise<SpacePageData> {
  if (!page.realm) return page;
  const { typeNames } = await import('../subject/definitions.ts');
  const types = [
    ...new Set(page.realm.published.map((subject) => subject.types[0]).filter((type): type is string => Boolean(type))),
  ];
  const names = await typeNames(types, locale);
  return {
    ...page,
    realm: {
      ...page.realm,
      published: page.realm.published.map((subject) => {
        const typeName = names.get(subject.types[0] ?? '');
        return { ...subject, ...(typeName ? { typeName } : {}) };
      }),
    },
  };
}

export type RealmLink = { realmId: string; name: string; description?: string | null };
export type MyRealmsReaderOrigin =
  | { kind: 'session'; subject: string; csrfFingerprint: string }
  | { kind: 'anonymous' }
  | { kind: 'unavailable' };

export type MyRealmsPage = {
  signedIn: boolean;
  realms: RealmLink[];
  next: string | null;
  /** Same-prepared-read provenance. It contains no credential or raw CSRF value. */
  readerOrigin?: MyRealmsReaderOrigin;
  /** A serializable binding added by the query caller before React Query publishes the result. */
  readerAdmission?: {
    callerId: string;
    routeKey: string;
    sourceRevision: number;
    sessionCacheRevision: { dataUpdateCount: number; dataUpdatedAt: number };
    readerOrigin: MyRealmsReaderOrigin;
  };
};

export type Located = { kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string };

type Result<T> = { data?: T | null; error?: unknown; status?: number };
type Auth = { headers: { authorization: string } } | Record<string, never>;

/** The subject produced by the same preparation that supplies the native read credential. */
export type ReaderOrigin =
  | { kind: 'anonymous' }
  | { kind: 'signed-in'; subject: string }
  | { kind: 'unidentified'; reason: 'credential-subject-unavailable' | 'session-preparation-failed' };

/** Additive capture result used by route reads; default loader helpers still return their original values. */
export type PreparedRead<T> = { value: T; readerOrigin: ReaderOrigin };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusOf(result: Result<unknown>): number | undefined {
  if (typeof result.status === 'number') return result.status;
  return isRecord(result.error) && typeof result.error.status === 'number' ? result.error.status : undefined;
}

/** Maps a community read: missing, unreadable and malformed are all not found; a closed gate stays closed. */
export function readCommunity<T>(result: Result<T>): T {
  const status = statusOf(result);
  const body = isRecord(result.error) ? (isRecord(result.error.value) ? result.error.value : result.error) : undefined;
  if (isPlatformClosedProblem(status, body)) throw new PlatformClosedError(status ?? 403, body);
  if (status === 400 || status === 404) throw notFound();
  if (result.error || status === undefined || status >= 400 || result.data == null)
    throw new Error('Kernel community read failed');
  return result.data;
}

/** A read whose absence is an ordinary answer: it yields null for 404 and otherwise behaves like `readCommunity`. */
async function readOptional<T>(read: Promise<Result<T>>): Promise<T | null> {
  const result = await read;
  const status = statusOf(result);
  if (status === 404 || status === 403) {
    if (!isPlatformClosedProblem(status, isRecord(result.error) ? result.error.value : undefined)) return null;
  }
  return readCommunity(result);
}

async function session(request: Request, sessionEnv: Partial<SessionEnv>, credentialMode: ReadCredentialMode) {
  if (credentialMode === 'anonymous')
    return { signedIn: false, auth: {} as Auth, readerOrigin: { kind: 'anonymous' } as const };
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const subject = sessionSubject(request);
  const auth: Auth = authorization ? { headers: { authorization } } : {};
  const readerOrigin: ReaderOrigin = !authorization
    ? { kind: 'anonymous' }
    : subject
      ? { kind: 'signed-in', subject }
      : { kind: 'unidentified', reason: 'credential-subject-unavailable' };
  return { signedIn: authorization !== null, auth, readerOrigin };
}

type SubjectRead = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>['data']>;

function presentSubject(id: string, read: SubjectRead): PublishedSubject {
  const summary = read.summary;
  return {
    id,
    types: summary?.types.length ? summary.types : [summary?.type || read.subject.type],
    labels: read.subject.labels,
    label: summary?.label?.value ?? null,
    cover: summary?.cover ?? null,
  };
}

/** One subject summary per published subject shown, started together. Unreadable subjects are left out. */
async function readPublished(client: KernelClient, ids: string[], auth: Auth): Promise<PublishedSubject[]> {
  const reads = await Promise.all(
    ids.map(async (id) => {
      const read = await readOptional(client.subjects({ id }).get({ query: {}, ...auth }));
      return read ? presentSubject(id, read) : null;
    }),
  );
  return reads.filter((subject): subject is PublishedSubject => subject !== null);
}

async function readViewer(
  client: KernelClient,
  realmId: string,
  auth: Auth,
): Promise<{ state: MemberState; idempotencyKey: string }> {
  const [membership, participation] = await Promise.all([
    client.realms({ realmId }).members.me.get(auth).then(readCommunity),
    client.realms({ realmId }).participation.get(auth),
  ]);
  const state = membership.state;
  const participationStatus = statusOf(participation);
  const denied = participationStatus === 403 && !isPlatformClosedProblem(403, participation.error?.value);
  if (participation.error && !denied) throw new Error('Kernel Realm participation read failed');
  if (participationStatus !== 204 && !denied) throw new Error('Kernel Realm participation read failed');
  return { state: denied ? 'banned' : state, idempotencyKey: crypto.randomUUID() };
}

/** The public Realm content. Personal membership is loaded separately after hydration. */
async function readHome(
  client: KernelClient,
  realm: NonNullable<Awaited<ReturnType<ReturnType<KernelClient['realms']>['get']>>['data']>['realm'],
  auth: Auth,
  credentialMode: ReadCredentialMode,
  space: NonNullable<Awaited<ReturnType<ReturnType<KernelClient['spaces']>['get']>>['data']>['space'],
): Promise<RealmHome> {
  const realmId = realm.realmId;
  const [boards, publications] = await Promise.all([
    client.realms({ realmId }).boards.get({ query: { limit: BOARD_ROW_LIMIT }, ...auth }),
    client.realms({ realmId }).publications.get({ query: { limit: COVER_ROW_LIMIT }, ...auth }),
  ]);
  const boardPage = readCommunity(boards);
  const publicationPage = readCommunity(publications);
  const boardItems = boardPage.items;
  const publicationItems = publicationPage.items;
  const unavailableBoards = boardItems.filter(
    (board) => board.availability !== 'available' && board.visibility !== 'taken_down',
  ).length;
  const publishedIds = publicationItems.slice(0, COVER_ROW_LIMIT).map((item) => item.subjectId);
  const published = await readPublished(client, publishedIds, auth);
  const presentation = await readRealmHomePresentation(client, auth, realm, space);
  return {
    id: realmId,
    title: realm.title ?? '',
    summary: realm.summary,
    presentation,
    visibility: realm.visibility,
    continuity: realmClaimSnapshot(realm),
    boards: boardItems
      .filter((board) => board.availability === 'available' && board.visibility !== 'taken_down')
      .map((board) => ({
        id: board.id,
        title: board.title,
        description: (board as typeof board & { description?: string | null }).description ?? null,
        purpose: board.purpose,
        visibility: board.visibility,
      })),
    unavailableBoards,
    published: attachPublicationHeads(published, publicationItems),
    boardNext: boardPage.next,
    publicationNext: publicationPage.next,
    credentialMode,
    unavailablePublished: publishedIds.length - published.length,
    viewer: null,
  };
}

function attachPublicationHeads(subjects: PublishedSubject[], items: { subjectId: string; publicationId: string }[]) {
  const heads = new Map(items.map((item) => [item.subjectId, item.publicationId]));
  return subjects.map((subject) => {
    const publicationId = heads.get(subject.id);
    return { ...subject, ...(publicationId ? { publicationId } : {}) };
  });
}

export type ShelfPage<T> =
  | { kind: 'page'; items: T[]; next: string | null; unavailable: number }
  | { kind: 'denied' | 'unavailable' | 'stale' };

function shelfFailure(result: Result<unknown>): { kind: 'denied' | 'unavailable' | 'stale' } | null {
  const status = statusOf(result);
  if (status === 409 || status === 400) return { kind: 'stale' };
  if (status === 401 || status === 403 || status === 404) return { kind: 'denied' };
  return result.error || status === undefined || status >= 400 || !result.data ? { kind: 'unavailable' } : null;
}

export type ShelfReadInput = { realmId: string; cursor?: string; credentialMode: ReadCredentialMode };

/** Continue exactly one native list, retaining its own reader-bound cursor and fixed page size. */
export function loadRealmShelfPageWithOrigin(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'boards' },
): Promise<PreparedRead<ShelfPage<RealmBoard>>>;
export function loadRealmShelfPageWithOrigin(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'publications' },
): Promise<PreparedRead<ShelfPage<PublishedSubject>>>;
export function loadRealmShelfPageWithOrigin(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'boards' | 'publications' },
): Promise<PreparedRead<ShelfPage<RealmBoard> | ShelfPage<PublishedSubject>>>;
export async function loadRealmShelfPageWithOrigin(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'boards' | 'publications' },
): Promise<PreparedRead<ShelfPage<RealmBoard> | ShelfPage<PublishedSubject>>> {
  let readerOrigin: ReaderOrigin = { kind: 'unidentified', reason: 'session-preparation-failed' };
  try {
    const prepared = await session(request, sessionEnv, input.credentialMode);
    const { auth } = prepared;
    readerOrigin = prepared.readerOrigin;
    const realm = client.realms({ realmId: input.realmId });
    const cursor = input.cursor ? { cursor: input.cursor } : {};
    if (input.list === 'boards') {
      const result = await realm.boards.get({ query: { limit: BOARD_ROW_LIMIT, ...cursor }, ...auth });
      const failure = shelfFailure(result);
      if (failure) return { value: failure, readerOrigin };
      const page = readCommunity(result);
      const items = page.items
        .filter((board) => board.availability === 'available' && board.visibility !== 'taken_down')
        .map((board) => ({
          id: board.id,
          title: board.title,
          description: (board as typeof board & { description?: string | null }).description ?? null,
          purpose: board.purpose,
          visibility: board.visibility,
        }));
      return {
        value: {
          kind: 'page',
          items,
          next: page.next,
          unavailable: page.items.filter(
            (board) => board.availability !== 'available' && board.visibility !== 'taken_down',
          ).length,
        },
        readerOrigin,
      };
    }
    const result = await realm.publications.get({ query: { limit: COVER_ROW_LIMIT, ...cursor }, ...auth });
    const failure = shelfFailure(result);
    if (failure) return { value: failure, readerOrigin };
    const page = readCommunity(result);
    const subjects = await readPublished(
      client,
      page.items.map((item) => item.subjectId),
      auth,
    );
    return {
      value: {
        kind: 'page',
        items: attachPublicationHeads(subjects, page.items),
        next: page.next,
        unavailable: page.items.length - subjects.length,
      },
      readerOrigin,
    };
  } catch {
    return { value: { kind: 'unavailable' }, readerOrigin };
  }
}

/** Compatibility helper for consumers that only need the original shelf value. */
export function loadRealmShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'boards' },
): Promise<ShelfPage<RealmBoard>>;
export function loadRealmShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'publications' },
): Promise<ShelfPage<PublishedSubject>>;
export async function loadRealmShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ShelfReadInput & { list: 'boards' | 'publications' },
): Promise<ShelfPage<RealmBoard> | ShelfPage<PublishedSubject>> {
  return (await loadRealmShelfPageWithOrigin(client, request, sessionEnv, input)).value;
}

/** The signed-in reader's membership state, loaded only by a browser personal query. */
export async function loadRealmMembership(client: KernelClient, realmId: string, auth: Auth) {
  return readViewer(client, realmId, auth);
}

/**
 * Reads the page of one Space address: the address, then the Space, then — only when the Space names a Realm this
 * viewer may read — the Realm, its boards, its publications and the viewer's standing together.
 */
export async function loadSpacePageWithOrigin(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { address: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<PreparedRead<SpacePageData>> {
  const prepared = await session(request, sessionEnv, credentialMode);
  const { auth } = prepared;
  const { spaceId } = readCommunity(await client.spaceAddresses({ address: input.address }).get(auth));
  const { space } = readCommunity(await client.spaces({ spaceId }).get(auth));
  const extendedSpace = space as typeof space & { banner?: CoverSummary | null };
  const base = {
    id: space.spaceId,
    title: space.title,
    summary: space.summary,
    ...(extendedSpace.banner ? { banner: extendedSpace.banner } : {}),
  };
  if (!space.realmId) return { value: { space: base, realm: null }, readerOrigin: prepared.readerOrigin };
  const realmId = space.realmId;
  const realm = await readOptional(client.realms({ realmId }).get(auth));
  if (!realm) return { value: { space: base, realm: null }, readerOrigin: prepared.readerOrigin };
  const home = await readHome(client, realm.realm, auth, credentialMode, space);
  return {
    value: {
      space: base,
      realm: { ...home, title: realm.realm.title, summary: realm.realm.summary, visibility: realm.realm.visibility },
    },
    readerOrigin: prepared.readerOrigin,
  };
}

/** Original return contract retained for callers that do not need reader admission. */
export async function loadSpacePage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { address: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<SpacePageData> {
  return (await loadSpacePageWithOrigin(client, request, sessionEnv, input, credentialMode)).value;
}

/**
 * Reads one Realm by id for the page of the Space that carries it: a Space with an address sends the viewer there,
 * and one without is shown from the reads already made.
 */
export async function locateRealmWithOrigin(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { realmId: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<PreparedRead<Located>> {
  const prepared = await session(request, sessionEnv, credentialMode);
  const { auth } = prepared;
  const { realm } = readCommunity(await client.realms({ realmId: input.realmId }).get(auth));
  const { space } = readCommunity(await client.spaces({ spaceId: realm.spaceId }).get(auth));
  if (space.address)
    return { value: { kind: 'redirect', address: space.address }, readerOrigin: prepared.readerOrigin };
  const home = await readHome(client, realm, auth, credentialMode, space);
  return {
    value: {
      kind: 'page',
      page: {
        space: {
          id: space.spaceId,
          title: space.title,
          summary: space.summary,
          ...((space as typeof space & { banner?: CoverSummary | null }).banner
            ? { banner: (space as typeof space & { banner?: CoverSummary | null }).banner }
            : {}),
        },
        realm: home,
      },
    },
    readerOrigin: prepared.readerOrigin,
  };
}

/** Original return contract retained for callers that do not need reader admission. */
export async function locateRealm(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { realmId: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<Located> {
  return (await locateRealmWithOrigin(client, request, sessionEnv, input, credentialMode)).value;
}

/** One page of the signed-in person's Realms. A cursor the kernel rejects restarts at the first page. */
export async function loadMyRealms(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<MyRealmsPage> {
  const { signedIn, auth } = await session(request, sessionEnv, 'session');
  const authorization = 'headers' in auth ? auth.headers.authorization : null;
  const subject = sessionSubject(request);
  const csrfToken = requestCsrfToken(request);
  const readerOrigin: MyRealmsReaderOrigin = authorization
    ? subject
      ? { kind: 'session', subject, csrfFingerprint: await csrfFingerprint(csrfToken) }
      : { kind: 'unavailable' }
    : { kind: 'anonymous' };
  if (!signedIn) return { signedIn: false, realms: [], next: null, readerOrigin };
  const read = async (cursor?: string) => client.me.realms.get({ query: cursor ? { cursor } : {}, ...auth });
  let result = await read(input.cursor);
  if (input.cursor && statusOf(result) === 409) result = await read();
  const page = readCommunity(result);
  return {
    signedIn: true,
    realms: page.items.map((item) => ({
      realmId: item.realmId,
      name: item.name,
    })),
    next: page.next,
    readerOrigin,
  };
}

async function csrfFingerprint(token: string | null): Promise<string> {
  const value = token === null ? 'null\u0000' : `token\u0000${token}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type MembershipOutcome = 'accepted' | 'closed' | 'refused';
export type MembershipResult =
  | { outcome: 'accepted'; workflowId: string }
  | { outcome: 'closed' | 'refused'; detail?: string; effect?: 'not-applied'; ownerReason?: 'last-owner' };

type MembershipInput = { realmId: string; action: 'join' | 'leave'; idempotencyKey: string };

/** Acceptance starts a native workflow; it does not establish membership or following. */
export async function requestRealmMembership(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: MembershipInput,
): Promise<MembershipResult> {
  const { signedIn, auth } = await session(request, sessionEnv, 'session');
  if (!signedIn || !('headers' in auth)) return { outcome: 'refused' };
  const realm = client.realms({ realmId: input.realmId });
  const headers = { ...auth.headers, 'idempotency-key': JSON.stringify(input.idempotencyKey) };
  const result =
    input.action === 'join'
      ? await realm.membership.post({}, { headers })
      : await realm.membership.delete(undefined, { headers });
  const body = isRecord(result.error) && isRecord(result.error.value) ? result.error.value : undefined;
  const effect = input.action === 'leave' ? nativeMembershipEffect(statusOf(result), body) : undefined;
  const ownerReason = input.action === 'leave' ? nativeRealmLeaveOwnerReason(statusOf(result), body) : undefined;
  if (isPlatformClosedProblem(statusOf(result), body)) return { outcome: 'closed', ...(effect ? { effect } : {}) };
  if (result.error || statusOf(result) !== 202 || !result.data?.workflowId)
    return {
      outcome: 'refused',
      ...(effect ? { effect } : {}),
      ...(ownerReason ? { ownerReason } : {}),
      ...(typeof body?.detail === 'string' ? { detail: body.detail } : {}),
    };
  return { outcome: 'accepted', workflowId: result.data.workflowId };
}

/** Compatibility for consumers that need only the command's acceptance outcome. */
export async function changeMembership(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: MembershipInput,
): Promise<MembershipOutcome> {
  return (await requestRealmMembership(client, request, sessionEnv, input)).outcome;
}
