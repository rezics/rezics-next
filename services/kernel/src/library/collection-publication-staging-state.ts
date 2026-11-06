/** Confidential, bounded progress only. None of these values admits a Source or certifies a query. */
import { isDeepStrictEqual } from 'node:util';
import { ProblemError } from '../http/problem.ts';
import type { CanonicalCollectionPrefix } from './collection-source.ts';
import type { ScopeEvaluationProgress, SearchScopeEvaluation } from '../search/scope-source.ts';

export type CollectionPublicationFrontier = Readonly<{
  after: string | null;
  pending: Readonly<{
    subject: string;
    coveredThrough: string;
    lastInPage: boolean;
    sourceExhausted: boolean;
    progress: ScopeEvaluationProgress | null;
  }> | null;
  exhausted: boolean;
}>;

export const initialCollectionPublicationFrontier = (): CollectionPublicationFrontier => ({
  after: null,
  pending: null,
  exhausted: false,
});
const unavailable = () => new ProblemError('dependency_unavailable');
const uuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

/** Matching catalogue subjects are already the admitted population; Search applied the predicate. */
export function enterCataloguePublicationMembers(
  frontier: CollectionPublicationFrontier,
  subjects: readonly string[],
  exhausted: boolean,
): CollectionPublicationFrontier {
  if (frontier.pending || frontier.exhausted) throw unavailable();
  let previous = frontier.after;
  for (const subject of subjects) {
    if (!uuid(subject) || (previous !== null && subject <= previous)) throw unavailable();
    previous = subject;
  }
  const candidate = subjects[0];
  if (!candidate) {
    if (!exhausted) throw unavailable();
    return { after: frontier.after, pending: null, exhausted: true };
  }
  return {
    after: frontier.after,
    exhausted: false,
    pending: {
      subject: candidate,
      coveredThrough: subjects.at(-1)!,
      lastInPage: subjects.length === 1,
      sourceExhausted: exhausted,
      progress: null,
    },
  };
}

/** Consume a genuine unfiltered canonical Source prefix. Unused suffix/lookahead is charged but not settled.
 * A later step seeks again after the last settled key; no population array is retained in a work intent.
 */
export function enterCollectionPublicationPrefix(
  frontier: CollectionPublicationFrontier,
  page: CanonicalCollectionPrefix,
): CollectionPublicationFrontier {
  if (frontier.pending || frontier.exhausted || page.kind !== 'canonical_subject_prefix') throw unavailable();
  let previous = frontier.after;
  for (const candidate of page.candidates) {
    if (!uuid(candidate.subjectId) || (previous !== null && candidate.subjectId <= previous)) throw unavailable();
    previous = candidate.subjectId;
  }
  if (
    (page.coveredThrough !== null && !uuid(page.coveredThrough)) ||
    (previous !== null && (page.coveredThrough === null || page.coveredThrough < previous)) ||
    (!page.exhausted && (page.coveredThrough === null || page.coveredThrough === frontier.after))
  )
    throw unavailable();
  const candidate = page.candidates[0];
  if (!candidate) return { after: page.coveredThrough ?? frontier.after, pending: null, exhausted: page.exhausted };
  if (page.coveredThrough === null) throw unavailable();
  return {
    after: frontier.after,
    exhausted: false,
    pending: {
      subject: candidate.subjectId,
      coveredThrough: page.coveredThrough,
      lastInPage: page.candidates.length === 1,
      sourceExhausted: page.exhausted,
      progress: null,
    },
  };
}

/** All leaves, including negative/excluded leaves, must settle before the canonical key can advance.
 * Native raw exhaustion is deliberately held on the unfinished subject rather than promoted to query exhaustion.
 */
export function settleCollectionPublicationSubject(
  frontier: CollectionPublicationFrontier,
  evaluation: SearchScopeEvaluation,
): Readonly<{ frontier: CollectionPublicationFrontier; included: boolean | null }> {
  const pending = frontier.pending;
  if (!pending || frontier.exhausted || evaluation.values.length !== 1) throw unavailable();
  const match = evaluation.values[0];
  if (match === 'not_proven') {
    if (
      !evaluation.progress ||
      evaluation.progress.subject !== pending.subject ||
      isDeepStrictEqual(evaluation.progress, pending.progress)
    )
      throw unavailable();
    return { frontier: { ...frontier, pending: { ...pending, progress: evaluation.progress } }, included: null };
  }
  if (typeof match !== 'boolean' || evaluation.progress !== null) throw unavailable();
  return {
    included: match,
    frontier: {
      after: pending.lastInPage ? pending.coveredThrough : pending.subject,
      pending: null,
      exhausted: pending.lastInPage && pending.sourceExhausted,
    },
  };
}
