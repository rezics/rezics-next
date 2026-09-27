import { t } from 'elysia';
import type { Static } from 'typebox';
import { pageFields, pageQuery, readAvatar, readId, readLanguage, readName, readUuid } from '../work/read-contract.ts';

export const feedKind = t.Union([t.Literal('work'), t.Literal('contribution'), t.Literal('adoption'),
  t.Literal('decision'), t.Literal('discussion'), t.Literal('reply'), t.Literal('collection')]);
export type FeedKind = Static<typeof feedKind>;
export const feedSort = t.Union([t.Literal('best'), t.Literal('new'), t.Literal('top')]);
export const feedWindow = t.Union([t.Literal('week'), t.Literal('month'), t.Literal('all')]);
export const feedReason = t.Union([
  t.Object({ kind: t.Literal('followed'), target: readId,
    targetKind: t.Union([t.Literal('realm'), t.Literal('zone'), t.Literal('work'), t.Literal('agent')]) }),
  t.Object({ kind: t.Literal('recommended'), basis: t.Union([t.Literal('all'), t.Literal('thin-following')]) }),
  t.Object({ kind: t.Literal('trending-in-realm'), realm: readId }),
  t.Object({ kind: t.Literal('editorial'), selection: readId }),
]);
const actor = t.Object({ id: readId, name: t.String(), handle: t.String() });
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
]);
export const feedAction = t.Union([
  t.Object({ kind: t.Literal('read-chapter'), work: readId, occurrence: readId, href: t.String() }),
  t.Object({ kind: t.Literal('next-unread'), work: readId, occurrence: readId, href: t.String() }),
  t.Object({ kind: t.Literal('install'), work: readId, revision: t.String(), href: t.String(),
    compatibilityTargets: t.Array(t.Object({ ecosystem: t.String(), selector: t.String(), target: t.Record(t.String(), t.Unknown()) }), { maxItems: 256 }) }),
  t.Object({ kind: t.Literal('copy-prompt'), work: readId, revision: t.String(), href: t.String() }),
  t.Object({ kind: t.Literal('want-to-read'), work: readId }),
  t.Object({ kind: t.Literal('open'), href: t.String() }),
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
  kinds: t.Optional(t.Array(feedKind, { minItems: 1, maxItems: 7, uniqueItems: true })),
  contentLanguages: t.Optional(t.Array(readLanguage, { minItems: 1, maxItems: 8, uniqueItems: true })),
  realms: t.Optional(t.Array(readId, { minItems: 1, maxItems: 8, uniqueItems: true })),
  tags: t.Optional(t.Array(readId, { minItems: 1, maxItems: 3, uniqueItems: true })),
}, { additionalProperties: false });
export type FeedQuery = Static<typeof feedQuery>;
export const feedItem = t.Object({ id: readId, kind: feedKind,
  actor, reason: feedReason, card: feedCard, primaryAction: feedAction, viewerState: feedViewerState,
  group: t.Object({ key: t.String(), count: t.Integer({ minimum: 1, maximum: 4 }),
    actors: t.Array(actor, { minItems: 1, maxItems: 3 }),
    range: t.Optional(t.Object({ kind: t.Literal('chapters'), from: t.Integer(), to: t.Integer() })) }),
  target: t.Object({ id: readId, work: t.Nullable(readId), title: readName, cover: readAvatar,
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
  projection: t.Object({ sequence: t.String(), status: t.Union([t.Literal('current'), t.Literal('catching-up')]) }) });
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
 * No offset or unbounded count. Refresh admits 20 references after the relay
 * cut; native graph scan/sort cost is bounded by the shared 160-call/4MiB/10s
 * envelope, not claimed to be a PostgreSQL seek. Cards cap responses at 256KiB. */
export const FEED_COST = { pageSize: 20, candidates: 8, tagCandidates: 2, refreshItems: 20, groupMembers: 4,
  commentProbe: 64, intervalMs: 1000, responseBytes: 256 * 1024 } as const;
