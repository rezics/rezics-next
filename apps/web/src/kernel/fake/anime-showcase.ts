import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageContinuation,
  type PresentationProfile,
  type SelectedContext,
  type View,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import { fromPlainText } from '@rezics/document';
import type { SubjectPageData } from '../../features/pages/page-model';
import {
  anime,
  animeContext,
  animeDigest,
  animeGlobal,
  animeId,
  animePageSubjectRead,
  animeRealm,
  animeRelease,
  animeSeasons,
  animeSubjectMap,
  animeSubjects,
  animeSubjectRead,
  animeSummary,
  animeSynopsisDocument,
  isAnimeShowcase,
} from '../fixtures/anime-showcase';
import type { FakeRoute } from '../fake-modules';
import { communityAuthor, communityThread, communityThreadPage } from './subject-community';
import { authoredReadingPage } from './thread-reading-page';
import { GLOBAL, ratingsFixtures } from './ratings';
import { storyViewerId } from './identities';
import collectionRecording from '../recorded/library-collection.json';

const profile = profileJson as PresentationProfile;
export type AnimeScenario = 'rich' | 'failure';
let active = false;
let failPage = false;
const entries = new Map<string, { state: string; revision: number }>();
const votes = new Map<string, { units: number; revision: number }>();
type ProgressState = {
  amount: string | null;
  revision: number;
  state: 'active' | 'completed' | 'abandoned';
  completedAt: string | null;
};
const progress = new Map<string, ProgressState>();
const progressReplays = new Map<string, ReturnType<typeof animeProgressSession>>();
const freshness = { consistency: 'eventual', target_seconds: 10, caught_up: true };
const language = (request: Request) => request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
const sparse = (id: string) => id === animeSeasons[2]!.id;

/** Installed Library vocabulary; Season, Series and Episode keep independent saved state. */
function activeState(id: string) {
  const type = animeSubjectMap.get(id)!.type;
  const profileId = animeRelease.types[type]?.library?.profileId;
  return profileId
    ? animeRelease.libraryProfiles![profileId]!.entryStateSet!.states.find((state) => state.role === 'active')!.id
    : undefined;
}
export function selectAnimeShowcase(scenario?: AnimeScenario) {
  active = scenario !== undefined;
  failPage = scenario === 'failure';
  entries.clear();
  votes.clear();
  progress.clear();
  progressReplays.clear();
  if (!active) return;
  for (const id of [anime.id, animeSeasons[0]!.id]) {
    entries.set(id, { state: activeState(id)!, revision: 1 });
    votes.set(id, { units: 17, revision: 1 });
    progress.set(id, { amount: '3', revision: 1, state: 'active', completedAt: null });
  }
}

export const animeReviewTitles = [
  'A place worth keeping the lights on for',
  'The city is a character too',
  'Patient skies, unforgettable people',
  'The music between the conversations',
  'A second season that finds its own path',
  'Cloudy evenings can be beautiful',
  'What changes when you look up',
];
const discussionTitles = [
  'Which visitor stayed with you?',
  'The star charts on the office wall',
  'Comparing the two opening themes',
  'The night bus route',
];
const reviewBodies = [
  'The observatory feels like a place that existed before the story began. The long pauses and small acts of care make its visitors memorable. No ending spoilers here: watch the changing light in the backgrounds.',
  'I came for the painted skies and stayed for the conversations. The series makes room for people of different ages without turning every encounter into a lesson.',
  'Mika Sen’s score knows when to fall silent. The sound of footsteps on the hill does as much work as the music. The second season changes the setting while keeping that attention to ordinary life.',
];
function threads(kind: 'review' | 'discussion', id: string, member: boolean) {
  if (sparse(id)) return [];
  const item = animeSubjectMap.get(id)!;
  const subject = { id, label: item.labels.en! };
  return (kind === 'review' ? animeReviewTitles : discussionTitles).map((title, index) => {
    const base = communityThread(kind, false, subject);
    // Subject-local identity prevents a Season review opening the Series' thread.
    const subjectIndex = animeSubjects.findIndex((row) => row.id === id);
    const threadId = animeId(20000 + subjectIndex * 100 + (kind === 'review' ? 0 : 50) + index);
    return {
      ...base,
      id: threadId,
      title,
      licence: 'CC0-1.0',
      firstPost: {
        ...base.firstPost,
        id: animeId(30000 + subjectIndex * 100 + (kind === 'review' ? 0 : 50) + index),
        threadId,
        licence: 'CC0-1.0',
        revisionId: animeId(40000 + subjectIndex * 100 + (kind === 'review' ? 0 : 50) + index),
        body: fromPlainText(
          kind === 'review'
            ? reviewBodies[index % reviewBodies.length]!
            : `${title} Please name the season and episode you are discussing and mark spoilers for later visitors.`,
          'blocks',
        ),
      },
      reactions: { like: 12 + index, insightful: 3 + index },
      viewerReaction: member ? 'like' : null,
    };
  });
}
const collectionTitles = ['Small places, wide skies', 'Quiet anime for a rainy evening', 'Cities after the last train'];
function collections(id: string) {
  if (sparse(id)) return [];
  return collectionTitles.map((title, index) => ({
    ...collectionRecording.collection,
    id: animeId(800 + index),
    title,
    description: 'An authored list of animated stories about ordinary people and the places they share.',
    memberCount: 1,
    cover: animeSummary(anime.id).cover,
    coverSource: 'member',
    presentationKind: 'schema:TVSeries',
    presentationKindSource: 'owner',
  }));
}

/** Membership assertions supply both directions. Array order is the fixture's native order. */
export function animeRelationRows(id: string, property: string, inverse: boolean, locale = 'en') {
  const owners = inverse ? animeSubjects : [animeSubjectMap.get(id)!];
  return owners.flatMap((owner) =>
    (owner.statements[property] ?? []).flatMap((statement) => {
      if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return [];
      if (inverse && statement.value.content !== id) return [];
      const target = inverse ? owner.id : statement.value.content;
      if (!animeSubjectMap.has(target)) return [];
      const summary = animeSummary(target, locale);
      return [
        {
          subject: target,
          target,
          external: null,
          property,
          label: summary.label.value,
          type: summary.type,
          summary,
          statement,
          assertion: statement,
          related: animeSubjectRead(owner.id, locale).related,
        },
      ];
    }),
  );
}
function windowOf<T>(rows: T[], limit: number, node: string, cursor?: string) {
  const offset = cursor ? Number(cursor.split(':').at(-1)) : 0;
  const items = rows.slice(offset, offset + limit);
  return {
    items,
    count: { value: rows.length, exact: true },
    next: offset + items.length < rows.length ? `anime:${node}:${offset + items.length}` : null,
  };
}

/** Resolve the installed page document and answer its declared read plan. */
export function animeShowcasePage(
  id = anime.id,
  view: View = 'overview',
  options: { locale?: string; realm?: string; continuation?: PageContinuation; member?: boolean } = {},
): SubjectPageData {
  const locale = options.locale ?? 'en';
  const item = animeSubjectMap.get(id)!;
  const target = { type: item.type, bases: animeRelease.types[item.type]!.bases };
  const resolved = resolveView(profile, target, view)!;
  const context: SelectedContext = options.realm
    ? { id: animeContext, population: { kind: 'realm', id: options.realm, title: 'Observatory night visitors' } }
    : { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: id,
    context,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  });
  const selected = options.continuation ? plan.nodes[options.continuation.node] : undefined;
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    const node = Object.keys(plan.nodes).find((name) => plan.nodes[name] === key)!;
    if (read.kind === 'subject') {
      reads[key] = { status: 200, body: animePageSubjectRead(id, locale, context.id) };
    } else if (selected && selected !== key) {
      reads[key] = { status: 204, body: null };
    } else if (read.kind === 'links' || read.kind === 'relations') {
      const page = windowOf(
        animeRelationRows(id, read.property, read.kind === 'links', locale),
        read.limit,
        node,
        read.cursor,
      );
      reads[key] = {
        status: 200,
        body: {
          [read.kind === 'links' ? 'links' : 'relations']: page.items.map((row) =>
            read.kind === 'links' ? { ...row, statement: row.statement.id } : row,
          ),
          count: page.count,
          next: page.next,
          freshness,
        },
      };
    } else if (read.kind === 'subjectThreads') {
      const page = windowOf(
        read.place === GLOBAL ? threads(read.threadKind, id, options.member ?? false) : [],
        read.limit,
        node,
        read.cursor,
      );
      reads[key] = {
        status: 200,
        body: communityThreadPage(read.threadKind, { id, label: item.labels.en! }, page.items, page.next, read.place),
      };
    } else if (read.kind === 'collections') {
      const page = windowOf(collections(id), read.limit, node, read.cursor);
      reads[key] = { status: 200, body: { collections: page.items, count: page.count, next: page.next } };
    }
  }
  return {
    subject: id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views: definedViews(profile, target),
    reads,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
}

type PageInput = {
  target: { subject?: string; view?: View; realm?: string };
  languages?: string[];
  continuation?: PageContinuation;
};
const pageAnswer: NonNullable<FakeRoute['story']> = async ({ request }) => {
  const input = (await request.json()) as PageInput;
  const id = input.target.subject;
  if (!isAnimeShowcase(id)) return;
  if (failPage && id === anime.id) {
    failPage = false;
    return { status: 503, code: 'dependency_unavailable' };
  }
  return {
    status: 200,
    ...animeShowcasePage(id, input.target.view, {
      locale: input.languages?.[0] ?? language(request),
      member: request.headers.has('authorization'),
      ...(input.target.realm ? { realm: input.target.realm } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
    }),
  };
};
function libraryEntry(id: string) {
  return {
    subjectId: id,
    ...entries.get(id)!,
    subject: animeSummary(id),
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-11-10T12:00:00.000Z',
  };
}
const libraryAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const id = match?.[1];
  if (!isAnimeShowcase(id)) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  if (request.method === 'GET')
    return entries.has(id) ? { status: 200, libraryEntry: libraryEntry(id) } : { status: 404, code: 'not_found' };
  const revision = (entries.get(id)?.revision ?? 0) + 1;
  if (request.method === 'PUT') {
    const body = (await request.json()) as { state: string };
    entries.set(id, { state: body.state, revision });
    return { status: 200, libraryEntry: libraryEntry(id) };
  }
  entries.delete(id);
  return {
    status: 204,
    headers: { 'Library-Entry-Deletion-Id': animeId(99), 'Library-Entry-Deletion-Revision': String(revision) },
  };
};
const voteAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const id = match?.[1];
  if (!isAnimeShowcase(id)) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  if (request.method === 'PUT') {
    const body = (await request.json()) as { units: number };
    votes.set(id, { units: body.units, revision: (votes.get(id)?.revision ?? 0) + 1 });
  }
  if (request.method === 'DELETE') {
    votes.delete(id);
    return { status: 204 };
  }
  const vote = votes.get(id);
  return vote ? { status: 200, ...vote, at: '2026-11-10T12:00:00.000Z' } : { status: 404, code: 'not_found' };
};

/** Scalar progress is private, independent of public membership and never episode completion identity. */
export function animeProgressSession(id = anime.id, locale = 'en') {
  const summary = animeSummary(id, locale);
  return {
    id: animeId(id === anime.id ? 500 : 501),
    subjectId: id,
    versionSubjectId: null,
    mode: 'scalar_amount',
    unit: 'episode',
    total: id === anime.id ? '28' : '22',
    locator: null,
    position: null,
    completedUnitCount: 0,
    startedAt: '2026-11-01T18:00:00.000Z',
    ...progress.get(id)!,
    subject: { ...summary, label: summary.label.value },
    versionSubject: null,
    presentation: {
      meaning: 'known',
      unitLabel: 'episode',
      unitLabelLanguage: 'en',
      unitCountForms: { one: 'episode', other: 'episodes' },
      dimension: 'episode',
      structure: 'unverified',
      recording: { state: 'supported', inputRules: { min: '0', step: '1', total: 'optional' } },
    },
  };
}

function progressSubject(sessionId: string | undefined) {
  return sessionId === animeId(500) ? anime.id : sessionId === animeId(501) ? animeSeasons[0]!.id : undefined;
}

/** The existing private editor writes one scalar; it never edits public episode membership. */
const progressAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const id = progressSubject(match?.[1]);
  if (!id) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  const body = (await request.json()) as { revision: number; amount?: string; clear?: true };
  const replayKey = `${match![1]}:${request.headers.get('idempotency-key')}`;
  const replay = progressReplays.get(replayKey);
  if (replay) return { status: 200, progressSession: replay };
  const previous = progress.get(id)!;
  // For example, a second editor submitting revision 1 after revision 2 must not overwrite it.
  if (body.revision !== previous.revision)
    return { status: 409, code: 'revision_conflict', effect_status: 'not_applied' };
  const action = match![2];
  progress.set(id, {
    amount: action === 'record' ? (body.clear ? null : body.amount!) : previous.amount,
    revision: previous.revision + 1,
    state: action === 'record' ? previous.state : action === 'complete' ? 'completed' : 'abandoned',
    completedAt: action === 'complete' ? '2026-11-14T12:00:00.000Z' : previous.completedAt,
  });
  const session = animeProgressSession(id, language(request));
  progressReplays.set(replayKey, session);
  return { status: 200, progressSession: session };
};

export const routes: FakeRoute[] = [
  { method: 'POST', path: '/v1/pages:read', story: pageAnswer },
  {
    method: 'GET',
    path: '/v1/definitions/active',
    story: () => (active ? { status: 200, digest: animeDigest } : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/definitions\/releases\/([^/]+)$/,
    story: ({ match }) =>
      active && decodeURIComponent(match![1]!) === animeDigest
        ? { status: 200, digest: animeDigest, release: animeRelease }
        : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isAnimeShowcase(id)) return;
      const context = new URL(request.url).searchParams.get('context') ?? animeGlobal;
      return { status: 200, ...animeSubjectRead(id, language(request), context) };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/documents\/([^/]+)$/,
    story: ({ match }) => (match?.[1] === animeId(90) ? { status: 200, document: animeSynopsisDocument() } : undefined),
  },
  ...(['GET', 'PUT', 'DELETE'] as const).map((method): FakeRoute => ({
    method,
    path: /^\/v1\/libraryEntries\/([^/]+)$/,
    story: libraryAnswer,
  })),
  ...(['GET', 'PUT', 'DELETE'] as const).map((method): FakeRoute => ({
    method,
    path: /^\/v1\/subjects\/([^/]+)\/ratings\/([^/]+)\/vote$/,
    story: voteAnswer,
  })),
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/ratings$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isAnimeShowcase(id)) return;
      const figure = ratingsFixtures[sparse(id) ? 'subject-ratings-empty' : 'subject-ratings-global'].aggregate;
      const populations = new URL(request.url).searchParams.getAll('population');
      return {
        status: 200,
        ...figure,
        subject: id,
        figures: (populations.length ? populations : [GLOBAL]).map(
          (population) =>
            figure.figures.find((row) => row.population === population) ?? {
              population,
              count: 0,
              freshness: { asOf: null, updating: false },
            },
        ),
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/source-statistics$/,
    story: ({ match }) => (isAnimeShowcase(match?.[1]) ? { status: 200, __responseBody: [] } : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/(links|relations)$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isAnimeShowcase(id)) return;
      const query = new URL(request.url).searchParams;
      const property = query.get('property')!;
      const inverse = match![2] === 'links';
      const page = windowOf(
        animeRelationRows(id, property, inverse, query.get('language') ?? language(request)),
        Number(query.get('limit') ?? 12),
        property,
        query.get('cursor') ?? undefined,
      );
      return {
        status: 200,
        [inverse ? 'links' : 'relations']: page.items.map((row) =>
          inverse ? { ...row, statement: row.statement.id } : row,
        ),
        count: page.count,
        next: page.next,
        freshness,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/threads$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isAnimeShowcase(id)) return;
      const query = new URL(request.url).searchParams;
      const kind = query.get('kind') as 'review' | 'discussion';
      const page = windowOf(
        (query.get('place') ?? GLOBAL) === GLOBAL ? threads(kind, id, request.headers.has('authorization')) : [],
        6,
        kind,
        query.get('cursor') ?? undefined,
      );
      return {
        status: 200,
        ...communityThreadPage(
          kind,
          { id, label: animeSubjectMap.get(id)!.labels.en! },
          page.items,
          page.next,
          query.get('place') ?? GLOBAL,
        ),
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/collections$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isAnimeShowcase(id)) return;
      const page = windowOf(collections(id), 6, 'lists', new URL(request.url).searchParams.get('cursor') ?? undefined);
      return { status: 200, collections: page.items, count: page.count, next: page.next };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/threads\/([^/]+)(\/reading-page|\/posts)?$/,
    story: ({ request, match }) => {
      if (!match?.[1]?.startsWith('0193a000-')) return;
      const member = request.headers.has('authorization');
      const thread = animeSubjects
        .flatMap((item) => [...threads('review', item.id, member), ...threads('discussion', item.id, member)])
        .find((row) => row.id === match[1]);
      if (!thread) return;
      if (match[2] === '/posts') return { status: 200, posts: [thread.firstPost], next: null };
      if (!match[2]) return { status: 200, thread };
      const page = authoredReadingPage(
        thread,
        [],
        [
          {
            id: communityAuthor.id,
            displayName: communityAuthor.displayName,
            handle: communityAuthor.handle,
            avatar: null,
          },
        ],
      );
      if (member) {
        page.viewer = { kind: 'account', id: storyViewerId };
        page.watch = { state: 'unavailable', retryable: true };
        page.currentness.watch = 'unavailable';
      }
      return { status: 200, ...page };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/([^/]+)(\/members)?$/,
    story: ({ match }) => {
      const collection = collections(anime.id).find((row) => row.id === match?.[1]);
      if (!collection) return;
      if (!match?.[2]) return { status: 200, collection };
      return {
        status: 200,
        members: [
          {
            id: animeId(900),
            subjectId: anime.id,
            note: 'Start with the first season.',
            addedAt: '2026-11-01T00:00:00.000Z',
            subject: animeSummary(anime.id),
          },
        ],
        next: null,
      };
    },
  },
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: ({ request }) => {
      const id = new URL(request.url).searchParams.get('subjectId') ?? undefined;
      if (!isAnimeShowcase(id)) return;
      if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
      return {
        status: 200,
        progressSessions: [anime.id, animeSeasons[0]!.id].includes(id)
          ? [animeProgressSession(id, language(request))]
          : [],
        next: null,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)(\/changes|\/completedUnits)?$/,
    story: ({ request, match }) => {
      const id = progressSubject(match?.[1]);
      if (!id) return;
      if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
      if (match?.[2]) return { status: 200, [match[2] === '/changes' ? 'changes' : 'completedUnits']: [], next: null };
      return { status: 200, progressSession: animeProgressSession(id, language(request)) };
    },
  },
  { method: 'POST', path: /^\/v1\/progressSessions\/([^/:]+):(record|complete|abandon)$/, story: progressAnswer },
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request }) =>
      isAnimeShowcase(new URL(request.url).searchParams.get('agent') ?? undefined)
        ? { status: 200, accounts: [], next: null }
        : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/realms\/([^/]+)$/,
    story: ({ match, recordings }) =>
      match?.[1] === animeRealm
        ? {
            status: 200,
            realm: {
              ...(recordings.realm?.realm as object),
              realmId: animeRealm,
              contextId: animeContext,
              title: 'Observatory night visitors',
            },
          }
        : undefined,
  },
];
