import { t } from 'elysia';
import { pageFields, pageQuery, readId, readLanguage, readUuid } from '../work/read-contract.ts';

export const REVIEW_COST = { pageSize: 20, quoteSize: 12, textChars: 8000,
  excerptChars: 240, eventBatch: 100, responseBytes: 220_000 } as const;
export const reviewCommand = t.Object({ profile: t.Literal('reader-review-command-v1'),
  actingSubject: readId, context: readId, target: readId,
  expectedRevision: t.Nullable(readUuid), language: readLanguage,
  text: t.String({ minLength: 1, maxLength: REVIEW_COST.textChars }), spoiler: t.Boolean() },
{ additionalProperties: false });
export const reviewDelete = t.Object({ profile: t.Literal('reader-review-delete-v1'),
  actingSubject: readId, expectedRevision: readUuid }, { additionalProperties: false });
export const helpfulCommand = t.Object({ profile: t.Literal('reader-review-helpful-v1'),
  actingSubject: readId, helpful: t.Boolean(), expectedRevision: t.Nullable(readUuid) },
{ additionalProperties: false });
export const reviewItem = t.Object({ id: readUuid, work: readId, context: readId,
  realm: t.Nullable(readId), author: readId, rating: t.Integer({ minimum: 1, maximum: 10 }),
  ratingObservation: readId, ratingRevision: readId, language: readLanguage,
  text: t.Nullable(t.String({ maxLength: REVIEW_COST.textChars })), spoiler: t.Boolean(),
  spoilerWithheld: t.Boolean(), startedOn: t.Nullable(t.String({ format: 'date' })),
  finishedOn: t.Nullable(t.String({ format: 'date' })), helpfulCount: t.Integer({ minimum: 0 }),
  viewerHelpful: t.Boolean(), viewerVoteRevision: t.Nullable(readUuid),
  revision: readUuid, createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }) });
export const reviewResult = t.Object({ profile: t.Literal('reader-review-receipt-v1'),
  review: readUuid, revision: readUuid, deleted: t.Boolean(), replayed: t.Boolean() });
export const helpfulResult = t.Object({ profile: t.Literal('reader-review-helpful-receipt-v1'),
  review: readUuid, revision: readUuid, helpful: t.Boolean(), helpfulCount: t.Integer({ minimum: 0 }),
  replayed: t.Boolean() });
export const reviewQuery = t.Object({ ...pageQuery, context: readId,
  sort: t.Optional(t.Union([t.Literal('new'), t.Literal('helpful')])),
  rating: t.Optional(t.Integer({ minimum: 1, maximum: 10 })),
  showSpoilers: t.Optional(t.Boolean()) }, { additionalProperties: false });
export const reviewPage = t.Object({ profile: t.Literal('reader-review-page-v1'),
  items: t.Array(reviewItem, { maxItems: REVIEW_COST.pageSize }), ...pageFields });
export const quote = t.Object({ review: readUuid, work: readId, context: readId,
  author: readId, rating: t.Integer({ minimum: 1, maximum: 10 }),
  language: readLanguage, excerpt: t.String({ maxLength: REVIEW_COST.excerptChars }) });
export const quotePage = t.Object({ profile: t.Literal('realm-reader-quotes-v1'),
  realm: readId, items: t.Array(quote, { maxItems: REVIEW_COST.quoteSize }),
  sourcePosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }) });
