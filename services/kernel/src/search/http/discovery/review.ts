import {
  ReviewContextSourceSchema,
  SearchReviewContextSchema,
  validReviewContextBinding,
} from '../../review-context-schemas.ts';
import type { Static } from 'typebox';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { MatchEvidenceSchema } from '../../http/match-evidence-schema.ts';
import { closed, id, nullableText, key, unavailable, evidenceOrDefault, admitIdentity } from './primitives.ts';
const reviewKey = t.Object(
  { owner: t.Literal('content'), kind: t.Literal('review'), route: t.Integer({ minimum: 0, maximum: 65535 }), id },
  closed,
);
const reviewAuthor = t.Object({ displayName: nullableText, handle: nullableText }, closed);
const reviewSubject = t.Object({ id, title: nullableText }, closed);
const reviewSummary = t.Object(
  {
    id,
    kind: t.Literal('review'),
    title: nullableText,
    author: t.Optional(reviewAuthor),
    excerpt: t.Optional(t.String({ maxLength: 640 })),
    subject: t.Optional(t.Union([reviewSubject, t.Null()])),
    source: t.Optional(ReviewContextSourceSchema),
    searchContext: t.Optional(SearchReviewContextSchema),
  },
  closed,
);
export const ReviewHitSchema = t.Object(
  {
    key: reviewKey,
    summary: t.Object({ kind: t.Literal('review'), value: reviewSummary }, closed),
    matchEvidence: MatchEvidenceSchema,
  },
  closed,
);

export type ReviewHttpHit = Static<typeof ReviewHitSchema>;
type ReviewHit = Extract<DiscoveryUnionHit, { summary: { kind: 'review' } }>;
const check = Compile(ReviewHitSchema);

export function admitReviewHit(value: unknown): asserts value is ReviewHit {
  const admitted = evidenceOrDefault(value);
  if (!check.Check(admitted)) unavailable();
  const hit = admitted as ReviewHttpHit;
  admitIdentity(hit);
  const { key, summary, matchEvidence } = hit;
  if (
    summary.kind === 'review' &&
    (key.owner !== 'content' || key.kind !== 'review' || !validReviewContextBinding(summary.value))
  )
    unavailable();
  if (matchEvidence.state !== 'unsupported') unavailable();
}

/** Detach all nested native values; later owner mutation cannot change the admitted response. */
export function serializeReviewHit(hit: ReviewHit): ReviewHttpHit {
  return structuredClone(evidenceOrDefault(hit)) as ReviewHttpHit;
}
