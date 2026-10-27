import {
  planReads,
  platformRegistry,
  profileDigest,
  resolveTemplate,
  type PageRead,
  type PresentationProfile,
} from '@rezics/composition';
import platformProfileJson from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import type { Related, Subject } from '../subject/types';
import homePageRecording from './recorded/home-page.json';
import missingSubjectPageRecording from './recorded/missing-subject-page.json';
import missingSubjectRecording from './recorded/missing-subject.json';
import subjectPageRecording from './recorded/subject-page.json';
import subjectRecording from './recorded/subject.json';
import subjectUncoveredRecording from './recorded/subject-uncovered.json';
import boardRecording from './recorded/board.json';
import boardThreadsRecording from './recorded/board-threads.json';
import threadRecording from './recorded/thread.json';
import threadPostsRecording from './recorded/thread-posts.json';
import accountsRecording from './recorded/accounts.json';
import threadOwnedRecording from './recorded/thread-owned.json';
import threadOwnedPostsRecording from './recorded/thread-owned-posts.json';
import offerRecording from './recorded/offer.json';
import offerCjkRecording from './recorded/offer-cjk.json';
import offerDelistedRecording from './recorded/offer-delisted.json';
import orderFailedRecording from './recorded/order-failed.json';
import orderPaidRecording from './recorded/order-paid.json';
import orderPendingRecording from './recorded/order-pending.json';
import searchRecording from './recorded/search.json';
import searchEmptyRecording from './recorded/search-empty.json';
import searchTypedRecording from './recorded/search-typed.json';
import definitionsActiveRecording from './recorded/definitions-active.json';
import definitionsReleaseRecording from './recorded/definitions-release.json';
import libraryCollectionMembersRecording from './recorded/library-collection-members.json';
import libraryCollectionRecording from './recorded/library-collection.json';
import libraryCollectionsRecording from './recorded/library-collections.json';
import libraryCopiesRecording from './recorded/library-copies.json';
import libraryEntriesRecording from './recorded/library-entries.json';
import libraryFollowsRecording from './recorded/library-follows.json';
import libraryProgressChangesRecording from './recorded/library-progress-changes.json';
import libraryProgressSessionRecording from './recorded/library-progress-session.json';
import libraryProgressSessionsRecording from './recorded/library-progress-sessions.json';
import libraryProgressUnitsRecording from './recorded/library-progress-units.json';
import libraryPublishedLogRecording from './recorded/library-published-log.json';
import libraryPublishedLogsRecording from './recorded/library-published-logs.json';
import settingsPreferencesRecording from './recorded/settings-preferences.json';
import myRealmsRecording from './recorded/my-realms.json';
import realmBoardsRecording from './recorded/realm-boards.json';
import realmMemberRecording from './recorded/realm-member.json';
import realmParticipationRecording from './recorded/realm-participation.json';
import realmPublicationsRecording from './recorded/realm-publications.json';
import realmRecording from './recorded/realm.json';
import realmSubjectsRecording from './recorded/realm-subjects.json';
import spaceAddressRecording from './recorded/space-address.json';
import spaceRecording from './recorded/space.json';

const platformProfile = platformProfileJson as PresentationProfile;
const platformDigest = profileDigest(platformProfile);

/** A fixture subject, with the cover summary the kernel would embed in a search hit when it has an image. */
type FixtureSubject = Subject & { cover?: unknown };

type Fixtures = {
  subjects: FixtureSubject[];
  properties: { id: string; labels: Record<string, string> }[];
  redirects: Record<string, string>;
  /** Structural bases by type, copied from the bundled definitions release. */
  types: Record<string, { bases: string[] }>;
};

export type KernelRecording = { status: number; [key: string]: unknown };

const missingSubjectId = '00000000-0000-4000-8000-000000000000';

function resourceId(recording: KernelRecording | undefined, key: string, idKey = 'id'): string | undefined {
  const value = recording?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>)[idKey];
  return typeof id === 'string' ? id : undefined;
}

function knownSubjectId(recordings: Record<string, KernelRecording>): string | undefined {
  const subject = recordings['subject-page']?.subject;
  return typeof subject === 'string' ? subject : resourceId(recordings.subject, 'subject');
}

/** `POST /v1/pages:read` for the recorded subject, or the fixed missing id. */
async function pageRecording(
  request: Request,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  let subject: unknown;
  let route: unknown;
  try {
    const body = (await request.json()) as { target?: unknown };
    const target = body.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
    subject = (target as { subject?: unknown }).subject;
    route = (target as { route?: unknown }).route;
  } catch {
    return undefined;
  }
  if (typeof route === 'string') return route === '/' ? recordings['home-page'] : undefined;
  if (typeof subject !== 'string') return undefined;
  if (subject === missingSubjectId) return recordings['missing-subject-page'];
  return subject === knownSubjectId(recordings) ? recordings['subject-page'] : undefined;
}

/** Keys of a recording that describe the request it answers; the rest is the response body. */
const requestKeys = new Set(['status', 'query', 'filterType', 'address']);

function recordedResponse(recording: KernelRecording): Response {
  if (recording.status === 204) return new Response(null, { status: 204 });
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(recording)) {
    if (requestKeys.has(key)) continue;
    body[key] = value;
  }
  return Response.json(body, {
    status: recording.status,
    headers: { 'content-type': recording.status === 404 ? 'application/problem+json' : 'application/json' },
  });
}

/** The type a search filter narrows to, when it has a type clause on its top level or inside `and`. */
function filterType(filter: unknown): string | undefined {
  if (!isRecord(filter)) return undefined;
  const type = filter.type;
  if (isRecord(type) && Array.isArray(type.in) && typeof type.in[0] === 'string') return type.in[0];
  if (Array.isArray(filter.and))
    for (const clause of filter.and) {
      const found = filterType(clause);
      if (found) return found;
    }
  return undefined;
}

/** The recording named `prefix` or `prefix-…` whose `key` resource has this id. */
function recordingsWithId(
  recordings: Record<string, KernelRecording>,
  prefix: string,
  key: string,
  id: string,
): KernelRecording | undefined {
  return Object.entries(recordings).find(
    ([name, recording]) => (name === prefix || name.startsWith(`${prefix}-`)) && resourceId(recording, key) === id,
  )?.[1];
}

/** The account the story session signs in as. */
export const storyViewerId = 'story-viewer';

/** Library reads by path. The member, change and unit pages hang off their parent's recorded id. */
function libraryRecording(
  method: string,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): KernelRecording | undefined {
  if (method !== 'GET') return undefined;
  const lists: Record<string, string> = {
    '/v1/libraryEntries': 'library-entries',
    '/v1/collections': 'library-collections',
    '/v1/copies': 'library-copies',
    '/v1/follows': 'library-follows',
    '/v1/progressSessions': 'library-progress-sessions',
    '/v1/publishedLogs': 'library-published-logs',
  };
  const list = lists[pathname];
  if (list) return recordings[list];
  const collection = /^\/v1\/collections\/([^/]+)(\/members)?$/.exec(pathname);
  if (
    collection?.[1] &&
    decodeURIComponent(collection[1]) === resourceId(recordings['library-collection'], 'collection')
  )
    return recordings[collection[2] ? 'library-collection-members' : 'library-collection'];
  const session = /^\/v1\/progressSessions\/([^/]+)(?:\/(changes|completedUnits))?$/.exec(pathname);
  if (
    session?.[1] &&
    decodeURIComponent(session[1]) === resourceId(recordings['library-progress-session'], 'progressSession')
  ) {
    if (session[2] === 'changes') return recordings['library-progress-changes'];
    return recordings[session[2] ? 'library-progress-units' : 'library-progress-session'];
  }
  const log = /^\/v1\/publishedLogs\/([^/]+)$/.exec(pathname);
  if (log?.[1] && decodeURIComponent(log[1]) === resourceId(recordings['library-published-log'], 'publishedLog'))
    return recordings['library-published-log'];
  return undefined;
}

/**
 * Community reads by path. The Space, its Realm and everything read from the Realm hang off the recorded ids; a
 * published subject is answered from the recorded subject summaries before the generic subject recording.
 */
function communityRecording(
  method: string,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): KernelRecording | undefined {
  if (method !== 'GET') return undefined;
  if (pathname === '/v1/me/realms') return recordings['my-realms'];
  const address = /^\/v1\/spaceAddresses\/([^/]+)$/.exec(pathname);
  if (address?.[1]) {
    const recorded = recordings['space-address'];
    return recorded && decodeURIComponent(address[1]) === recorded.address ? recorded : undefined;
  }
  const space = /^\/v1\/spaces\/([^/]+)$/.exec(pathname);
  if (space?.[1])
    return decodeURIComponent(space[1]) === resourceId(recordings.space, 'space', 'spaceId')
      ? recordings.space
      : undefined;
  const realm = /^\/v1\/realms\/([^/]+)(?:\/(boards|publications|members\/me|participation))?$/.exec(pathname);
  if (realm?.[1] && decodeURIComponent(realm[1]) === resourceId(recordings.realm, 'realm', 'realmId')) {
    const parts: Record<string, string> = {
      boards: 'realm-boards',
      publications: 'realm-publications',
      'members/me': 'realm-member',
      participation: 'realm-participation',
    };
    return recordings[realm[2] ? parts[realm[2]]! : 'realm'];
  }
  return undefined;
}

/** The recorded summary of one published subject, in the shape of `GET /v1/subjects/:id`. */
function publishedSubject(id: string, recordings: Record<string, KernelRecording>): KernelRecording | undefined {
  const subjects = recordings['realm-subjects']?.subjects;
  const payload = isRecord(subjects) ? subjects[id] : undefined;
  return isRecord(payload) ? { status: 200, ...payload } : undefined;
}

async function selectRecording(
  request: Request,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  const library = libraryRecording(request.method, pathname, recordings);
  if (library) return library;
  if (request.method === 'GET' && pathname === `/v1/accounts/${storyViewerId}/preferences`)
    return recordings['settings-preferences'];
  const community = communityRecording(request.method, pathname, recordings);
  if (community) return community;
  if (request.method === 'GET') {
    if (pathname === '/v1/accounts') return recordings.accounts;
    const subject = /^\/v1\/subjects\/([^/]+)$/.exec(pathname);
    if (subject?.[1]) {
      const id = decodeURIComponent(subject[1]);
      const published = publishedSubject(id, recordings);
      if (published) return published;
      if (id === resourceId(recordings['subject-uncovered'], 'subject')) return recordings['subject-uncovered'];
      return recordings[id === missingSubjectId ? 'missing-subject' : 'subject'];
    }
    const boardThreads = /^\/v1\/boards\/([^/]+)\/threads$/.exec(pathname);
    if (boardThreads?.[1] && decodeURIComponent(boardThreads[1]) === resourceId(recordings.board, 'board'))
      return recordings['board-threads'];
    const board = /^\/v1\/boards\/([^/]+)$/.exec(pathname);
    if (board?.[1] && decodeURIComponent(board[1]) === resourceId(recordings.board, 'board')) return recordings.board;
    const posts = /^\/v1\/threads\/([^/]+)\/posts$/.exec(pathname);
    if (posts?.[1] && decodeURIComponent(posts[1]) === resourceId(recordings.thread, 'thread'))
      return recordings['thread-posts'];
    if (posts?.[1] && decodeURIComponent(posts[1]) === resourceId(recordings['thread-owned'], 'thread'))
      return recordings['thread-owned-posts'];
    const thread = /^\/v1\/threads\/([^/]+)$/.exec(pathname);
    if (thread?.[1] && decodeURIComponent(thread[1]) === resourceId(recordings.thread, 'thread'))
      return recordings.thread;
    if (thread?.[1] && decodeURIComponent(thread[1]) === resourceId(recordings['thread-owned'], 'thread'))
      return recordings['thread-owned'];
    const offer = /^\/v1\/offers\/([^/]+)$/.exec(pathname);
    if (offer?.[1]) return recordingsWithId(recordings, 'offer', 'offer', decodeURIComponent(offer[1]));
    const order = /^\/v1\/orders\/([^/]+)$/.exec(pathname);
    if (order?.[1]) return recordingsWithId(recordings, 'order', 'order', decodeURIComponent(order[1]));
    if (pathname === '/v1/definitions/active') return recordings['definitions-active'];
    const release = /^\/v1\/definitions\/releases\/([^/]+)$/.exec(pathname);
    if (release?.[1] && decodeURIComponent(release[1]) === recordings['definitions-release']?.digest)
      return recordings['definitions-release'];
    return undefined;
  }
  if (request.method === 'POST' && pathname === '/v1/pages:read') return pageRecording(request, recordings);
  if (request.method !== 'POST' || pathname !== '/v1/subjects:search') return undefined;
  let text: unknown;
  let type: string | undefined;
  try {
    const body = (await request.json()) as { text?: unknown; filter?: unknown };
    text = body.text;
    type = filterType(body.filter);
  } catch {
    return undefined;
  }
  if (typeof text !== 'string') return undefined;
  return Object.values(recordings).find((recording) => recording.query === text && recording.filterType === type);
}

/** Replay committed API bodies through the same fetch boundary used by fixture-backed tests. */
export function createRecordedKernelFetch(recordings: Record<string, KernelRecording>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const recording = await selectRecording(request, new URL(request.url).pathname, recordings);
    if (!recording) return new Response(null, { status: 404 });
    return recordedResponse(recording);
  }) as typeof fetch;
}

/**
 * The Library recordings, with the recorded account standing in for the signed-in story visitor. The owner pages
 * (my collections, my logs, the owner's own collection) recognise the visitor by account id.
 */
function libraryStoryRecordings(): Record<string, KernelRecording> {
  const recordings: Record<string, KernelRecording> = {
    'library-collection-members': libraryCollectionMembersRecording,
    'library-collection': libraryCollectionRecording,
    'library-collections': libraryCollectionsRecording,
    'library-copies': libraryCopiesRecording,
    'library-entries': libraryEntriesRecording,
    'library-follows': libraryFollowsRecording,
    'library-progress-changes': libraryProgressChangesRecording,
    'library-progress-session': libraryProgressSessionRecording,
    'library-progress-sessions': libraryProgressSessionsRecording,
    'library-progress-units': libraryProgressUnitsRecording,
    'library-published-log': libraryPublishedLogRecording,
    'library-published-logs': libraryPublishedLogsRecording,
  };
  const owner = libraryCollectionRecording.collection.curatorAccountId;
  return JSON.parse(JSON.stringify(recordings).replaceAll(owner, storyViewerId)) as Record<string, KernelRecording>;
}

/**
 * The board's recorded thread row with the reply count and last activity time that thread rows will carry. They are
 * derived from the recorded post page, and kept out of the recording, which holds only the contract's fields.
 */
function boardThreadsWithActivity(): KernelRecording {
  const posts = threadPostsRecording.posts;
  return {
    ...boardThreadsRecording,
    threads: boardThreadsRecording.threads.map((thread) => ({
      ...thread,
      replyCount: Math.max(0, posts.length - 1),
      lastActivityAt: posts.at(-1)?.createdAt ?? thread.createdAt,
    })),
  };
}

/** The thread the recording account wrote, with the story visitor in its place so that the visitor may edit it. */
function ownedThreadRecordings(): Record<string, KernelRecording> {
  const recordings = { 'thread-owned': threadOwnedRecording, 'thread-owned-posts': threadOwnedPostsRecording };
  const author = threadOwnedRecording.thread.authorId;
  return JSON.parse(JSON.stringify(recordings).replaceAll(author, storyViewerId)) as Record<string, KernelRecording>;
}

/** The browser-only Storybook kernel uses the checked-in responses for the real page routes. */
export function createStoryRecordedKernelFetch(): typeof fetch {
  return createRecordedKernelFetch({
    'home-page': homePageRecording,
    'missing-subject-page': missingSubjectPageRecording,
    'missing-subject': missingSubjectRecording,
    'subject-page': subjectPageRecording,
    subject: subjectRecording,
    'subject-uncovered': subjectUncoveredRecording,
    board: boardRecording,
    'board-threads': boardThreadsWithActivity(),
    thread: threadRecording,
    'thread-posts': threadPostsRecording,
    accounts: accountsRecording,
    search: searchRecording,
    'search-empty': searchEmptyRecording,
    'search-typed': searchTypedRecording,
    'definitions-active': definitionsActiveRecording,
    'definitions-release': definitionsReleaseRecording,
    'settings-preferences': settingsPreferencesRecording,
    ...ownedThreadRecordings(),
    offer: offerRecording,
    'offer-cjk': offerCjkRecording,
    'offer-delisted': offerDelistedRecording,
    'order-failed': orderFailedRecording,
    'order-paid': orderPaidRecording,
    'order-pending': orderPendingRecording,
    ...libraryStoryRecordings(),
    'my-realms': myRealmsRecording,
    realm: realmRecording,
    'realm-boards': realmBoardsRecording,
    'realm-member': realmMemberRecording,
    'realm-participation': realmParticipationRecording,
    'realm-publications': realmPublicationsRecording,
    'realm-subjects': realmSubjectsRecording,
    space: spaceRecording,
    'space-address': spaceAddressRecording,
  });
}

function notFound(): Response {
  return Response.json(
    {
      type: 'https://rezics.com/problems/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      retryable: false,
      effect_status: 'not_applicable',
      request_id: crypto.randomUUID(),
    },
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same subject payload `GET /v1/subjects/:id` returns, including a merged subject's survivor. */
function subjectPayload(fixtures: Fixtures, id: string): { subject: Subject; related: Related } | undefined {
  const target = fixtures.redirects[id] ?? id;
  const subject = fixtures.subjects.find((item) => item.id === target);
  if (!subject) return undefined;
  const related: Related = {};
  const labelSubject = (subjectId: string) => {
    const redirect = fixtures.redirects[subjectId];
    const item = fixtures.subjects.find((candidate) => candidate.id === (redirect ?? subjectId));
    if (item) related[subjectId] = { labels: item.labels, ...(redirect ? { redirect } : {}) };
  };
  const visit = (snak: { property: { id: string; data_type: string }; value: { type: string; content?: unknown } }) => {
    const property = fixtures.properties.find((item) => item.id === snak.property.id);
    if (property) related[property.id] = { labels: property.labels };
    if (
      snak.property.data_type === 'wikibase-item' &&
      snak.value.type === 'value' &&
      typeof snak.value.content === 'string'
    )
      labelSubject(snak.value.content);
  };
  for (const statements of Object.values(subject.statements))
    for (const statement of statements) {
      visit(statement);
      statement.qualifiers.forEach(visit);
      statement.references.flatMap((reference) => reference.parts).forEach(visit);
    }
  return { subject, related };
}

function byEnglishLabel(left: Subject, right: Subject): number {
  const leftLabel = left.labels.en ?? '';
  const rightLabel = right.labels.en ?? '';
  if (leftLabel < rightLabel) return -1;
  if (leftLabel > rightLabel) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** The hit a search read returns for one fixture: its labels and the summary that draws its cover. */
function searchHit(fixtures: Fixtures, subject: FixtureSubject) {
  const types = [subject.type, ...(fixtures.types[subject.type]?.bases ?? [])];
  return {
    id: subject.id,
    type: subject.type,
    labels: subject.labels,
    summary: {
      id: subject.id,
      type: subject.type,
      types,
      creativeWork: types.includes('schema:CreativeWork'),
      label: { value: subject.labels.en ?? Object.values(subject.labels)[0] ?? '', language: 'en' },
      cover: subject.cover ?? null,
    },
  };
}

/** Subjects with a statement of that property naming one of the filter's subjects. */
function searchRead(fixtures: Fixtures, read: Extract<PageRead, { kind: 'search' }>) {
  const filter = read.body.filter;
  if ('type' in filter) {
    const types = new Set(filter.type.in);
    const matched = fixtures.subjects.filter((subject) => types.has(subject.type)).sort(byEnglishLabel);
    const subjects = matched.slice(0, read.body.limit).map((subject) => searchHit(fixtures, subject));
    return {
      subjects,
      total: { value: matched.length, relation: 'exact' as const },
      next: null,
      as_of: '2026-10-26T00:00:00.000Z',
    };
  }
  const named = 'statement' in filter ? filter.statement : undefined;
  const ids = new Set(named?.in ?? []);
  const matched = named
    ? fixtures.subjects.filter((subject) =>
        subject.statements[named.property]?.some(
          (statement) =>
            statement.value.type === 'value' &&
            typeof statement.value.content === 'string' &&
            ids.has(statement.value.content),
        ),
      )
    : [];
  matched.sort(byEnglishLabel);
  const subjects = matched.slice(0, read.body.limit).map((subject) => searchHit(fixtures, subject));
  return {
    subjects,
    total: { value: matched.length, relation: 'exact' as const },
    next: null,
    as_of: '2026-10-26T00:00:00.000Z',
  };
}

async function pageRead(fixtures: Fixtures, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return notFound();
  }
  const target = isRecord(body) ? body.target : undefined;
  const requested = isRecord(target) && typeof target.subject === 'string' ? target.subject : undefined;
  const requestedRoute = isRecord(target) && typeof target.route === 'string' ? target.route : undefined;
  if (!requested && requestedRoute === undefined) return notFound();
  const payload = requested ? subjectPayload(fixtures, requested) : undefined;
  if (requested && !payload) return notFound();
  const definition = payload ? fixtures.types[payload.subject.type] : undefined;
  const resolved = resolveTemplate(
    platformProfile,
    requestedRoute !== undefined
      ? { route: requestedRoute }
      : {
          type: payload!.subject.type,
          ...(definition ? { bases: definition.bases } : {}),
        },
  );
  const plan = planReads(platformRegistry, resolved.document, { subject: payload?.subject.id ?? null });
  const reads: Record<string, { status: number; body: unknown }> = {};
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    // The subject read that selected the template is reused.
    reads[key] =
      descriptor.kind === 'subject' && descriptor.id === payload?.subject.id && payload
        ? { status: 200, body: payload }
        : descriptor.kind === 'search'
          ? { status: 200, body: searchRead(fixtures, descriptor) }
          : { status: 404, body: { code: 'not_found' } };
  }
  return Response.json({
    ...(payload ? { subject: payload.subject.id } : {}),
    profile: platformDigest,
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    reads,
  });
}

export function createFakeKernelFetch(fixtures: Fixtures): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return pageRead(fixtures, request);
    const match = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    if (request.method !== 'GET' || !match) return notFound();
    const payload = subjectPayload(fixtures, decodeURIComponent(match[1]!));
    return payload ? Response.json(payload) : notFound();
  }) as typeof fetch;
}
