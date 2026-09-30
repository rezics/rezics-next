import { browserMainApi } from '../api/browser.ts';
import { followHref } from '../entity-page/href.ts';
import { failureOf } from './failure.ts';
import type { Loaded, Review, Reviewer, ReviewPage } from './types.ts';

/** The list's controls: Main's sort, and the language and rating filters. */
export interface ReviewFilter { sort: 'helpful' | 'new'; language?: string; rating?: number }

export type ReviewWrite = 'saved' | 'rate-first' | 'conflict' | 'denied' | 'failed';

/**
 * What the reviews section asks of Main, through the BFF (which carries the
 * session). Stories supply an in-memory one. Every write carries the
 * revision it saw, as Main's compare-and-set requires.
 */
export interface ReviewApi {
  page: (filter: ReviewFilter, cursor?: string) => Promise<Loaded<ReviewPage>>;
  /** One review with its spoiler text, for "Show spoilers" and a followed `#review-{id}` link. */
  one: (id: string) => Promise<Review | null>;
  reviewers: (agents: readonly string[]) => Promise<Record<string, Reviewer>>;
  write: (input: { expectedRevision: string | null; language: string; text: string; spoiler: boolean }) =>
    Promise<ReviewWrite>;
  remove: (id: string, expectedRevision: string) => Promise<boolean>;
  helpful: (id: string, helpful: boolean, expectedRevision: string | null) =>
    Promise<{ helpful: boolean; helpfulCount: number; revision: string } | null>;
}

const key = () => ({ headers: { 'idempotency-key': crypto.randomUUID() } });

/**
 * Main's reviews for one resource and rating Context, read and written as `actingSubject` when there is one.
 * The list is read from `href`, the link the resource's page projection gave, else the resource's own reviews read.
 */
export function mainReviewApi({ target, href, context, actingSubject }: {
  target: string; href?: string; context: string; actingSubject: string | null;
}): ReviewApi {
  const main = () => browserMainApi();
  const reader = actingSubject ? { actingSubject } : {};
  return {
    async page(filter, cursor) {
      try {
        const { data, error } = await followHref<ReviewPage>(main(), href ?? `/v1/resources/${target.slice(-36)}/reviews`,
          { context, sort: filter.sort, language: filter.language, rating: filter.rating, cursor, limit: 10, ...reader })();
        if (error) return { ok: false, failure: failureOf(error.status) };
        return data ? { ok: true, data } : { ok: false, failure: 'unavailable' };
      } catch {
        return { ok: false, failure: 'unavailable' };
      }
    },
    async one(id) {
      try {
        const { data } = await main().v1.reviews({ id }).get({ query: { showSpoilers: true, ...reader } });
        return data ?? null;
      } catch {
        return null;
      }
    },
    async reviewers(agents) {
      const named: Record<string, Reviewer> = {};
      await Promise.all([...new Set(agents)].map(async agent => {
        try {
          const { data } = await main().v1.agents({ id: agent.slice(-36) }).get({ query: reader });
          if (data) named[agent] = { name: data.displayName, handle: data.handle };
        } catch { /* The review then names "A reader". */ }
      }));
      return named;
    },
    async write(input) {
      if (!actingSubject) return 'denied';
      try {
        const { error } = await main().v1.reviews.post({ profile: 'reader-review-command-v1', actingSubject, context,
          target, ...input }, key());
        if (!error) return 'saved';
        // Main proves the reader's rating in this Context before it keeps a review.
        if (error.status === 404) return 'rate-first';
        if (error.status === 409) return 'conflict';
        return error.status === 403 ? 'denied' : 'failed';
      } catch {
        return 'failed';
      }
    },
    async remove(id, expectedRevision) {
      if (!actingSubject) return false;
      try {
        const { error } = await main().v1.reviews({ id }).delete({ profile: 'reader-review-delete-v1', actingSubject,
          expectedRevision }, key());
        return !error;
      } catch {
        return false;
      }
    },
    async helpful(id, helpful, expectedRevision) {
      if (!actingSubject) return null;
      try {
        const { data } = await main().v1.reviews({ id }).helpful.put({ profile: 'reader-review-helpful-v1',
          actingSubject, helpful, expectedRevision }, key());
        return data ? { helpful: data.helpful, helpfulCount: data.helpfulCount, revision: data.revision } : null;
      } catch {
        return null;
      }
    },
  };
}
