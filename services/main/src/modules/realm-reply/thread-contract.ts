import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName, readPosition, readUuid } from '../work/read-contract.ts';
import { DISCUSSION_TITLE_CHARS } from './discussion-text.ts';
import { documentSnapshotSchema } from '../../api-document.ts';

/**
 * Bounds of the Realm thread reads. Best and Top seek at most pageSize+1
 * maintained order rows; New seeks by placement order. `cohort` is a legacy
 * admission batch bound, never the ranked population. A
 * thread read returns at most `replies` replies below its focus, `depth`
 * levels deep, and `ancestors` parents above it; `complete: false` says more
 * exist. Reply counts walk at most `countPerThread` replies per listed thread.
 */
export const REALM_THREAD_COST = { pageSize: 20, cohort: 256, replies: 191, depth: 32, ancestors: 32,
  countPerThread: 64, excerptChars: 400, bodyChars: 20_000, contentBatch: 64, responseBytes: 4 * 1024 * 1024 } as const;

export const threadSort = t.Union([t.Literal('best'), t.Literal('new'), t.Literal('top')]);
export const threadWindow = t.Union([t.Literal('week'), t.Literal('month'), t.Literal('all')]);

/** A reply's author; null when their profile is not public, so the reply shows without a name. */
const threadAuthor = t.Nullable(t.Object({ id: readId, name: t.String(), handle: t.Nullable(t.String()) }));
/** Net score and the reader's vote, from Home's projection. `open` is false where it takes no vote. */
const threadVote = t.Object({ score: t.Integer(), value: t.Union([t.Literal(-1), t.Literal(0), t.Literal(1)]),
  revision: t.Nullable(readUuid), open: t.Boolean() });
const count = t.Object({ value: t.Integer({ minimum: 0 }),
  kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) });

/** The public Work a thread is about, as every card names it. */
const threadWork = t.Object({ id: readId, title: readName, cover: readAvatar });

/**
 * One discussion in a Realm's list: its title (the author's first line, see
 * `discussion-text.ts`), the words after it, the Work it is about and how it is doing.
 */
export const realmThreadSummary = t.Object({ reply: readId, placement: readId,
  work: threadWork, author: threadAuthor,
  time: t.String(), language: t.Nullable(t.String()),
  title: t.String({ maxLength: DISCUSSION_TITLE_CHARS + 1 }),
  excerpt: t.String({ maxLength: REALM_THREAD_COST.excerptChars }),
  /** From the exact revision already read. Omitted when that revision never declared one; `false` is a cleared declaration. */
  spoiler: t.Optional(t.Boolean()),
  vote: threadVote, replies: count });
export const realmThreadsQuery = t.Object({ sort: t.Optional(threadSort), window: t.Optional(threadWindow),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: REALM_THREAD_COST.pageSize })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  language: t.Optional(t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 })),
  actingSubject: t.Optional(readId) }, { additionalProperties: false });
export const realmThreadsPage = t.Object({ profile: t.Literal('realm-threads-v1'), realm: readId,
  sort: threadSort, window: threadWindow,
  items: t.Array(realmThreadSummary, { maxItems: REALM_THREAD_COST.pageSize }), ...pageFields });

/**
 * One reply in a thread. `parent` is null only for the discussion that opens
 * it, which alone has a `title`: its first line, which `body` then leaves out.
 */
export const realmThreadReply = t.Object({ reply: readId, placement: readId, parent: t.Nullable(readId),
  author: threadAuthor, time: t.String(), language: t.Nullable(t.String()), revisionId: readUuid,
  title: t.Nullable(t.String({ maxLength: DISCUSSION_TITLE_CHARS + 1 })),
  body: t.String({ maxLength: REALM_THREAD_COST.bodyChars }),
  /** From the exact revision already read. Omitted when that revision never declared one; `false` is a cleared declaration. */
  spoiler: t.Optional(t.Boolean()),
  /** Complete snapshot, including the root heading; renderers may omit it when already shown as title. */
  document: t.Optional(documentSnapshotSchema),
  /** The reader blocked this author; the body and author are withheld from this read. */
  blocked: t.Optional(t.Boolean()), vote: threadVote });
export const realmThreadQuery = t.Object({ sort: t.Optional(threadSort),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  language: t.Optional(realmThreadsQuery.properties.language),
  actingSubject: t.Optional(readId) }, { additionalProperties: false });
/** Sibling cursors seek under `reply`; branch/ancestor reads use `reply` as their new focus. */
export const realmThreadContinuation = t.Union([
  t.Object({ kind: t.Literal('siblings'), reply: readId, cursor: t.String({ maxLength: 2048 }) }),
  t.Object({ kind: t.Union([t.Literal('depth'), t.Literal('ancestors')]), reply: readId }),
]);
/**
 * A reply and everything under it, as one Realm shows it. `items` start with
 * the focus and follow each reply with its replies in `sort` order, the order
 * people read them in. `ancestors` are the visible parents above the focus,
 * the opening discussion first; `thread` is that discussion. Replying needs
 * `work` and `rootRevision`, which every reply in the thread shares.
 */
export const realmThread = t.Object({ profile: t.Literal('realm-thread-v1'), realm: readId, thread: readId,
  focus: readId, sort: threadSort, work: threadWork, rootRevision: readId,
  ancestors: t.Array(realmThreadReply, { maxItems: REALM_THREAD_COST.ancestors }),
  items: t.Array(realmThreadReply, { maxItems: REALM_THREAD_COST.replies + 1 }),
  continuations: t.Array(realmThreadContinuation, { maxItems: REALM_THREAD_COST.replies + 2 }),
  complete: t.Boolean(), sourcePosition: readPosition });
