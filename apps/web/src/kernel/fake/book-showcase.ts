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
import type { SubjectPageData } from '../../features/pages/subject';
import {
  book,
  bookContext,
  bookId,
  bookLong,
  bookRealm,
  bookSparse,
  bookSubjectMap,
  bookSubjects,
  bookSubjectRead,
  bookPageSubjectRead,
  bookSynopsisDocument,
  bookSummary,
  isBookShowcase,
} from '../fixtures/book-showcase';
import type { FakeRoute } from '../fake-modules';
import { communityAuthor, communityThread, communityThreadPage } from './subject-community';
import { authoredReadingPage } from './thread-reading-page';
import { GLOBAL, QUESTION, ratingsFixtures } from './ratings';
import { recordedBookState } from './library-entry-states';
import { storyViewerId } from './identities';
import definitions from '../recorded/definitions-release.json';
import collectionRecording from '../recorded/library-collection.json';

const profile = profileJson as PresentationProfile;
export type BookScenario = 'rich' | 'sparse' | 'failure' | 'limited' | 'long';
function createBookVisit(scenario: BookScenario) {
  const votes = new Map<string, { units: number; revision: number }>();
  const libraryEntries = new Map<string, { state: string; revision: number }>();
  if (scenario !== 'sparse')
    for (const { id } of [book, bookLong]) {
      votes.set(id, { units: 17, revision: 1 });
      libraryEntries.set(id, { state: recordedBookState(1)!, revision: 1 });
    }
  return { scenario, failed: false, votes, libraryEntries };
}
type BookVisit = ReturnType<typeof createBookVisit>;
let selected = createBookVisit('rich');

/** State belongs to a mounted story; navigation does not reset it. */
export function selectBookShowcase(next: BookScenario = 'rich') {
  selected = createBookVisit(next);
}

/** A retired story releases only its own selection, including after a source refresh. */
export function prepareBookShowcase(next: BookScenario = 'rich'): () => void {
  const visit = createBookVisit(next);
  selected = visit;
  return () => {
    if (selected === visit) selectBookShowcase();
  };
}
export const bookStorySubject = (state: BookScenario) =>
  state === 'sparse' ? bookSparse : state === 'long' ? bookLong : book;
const language = (request: Request) => request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
const freshness = { consistency: 'eventual', target_seconds: 10, caught_up: true };
type BookCursor = { scope: string; node: string; offset: number };
const cursorByAddress = new Map<string, string>();
const addressByCursor = new Map<string, BookCursor>();
let cursorSequence = 0;
function opaqueCursor(scope: string, node: string, offset: number): string {
  const address = `${scope}\0${node}\0${offset}`;
  const known = cursorByAddress.get(address);
  if (known) return known;
  if (addressByCursor.size >= 256) {
    const oldest = addressByCursor.entries().next().value as [string, BookCursor] | undefined;
    if (oldest) {
      addressByCursor.delete(oldest[0]);
      cursorByAddress.delete(`${oldest[1].scope}\0${oldest[1].node}\0${oldest[1].offset}`);
    }
  }
  const cursor = `book-window-${bookId(9000 + cursorSequence++)}`;
  cursorByAddress.set(address, cursor);
  addressByCursor.set(cursor, { scope, node, offset });
  return cursor;
}

export const bookReviewTitles = [
  'A city worth getting lost in',
  'The maps tell a second story',
  'On reading the translation beside the original',
  'Patient, luminous, and occasionally difficult',
  'An atlas of ordinary kindness',
  'A reread after ten years',
  'The interludes finally clicked for me',
  'The revised edition gives the ending room',
  'Every borrowed day has a cost',
];
export const bookDiscussionTitles = [
  'Which map did you notice first?',
  'Reading order for The Tide Archive',
  'How does the English translation handle the names?',
  'The harbour’s changing geography',
  'Favourite illustrated spread?',
  'A spoiler-free guide to the interludes',
  'The closing festival and the opening letter',
  'Differences in the revised edition',
  'Our next group reread',
];
const reviewBodies = [
  'The quiet precision of the harbour scenes stayed with me long after the mystery resolved. Sora’s choices make the city feel lived in, and the illustrations reward returning to earlier chapters.',
  'I kept a finger in the map pages throughout. The visual clues are subtle, never substitutes for the prose. A beautiful example of text and illustration sharing the storytelling.',
  'Mara Chen keeps the deliberate repetitions without flattening the different voices. The afterword is especially useful after reading the last interlude.',
];
function threadRows(kind: 'review' | 'discussion', id: string, member: boolean) {
  const subject = { id, label: bookSubjectMap.get(id)!.labels.en! };
  return (kind === 'review' ? bookReviewTitles : bookDiscussionTitles).map(
    (title, index): ReturnType<typeof communityThread> => {
      const base = communityThread(kind, false, subject);
      const threadId = bookId((kind === 'review' ? 1000 : 1100) + index);
      return {
        ...base,
        id: threadId,
        title,
        licence: 'CC0-1.0',
        firstPost: {
          id: bookId((kind === 'review' ? 1200 : 1300) + index),
          threadId,
          route: 1,
          authorId: communityAuthor.id,
          boardId: base.boardId,
          parentId: null,
          licence: 'CC0-1.0',
          subjectIds: [id],
          visibility: 'published',
          securityRevision: '1',
          createdAt: base.createdAt,
          revisedAt: null,
          mediaIds: [],
          revisionId: bookId((kind === 'review' ? 1400 : 1500) + index),
          body: fromPlainText(
            kind === 'review'
              ? reviewBodies[index % reviewBodies.length]!
              : `${title} We are comparing passages from the original and the revised edition. Please identify your edition and mark spoilers for readers who have not reached the final festival.`,
            'blocks',
          ),
          sha256: 'a'.repeat(64),
          availability: 'available',
          voteCitation: kind === 'review' ? { questionId: QUESTION, units: 14 + (index % 6), revision: 1 } : null,
        },
        reactions: { upvote: 4 + index * 3, like: 19 - index, insightful: index + 1 },
        viewerReaction: member ? 'like' : null,
      };
    },
  );
}

const collectionTitles = [
  'Cities that remember',
  'Illustrated journeys',
  'Japanese fiction in translation',
  'The quiet fantastic',
  'Maps, letters and unreliable memories',
  'The Tide Archive reading group',
  'Books for a rainy ferry crossing',
  'Stories of finding home',
  'Small presses, lasting books',
];
function collections(id: string) {
  return collectionTitles.map((title, index) => ({
    ...collectionRecording.collection,
    id: bookId(800 + index),
    title,
    description: `${title}: a considered reading list with notes on language, editions and reading order.`,
    memberCount: 4,
    cover: bookSummary(id).cover,
    coverSource: 'member',
    presentationKind: 'schema:Book',
    presentationKindSource: 'owner',
  }));
}

/** Match actual directed statements, keeping their identity and qualifiers through both directions. */
function relationRows(id: string, property: string, inverse: boolean, locale: string) {
  const owners = inverse ? bookSubjects : [bookSubjectMap.get(id)!];
  return owners.flatMap((owner) =>
    (owner.statements[property] ?? []).flatMap((statement) => {
      if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return [];
      const target = inverse ? owner.id : statement.value.content;
      if (inverse && statement.value.content !== id) return [];
      if (!bookSubjectMap.has(target)) return [];
      const summary = bookSummary(target, locale);
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
          related: bookSubjectRead(owner.id, locale).related,
        },
      ];
    }),
  );
}

function windowOf<T>(rows: T[], limit: number, node: string, cursor?: string, scope = node) {
  const address = cursor ? addressByCursor.get(cursor) : undefined;
  const offset = cursor
    ? address?.scope === scope && address.node === node
      ? Math.min(address.offset, rows.length)
      : rows.length
    : 0;
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(24, Math.max(1, limit)) : 12;
  const page = rows.slice(offset, offset + boundedLimit);
  return {
    rows: page,
    count: { value: rows.length, exact: true },
    next: offset + page.length < rows.length ? opaqueCursor(scope, node, offset + page.length) : null,
  };
}

/** Resolve the shipped template and answer its ordinary read plan; no alternate Book renderer. */
export function bookShowcasePage(
  id = book.id,
  view: View = 'overview',
  options: {
    locale?: string;
    realm?: string;
    continuation?: PageContinuation;
    member?: boolean;
    failEditions?: boolean;
  } = {},
): SubjectPageData {
  const locale = options.locale ?? 'en';
  const item = bookSubjectMap.get(id)!;
  const types = definitions.release.types as Record<string, { bases: string[] }>;
  const target = { type: item.type, bases: types[item.type]!.bases };
  const resolved = resolveView(profile, target, view)!;
  const context: SelectedContext = options.realm
    ? { id: bookContext, population: { kind: 'realm', id: options.realm, title: 'The Tide Archive reading group' } }
    : { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: id,
    context,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  });
  const selected = options.continuation ? plan.nodes[options.continuation.node] : undefined;
  const reads: SubjectPageData['reads'] = {};
  const catalogueDirections: NonNullable<NonNullable<SubjectPageData['catalogue']>['directions']> = [];
  const admittedDirections = new Set<string>();
  const properties = definitions.release.properties as Record<string, { relation?: { inverse?: string | null } }>;
  for (const read of Object.values(plan.reads)) {
    if (read.kind !== 'links' && read.kind !== 'relations') continue;
    const direction: 'forward' | 'inverse' = read.kind === 'links' ? 'inverse' : 'forward';
    const key = `${read.property}:${direction}`;
    if (admittedDirections.has(key)) continue;
    admittedDirections.add(key);
    catalogueDirections.push({
      state: 'admitted',
      property: read.property,
      direction,
      inverse: properties[read.property]?.relation?.inverse ?? null,
      sourceTypes: [],
      targetTypes: [],
      release: definitions.digest,
      qualifiers: [],
    });
  }
  const sparse = id === bookSparse.id;
  for (const [key, read] of Object.entries(plan.reads)) {
    const node = Object.keys(plan.nodes).find((name) => plan.nodes[name] === key)!;
    if (read.kind === 'subject') {
      reads[key] = { status: 200, body: bookPageSubjectRead(id, locale, context.id) };
      continue;
    }
    if (selected && selected !== key) {
      reads[key] = { status: 204, body: null };
      continue;
    }
    if (options.failEditions && node === 'editions') {
      reads[key] = { status: 503, body: { code: 'dependency_unavailable' } };
      continue;
    }
    if (read.kind === 'links' || read.kind === 'relations') {
      const rows = relationRows(id, read.property, read.kind === 'links', locale);
      const page = windowOf(rows, read.limit, node, read.cursor, `${id}:${context.id}:${resolved.key}:${node}`);
      reads[key] = {
        status: 200,
        body: {
          [read.kind === 'links' ? 'links' : 'relations']: page.rows.map((row) =>
            read.kind === 'links' ? { ...row, statement: row.statement.id } : row,
          ),
          count: page.count,
          next: page.next,
          freshness,
        },
      };
    } else if (read.kind === 'subjectThreads') {
      const page = windowOf(
        sparse || read.place !== GLOBAL ? [] : threadRows(read.threadKind, id, options.member ?? false),
        read.limit,
        node,
        read.cursor,
        `${id}:${context.id}:${node}:${read.place}:${read.threadKind}`,
      );
      reads[key] = {
        status: 200,
        body: communityThreadPage(read.threadKind, { id, label: item.labels.en! }, page.rows, page.next, read.place),
      };
    } else if (read.kind === 'collections') {
      const rows = sparse ? [] : collections(id);
      const page = windowOf(rows, read.limit, node, read.cursor, `${id}:${context.id}:${node}`);
      reads[key] = {
        status: 200,
        body: { collections: page.rows, count: page.count, next: page.next },
      };
    }
  }
  return {
    subject: id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views: definedViews(profile, target),
    catalogue: {
      state: 'released',
      type: item.type,
      digest: definitions.digest,
      definitions: definitions.release,
      directions: catalogueDirections,
    },
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
  const visit = selected;
  const input = (await request.json()) as PageInput;
  if (!isBookShowcase(input.target.subject)) return;
  const target = input.target;
  const failEditions = visit.scenario === 'failure' && !visit.failed;
  if (target.view === 'editions') visit.failed = true;
  return {
    status: 200,
    ...bookShowcasePage(target.subject!, target.view, {
      locale: input.languages?.[0] ?? language(request),
      ...('realm' in target && target.realm ? { realm: target.realm } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
      member: request.headers.has('authorization'),
      failEditions,
    }),
  };
};

function entry(visit: BookVisit, id: string, locale: string) {
  return {
    subjectId: id,
    ...visit.libraryEntries.get(id)!,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-11-10T12:00:00.000Z',
    subject: bookSummary(id, locale),
  };
}
const libraryAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const visit = selected;
  const { libraryEntries } = visit;
  const id = match?.[1];
  if (!isBookShowcase(id)) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  if (visit.scenario === 'limited' && request.method !== 'GET') return { status: 403, code: 'forbidden' };
  if (request.method === 'GET')
    return libraryEntries.has(id!)
      ? { status: 200, libraryEntry: entry(visit, id!, language(request)) }
      : { status: 404, code: 'not_found' };
  const revision = (libraryEntries.get(id!)?.revision ?? 0) + 1;
  if (request.method === 'PUT') {
    const body = (await request.json()) as { state: string };
    libraryEntries.set(id!, { state: body.state, revision });
    return { status: 200, libraryEntry: entry(visit, id!, language(request)) };
  }
  libraryEntries.delete(id!);
  return {
    status: 204,
    headers: { 'Library-Entry-Deletion-Id': bookId(99), 'Library-Entry-Deletion-Revision': String(revision) },
  };
};
const voteAnswer: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const visit = selected;
  const { votes } = visit;
  const id = match?.[1];
  if (!isBookShowcase(id)) return;
  if (!request.headers.has('authorization')) return { status: 401, code: 'unauthorized' };
  if (visit.scenario === 'limited' && request.method !== 'GET') return { status: 403, code: 'forbidden' };
  if (request.method === 'PUT') {
    const { units } = (await request.json()) as { units: number };
    votes.set(id!, { units, revision: (votes.get(id!)?.revision ?? 0) + 1 });
  }
  if (request.method === 'DELETE') {
    votes.delete(id!);
    return { status: 204 };
  }
  const vote = votes.get(id!);
  return vote ? { status: 200, ...vote, at: '2026-11-10T12:00:00.000Z' } : { status: 404, code: 'not_found' };
};

export const routes: FakeRoute[] = [
  { method: 'POST', path: '/v1/pages:read', story: pageAnswer },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ request, match }) =>
      isBookShowcase(match?.[1]) ? { status: 200, ...bookSubjectRead(match![1]!, language(request)) } : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/documents\/([^/]+)$/,
    story: ({ match }) => {
      const id = match?.[1] === bookId(90) ? book.id : match?.[1] === bookId(91) ? bookLong.id : undefined;
      return id ? { status: 200, document: bookSynopsisDocument(id) } : undefined;
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
      if (!isBookShowcase(match?.[1])) return;
      const figure =
        ratingsFixtures[match![1] === bookSparse.id ? 'subject-ratings-empty' : 'subject-ratings-global'].aggregate;
      const populations = new URL(request.url).searchParams.getAll('population');
      return {
        status: 200,
        ...figure,
        subject: match![1]!,
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
    story: ({ match }) => (isBookShowcase(match?.[1]) ? { status: 200, __responseBody: [] } : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/collections$/,
    story: ({ request, match }) => {
      if (!isBookShowcase(match?.[1])) return;
      const page = windowOf(
        match?.[1] === bookSparse.id ? [] : collections(match![1]!),
        6,
        'lists',
        new URL(request.url).searchParams.get('cursor') ?? undefined,
        `${match?.[1]}:collections`,
      );
      return { status: 200, collections: page.rows, count: page.count, next: page.next };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/threads$/,
    story: ({ request, match }) => {
      if (!isBookShowcase(match?.[1])) return;
      const query = new URL(request.url).searchParams;
      const kind = query.get('kind') as 'review' | 'discussion';
      const page = windowOf(
        match![1] === bookSparse.id || (query.get('place') ?? GLOBAL) !== GLOBAL
          ? []
          : threadRows(kind, match![1]!, request.headers.has('authorization')),
        6,
        kind === 'review' ? 'reviews' : 'threads',
        query.get('cursor') ?? undefined,
        `${match?.[1]}:threads:${kind}:${query.get('place') ?? GLOBAL}`,
      );
      return {
        status: 200,
        ...communityThreadPage(
          kind,
          { id: match![1]!, label: bookSubjectMap.get(match![1]!)!.labels.en! },
          page.rows,
          page.next,
          query.get('place') ?? GLOBAL,
        ),
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/(links|relations)$/,
    story: ({ request, match }) => {
      if (!isBookShowcase(match?.[1])) return;
      const query = new URL(request.url).searchParams;
      const property = query.get('property')!;
      const inverse = match![2] === 'links';
      const page = windowOf(
        relationRows(match![1]!, property, inverse, language(request)),
        Number(query.get('limit') ?? 12),
        property,
        query.get('cursor') ?? undefined,
        `${match?.[1]}:relations:${property}:${inverse ? 'inverse' : 'forward'}`,
      );
      return {
        status: 200,
        [inverse ? 'links' : 'relations']: page.rows.map((row) =>
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
    path: /^\/v1\/threads\/([^/]+)(\/reading-page|\/posts)?$/,
    story: ({ request, match }) => {
      const member = request.headers.has('authorization');
      const thread = [...threadRows('review', book.id, member), ...threadRows('discussion', book.id, member)].find(
        (row) => row.id === match?.[1],
      );
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
      const collection = collections(book.id).find((row) => row.id === match?.[1]);
      if (!collection) return;
      if (!match?.[2]) return { status: 200, collection };
      return {
        status: 200,
        members: [book.id, bookId(300), bookId(301), bookId(302)].map((id, index) => ({
          id: bookId(900 + index),
          subjectId: id,
          note: index === 0 ? 'Begin here, before the other three volumes.' : null,
          addedAt: '2026-11-01T00:00:00.000Z',
          subject: bookSummary(id),
        })),
        next: null,
      };
    },
  },
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request }) =>
      isBookShowcase(new URL(request.url).searchParams.get('agent') ?? undefined)
        ? { status: 200, accounts: [], next: null }
        : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/realms\/([^/]+)$/,
    story: ({ match, recordings }) =>
      match?.[1] === bookRealm
        ? {
            status: 200,
            realm: {
              ...(recordings.realm?.realm as object),
              realmId: bookRealm,
              contextId: bookContext,
              title: 'The Tide Archive reading group',
            },
          }
        : undefined,
  },
];
