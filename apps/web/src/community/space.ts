import type { KernelClient } from '@rezics/client';
import type { CoverSummary } from '@rezics/ui/cover';
import { notFound } from '@tanstack/react-router';
import { isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { prepareSession, viewerCredential } from '../session/request';

/** Boards listed on a Realm page. The kernel allows at most 100. */
export const BOARD_ROW_LIMIT = 20;
/** Published subjects shown in the cover row; one subject summary read each. */
export const COVER_ROW_LIMIT = 12;

export type MemberState = 'none' | 'pending' | 'member' | 'banned';

export type RealmBoard = {
  id: string;
  title: string | null;
  purpose: 'discussion' | 'reviews';
  visibility: 'published' | 'draft' | 'protected' | 'taken_down';
};

export type PublishedSubject = {
  id: string;
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
  boards: RealmBoard[];
  published: PublishedSubject[];
  /** Null when signed out. */
  viewer: { state: MemberState; idempotencyKey: string } | null;
};

export type SpacePageData = {
  space: { id: string; title: string; summary: string };
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

export type RealmLink = { realmId: string; name: string };
export type MyRealmsPage = { signedIn: boolean; realms: RealmLink[]; next: string | null };

export type Located = { kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string };

type Result<T> = { data?: T | null; error?: unknown; status?: number };
type Auth = { headers: { authorization: string } } | Record<string, never>;

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
  if (credentialMode === 'anonymous') return { signedIn: false, auth: {} as Auth };
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const auth: Auth = authorization ? { headers: { authorization } } : {};
  return { signedIn: authorization !== null, auth };
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
    readOptional(client.realms({ realmId }).members.me.get(auth)),
    client.realms({ realmId }).participation.get(auth),
  ]);
  const state = membership?.state ?? 'none';
  const denied = statusOf(participation) === 403 && !isPlatformClosedProblem(403, participation.error?.value);
  return { state: state === 'none' && denied ? 'banned' : state, idempotencyKey: crypto.randomUUID() };
}

/** The public Realm content. Personal membership is loaded separately after hydration. */
async function readHome(
  client: KernelClient,
  realm: { realmId: string; visibility: 'public' | 'protected'; title?: string },
  auth: Auth,
): Promise<RealmHome> {
  const realmId = realm.realmId;
  const [boards, publications] = await Promise.all([
    readOptional(client.realms({ realmId }).boards.get({ query: { limit: BOARD_ROW_LIMIT }, ...auth })),
    readOptional(client.realms({ realmId }).publications.get({ query: { limit: COVER_ROW_LIMIT }, ...auth })),
  ]);
  const published = await readPublished(
    client,
    (publications?.items ?? []).slice(0, COVER_ROW_LIMIT).map((item) => item.subjectId),
    auth,
  );
  return {
    id: realmId,
    title: realm.title ?? '',
    visibility: realm.visibility,
    boards: (boards?.items ?? [])
      .filter((board) => board.availability === 'available' && board.visibility !== 'taken_down')
      .map((board) => ({ id: board.id, title: board.title, purpose: board.purpose, visibility: board.visibility })),
    published,
    viewer: null,
  };
}

/** The signed-in reader's membership state, loaded only by a browser personal query. */
export async function loadRealmMembership(client: KernelClient, realmId: string, auth: Auth) {
  return readViewer(client, realmId, auth);
}

/**
 * Reads the page of one Space address: the address, then the Space, then — only when the Space names a Realm this
 * viewer may read — the Realm, its boards, its publications and the viewer's standing together.
 */
export async function loadSpacePage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { address: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<SpacePageData> {
  const { auth } = await session(request, sessionEnv, credentialMode);
  const { spaceId } = readCommunity(await client.spaceAddresses({ address: input.address }).get(auth));
  const { space } = readCommunity(await client.spaces({ spaceId }).get(auth));
  const base = { id: space.spaceId, title: space.title, summary: space.summary };
  if (!space.realmId) return { space: base, realm: null };
  const realmId = space.realmId;
  const [realm, home] = await Promise.all([
    readOptional(client.realms({ realmId }).get(auth)),
    readHome(client, { realmId, visibility: 'public' }, auth),
  ]);
  if (!realm) return { space: base, realm: null };
  return {
    space: base,
    realm: { ...home, title: realm.realm.title, summary: realm.realm.summary, visibility: realm.realm.visibility },
  };
}

/**
 * Reads one Realm by id for the page of the Space that carries it: a Space with an address sends the viewer there,
 * and one without is shown from the reads already made.
 */
export async function locateRealm(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { realmId: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<Located> {
  const { auth } = await session(request, sessionEnv, credentialMode);
  const { realm } = readCommunity(await client.realms({ realmId: input.realmId }).get(auth));
  const { space } = readCommunity(await client.spaces({ spaceId: realm.spaceId }).get(auth));
  if (space.address) return { kind: 'redirect', address: space.address };
  const home = await readHome(client, realm, auth);
  return {
    kind: 'page',
    page: { space: { id: space.spaceId, title: space.title, summary: space.summary }, realm: home },
  };
}

/** One page of the signed-in person's Realms. A cursor the kernel rejects restarts at the first page. */
export async function loadMyRealms(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<MyRealmsPage> {
  const { signedIn, auth } = await session(request, sessionEnv, 'session');
  if (!signedIn) return { signedIn: false, realms: [], next: null };
  const read = async (cursor?: string) => client.me.realms.get({ query: cursor ? { cursor } : {}, ...auth });
  let result = await read(input.cursor);
  if (input.cursor && statusOf(result) === 409) result = await read();
  const page = readCommunity(result);
  return {
    signedIn: true,
    realms: page.items.map((item) => ({ realmId: item.realmId, name: item.name })),
    next: page.next,
  };
}

export type MembershipOutcome = 'accepted' | 'closed' | 'refused';

/** Asks to join (`POST`) or leave (`DELETE`) one Realm with the session's credential and the page's idempotency key. */
export async function changeMembership(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { realmId: string; action: 'join' | 'leave'; idempotencyKey: string },
): Promise<MembershipOutcome> {
  const { signedIn, auth } = await session(request, sessionEnv, 'session');
  if (!signedIn) return 'refused';
  const realm = client.realms({ realmId: input.realmId });
  const headers = {
    ...(auth as { headers: { authorization: string } }).headers,
    'idempotency-key': input.idempotencyKey,
  };
  const result =
    input.action === 'join'
      ? await realm.membership.post({}, { headers })
      : await realm.membership.delete(undefined, { headers: headers as never });
  if (isPlatformClosedProblem(statusOf(result), isRecord(result.error) ? result.error.value : undefined))
    return 'closed';
  return result.error ? 'refused' : 'accepted';
}
