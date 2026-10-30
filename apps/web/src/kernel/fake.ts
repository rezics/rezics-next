import {
  definedViews,
  isView,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageRead,
  type PresentationProfile,
} from '@rezics/composition';
import platformProfileJson from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import type { Related, Subject, Summary } from '../subject/types';
import { demoAgentAccounts, demoAgentSubjects } from './agent-fixtures';
import { answerFakeRoute, discoveredRecordings, mergeFakeFixtures } from './fake-modules.ts';
import defaultFixtures from './fixtures.json' with { type: 'json' };
import { languageList, localizeRecording } from './fake/languages.ts';
import homePageRecording from './recorded/home-page.json';
import missingSubjectPageRecording from './recorded/missing-subject-page.json';
import missingSubjectRecording from './recorded/missing-subject.json';
import subjectLinksRecording from './recorded/subject-links.json';
import subjectPageRecording from './recorded/subject-page.json';
import subjectReactionRecording from './recorded/subject-reaction.json';
import subjectReactionsRecording from './recorded/subject-reactions.json';
import subjectRecording from './recorded/subject.json';
import subjectUncoveredRecording from './recorded/subject-uncovered.json';
import ratingVoteRecording from './recorded/rating-vote.json';
import subjectReviewThreadsRecording from './recorded/subject-review-threads.json';
import boardRecording from './recorded/board.json';
import boardThreadsRecording from './recorded/board-threads.json';
import threadRecording from './recorded/thread.json';
import threadPostsRecording from './recorded/thread-posts.json';
import accountsRecording from './recorded/accounts.json';
import agentPageReaderRecording from './recorded/agent-page-reader.json';
import agentPageRecording from './recorded/agent-page.json';
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
import libraryContinueEntriesRecording from './recorded/library-continue-entries.json';
import libraryFollowsRecording from './recorded/library-follows.json';
import libraryProgressChangesRecording from './recorded/library-progress-changes.json';
import libraryProgressSessionRecording from './recorded/library-progress-session.json';
import libraryProgressSessionsRecording from './recorded/library-progress-sessions.json';
import libraryContinueProgressSessionsRecording from './recorded/library-continue-progress-sessions.json';
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
import boardRealmRecording from './recorded/board-realm.json';
import boardRealmRealmRecording from './recorded/board-realm-realm.json';
import boardRealmThreadPostsRecording from './recorded/board-realm-thread-posts.json';
import boardRealmThreadRecording from './recorded/board-realm-thread.json';
import boardRealmThreadsRecording from './recorded/board-realm-threads.json';

const platformProfile = platformProfileJson as PresentationProfile;
const platformDigest = profileDigest(platformProfile);

/** A fixture subject, with the cover summary the kernel would embed in a search hit when it has an image. */
type FixtureSubject = Subject & { cover?: unknown };

type Fixtures = {
  /** Mounted groups the demo viewer may use; omitted groups are closed. */
  admitted?: string[];
  subjects: FixtureSubject[];
  properties: { id: string; labels: Record<string, string> }[];
  redirects: Record<string, string>;
  /** Structural bases by type, copied from the bundled definitions release. */
  types: Record<string, { bases: string[] }>;
  /** The cover summary a subject read returns beside the subject, by subject id; a subject with none has none. */
  summaries?: Record<string, Summary>;
  /** Accounts by handle; each is an agent, and `subject` names the subject it is verified as. */
  accounts?: FixtureAccount[];
  /** Page reads whose relation total is unavailable in this fixture. */
  linksWithoutCount?: { subject: string; property: string }[];
  /** Search and facet fixtures use the public count-free response shape. */
  searchWithoutTotal?: boolean;
  facetsWithoutCounts?: boolean;
};

export type { Fixtures };

/** One account as the fake kernel serves it: the public profile, and the activity its lists page through. */
export type FixtureAccount = {
  id: string;
  handle: string;
  kind: 'actor' | 'organization';
  state: 'active' | 'deleted';
  displayName: string | null;
  bio: string | null;
  links: { label: string; url: string }[];
  avatar: unknown;
  /** The subject the account is verified as; an unverified account is its own agent node. */
  subject: string | null;
  publicViews?: { posts: boolean; reviews: boolean; collections: boolean };
  threads?: Record<string, unknown>[];
  posts?: Record<string, unknown>[];
  collections?: Record<string, unknown>[];
};

export type KernelRecording = { status: number; [key: string]: unknown };

/** A fake-kernel request summary for bounded-read and anonymous-render tests. */
export type FakeKernelCall = {
  method: string;
  path: string;
  authorization: string | null;
  cookie: string | null;
};

const missingSubjectId = '00000000-0000-4000-8000-000000000000';
const reviewFakeRecordings: Record<string, KernelRecording> = {
  'subject-page': subjectPageRecording,
  subject: subjectRecording,
  'my-realms': myRealmsRecording,
  realm: realmRecording,
  'realm-boards': realmBoardsRecording,
  'rating-vote': ratingVoteRecording,
  'subject-review-threads': subjectReviewThreadsRecording,
};

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
  let account: unknown;
  try {
    const body = (await request.json()) as { target?: unknown };
    const target = body.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
    subject = (target as { subject?: unknown }).subject;
    route = (target as { route?: unknown }).route;
    account = (target as { account?: unknown }).account;
    // The recordings hold overviews only.
    const view = (target as { view?: unknown }).view;
    if (view !== undefined && view !== 'overview') return undefined;
  } catch {
    return undefined;
  }
  if (typeof account === 'string')
    return Object.entries(recordings).find(
      ([name, recording]) => name.startsWith('agent-page') && recording.handle === account,
    )?.[1];
  if (typeof route === 'string')
    return route === '/' ? requestedRecording('home-page', request, recordings) : undefined;
  if (typeof subject !== 'string') return undefined;
  if (subject === missingSubjectId) return recordings['missing-subject-page'];
  return subject === knownSubjectId(recordings) ? requestedRecording('subject-page', request, recordings) : undefined;
}

function requestedRecording(name: string, request: Request, recordings: Record<string, KernelRecording>) {
  const locale = request.headers.get('Accept-Language')?.split(',')[0]?.trim().split('-q=')[0];
  const localized = locale ? recordings[`${name}-${locale}`] : undefined;
  return localized ?? recordings[name];
}

/** Keys of a recording that describe the request it answers; the rest is the response body. */
const requestKeys = new Set(['status', 'query', 'filterType', 'address', 'handle', 'headers']);

function recordedResponse(recording: KernelRecording): Response {
  const recordedHeaders = new Headers({
    'content-type': recording.status === 404 ? 'application/problem+json' : 'application/json',
  });
  if (isRecord(recording.headers))
    for (const [name, value] of Object.entries(recording.headers))
      if (typeof value === 'string') recordedHeaders.set(name, value);
  if (recording.status === 204 && isRecord(recording.headers))
    return new Response(null, { status: 204, headers: recordedHeaders });
  if (recording.status === 204) return new Response(null, { status: 204 });
  // Fake modules use this envelope when a kernel response body is not an object, such as a list response.
  if (Object.hasOwn(recording, '__responseBody'))
    return Response.json(recording.__responseBody, {
      status: recording.status,
      headers: recordedHeaders,
    });
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(recording)) {
    if (requestKeys.has(key)) continue;
    body[key] = value;
  }
  delete body.headers;
  if (isRecord(recording.headers)) return Response.json(body, { status: recording.status, headers: recordedHeaders });
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
  request: Request,
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
  if (list) return requestedRecording(list, request, recordings);
  const collection = /^\/v1\/collections\/([^/]+)(\/members)?$/.exec(pathname);
  if (
    collection?.[1] &&
    decodeURIComponent(collection[1]) === resourceId(recordings['library-collection'], 'collection')
  )
    return requestedRecording(collection[2] ? 'library-collection-members' : 'library-collection', request, recordings);
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

/** The reads of the recorded Realm board: the board, its Realm, its threads, and its thread with the posts. */
function boardRealmRead(
  method: string,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): KernelRecording | undefined {
  if (method !== 'GET') return undefined;
  const board = /^\/v1\/boards\/([^/]+)(\/threads)?$/.exec(pathname);
  if (board?.[1] && decodeURIComponent(board[1]) === resourceId(recordings['board-realm'], 'board'))
    return recordings[board[2] ? 'board-realm-threads' : 'board-realm'];
  const realm = /^\/v1\/realms\/([^/]+)$/.exec(pathname);
  if (realm?.[1] && decodeURIComponent(realm[1]) === resourceId(recordings['board-realm-realm'], 'realm', 'realmId'))
    return recordings['board-realm-realm'];
  const thread = /^\/v1\/threads\/([^/]+)(\/posts)?$/.exec(pathname);
  if (thread?.[1] && decodeURIComponent(thread[1]) === resourceId(recordings['board-realm-thread'], 'thread'))
    return recordings[thread[2] ? 'board-realm-thread-posts' : 'board-realm-thread'];
  return undefined;
}

/** The local sitemap endpoints expose only recorded public items and stop after their single demo page. */
function sitemapRecording(
  method: string,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): KernelRecording | undefined {
  if (method !== 'GET') return undefined;
  const match = /^\/v1\/sitemap\/(boards|threads|realms|spaces)$/.exec(pathname);
  const type = match?.[1] as 'boards' | 'threads' | 'realms' | 'spaces' | undefined;
  if (!type) return undefined;
  const sourceName = { boards: 'board', threads: 'thread', realms: 'realm', spaces: 'space' } as const;
  const sourceKey = { boards: 'board', threads: 'thread', realms: 'realm', spaces: 'space' } as const;
  const source = recordings[sourceName[type]]?.[sourceKey[type]];
  if (!isRecord(source)) return { status: 200, items: [], next: null };
  const id = type === 'realms' ? source.realmId : type === 'spaces' ? source.spaceId : source.id;
  if (typeof id !== 'string') return { status: 200, items: [], next: null };
  const modified =
    type === 'realms' || type === 'spaces'
      ? (source.revisionCreatedAt ?? source.createdAt)
      : (source.lastActivityAt ?? source.createdAt);
  const lastModified = typeof modified === 'string' ? modified : undefined;
  const item = {
    id,
    ...(type === 'threads' ? { title: typeof source.title === 'string' ? source.title : null } : {}),
    ...(type === 'spaces' && typeof source.address === 'string' ? { address: source.address } : {}),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
  if (type === 'spaces' && typeof item.address !== 'string') return { status: 200, items: [], next: null };
  return { status: 200, items: [item], next: null };
}

async function selectRecording(
  request: Request,
  pathname: string,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  const moduleRecording = await answerFakeRoute('story', request, recordings);
  if (moduleRecording) return moduleRecording;
  if (request.method === 'POST' && pathname === '/v1/subjects:search') {
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => undefined);
    if (isRecord(body) && typeof body.text === 'string') {
      const type = filterType(body.filter);
      const candidates = Object.entries(recordings).filter(
        ([name, candidate]) =>
          name.startsWith('search') &&
          candidate.query === body.text &&
          (candidate.filterType ?? undefined) === type &&
          Array.isArray(candidate.subjects),
      );
      const locale = request.headers.get('Accept-Language')?.split(',')[0]?.trim();
      const recording = candidates.find(([name]) => locale && name.endsWith(`-${locale}`))?.[1] ?? candidates[0]?.[1];
      if (recording) {
        const languages = languageList(body.languages);
        return languages.length > 0
          ? localizeRecording(recording, languages, defaultFixtures as unknown as Fixtures)
          : recording;
      }
    }
  }
  const sitemap = sitemapRecording(request.method, pathname, recordings);
  if (sitemap) return sitemap;
  if (request.method === 'GET' && pathname === '/v1/libraryEntries') {
    const url = new URL(request.url);
    const continueEntries = recordings['library-continue-entries'];
    if (url.searchParams.get('state') === 'in_progress' && continueEntries)
      return requestedRecording('library-continue-entries', request, recordings) ?? continueEntries;
  }
  if (request.method === 'GET' && pathname === '/v1/progressSessions') {
    const url = new URL(request.url);
    const continueSessions = recordings['library-continue-progress-sessions'];
    if (
      url.searchParams.has('subjectId') &&
      url.searchParams.get('limit') === '5' &&
      !url.searchParams.has('view') &&
      continueSessions &&
      Array.isArray(continueSessions.progressSessions)
    ) {
      const subjectId = url.searchParams.get('subjectId');
      return {
        ...continueSessions,
        progressSessions: continueSessions.progressSessions.filter(
          (session) => isRecord(session) && session.subjectId === subjectId,
        ),
      };
    }
  }
  if (request.method === 'GET' && pathname === `/v1/threads/${mentionThreadId}`) return mentionStoryThread();
  if (request.method === 'GET' && pathname === `/v1/threads/${mentionThreadId}/posts`) return mentionStoryPosts();
  if (request.method === 'GET' && pathname === '/v1/libraryEntries') {
    // A shelf reads one status at a time; the recording holds every status, so the answer keeps the asked one.
    const state = new URL(request.url).searchParams.get('state');
    const recorded = requestedRecording('library-entries', request, recordings);
    const rows = recorded?.libraryEntries;
    if (state && recorded && Array.isArray(rows))
      return { ...recorded, libraryEntries: rows.filter((row) => isRecord(row) && row.state === state) };
  }
  const library = libraryRecording(request, request.method, pathname, recordings);
  if (library) return library;
  if (request.method === 'GET' && pathname === `/v1/accounts/${storyViewerId}/preferences`)
    return recordings['settings-preferences'];
  const community = communityRecording(request.method, pathname, recordings);
  if (community) return community;
  const boardRealm = boardRealmRead(request.method, pathname, recordings);
  if (boardRealm) return boardRealm;
  if (request.method === 'GET' && pathname === '/v1/subjects:suggest') {
    const subjects = Array.isArray(recordings.search?.subjects) ? recordings.search.subjects : [];
    return suggestionRead(subjects, request);
  }
  if (request.method === 'GET') {
    const realmReviewBoards = recordings['realm-boards']?.items;
    const reviewBoard = Array.isArray(realmReviewBoards)
      ? realmReviewBoards.find((board) => isRecord(board) && board.purpose === 'reviews')
      : undefined;
    const reviewBoardPath = /^\/v1\/boards\/([^/]+)$/.exec(pathname);
    if (reviewBoardPath?.[1] && isRecord(reviewBoard) && decodeURIComponent(reviewBoardPath[1]) === reviewBoard.id)
      return { status: 200, board: reviewBoard };
    const subjectThreads = /^\/v1\/subjects\/([^/]+)\/threads$/.exec(pathname);
    if (subjectThreads?.[1] && decodeURIComponent(subjectThreads[1]) === knownSubjectId(recordings)) {
      const query = new URL(request.url).searchParams;
      if (query.get('kind') === 'review' && query.get('place') === '01a1a000-0000-7000-8000-000000000002')
        return recordings['subject-review-threads'];
    }
    const withDeleted = pathname === '/v1/accounts' ? withDeletedOrganization(request, recordings.accounts) : undefined;
    if (withDeleted) return withDeleted;
    if (pathname === '/v1/accounts' && new URL(request.url).searchParams.has('handle')) {
      const handle = new URL(request.url).searchParams.get('handle')!;
      const accounts = Array.isArray(recordings.accounts?.accounts) ? recordings.accounts.accounts : [];
      return {
        status: 200,
        accounts: accounts.filter(
          (account) =>
            isRecord(account) &&
            account.state === 'active' &&
            typeof account.handle === 'string' &&
            account.handle.toLowerCase() === handle.toLowerCase(),
        ),
        next: null,
      };
    }
    if (pathname === '/v1/accounts' && new URL(request.url).searchParams.has('ids')) {
      const ids = new Set(new URL(request.url).searchParams.get('ids')!.split(',').slice(0, 100));
      const accounts = Array.isArray(recordings.accounts?.accounts) ? recordings.accounts.accounts : [];
      return {
        status: 200,
        accounts: accounts.filter(
          (account) => isRecord(account) && typeof account.id === 'string' && ids.has(account.id),
        ),
        next: null,
      };
    }
    if (pathname === '/v1/accounts') return recordings.accounts;
    const vote = /^\/v1\/subjects\/([^/]+)\/ratings\/([^/]+)\/vote$/.exec(pathname);
    if (
      vote?.[1] &&
      vote[2] === '00000000-0000-7000-8000-000000000001' &&
      decodeURIComponent(vote[1]) === knownSubjectId(recordings)
    )
      return recordings['rating-vote'];
    const reactions = /^\/v1\/subjects\/([^/]+)\/(reactions?)$/.exec(pathname);
    if (reactions?.[1] && decodeURIComponent(reactions[1]) === knownSubjectId(recordings))
      return recordings[reactions[2] === 'reactions' ? 'subject-reactions' : 'subject-reaction'];
    const subject = /^\/v1\/subjects\/([^/]+)$/.exec(pathname);
    if (subject?.[1]) {
      const id = decodeURIComponent(subject[1]);
      const published = publishedSubject(id, recordings);
      if (published) return published;
      if (id === resourceId(recordings['subject-uncovered'], 'subject')) return recordings['subject-uncovered'];
      return recordings[id === missingSubjectId ? 'missing-subject' : 'subject'];
    }
    const subjectLinks = /^\/v1\/subjects\/([^/]+)\/links$/.exec(pathname);
    if (subjectLinks?.[1] && decodeURIComponent(subjectLinks[1]) === resourceId(recordings.subject, 'subject'))
      return recordings['subject-links'];
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
    const ownReaction = /^\/v1\/(threads|posts)\/([^/]+)\/reaction$/.exec(pathname);
    if (ownReaction?.[1] && ownReaction[2]) {
      const id = decodeURIComponent(ownReaction[2]);
      const threadRecord = recordings['thread-owned']?.thread as { id?: unknown } | undefined;
      const postRecord = (recordings['thread-owned-posts']?.posts as Record<string, unknown>[] | undefined)?.find(
        (post) => post.id === id,
      );
      if ((ownReaction[1] === 'threads' && threadRecord?.id === id) || postRecord) return { status: 200, kind: null };
    }
    if (pathname === `/v1/threads/${deletedOrganizationThreadId}/posts`)
      return recordings['thread-deleted-organization-posts'];
    if (pathname === `/v1/threads/${deletedOrganizationThreadId}`) return recordings['thread-deleted-organization'];
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

/** Set before rendering a story to preview its admitted controls. Defaults to closed. */
let fakeAdmitted: string[] = [];
export function setFakeAdmitted(admitted: string[]): void {
  fakeAdmitted = [...admitted];
}
function exposureResponse(request: Request, admitted = fakeAdmitted): Response | undefined {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/v1/platform/exposure') return;
  return Response.json({ admitted: [...new Set(admitted)].sort() }, { headers: { 'cache-control': 'no-store' } });
}

/** Replay committed API bodies through the same fetch boundary used by fixture-backed tests. */
export function createRecordedKernelFetch(recordings: Record<string, KernelRecording>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const exposure = exposureResponse(request);
    if (exposure) return exposure;
    const available = { ...discoveredRecordings(), ...recordings };
    const moduleRecording = await answerFakeRoute('story', request, available);
    if (moduleRecording) return recordedResponse(moduleRecording);
    const recording = await selectRecording(request, new URL(request.url).pathname, available);
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
    'library-continue-entries': libraryContinueEntriesRecording,
    'library-follows': libraryFollowsRecording,
    'library-progress-changes': libraryProgressChangesRecording,
    'library-progress-session': libraryProgressSessionRecording,
    'library-progress-sessions': libraryProgressSessionsRecording,
    'library-continue-progress-sessions': libraryContinueProgressSessionsRecording,
    'library-progress-units': libraryProgressUnitsRecording,
    'library-published-log': libraryPublishedLogRecording,
    'library-published-logs': libraryPublishedLogsRecording,
  };
  const owner = libraryCollectionRecording.collection.curatorAccountId;
  return JSON.parse(JSON.stringify(recordings).replaceAll(owner, storyViewerId)) as Record<string, KernelRecording>;
}

/** The Realm board's recordings, with the recorded account standing in for the author of its thread. */
function boardRealmStoryRecordings(): Record<string, KernelRecording> {
  const recordings: Record<string, KernelRecording> = {
    'board-realm': boardRealmRecording,
    'board-realm-realm': boardRealmRealmRecording,
    'board-realm-thread': boardRealmThreadRecording,
    'board-realm-thread-posts': boardRealmThreadPostsRecording,
    'board-realm-threads': boardRealmThreadsRecording,
  };
  const known = accountsRecording.accounts[0]?.id;
  if (!known) return recordings;
  return JSON.parse(JSON.stringify(recordings).replaceAll(boardRealmThreadRecording.thread.authorId, known)) as Record<
    string,
    KernelRecording
  >;
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

/** An organization whose account is deleted: the identity read answers it by id and kind alone. */
export const deletedOrganizationId = '01a17a79-0af6-71c2-a357-5eefeef70de1';
export const deletedOrganizationThreadId = '01a17a7a-1071-720c-8100-2345e36e84de';

/** The identity read for a page whose authors include the deleted organization. */
function withDeletedOrganization(request: Request, recording: KernelRecording | undefined) {
  const ids = new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
  if (!recording || !ids.includes(deletedOrganizationId)) return undefined;
  const accounts = Array.isArray(recording.accounts) ? recording.accounts : [];
  return {
    ...recording,
    accounts: [...accounts, { id: deletedOrganizationId, kind: 'organization', state: 'deleted' }],
  };
}

/** The recorded owned thread, written by the deleted organization under an id of its own. */
function deletedOrganizationThreadRecordings(): Record<string, KernelRecording> {
  const recordings = {
    'thread-deleted-organization': threadOwnedRecording,
    'thread-deleted-organization-posts': threadOwnedPostsRecording,
  };
  return JSON.parse(
    JSON.stringify(recordings)
      .replaceAll(threadOwnedRecording.thread.authorId, deletedOrganizationId)
      .replaceAll(threadOwnedRecording.thread.id, deletedOrganizationThreadId),
  ) as Record<string, KernelRecording>;
}

/** The browser-only Storybook kernel uses the checked-in responses for the real page routes. */
export function createStoryRecordedKernelFetch(): typeof fetch {
  return createRecordedKernelFetch({
    'home-page': homePageRecording,
    'agent-page': agentPageRecording,
    'agent-page-reader': agentPageReaderRecording,
    'missing-subject-page': missingSubjectPageRecording,
    'missing-subject': missingSubjectRecording,
    'subject-page': subjectPageRecording,
    'subject-links': subjectLinksRecording,
    subject: subjectRecording,
    'subject-reactions': subjectReactionsRecording,
    'subject-reaction': subjectReactionRecording,
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
    ...deletedOrganizationThreadRecordings(),
    offer: offerRecording,
    'offer-cjk': offerCjkRecording,
    'offer-delisted': offerDelistedRecording,
    'order-failed': orderFailedRecording,
    'order-paid': orderPaidRecording,
    'order-pending': orderPendingRecording,
    ...libraryStoryRecordings(),
    'rating-vote': ratingVoteRecording,
    'subject-review-threads': subjectReviewThreadsRecording,
    'my-realms': myRealmsRecording,
    realm: realmRecording,
    'realm-boards': realmBoardsRecording,
    'realm-member': realmMemberRecording,
    'realm-participation': realmParticipationRecording,
    'realm-publications': realmPublicationsRecording,
    'realm-subjects': realmSubjectsRecording,
    space: spaceRecording,
    'space-address': spaceAddressRecording,
    ...boardRealmStoryRecordings(),
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
function subjectPayload(
  fixtures: Fixtures,
  id: string,
): { subject: Subject; account: { id: string } | null; related: Related; summary?: Summary } | undefined {
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
  const summary =
    fixtures.summaries && Object.hasOwn(fixtures.summaries, target) ? fixtures.summaries[target] : undefined;
  const account = fixtures.accounts?.find((item) => item.subject === target);
  return { subject, account: account ? { id: account.id } : null, related, ...(summary ? { summary } : {}) };
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
  if (fixtures.searchWithoutTotal) {
    const named = 'statement' in filter ? filter.statement : undefined;
    const ids = new Set(named?.in ?? []);
    const matched = fixtures.subjects.filter((subject) =>
      'type' in filter
        ? filter.type.in.includes(subject.type)
        : !!named &&
          !!subject.statements[named.property]?.some(
            (statement) =>
              statement.value.type === 'value' &&
              typeof statement.value.content === 'string' &&
              ids.has(statement.value.content),
          ),
    );
    matched.sort(byEnglishLabel);
    return {
      subjects: matched.slice(0, read.body.limit).map((subject) => searchHit(fixtures, subject)),
      next: null,
      as_of: '2026-10-26T00:00:00.000Z',
    };
  }
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

/** Subjects holding a statement of the property that names the subject, as the kernel's `links` read returns them. */
function linksRead(fixtures: Fixtures, read: Extract<PageRead, { kind: 'links' }>) {
  const matched = fixtures.subjects
    .filter(
      (subject) =>
        (read.type === undefined || subject.type === read.type) &&
        subject.statements[read.property]?.some(
          (statement) => statement.value.type === 'value' && statement.value.content === read.id,
        ),
    )
    .sort(byEnglishLabel);
  return {
    links: matched.slice(0, read.limit).map((subject) => {
      const hit = searchHit(fixtures, subject);
      return { subject: subject.id, label: subject.labels.en ?? '', type: subject.type, summary: hit.summary };
    }),
    count: { value: matched.length, exact: true },
  };
}

const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function problem(status: number, code: string, pointer?: string): Response {
  return Response.json(
    {
      type: `https://rezics.com/problems/${code}`,
      title: code,
      status,
      code,
      retryable: false,
      effect_status: 'not_applicable',
      request_id: crypto.randomUUID(),
      ...(pointer ? { errors: [{ pointer, code: 'invalid_format' }] } : {}),
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** The public profile `GET /v1/accounts?handle=` answers for an active account. */
function accountProfile(fixtures: Fixtures, account: FixtureAccount) {
  const subject = account.subject ? fixtures.subjects.find((item) => item.id === account.subject) : undefined;
  return {
    id: account.id,
    kind: account.kind,
    handle: account.handle,
    displayName: account.displayName,
    state: account.state,
    ...('movedTo' in account && typeof account.movedTo === 'string' ? { movedTo: account.movedTo } : {}),
    automated: false,
    operatorId: null,
    bio: account.bio,
    links: account.links,
    avatar: account.avatar ?? null,
    publicViews: account.publicViews ?? { posts: true, reviews: true, collections: true },
    subject: subject ? { id: subject.id, label: subject.labels.en ?? '', type: subject.type } : null,
    verified: subject !== undefined,
  };
}

/** The agent node an unverified account is: a Person or Organization with the account's own name. */
function agentNode(account: FixtureAccount): Subject {
  return {
    id: account.id,
    type: account.kind === 'organization' ? 'schema:Organization' : 'schema:Person',
    labels: account.displayName ? { en: account.displayName } : {},
    descriptions: {},
    aliases: {},
    statements: {},
  } as unknown as Subject;
}

type AccountList = 'posts' | 'threads' | 'collections';

/** One page of an account's list, `limit` rows from the cursor; a private view answers an empty page. */
function accountListPage(
  account: FixtureAccount,
  list: AccountList,
  query: { limit: number; cursor?: string | undefined; threadKind?: string | undefined },
) {
  const views = account.publicViews ?? { posts: true, reviews: true, collections: true };
  const shown =
    list === 'posts'
      ? views.posts
      : list === 'collections'
        ? views.collections
        : query.threadKind === 'review'
          ? views.reviews
          : true;
  const all = (shown ? (account[list] ?? []) : []).filter((row) => list !== 'threads' || row.kind === query.threadKind);
  const start = query.cursor ? Number(/^c(\d+)$/.exec(query.cursor)?.[1] ?? 0) : 0;
  const rows = all.slice(start, start + query.limit);
  return { [list]: rows, next: start + query.limit < all.length ? `c${start + query.limit}` : null };
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
  const requestedView = isRecord(target) && isView(target.view) ? target.view : 'overview';
  const handle = isRecord(target) && typeof target.account === 'string' ? target.account : undefined;
  if (handle !== undefined && !handlePattern.test(handle)) return problem(400, 'invalid_request', '/target/account');
  // An unknown, reserved or deleted handle is the same 404.
  const account =
    handle === undefined
      ? undefined
      : fixtures.accounts?.find((item) => item.handle === handle && item.state === 'active' && !('movedTo' in item));
  if (handle !== undefined && !account) return notFound();
  if (!requested && requestedRoute === undefined && !account) return notFound();
  const payload = account
    ? (subjectPayload(fixtures, account.subject ?? account.id) ?? {
        subject: agentNode(account),
        account: { id: account.id },
        related: {} as Related,
      })
    : requested
      ? subjectPayload(fixtures, requested)
      : undefined;
  if (requested && !payload) return notFound();
  const definition = payload ? fixtures.types[payload.subject.type] : undefined;
  const templateTarget =
    requestedRoute !== undefined
      ? { route: requestedRoute }
      : {
          type: payload!.subject.type,
          ...(definition ? { bases: definition.bases } : {}),
        };
  const resolved = resolveView(platformProfile, templateTarget, requestedView);
  if (!resolved) return notFound();
  const pageAccount = account ? { id: account.id, handle: account.handle } : null;
  const plan = planReads(platformRegistry, resolved.document, {
    subject: payload?.subject.id ?? null,
    account: pageAccount,
  });
  const reads: Record<string, { status: number; body: unknown }> = {};
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    // The subject read that selected the template is reused.
    reads[key] =
      descriptor.kind === 'subject' && descriptor.id === payload?.subject.id && payload
        ? { status: 200, body: payload }
        : descriptor.kind === 'search'
          ? { status: 200, body: searchRead(fixtures, descriptor) }
          : descriptor.kind === 'links'
            ? { status: 200, body: linksRead(fixtures, descriptor) }
            : descriptor.kind === 'collections'
              ? { status: 200, body: { collections: [], count: { value: 0, exact: true } } }
              : account && descriptor.kind === 'account'
                ? { status: 200, body: { accounts: [accountProfile(fixtures, account)], next: null } }
                : account && descriptor.kind === 'accountPosts'
                  ? { status: 200, body: accountListPage(account, 'posts', descriptor) }
                  : account && descriptor.kind === 'accountThreads'
                    ? { status: 200, body: accountListPage(account, 'threads', descriptor) }
                    : account && descriptor.kind === 'accountCollections'
                      ? { status: 200, body: accountListPage(account, 'collections', descriptor) }
                      : { status: 404, body: { code: 'not_found' } };
  }
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    if (
      descriptor.kind !== 'links' ||
      !fixtures.linksWithoutCount?.some(
        (entry) => entry.subject === descriptor.id && entry.property === descriptor.property,
      )
    )
      continue;
    const read = reads[key];
    if (read?.status !== 200 || !isRecord(read.body)) continue;
    const body = { ...read.body };
    delete body.count;
    reads[key] = { status: 200, body };
  }
  return Response.json({
    ...(payload ? { subject: payload.subject.id } : {}),
    ...(account ? { account: account.id } : {}),
    profile: platformDigest,
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    ...(payload ? { views: definedViews(platformProfile, templateTarget) } : {}),
    reads,
  });
}

export function createFakeKernelFetch(given: Fixtures, observe?: (call: FakeKernelCall) => void): typeof fetch {
  // Fixtures that name no accounts get the demo cast, so every agent address in the dev site answers.
  const fixtures: Fixtures = given.accounts
    ? given
    : {
        ...given,
        subjects: [...given.subjects, ...(demoAgentSubjects as unknown as FixtureSubject[])],
        accounts: demoAgentAccounts,
      };
  const moduleFixtures = mergeFakeFixtures(fixtures);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const fixtures = moduleFixtures;
    const request = new Request(input, init);
    const exposure = exposureResponse(request, given.admitted);
    if (exposure) return exposure;
    const url = new URL(request.url);
    observe?.({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      cookie: request.headers.get('cookie'),
    });
    if (request.method === 'GET' && url.pathname === '/v1/accounts' && url.searchParams.has('handle')) {
      const handle = url.searchParams.get('handle');
      const account = fixtures.accounts?.find((item) => item.handle === handle && item.state === 'active');
      return Response.json({ accounts: account ? [accountProfile(fixtures, account)] : [], next: null });
    }
    const moduleRecording = await answerFakeRoute('fixture', request, undefined, fixtures);
    if (moduleRecording) return recordedResponse(moduleRecording);
    if (request.method === 'GET') {
      const community = communityRecording(request.method, url.pathname, reviewFakeRecordings);
      if (community) return recordedResponse(community);
      const reviewBoard = reviewFakeRecordings['realm-boards'];
      const items = reviewBoard?.items;
      const firstReviewBoard = Array.isArray(items)
        ? items.find((board) => isRecord(board) && board.purpose === 'reviews')
        : undefined;
      const boardPath = /^\/v1\/boards\/([^/]+)$/.exec(url.pathname);
      if (boardPath?.[1] && isRecord(firstReviewBoard) && decodeURIComponent(boardPath[1]) === firstReviewBoard.id)
        return recordedResponse({ status: 200, board: firstReviewBoard });
      const votePath = /^\/v1\/subjects\/([^/]+)\/ratings\/([^/]+)\/vote$/.exec(url.pathname);
      if (
        votePath?.[1] &&
        votePath[2] === '00000000-0000-7000-8000-000000000001' &&
        decodeURIComponent(votePath[1]) === knownSubjectId(reviewFakeRecordings)
      )
        return recordedResponse(reviewFakeRecordings['rating-vote']!);
      const subjectThreadsPath = /^\/v1\/subjects\/([^/]+)\/threads$/.exec(url.pathname);
      if (
        subjectThreadsPath?.[1] &&
        decodeURIComponent(subjectThreadsPath[1]) === knownSubjectId(reviewFakeRecordings) &&
        url.searchParams.get('kind') === 'review' &&
        url.searchParams.get('place') === '01a1a000-0000-7000-8000-000000000002'
      )
        return recordedResponse(reviewFakeRecordings['subject-review-threads']!);
    }
    const sitemap = sitemapRecording(request.method, url.pathname, {
      board: boardRecording,
      thread: threadRecording,
      realm: realmRecording,
      space: spaceRecording,
    });
    if (sitemap) return recordedResponse(sitemap);
    if (request.method === 'GET' && url.pathname === '/v1/subjects:suggest')
      return recordedResponse(
        suggestionRead(
          fixtures.subjects.map((subject) => searchHit(fixtures, subject)),
          request,
        ),
      );
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return pageRead(fixtures, request);
    if (request.method === 'GET' && url.pathname === '/v1/accounts' && url.searchParams.has('agent')) {
      const subjectId = url.searchParams.get('agent');
      const account = fixtures.accounts?.find((item) => item.subject === subjectId && item.state === 'active');
      return Response.json({ accounts: account ? [accountProfile(fixtures, account)] : [], next: null });
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/accounts' &&
      (url.searchParams.has('handle') || url.searchParams.has('ids'))
    ) {
      const handle = url.searchParams.get('handle');
      const ids = new Set(url.searchParams.get('ids')?.split(',').slice(0, 100) ?? []);
      const accounts =
        fixtures.accounts?.filter((account) =>
          handle !== null
            ? account.state === 'active' && account.handle.toLowerCase() === handle.toLowerCase()
            : ids.has(account.id),
        ) ?? [];
      return Response.json({ accounts: accounts.map((account) => accountProfile(fixtures, account)), next: null });
    }
    const list = /^\/v1\/accounts\/([^/]+)\/(posts|threads|collections)$/.exec(url.pathname);
    if (request.method === 'GET' && list) {
      const owner = fixtures.accounts?.find(
        (item) => item.id === decodeURIComponent(list[1]!) && item.state === 'active',
      );
      if (!owner) return notFound();
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return Response.json(
        accountListPage(owner, list[2] as AccountList, {
          limit: Number.isInteger(limit) && limit >= 1 ? limit : 20,
          cursor: url.searchParams.get('cursor') ?? undefined,
          threadKind: url.searchParams.get('kind') ?? undefined,
        }),
      );
    }
    const match = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname);
    if (request.method !== 'GET' || !match) return notFound();
    const id = decodeURIComponent(match[1]!);
    const survivor = fixtures.redirects[id];
    if (survivor)
      return Response.json(
        { redirect: { from: id, to: survivor } },
        { status: 308, headers: { location: `/v1/subjects/${encodeURIComponent(survivor)}` } },
      );
    const payload = subjectPayload(fixtures, id);
    return payload ? Response.json(payload) : notFound();
  }) as typeof fetch;
}

/** The bounded suggestion read, using the same summaries as the fake kernel's search results. */
function suggestionRead(subjects: readonly unknown[], request: Request): KernelRecording {
  const query = new URL(request.url).searchParams.get('q')?.trim().toLocaleLowerCase() ?? '';
  const matches = subjects.filter(
    (subject) =>
      query &&
      isRecord(subject) &&
      isRecord(subject.labels) &&
      Object.values(subject.labels).some(
        (label) => typeof label === 'string' && label.toLocaleLowerCase().includes(query),
      ),
  );
  return { status: 200, subjects: matches.slice(0, 8), as_of: new Date().toISOString() };
}

export { pageRead };
/** A separate mention story preserves the recorded responses used by the other page stories. */
export const mentionThreadId = '01a17a7a-1071-720c-8100-2345e36e84df';
function mentionStoryPosts(): KernelRecording {
  const posts = structuredClone(threadPostsRecording.posts);
  for (const post of posts) {
    post.threadId = mentionThreadId;
    if (post.body)
      post.body.doc.content.push({
        type: 'paragraph',
        attrs: { id: `mentions-${post.id}` },
        content: [
          { type: 'text', text: 'Thanks, ' },
          { type: 'mention', attrs: { accountId: accountsRecording.accounts[0]!.id } },
          { type: 'text', text: '. ' },
          { type: 'mention', attrs: { accountId: deletedOrganizationId } },
        ],
      } as never);
  }
  return { status: 200, posts, next: null };
}
function mentionStoryThread(): KernelRecording {
  return { status: 200, thread: { ...threadRecording.thread, id: mentionThreadId } };
}
