import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageContinuation,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import { calendarRangeMatches, type DiscoveryFilterDocument } from '@rezics/filter';
import profileJson from '@rezics/composition/profiles/platform.json';
import type { FakeRoute } from '../fake-modules';
import type { DiscoveryHit, DiscoveryPage } from '../../search/discovery';
import { GLOBAL, QUESTION } from '../../ratings/question-ids';
import { PUBLIC_RATING_SCALE } from '../../ratings/question-contract';
import {
  bookReviewMembers,
  mediaReviewMembers,
  reviewBooks,
  reviewDate,
  reviewFacts,
  reviewId,
  reviewItemMap,
  reviewLiterary,
  reviewSubjectRead,
  reviewSummary,
  type ReviewItem,
} from '../fixtures/collection-showcase';
import definitions from '../recorded/definitions-release.json';
import collectionRecording from '../recorded/library-collection.json';
import { storyViewerId } from './identities';

/** Exact identities keep these illustrative responses separate from recordings and other Web owners. */
export const collectionReviewIds = {
  books: reviewId(701),
  media: reviewId(702),
  owner: reviewId(703),
  empty: reviewId(704),
  sparse: reviewId(705),
  unavailable: reviewId(706),
} as const;
export const collectionReviewCursor = 'collection review /+== native frontier : second';
export const collectionReviewLastCursor = 'collection review /+== sparse frontier : final';
export const bookReviewCursor = 'book catalogue /+== native frontier : second';
export type BookListScenario = 'ready' | 'empty' | 'sparse' | 'unavailable';
let activeBookList: BookListScenario | undefined;
const failures = new Set<string>();

/** A new visit resets failures; effect reattachment only resumes its transport selection. */
export function selectBookListReview(scenario?: BookListScenario, reset = true) {
  activeBookList = scenario;
  if (reset) failures.clear();
}
export function resetCollectionReview() {
  activeBookList = undefined;
  failures.clear();
}
export function collectionReviewPath(kind: keyof typeof collectionReviewIds, query = '') {
  return `/collections/${collectionReviewIds[kind]}${query ? `?${query}` : ''}`;
}
const localeOf = (request: Request) => request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
const profile = profileJson as PresentationProfile;
const collectionKinds = new Map<string, keyof typeof collectionReviewIds>(
  Object.entries(collectionReviewIds).map(([kind, id]) => [id, kind as keyof typeof collectionReviewIds]),
);

/** This fixture evaluates the closed wire predicate at the fake transport, never in a list consumer. */
function matches(entry: ReviewItem, filter: DiscoveryFilterDocument | undefined): boolean {
  if (!filter) return true;
  if ('and' in filter) return filter.and.every((part) => matches(entry, part));
  if ('or' in filter) return filter.or.some((part) => matches(entry, part));
  if ('not' in filter) return !matches(entry, filter.not);
  if ('type' in filter) return filter.type.in.includes(entry.type);
  if ('kind' in filter) return filter.kind.in.includes(entry.type);
  if ('statement' in filter) {
    const condition = filter.statement;
    const facts = reviewFacts(entry)[condition.property] ?? [];
    if ('in' in condition)
      return facts.some((fact) =>
        fact.kind === 'item'
          ? condition.in.includes(fact.id)
          : fact.kind === 'code' && condition.in.includes(fact.value),
      );
    if ('range' in condition)
      return facts.some((fact) => {
        const range = condition.range;
        if (range.type === 'time') return fact.kind === 'time' && calendarRangeMatches(fact, range);
        const value = fact.kind === 'quantity' ? fact.amount : fact.kind === 'time' ? fact.year : undefined;
        return (
          value !== undefined &&
          (range.gte === undefined || value >= range.gte) &&
          (range.lte === undefined || value <= range.lte)
        );
      });
    return false;
  }
  // Collection scope is attached by the existing facet reader. The selected catalogue is already bounded to it.
  return 'collection' in filter;
}
function filterOf(request: Request): DiscoveryFilterDocument | undefined {
  const value = new URL(request.url).searchParams.get('filter');
  return value ? (JSON.parse(value) as DiscoveryFilterDocument) : undefined;
}
function firstFailure(key: string) {
  if (failures.has(key)) return false;
  failures.add(key);
  return true;
}
function collectionRows(kind: keyof typeof collectionReviewIds, locale: string) {
  return kind === 'books' ? bookReviewMembers(locale) : kind === 'empty' ? [] : mediaReviewMembers(locale);
}

const collectionAnswer: NonNullable<FakeRoute['story']> = ({ request, match }) => {
  const id = match?.[1];
  const kind = id && collectionKinds.get(id);
  if (!kind) return;
  const url = new URL(request.url);
  const locale = localeOf(request);
  const all = collectionRows(kind, locale);
  if (!match?.[2]) {
    const owner = kind === 'owner';
    return {
      status: 200,
      collection: {
        ...collectionRecording.collection,
        id,
        curatorAccountId: owner ? storyViewerId : 'collection-review-curator',
        curator: owner
          ? { id: storyViewerId, handle: 'mira', displayName: 'Mira Okabe' }
          : { id: 'collection-review-curator', handle: 'harbour-library', displayName: 'Harbour Library' },
        title:
          kind === 'books'
            ? 'Stories for a slower afternoon'
            : kind === 'empty'
              ? 'The next coastal journey'
              : 'Across the harbour: books, games and animation',
        description:
          kind === 'books'
            ? 'Eight stories about finding a place in the world. Read in the curator’s order, or refine the supplied author, genre and publication facts.'
            : kind === 'empty'
              ? 'A new collection, ready for its first discovery.'
              : 'Different ways into one imagined coastline. Novels sit beside games and animation; each keeps its own identity, date and curator note.',
        visibility: 'public',
        revision: 1,
        memberCount: all.length,
        presentationKind: kind === 'books' ? 'schema:Book' : null,
        presentationKindSource: kind === 'books' ? 'owner' : 'mixed',
        cover: all[0]?.subject?.cover ?? null,
        coverSource: all.length ? 'member' : 'none',
        updatedAt: reviewDate,
      },
    };
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && ![collectionReviewCursor, collectionReviewLastCursor].includes(cursor))
    return { status: 409, code: 'stale_cursor' };
  if (kind === 'unavailable' && firstFailure(`${url.href}:${request.headers.get('authorization') ?? 'anonymous'}`))
    return { status: 503, code: 'dependency_unavailable' };
  const filter = filterOf(request);
  const rows = all.filter((member) => matches(reviewItemMap.get(member.subjectId!)!, filter));
  if (kind === 'sparse') {
    if (!cursor) return { status: 200, members: [], next: collectionReviewCursor };
    if (cursor === collectionReviewCursor)
      return { status: 200, members: rows.slice(0, 1), next: collectionReviewLastCursor };
    return { status: 200, members: rows.slice(1), next: null };
  }
  const split = kind === 'books' ? 6 : 7;
  return {
    status: 200,
    members: cursor ? rows.slice(split) : rows.slice(0, split),
    next: !cursor && rows.length > split ? collectionReviewCursor : null,
  };
};

function rating(entry: ReviewItem) {
  const score = 7 + (Number(entry.id.slice(-3)) % 5) * 0.5;
  return {
    questionId: QUESTION,
    populationId: GLOBAL,
    scale: { ...PUBLIC_RATING_SCALE, displayStep: 1 },
    count: 18 + Number(entry.id.slice(-3)),
    state: 'ready' as const,
    mean: score,
    score,
  };
}
type SearchInput = {
  representation?: string;
  text?: string;
  filter?: DiscoveryFilterDocument;
  sort?: string;
  cursor?: string;
  scope?: { kind: string; id: string };
  languages?: string[];
  kindPage?: { cursor?: string };
  facets?: { property: string; size?: number; cursor?: string }[];
};
type CatalogueHit = Extract<DiscoveryHit, { summary: { kind: 'subject' } }>;
function searchEntries(input: SearchInput) {
  let entries = [...reviewBooks, ...reviewLiterary].filter((entry) => matches(entry, input.filter));
  if (input.text?.trim()) {
    const text = input.text.trim().toLocaleLowerCase();
    entries = entries.filter((entry) =>
      [...Object.values(entry.labels), entry.description, entry.creator?.label ?? ''].some((value) =>
        value.toLocaleLowerCase().includes(text),
      ),
    );
  }
  if (input.sort === 'rating') entries.sort((a, b) => rating(b).score - rating(a).score || a.id.localeCompare(b.id));
  return entries;
}
const searchAnswer: NonNullable<FakeRoute['story']> = async ({ request }) => {
  if (!activeBookList) return;
  const input = (await request.json()) as SearchInput;
  if (input.representation !== 'discovery-v1') return;
  if (activeBookList === 'unavailable' && firstFailure(`search:${JSON.stringify(input)}`))
    return { status: 503, code: 'dependency_unavailable' };
  if (input.cursor && ![bookReviewCursor, collectionReviewLastCursor].includes(input.cursor))
    return { status: 409, code: 'search_restart_required' };
  const locale = input.languages?.[0] ?? localeOf(request);
  const rows = activeBookList === 'empty' ? [] : searchEntries(input);
  const split = 6;
  const selected =
    activeBookList === 'sparse' && !input.cursor
      ? rows.slice(0, 1)
      : input.cursor
        ? rows.slice(activeBookList === 'sparse' ? 1 : split)
        : rows.slice(0, split);
  const page: DiscoveryPage = {
    hits: selected.map((entry) => ({
      key: { owner: 'semantic', kind: entry.type, route: 0, id: entry.id },
      matchEvidence: { state: 'unavailable' },
      summary: { kind: 'subject', value: reviewSummary(entry, locale) },
      labels: entry.labels,
      descriptions: { en: entry.description },
      facts: reviewFacts(entry),
      figure: rating(entry),
      listPresentation: definitions.release.types[entry.type].listPresentation as NonNullable<
        CatalogueHit['listPresentation']
      >,
    })),
    kinds: {
      values: ['schema:Book', 'schema:BookSeries', 'bf:Instance'].map((id) => ({
        id,
        labels: definitions.release.types[id as 'schema:Book'].labels,
        icon: 'book',
      })),
      next: null,
    },
    next: !input.cursor && rows.length > selected.length ? bookReviewCursor : null,
    as_of: reviewDate,
  };
  return { status: 200, ...page };
};
function scopedCollection(filter: unknown): string | undefined {
  if (!filter || typeof filter !== 'object') return;
  if ('collection' in filter) return (filter.collection as { id: string }).id;
  if ('and' in filter) return (filter.and as unknown[]).map(scopedCollection).find(Boolean);
}
const facetFrontiers = Array.from({ length: 10 }, (_, index) => `facet review /+== native frontier : ${index + 1}`);
const facetsAnswer: NonNullable<FakeRoute['story']> = async ({ request }) => {
  const input = (await request.json()) as SearchInput;
  const scope = input.scope?.kind === 'collection' ? input.scope.id : scopedCollection(input.filter);
  const kind = scope && collectionKinds.get(scope);
  if (!activeBookList && !kind) return;
  const entries = kind
    ? collectionRows(kind, 'en')
        .map((row) => reviewItemMap.get(row.subjectId!)!)
        .filter((entry) => matches(entry, input.filter))
    : searchEntries(input);
  return {
    status: 200,
    as_of: reviewDate,
    facets: (input.facets ?? []).map(({ property, size = 10, cursor }) => {
      const values = new Map<string, { value: string; labels: Record<string, string> }>();
      for (const entry of entries) {
        if (property === 'type')
          values.set(entry.type, { value: entry.type, labels: definitions.release.types[entry.type].labels });
        for (const fact of reviewFacts(entry)[property] ?? [])
          if (fact.kind === 'item') values.set(fact.id, { value: fact.id, labels: fact.labels });
      }
      const rows = [...values.values()];
      const offset = cursor ? facetFrontiers.indexOf(cursor) + 1 : 0;
      return {
        property,
        values: rows.slice(offset, offset + size),
        next: rows.length > offset + size ? facetFrontiers[offset + size - 1]! : null,
      };
    }),
  };
};

/** The same released composition and Subject envelope as production; empty sections stay explicitly empty. */
const subjectPageAnswer: NonNullable<FakeRoute['story']> = async ({ request }) => {
  const input = (await request.json()) as {
    target: { subject?: string; view?: View };
    languages?: string[];
    continuation?: PageContinuation;
  };
  const id = input.target.subject;
  if (!id) return;
  const locale = input.languages?.[0] ?? localeOf(request);
  const subject = reviewSubjectRead(id, locale);
  if (!subject) return;
  const definition = definitions.release.types[subject.subject.type as keyof typeof definitions.release.types];
  const target = { type: subject.subject.type, bases: definition.bases };
  const resolved = resolveView(profile, target, input.target.view ?? 'overview');
  if (!resolved) return { status: 404, code: 'not_found' };
  const context = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: id,
    context,
    ...(input.continuation ? { continuation: input.continuation } : {}),
  });
  const reads: Record<string, { status: number; body: unknown }> = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') reads[key] = { status: 200, body: subject };
    else if (read.kind === 'links' || read.kind === 'relations')
      reads[key] = {
        status: 200,
        body: { [read.kind]: [], count: { value: 0, exact: true }, next: null },
      };
    else if (read.kind === 'collections')
      reads[key] = {
        status: 200,
        body: { collections: [], count: { value: 0, exact: true }, next: null },
      };
    else reads[key] = { status: 404, body: { code: 'not_found' } };
  }
  return {
    status: 200,
    subject: id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views: definedViews(profile, target),
    reads,
    ...(input.continuation ? { continuation: input.continuation } : {}),
  };
};

export const routes: FakeRoute[] = [
  { method: 'GET', path: /^\/v1\/collections\/([^/]+)(\/members)?$/, story: collectionAnswer },
  { method: 'POST', path: '/v1/subjects:search', story: searchAnswer },
  { method: 'POST', path: '/v1/subjects:facets', story: facetsAnswer },
  { method: 'POST', path: '/v1/pages:read', story: subjectPageAnswer },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ match, request }) => {
      const read = reviewSubjectRead(match![1]!, localeOf(request));
      return read ? { status: 200, ...read } : undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/libraryEntries\/([^/]+)$/,
    story: ({ match, request }) =>
      reviewItemMap.has(match![1]!)
        ? { status: request.headers.has('authorization') ? 404 : 401, code: 'not_found' }
        : undefined,
  },
];
