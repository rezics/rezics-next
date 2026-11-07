import { t } from 'elysia';
import type { DocumentSnapshot } from '@rezics/document';
import type { ReadingPagePost } from './contract/index.ts';
import type { Pool } from 'pg';
import { routeOf } from '../route/route.ts';
import type { PostEntry } from './reads.ts';
import { selectReadingPageMentions as selectMentions } from './application/index.ts';
import { readingPageCapabilities } from './adapters/reading-page-bind.ts';
export {
  currentReadingPageMentions,
  readingPageMentionIdentityViews,
  unavailableReadingPageMentions,
} from './application/index.ts';
export type {
  ReadingPageMentions,
  ReadingPageMentionSource as SelectedReadingPageMentionSource,
  SelectedReadingPageMentionInventory,
} from './contract/index.ts';

const closed = { additionalProperties: false } as const;
const mentionId = t.String({ format: 'uuid' });

const ReadingPageMentionSourceSchema = t.Object(
  {
    postId: mentionId,
    threadId: mentionId,
    revisionId: mentionId,
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
    pageIndex: t.Integer({ minimum: 0, maximum: 20 }),
    references: t.Array(mentionId, { maxItems: 100 }),
    overflow: t.Boolean(),
  },
  closed,
);

const ReadingPageMentionIdentitySchema = t.Union([
  t.Object(
    { id: mentionId, state: t.Literal('active'), handle: t.Union([t.String({ maxLength: 64 }), t.Null()]) },
    closed,
  ),
  t.Object({ id: mentionId, state: t.Literal('concealed') }, closed),
  t.Object({ id: mentionId, state: t.Literal('erased') }, closed),
]);

export const ReadingPageMentionsSchema = t.Object(
  {
    state: t.Union([t.Literal('current'), t.Literal('unavailable')]),
    retryable: t.Boolean(),
    overflow: t.Boolean(),
    sources: t.Array(ReadingPageMentionSourceSchema, { maxItems: 21 }),
    identities: t.Array(ReadingPageMentionIdentitySchema, { maxItems: 100 }),
  },
  closed,
);

export function selectReadingPageMentions(posts: readonly ReadingPageMentionPost[]) {
  return selectMentions(posts, (id) => routeOf(id) !== null);
}
/** Older direct consumers may omit a deadline; page composition always forwards its original budget. */
export function readReadingPageMentions(pool: Pool, posts: readonly PostEntry[], deadline?: number) {
  return readingPageCapabilities().readMentions(pool, selectReadingPageMentions(posts), deadline);
}

export type ReadingPageMentionPost = Omit<ReadingPagePost, 'body' | 'mediaIds'> &
  Readonly<{ body: DocumentSnapshot | null }>;
