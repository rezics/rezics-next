import {
  definedViews,
  PAGE_GLOBAL_CONTEXT,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageContinuation,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import { fromPlainText } from '@rezics/document';
import type { SubjectPageData } from '../../features/pages/page-model';
import {
  game,
  gameSparse,
  gameId,
  gameDefinitions,
  gameDigest,
  gameSubjects,
  gameSubjectMap,
  gameSubjectRead,
  gameSummary,
  gameReleaseCard,
  isGameShowcase,
} from '../fixtures/game-showcase';
import type { FakeRoute } from '../fake-modules';
import { communityAuthor, communityThread, communityThreadPage } from './subject-community';
import { authoredReadingPage } from './thread-reading-page';
import { GLOBAL, QUESTION, ratingsFixtures } from './ratings';
import { storyViewerId } from './identities';
import collectionRecording from '../recorded/library-collection.json';

const profile = profileJson as PresentationProfile;
const freshness = { consistency: 'eventual', target_seconds: 10, caught_up: true };
export type GameShowcaseState = 'rich' | 'sparse' | 'release-failure' | 'review-failure';
let scenario: GameShowcaseState = 'rich';
const failures = new Set<string>();
const entries = new Map<string, { state: string; revision: number }>();
const votes = new Map<string, { units: number; revision: number }>();
export const gameEntryState = (index: number) =>
  gameDefinitions.libraryProfiles!['game.playing']!.entryStateSet!.states[index]!.id;

/** Called once per story entry; navigating tabs, destinations and history keeps the same viewer state. */
export function selectGameShowcase(state: GameShowcaseState = 'rich') {
  scenario = state;
  failures.clear();
  entries.clear();
  votes.clear();
  if (state !== 'sparse') {
    entries.set(game.id, { state: gameEntryState(1), revision: 1 });
    votes.set(game.id, { units: 17, revision: 1 });
  }
}
const language = (request: Request) => request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
export const gameReviewTitles = [
  'A place worth coming home to',
  'The sound of the harbour after dark',
  'Small puzzles, generous storytelling',
  'The Switch release on a long train ride',
  'Playing in Japanese after the English version',
  'The lighthouse is only the beginning',
  'Returning with The Last Ferry',
];
const reviewBodies = [
  'The harbour changes with every tide, but the people are what made me return. I liked the quiet routine of mending the lamp before setting out. The last crossing gives those small choices a satisfying shape.',
  'Ship bells, gulls and a piano heard through an open window: the sound design makes North Quay feel lived in. There is enough silence for the conversations to land. Play with headphones if you can.',
  'The environmental puzzles ask you to notice a place rather than search an inventory. A few early routes feel slow, but the map opens naturally as you learn who lives where. A thoughtful weekend adventure.',
];
const discussionTitles = [
  'A spoiler-free guide to the low-water paths',
  'Which release includes The Last Ferry?',
  'Favourite music from North Quay?',
  'Controller or keyboard for the map?',
  'Language options in the Switch game card',
  'The lamp-room puzzle: hints before answers',
  'Our next community replay',
];
function threads(kind: 'review' | 'discussion', subjectId: string, member: boolean) {
  const item = gameSubjectMap.get(subjectId)!;
  if (!['schema:VideoGame', 'wd:Q20631656', 'wd:Q209163'].includes(item.type) || subjectId === gameSparse.id) return [];
  const primary = subjectId === game.id;
  const titles = primary
    ? kind === 'review'
      ? gameReviewTitles
      : discussionTitles
    : [kind === 'review' ? `Playing ${item.labels.en}` : `Questions about ${item.labels.en}`];
  const identity = 1000000 + Number(subjectId.slice(-12)) * 1000 + (kind === 'review' ? 0 : 100);
  return titles.map((title, index) => {
    const base = communityThread(kind, false, { id: subjectId, label: item.labels.en! });
    const id = gameId(identity + index);
    return {
      ...base,
      id,
      title,
      licence: 'CC0-1.0',
      firstPost: {
        ...base.firstPost,
        id: gameId(identity + 200 + index),
        threadId: id,
        revisionId: gameId(identity + 400 + index),
        licence: 'CC0-1.0',
        body: fromPlainText(
          kind === 'review'
            ? primary
              ? reviewBodies[index % reviewBodies.length]!
              : `This review concerns ${item.labels.en}, not every release of the work. ${item.descriptions.en} The quiet exploration and careful sound design are the highlights of this synthetic playthrough.`
            : `${title} Please name your exact release and language when comparing versions. Keep story spoilers marked so new players can join the conversation.`,
          'blocks',
        ),
        voteCitation: kind === 'review' ? { questionId: QUESTION, units: 15 + (index % 5), revision: 1 } : null,
      },
      reactions: { like: 12 + index, insightful: 3 + index },
      viewerReaction: member ? 'like' : null,
    };
  });
}
const collectionMembers = [game.id, gameId(71), gameId(72)];
function collections() {
  return [
    'Places to return to',
    'Quiet adventures for a rainy weekend',
    'Games that listen',
    'The North Quay shelf',
  ].map((title, index) => ({
    ...collectionRecording.collection,
    id: gameId(800 + index),
    title,
    description: 'A synthetic community selection of narrative games, with notes about languages and releases.',
    memberCount: collectionMembers.length,
    cover: gameSummary(game.id).cover,
    coverSource: 'member',
    presentationKind: 'schema:VideoGame',
    presentationKindSource: 'owner',
  }));
}
const subjectCollections = (id: string) => (collectionMembers.includes(id) ? collections() : []);
function relationRows(id: string, property: string, inverse: boolean, locale: string) {
  return (inverse ? gameSubjects : [gameSubjectMap.get(id)!]).flatMap((owner) =>
    (owner.statements[property] ?? []).flatMap((assertion) => {
      if (assertion.value.type !== 'value' || typeof assertion.value.content !== 'string') return [];
      if (inverse && assertion.value.content !== id) return [];
      const target = inverse ? owner.id : assertion.value.content;
      if (!isGameShowcase(target)) return [];
      const summary = gameSummary(target, locale);
      return [
        {
          subject: target,
          target,
          external: null,
          property,
          label: summary.label.value,
          type: summary.type,
          summary,
          statement: assertion,
          assertion,
          related: gameSubjectRead(owner.id, locale).related,
        },
      ];
    }),
  );
}
function windowOf<T>(rows: T[], limit: number, node: string, cursor?: string) {
  const offset = cursor ? Number(cursor.split(':').at(-1)) : 0;
  const page = rows.slice(offset, offset + limit);
  return {
    rows: page,
    count: { value: rows.length, exact: true },
    next: offset + page.length < rows.length ? `game:${node}:${offset + page.length}` : null,
  };
}
export function gameRelationPage(
  id: string,
  property: string,
  inverse: boolean,
  locale: string,
  limit: number,
  cursor?: string,
) {
  const page = windowOf(relationRows(id, property, inverse, locale), limit, property, cursor);
  const releasePage = inverse && property === 'schema:exampleOfWork';
  return {
    [inverse ? 'links' : 'relations']: page.rows.map((row) =>
      inverse ? { ...row, statement: row.statement.id } : row,
    ),
    count: page.count,
    next: page.next,
    freshness,
    ...(releasePage
      ? {
          workReleaseCards: { state: 'available', cards: page.rows.map((row) => gameReleaseCard(row.subject, locale)) },
        }
      : {}),
  };
}
type Options = {
  locale?: string;
  member?: boolean;
  continuation?: PageContinuation;
  failReleases?: boolean;
  failReviews?: boolean;
};
/** The released application template owns every tab and read; the showcase only supplies native-shaped results. */
export function gameShowcasePage(id = game.id, view: View = 'overview', options: Options = {}): SubjectPageData {
  const locale = options.locale ?? 'en';
  const item = gameSubjectMap.get(id)!;
  const target = { type: item.type, bases: gameDefinitions.types[item.type]!.bases };
  const resolved = resolveView(profile, target, view)!;
  const context = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: id,
    context,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  });
  const reads: SubjectPageData['reads'] = {};
  const selected = options.continuation ? plan.nodes[options.continuation.node] : undefined;
  const sparse = id === gameSparse.id;
  for (const [key, read] of Object.entries(plan.reads)) {
    const node = Object.keys(plan.nodes).find((name) => plan.nodes[name] === key)!;
    if (read.kind === 'subject') {
      reads[key] = { status: 200, body: gameSubjectRead(id, locale) };
    } else if (selected && selected !== key) {
      reads[key] = { status: 204, body: null };
    } else if (
      (options.failReleases && read.kind === 'links' && read.property === 'schema:exampleOfWork') ||
      (options.failReviews && read.kind === 'subjectThreads' && read.threadKind === 'review')
    ) {
      reads[key] = { status: 503, body: { code: 'dependency_unavailable' } };
    } else if (read.kind === 'links' || read.kind === 'relations') {
      reads[key] = {
        status: 200,
        body: gameRelationPage(id, read.property, read.kind === 'links', locale, read.limit, read.cursor),
      };
    } else if (read.kind === 'subjectThreads') {
      const page = windowOf(
        sparse || read.place !== GLOBAL ? [] : threads(read.threadKind, id, options.member ?? false),
        read.limit,
        node,
        read.cursor,
      );
      reads[key] = {
        status: 200,
        body: communityThreadPage(read.threadKind, { id, label: item.labels.en! }, page.rows, page.next, read.place),
      };
    } else if (read.kind === 'collections') {
      const page = windowOf(subjectCollections(id), read.limit, node, read.cursor);
      reads[key] = { status: 200, body: { collections: page.rows, count: page.count, next: page.next } };
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
    catalogue: { state: 'released', type: item.type, digest: gameDigest, definitions: gameDefinitions },
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
}
const pageAnswer: NonNullable<FakeRoute['story']> = async ({ request }) => {
  const input = (await request.json()) as {
    target: { subject?: string; view?: View };
    languages?: string[];
    continuation?: PageContinuation;
  };
  if (!isGameShowcase(input.target.subject)) return;
  const failReleases = scenario === 'release-failure' && !failures.has('releases');
  const failReviews = scenario === 'review-failure' && !failures.has('reviews');
  const page = gameShowcasePage(input.target.subject, input.target.view, {
    locale: input.languages?.[0] ?? language(request),
    member: request.headers.has('authorization'),
    ...(input.continuation ? { continuation: input.continuation } : {}),
    failReleases,
    failReviews,
  });
  if (failReleases) failures.add('releases');
  if (failReviews) failures.add('reviews');
  return { status: 200, ...page };
};
const entry = (id: string) => ({
  subjectId: id,
  ...entries.get(id)!,
  subject: gameSummary(id),
  createdAt: '2026-10-20T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z',
});
const libraryAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const id = match?.[1];
  if (!isGameShowcase(id)) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  if (request.method === 'GET')
    return entries.has(id) ? { status: 200, libraryEntry: entry(id) } : { status: 404, code: 'not_found' };
  const revision = (entries.get(id)?.revision ?? 0) + 1;
  if (request.method === 'PUT') {
    const { state } = (await request.json()) as { state: string };
    entries.set(id, { state, revision });
    return { status: 200, libraryEntry: entry(id) };
  }
  entries.delete(id);
  return {
    status: 204,
    headers: { 'Library-Entry-Deletion-Id': gameId(99), 'Library-Entry-Deletion-Revision': String(revision) },
  };
};
const voteAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const id = match?.[1];
  if (!isGameShowcase(id)) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  if (request.method === 'PUT') {
    const { units } = (await request.json()) as { units: number };
    votes.set(id, { units, revision: (votes.get(id)?.revision ?? 0) + 1 });
  } else if (request.method === 'DELETE') {
    votes.delete(id);
    return { status: 204 };
  }
  return votes.has(id)
    ? { status: 200, ...votes.get(id)!, at: '2026-11-10T12:00:00.000Z' }
    : { status: 404, code: 'not_found' };
};
export const routes: FakeRoute[] = [
  { method: 'POST', path: '/v1/pages:read', story: pageAnswer },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ request, match }) =>
      isGameShowcase(match?.[1])
        ? {
            status: 200,
            ...gameSubjectRead(
              match![1]!,
              language(request),
              new URL(request.url).searchParams.get('context') ?? PAGE_GLOBAL_CONTEXT,
            ),
          }
        : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/(links|relations)$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isGameShowcase(id)) return;
      const query = new URL(request.url).searchParams;
      if (
        scenario === 'release-failure' &&
        match![2] === 'links' &&
        query.get('property') === 'schema:exampleOfWork' &&
        !failures.has('releases')
      ) {
        failures.add('releases');
        return { status: 503, code: 'dependency_unavailable' };
      }
      return {
        status: 200,
        ...gameRelationPage(
          id,
          query.get('property')!,
          match![2] === 'links',
          language(request),
          Number(query.get('limit') ?? 12),
          query.get('cursor') ?? undefined,
        ),
      };
    },
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
      if (!isGameShowcase(id)) return;
      const figure =
        ratingsFixtures[id === gameSparse.id ? 'subject-ratings-empty' : 'subject-ratings-global'].aggregate;
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
    story: ({ match }) => (isGameShowcase(match?.[1]) ? { status: 200, __responseBody: [] } : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/threads$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (!isGameShowcase(id)) return;
      const query = new URL(request.url).searchParams;
      const kind = query.get('kind') as 'review' | 'discussion';
      if (kind === 'review' && scenario === 'review-failure' && !failures.has('reviews')) {
        failures.add('reviews');
        return { status: 503, code: 'dependency_unavailable' };
      }
      const page = windowOf(
        id === gameSparse.id || (query.get('place') ?? GLOBAL) !== GLOBAL
          ? []
          : threads(kind, id, request.headers.has('authorization')),
        Number(query.get('limit') ?? 6),
        kind,
        query.get('cursor') ?? undefined,
      );
      return {
        status: 200,
        ...communityThreadPage(
          kind,
          { id, label: gameSubjectMap.get(id)!.labels.en! },
          page.rows,
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
      if (!isGameShowcase(id)) return;
      const page = windowOf(
        subjectCollections(id),
        6,
        'lists',
        new URL(request.url).searchParams.get('cursor') ?? undefined,
      );
      return { status: 200, collections: page.rows, count: page.count, next: page.next };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/threads\/([^/]+)(\/reading-page|\/posts)?$/,
    story: ({ request, match }) => {
      const member = request.headers.has('authorization');
      const thread = gameSubjects
        .flatMap((item) => [...threads('review', item.id, member), ...threads('discussion', item.id, member)])
        .find((row) => row.id === match?.[1]);
      if (!thread) return;
      if (match?.[2] === '/posts') return { status: 200, posts: [thread.firstPost], next: null };
      if (!match?.[2]) return { status: 200, thread };
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
      const collection = collections().find((row) => row.id === match?.[1]);
      if (!collection) return;
      if (!match?.[2]) return { status: 200, collection };
      return {
        status: 200,
        members: collectionMembers.map((id, index) => ({
          id: gameId(900 + index),
          subjectId: id,
          note:
            index === 0
              ? 'Begin at the lighthouse; choose your exact platform release.'
              : 'Another story in the North Quay setting.',
          addedAt: '2026-11-01T00:00:00.000Z',
          subject: gameSummary(id),
        })),
        next: null,
      };
    },
  },
];
