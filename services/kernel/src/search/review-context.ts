import type { DocumentNode } from '@rezics/document';
import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { requireAccessDeadline } from '../request/unavailable.ts';
import {
  discloseThreads,
  readCitationDisclosure,
  type ContentReadDependencies,
  type ThreadView,
} from '../content/reads.ts';
import { createReviewDiscoverySource, type ReviewDiscoverySource } from '../content/review-discovery.ts';
import type { ReadContext, ReviewVoteCitation } from '../content/model.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  readSubjectSummaryObservation,
  type SubjectSummary,
  type SubjectSummaryObservation,
} from '../semantic/summaries.ts';
import type { DiscoveryPage, DiscoveryReadContext, PublicReviewDiscoverySummary } from './discovery.ts';

export const REVIEW_CONTEXT_LIMITS = Object.freeze({
  selected: 100,
  rowBytes: 8192,
  pageBytes: 128 * 1024,
  nodes: 4096,
  depth: 64,
});
export type ReviewContextSource = Readonly<{ openingRevisionId: string; sourceVersion: string }>;
export type SearchReviewCitation =
  | Readonly<{
      state: 'available';
      recorded: ReviewVoteCitation;
      /** Content has no reusable historical question/label reader yet. A current
       * question is not a substitute for the presentation when this was cited. */
      historicalQuestion: Readonly<{ state: 'unavailable' }>;
    }>
  | Readonly<{ state: 'absent' | 'unsupported' | 'unavailable' | 'withdrawn' | 'erased' | 'withheld' }>;
export type SearchReviewContext =
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{
      state: 'available';
      openingPostId: string;
      target:
        | Readonly<{ state: 'available'; subject: SubjectSummary }>
        | Readonly<{ state: 'withheld' | 'unavailable' }>;
      citation: SearchReviewCitation;
      language: string | null;
      spoiler: boolean;
    }>;

type Dependencies = ContentReadDependencies & { routeKey: Uint8Array };
type ReviewHit = Extract<DiscoveryPage['hits'][number], { summary: { kind: 'review' } }>;
function isReview(hit: DiscoveryPage['hits'][number]): hit is ReviewHit {
  return hit.summary.kind === 'review';
}
type NativeRow = Awaited<ReturnType<ReviewDiscoverySource['hydrate']>>['reviews'][number];
const restart = () => new ProblemError('search_restart_required');

/** Bound variable-length native metadata before copying or serializing it. Cover
 * withholding does not withhold a currently readable target or change its ID. */
function boundedSubject(value: SubjectSummary): SubjectSummary | null {
  const text = (value: string, limit: number) => value.length <= limit && value.isWellFormed();
  if (
    !text(value.type, 256) ||
    value.types.length > 16 ||
    value.types.some((type) => !text(type, 256)) ||
    (value.label && (!text(value.label.value, 1024) || !text(value.label.language, 64)))
  )
    return null;
  const cover = value.cover;
  const credit = cover?.credit;
  const boundedCover =
    cover &&
    cover.variants.length <= 16 &&
    text(cover.placeholder.thumbhash, 256) &&
    text(cover.placeholder.color, 64) &&
    (!credit ||
      (text(credit.rightsHolder, 512) &&
        (!credit.license || text(credit.license, 512)) &&
        (!credit.via || (text(credit.via.name, 512) && text(credit.via.url, 2048))) &&
        credit.obligations.length <= 16 &&
        credit.obligations.every((item) => text(item, 256))));
  const result = { ...value, cover: boundedCover ? cover : null };
  return Buffer.byteLength(JSON.stringify(result)) <= REVIEW_CONTEXT_LIMITS.rowBytes - 2048
    ? result
    : { ...result, cover: null };
}

/** No unbounded document traversal or indexed spoiler fallback. The text itself
 * remains Content's approved excerpt; this only admits its presentation. */
function presentation(thread: ThreadView): { language: string | null; spoiler: boolean } | null {
  const post = thread.firstPost;
  if (post.availability !== 'available' || !post.body) return null;
  let count = 0;
  let language: string | null = null;
  let spoiler = false;
  const visit = (node: DocumentNode, depth: number): boolean => {
    if (++count > REVIEW_CONTEXT_LIMITS.nodes || depth > REVIEW_CONTEXT_LIMITS.depth) return false;
    if (typeof node.attrs?.lang === 'string' && !language) {
      if (node.attrs.lang.length > 64) return false;
      language = node.attrs.lang;
    }
    if (node.marks?.some((mark) => mark.type === 'spoiler')) spoiler = true;
    for (const child of node.content ?? []) if (!visit(child, depth + 1)) return false;
    return true;
  };
  return visit(post.body.doc, 0) ? { language, spoiler } : null;
}

function matches(row: NativeRow, hit: ReviewHit): boolean {
  const summary = hit.summary.value;
  return (
    row.id === hit.key.id &&
    row.sourceVersion === summary.source?.sourceVersion &&
    row.revisionId === summary.source.openingRevisionId &&
    row.title === summary.title &&
    (row.excerpt ?? '') === (summary.excerpt ?? '')
  );
}

function witness(thread: ThreadView) {
  const post = thread.firstPost;
  return JSON.stringify({
    id: thread.id,
    route: thread.route,
    kind: thread.kind,
    board: thread.boardId,
    security: thread.securityRevision,
    subjects: thread.subjectIds,
    title: thread.title,
    author: thread.authorId,
    post: post.id,
    availability: post.availability,
    revision: 'revisionId' in post ? post.revisionId : null,
    securityRevision: 'securityRevision' in post ? post.securityRevision : null,
    sha256: post.sha256,
    citation: 'voteCitation' in post ? post.voteCitation : null,
    citationDisclosure: readCitationDisclosure(thread),
  });
}

/** Selected page only. Native Content retains all lifecycle/count/cursor authority;
 * this projection has no SQL, current-vote read, refill, command, or browser work. */
export async function prepareSearchReviewContexts(
  dependencies: Dependencies,
  page: DiscoveryPage,
  context: DiscoveryReadContext,
): Promise<Readonly<{ finish(page: DiscoveryPage): Promise<DiscoveryPage> }>> {
  const reviews = page.hits.filter(isReview);
  if (reviews.length > REVIEW_CONTEXT_LIMITS.selected) throw new RangeError('At most 100 selected Search reviews');
  if (!reviews.length) return { finish: async (current) => current };
  const publicContext: ReadContext = { actor: { kind: 'anonymous' }, deadline: context.deadline };
  const source = createReviewDiscoverySource(dependencies, () => publicContext);
  const ids = reviews.map((hit) => hit.key.id);
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Invalid Search review identity');
    const partition = partitionOf(route);
    groups.set(partition, [...(groups.get(partition) ?? []), id]);
  }
  async function native() {
    const result = new Map<string, NativeRow>();
    for (const [partition, keys] of groups) {
      for (const row of (await source.hydrate(partition, keys)).reviews) result.set(row.id, row);
    }
    return result;
  }
  async function threads() {
    const rows = await discloseThreads(dependencies, ids, publicContext);
    return new Map(rows.flatMap(({ value }) => (value ? [[value.id, value] as const] : [])));
  }
  const initial = await native();
  const selected = await threads();
  for (const hit of reviews) {
    const row = initial.get(hit.key.id);
    const thread = selected.get(hit.key.id);
    if (
      !row ||
      !matches(row, hit) ||
      !thread ||
      thread.kind !== 'review' ||
      thread.firstPost.availability !== 'available' ||
      !('revisionId' in thread.firstPost) ||
      thread.firstPost.revisionId !== row.revisionId ||
      thread.subjectIds.length !== 1 ||
      thread.subjectIds[0] !== row.subjectId ||
      thread.authorId !== row.authorId ||
      thread.firstPost.subjectIds.length !== 1 ||
      thread.firstPost.subjectIds[0] !== row.subjectId ||
      thread.firstPost.authorId !== row.authorId
    )
      throw restart();
  }
  const targets = [...new Set([...initial.values()].map((row) => row.subjectId))];
  const semantic: SubjectSummaryObservation = await readSubjectSummaryObservation(
    { ...dependencies, actor: publicContext.actor, deadline: context.deadline },
    targets,
    { languages: context.languages ?? ['en'] },
  );
  let finished = false;
  return {
    async finish(currentPage) {
      if (finished) throw new TypeError('Search review context finish only once');
      finished = true;
      // Account presentation is public and never inherited from the Search viewer.
      const authorIds = [...new Set([...initial.values()].map((row) => row.authorId))];
      const readAuthors = async () => {
        const summaries = await readAccountDiscoverySummaries(
          { ...dependencies, actor: publicContext.actor, deadline: context.deadline },
          authorIds,
          { languages: context.languages ?? ['en'] },
        );
        return new Map(
          [...summaries].map(
            ([id, author]) => [id, author ? { displayName: author.displayName, handle: author.handle } : null] as const,
          ),
        );
      };
      const accounts = await readAuthors();
      const confirmed = await native();
      const finalThreads = await threads();
      if (!(await semantic.current())) throw restart();
      // Account deletion or presentation movement during the final foreign reads
      // invalidates both attribution and any citation that depends on that author.
      if (JSON.stringify([...accounts]) !== JSON.stringify([...(await readAuthors())])) throw restart();
      const values = new Map<string, PublicReviewDiscoverySummary>();
      let bytes = 0;
      for (const hit of reviews) {
        const id = hit.key.id;
        const row = confirmed.get(id);
        const thread = finalThreads.get(id);
        if (!row || !matches(row, hit) || !thread || witness(thread) !== witness(selected.get(id)!)) throw restart();
        const post = thread.firstPost;
        const author = accounts.get(row.authorId);
        const subject = semantic.summaries.get(row.subjectId);
        const target = subject ? boundedSubject(subject) : null;
        const recorded = 'voteCitation' in post ? post.voteCitation : null;
        const citation: SearchReviewCitation =
          !target || !author || readCitationDisclosure(thread) === 'withheld'
            ? { state: 'withheld' }
            : post.availability === 'erased'
              ? { state: 'erased' }
              : post.availability !== 'available'
                ? { state: 'withheld' }
                : recorded
                  ? { state: 'available', recorded: { ...recorded }, historicalQuestion: { state: 'unavailable' } }
                  : { state: 'absent' };
        const display = presentation(thread);
        const searchContext: SearchReviewContext = {
          state: 'available',
          openingPostId: post.id,
          target: target ? { state: 'available', subject: target } : { state: subject ? 'unavailable' : 'withheld' },
          citation,
          language: display?.language ?? null,
          spoiler: display?.spoiler ?? true,
        };
        const { subject: _oldTarget, author: _oldAuthor, excerpt: _oldExcerpt, ...base } = hit.summary.value;
        const value: PublicReviewDiscoverySummary = {
          ...base,
          searchContext,
          ...(author ? { author: { displayName: author.displayName, handle: author.handle } } : {}),
          ...(display && row.excerpt ? { excerpt: row.excerpt } : {}),
        };
        // Native variable fields have been admitted before these serialization copies.
        const size = Buffer.byteLength(JSON.stringify(searchContext));
        if (size > REVIEW_CONTEXT_LIMITS.rowBytes || (bytes += size) > REVIEW_CONTEXT_LIMITS.pageBytes) {
          const { excerpt: _excerpt, ...bounded } = value;
          values.set(id, { ...bounded, searchContext: { state: 'unavailable' } });
          continue;
        }
        values.set(id, value);
      }
      requireAccessDeadline(context.deadline);
      return {
        ...currentPage,
        hits: currentPage.hits.map((hit) =>
          isReview(hit) ? { ...hit, summary: { kind: 'review' as const, value: values.get(hit.key.id)! } } : hit,
        ),
      };
    },
  };
}
