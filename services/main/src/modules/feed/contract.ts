import { t } from 'elysia';
import type { Static } from 'typebox';
import { pageFields, pageQuery, readAvatar, readId, readLanguage, readName, readUuid } from '../work/read-contract.ts';
import { discoveryCredit } from '../discovery/contract.ts';
import { followKind, followTargetId } from '../follows/contract.ts';
import { readingLanguages } from '../preferences/languages.ts';

export const feedKind = t.Union([t.Literal('work'), t.Literal('added'), t.Literal('contribution'), t.Literal('adoption'),
  t.Literal('decision'), t.Literal('discussion'), t.Literal('reply'), t.Literal('collection'), t.Literal('review')]);
export type FeedKind = Static<typeof feedKind>;
export const feedSort = t.Union([t.Literal('best'), t.Literal('new'), t.Literal('top')]);
export const feedWindow = t.Union([t.Literal('week'), t.Literal('month'), t.Literal('all')]);
export const feedReason = t.Union([
  /**
   * The first follow the card answers to, in Following and All alike: an
   * author's news to its credited authors, then any card to its poster before
   * its Realm, except a Realm's own act (see `followIdentities`).
   */
  t.Object({ kind: t.Literal('followed'), target: followTargetId, targetKind: followKind }),
  t.Object({ kind: t.Literal('recommended'), basis: t.Union([t.Literal('all'), t.Literal('thin-following')]) }),
  t.Object({ kind: t.Literal('trending-in-realm'), realm: readId }),
  t.Object({ kind: t.Literal('editorial'), selection: readId }),
]);
const actor = t.Object({ id: readId, name: t.String(), handle: t.String() });
export const feedActivityReason = t.Union([
  t.Object({ kind: t.Literal('new-work'), actor: readId }),
  t.Object({ kind: t.Literal('added-to-rezics'), actor: readId }),
  t.Object({ kind: t.Literal('realm-pick'), realm: readId, curator: readId }),
]);
export const feedCard = t.Union([
  t.Object({ kind: t.Literal('work') }),
  t.Object({ kind: t.Literal('chapter'), occurrence: readId, parent: readId, number: t.Optional(t.Integer({ minimum: 1 })),
    title: t.Optional(t.String()), wordCount: t.Optional(t.Integer({ minimum: 0 })), excerpt: t.Optional(t.String({ maxLength: 400 })) }),
  t.Object({ kind: t.Literal('release'), version: t.Optional(t.String()), level: t.Optional(t.String()),
    changelogExcerpt: t.Optional(t.String({ maxLength: 400 })) }),
  t.Object({ kind: t.Literal('recipe'), heroImage: t.Optional(readAvatar),
    totalTime: t.Optional(t.String()), servings: t.Optional(t.String()) }),
  t.Object({ kind: t.Literal('prompt'), preview: t.Optional(t.String({ maxLength: 400 })) }),
  t.Object({ kind: t.Literal('media'), durationSeconds: t.Optional(t.Number({ minimum: 0 })) }),
  t.Object({ kind: t.Literal('activity') }),
  /** A public list: how many public Works it holds and its first three, so the card shows what is in it. */
  t.Object({ kind: t.Literal('list'),
    count: t.Object({ value: t.Integer({ minimum: 0 }),
      kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }),
    works: t.Array(t.Object({ id: readId, title: readName, cover: readAvatar,
      types: t.Array(t.String(), { maxItems: 3 }) }), { maxItems: 3 }) }),
  t.Object({ kind: t.Literal('review'), review: readUuid, rating: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })),
    scale: t.Union([t.Literal(5), t.Literal(10)]), spoiler: t.Boolean(),
    helpfulCount: t.Integer({ minimum: 0 }), opening: t.Nullable(t.String({ maxLength: 400 })) }),
]);
export const feedAction = t.Union([
  t.Object({ kind: t.Literal('read-chapter'), work: readId, occurrence: readId, href: t.String() }),
  t.Object({ kind: t.Literal('next-unread'), work: readId, occurrence: readId, href: t.String() }),
  t.Object({ kind: t.Literal('install'), work: readId, revision: t.String(), href: t.String(),
    compatibilityTargets: t.Array(t.Object({ ecosystem: t.String(), selector: t.String(), target: t.Record(t.String(), t.Unknown()) }), { maxItems: 256 }) }),
  t.Object({ kind: t.Literal('copy-prompt'), work: readId, revision: t.String(), href: t.String() }),
  t.Object({ kind: t.Literal('want-to-read'), work: readId }),
  t.Object({ kind: t.Literal('open'), href: t.String() }),
  t.Object({ kind: t.Literal('read-review'), review: readUuid, href: t.String() }),
]);
/** G-285 supplies this batch seam; unavailable is distinct from an empty shelf. */
export const feedViewerState = t.Union([
  t.Object({ status: t.Literal('anonymous') }), t.Object({ status: t.Literal('unavailable') }),
  t.Object({ status: t.Literal('available'),
    nextUnread: t.Optional(t.Object({ work: readId, occurrence: readId, language: t.Optional(readLanguage) })),
    shelf: t.Nullable(t.Object({ id: readId, status: t.String() })),
    progress: t.Nullable(t.Object({ composition: readId, occurrence: readId,
      selectedRevision: t.Nullable(t.String()), completed: t.Boolean(), position: t.Nullable(t.String()) })),
    spoiler: t.Object({ policy: t.Union([t.Literal('show'), t.Literal('hide-unread')]), hidden: t.Boolean() }) }),
]);
export type FeedViewerState = Static<typeof feedViewerState>;
export const feedQuery = t.Object({ ...pageQuery,
  scope: t.Optional(t.Union([t.Literal('following'), t.Literal('all')])),
  sort: t.Optional(feedSort), window: t.Optional(feedWindow),
  kinds: t.Optional(t.Array(feedKind, { minItems: 1, maxItems: 8, uniqueItems: true })),
  /** Comma-separated human kinds. The reader rejects duplicates and unknown values. */
  interests: t.Optional(t.String({ minLength: 2, maxLength: 64 })),
  contentLanguages: t.Optional(t.Array(readingLanguages.items, { minItems: 1, maxItems: 20, uniqueItems: true })),
  realms: t.Optional(t.Array(readId, { minItems: 1, maxItems: 8, uniqueItems: true })),
  /** Concepts a Work matches any of. Together with `requiredConcept` and `excludedConcepts`, at most three. */
  concepts: t.Optional(t.Array(readId, { minItems: 1, maxItems: 3, uniqueItems: true })),
  /** A Concept the Work must carry, beside any Concept in `concepts`. */
  requiredConcept: t.Optional(readId),
  /** Concepts the Work must not carry. */
  excludedConcepts: t.Optional(t.Array(readId, { minItems: 1, maxItems: 2, uniqueItems: true })),
}, { additionalProperties: false });
export type FeedQuery = Static<typeof feedQuery>;
/**
 * The post itself, apart from the Work it is about (`target`): its own title
 * where it has one (a discussion's first line, a chapter's or a list's name,
 * a release's version), its opening words and their language. A post that is
 * the Work itself (a new Work, a pick, a prompt) has no title of its own and
 * its words are the Work's. Its type is `kind`; its author is `actor`.
 */
export const feedPost = t.Object({ title: t.Nullable(t.String({ maxLength: 301 })),
  excerpt: t.Nullable(t.String({ maxLength: 400 })), language: t.Nullable(t.String()) });
export const feedItem = t.Object({ id: readId, kind: feedKind, post: feedPost,
  actor, authors: t.Array(discoveryCredit, { maxItems: 3 }),
  reason: feedReason, reasons: t.Array(feedActivityReason, { maxItems: 8 }),
  card: feedCard, primaryAction: feedAction, viewerState: feedViewerState,
  group: t.Object({ key: t.String(), count: t.Integer({ minimum: 1, maximum: 4 }),
    actors: t.Array(actor, { minItems: 1, maxItems: 3 }),
    range: t.Optional(t.Object({ kind: t.Literal('chapters'), from: t.Integer(), to: t.Integer() })) }),
  target: t.Object({ id: readId, work: t.Nullable(readId), title: readName, cover: readAvatar,
    /** The Work's semantic types; empty when the target is not a Work. */
    types: t.Array(t.String(), { maxItems: 3 }),
    excerpt: t.Nullable(t.String({ maxLength: 400 })), language: t.Nullable(t.String()) }),
  realm: t.Nullable(t.Object({ id: readId, name: readName, icon: readAvatar })),
  time: t.String(), timeBasis: t.Union([t.Literal('revision'), t.Literal('relay')]),
  score: t.Integer(), vote: t.Union([t.Literal(-1), t.Literal(0), t.Literal(1)]),
  voteRevision: t.Nullable(readUuid),
  comments: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }),
  links: t.Object({ target: t.String(), actor: t.String(), comments: t.String(), vote: t.String() }) });
export type FeedItem = Static<typeof feedItem>;
export const feedPage = t.Object({ profile: t.Literal('home-feed-v1'),
  scope: t.Union([t.Literal('following'), t.Literal('all')]), sort: feedSort, window: feedWindow,
  ranking: t.Object({ version: t.String(), decayHours: t.Number(), candidatePool: t.Integer(),
    normalization: t.String(), signals: t.Object({ upvote: t.Number(), downvote: t.Number() }), diversityWindow: t.Integer(), realmCap: t.Integer(), thinFollowing: t.Integer() }),
  caughtUp: t.Nullable(t.Object({ asOf: t.String(), lastVisitedAt: t.Nullable(t.String()),
    state: t.Union([t.Literal('more'), t.Literal('caught-up'), t.Literal('projecting')]) })),
  items: t.Array(feedItem, { maxItems: 20 }), ...pageFields,
  projection: t.Object({ sequence: t.String(), reviewSequence: t.String(),
    status: t.Union([t.Literal('current'), t.Literal('catching-up')]) }) });
export const feedVoteCommand = t.Object({ profile: t.Literal('feed-vote-command-v1'), actingSubject: readId,
  value: t.Union([t.Literal(-1), t.Literal(0), t.Literal(1)]), expectedRevision: t.Nullable(readUuid) },
{ additionalProperties: false });
export type FeedVoteCommand = Static<typeof feedVoteCommand>;
export const feedVoteResult = t.Object({ profile: t.Literal('feed-vote-receipt-v1'), target: readId,
  value: t.Union([t.Literal(-1), t.Literal(0), t.Literal(1)]), revision: readUuid,
  score: t.Integer(), replayed: t.Boolean() });
export type FeedVoteResult = Static<typeof feedVoteResult>;

/** New/Top seek P+1 group anchors before filtering/disclosure. Best ranks a
 * 256-anchor cohort, O(K²) percentile comparisons with K fixed at 256. Sparse
 * pages continue via cursor. Hydration admits at most 8 member references,
 * including all members of a group (at most 4). Tags admit 2 groups and reuse
 * the authoritative classification result for each distinct Work/Realm.
 * Group time is creation time, not the newest member, preserving New's order.
 * Interest matching admits two reads of at most 120 rows each for eight member
 * Works, using the same current types and accepted global Senses as onboarding.
 * No offset or unbounded count. Refresh admits 20 references after the relay
 * cut; native graph scan/sort cost is bounded by the shared 160-call/4MiB/10s
 * envelope, not claimed to be a PostgreSQL seek. Review refresh seeks at most
 * 100 Access events and rechecks at most 20 current rows. Cards cap responses at 256KiB. */
export const FEED_COST = { pageSize: 20, candidates: 8, tagCandidates: 2, refreshItems: 20, groupMembers: 4,
  commentProbe: 64, intervalMs: 1000, responseBytes: 256 * 1024,
  /** A list card reads one page of its placements and names the first public Works in it. */
  listPlacements: 100, listPreview: 3 } as const;
