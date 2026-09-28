import { t } from 'elysia';
import type { Static } from 'typebox';
import { shelfWork } from '../profiles/read-contract.ts';
import { pageFields, pageQuery, readAvatar, readId, readName, readUuid } from '../work/read-contract.ts';

/**
 * What a follow names. Following a `concept` follows its one-Condition Filter
 * (`conceptFilter`): Works whose accepted values include the Concept.
 */
export const followKind = t.Union([t.Literal('realm'), t.Literal('zone'), t.Literal('work'), t.Literal('agent'),
  t.Literal('external-author'), t.Literal('concept')]);
export type FollowKind = Static<typeof followKind>;
/**
 * An author a catalogue lists but REZICS has no Agent for, keyed by provider
 * and key: `open-library:OL21594A`. Every other kind is a REZICS IRI.
 */
export const externalAuthorTarget = t.String({ pattern: '^open-library:OL[1-9][0-9]{0,11}A$' });
export const followTargetId = t.Union([readId, externalAuthorTarget]);
const EXTERNAL_AUTHOR = /^open-library:(OL[1-9][0-9]{0,11}A)$/;
/** The Open Library key (`/authors/OL21594A`) an external-author target names, or null. */
export function externalAuthorKey(target: string): string | null {
  const id = EXTERNAL_AUTHOR.exec(target)?.[1];
  return id ? `/authors/${id}` : null;
}
/** The follow target for an Open Library author key (`/authors/OL21594A`). */
export const externalAuthorFollow = (key: string) => `open-library:${key.slice('/authors/'.length)}`;
/** Only an external author has a keyed target; the store and a CHECK both hold this. */
export const followTargetMatches = (target: string, kind: FollowKind) =>
  (kind === 'external-author') === (externalAuthorKey(target) !== null);
/** Kinds a reader sees as authors: a REZICS Agent or an author a catalogue lists. */
export const AUTHOR_FOLLOW_KINDS = ['agent', 'external-author'] as const satisfies readonly FollowKind[];
export const followCommand = t.Object({ profile: t.Literal('follow-command-v1'),
  target: followTargetId, kind: followKind, actingSubject: readId, following: t.Boolean(),
  expectedRevision: t.Nullable(readUuid) }, { additionalProperties: false });
export type FollowCommand = Static<typeof followCommand>;
export const followResult = t.Object({ profile: t.Literal('follow-receipt-v1'), target: followTargetId,
  kind: followKind, actingSubject: readId, following: t.Boolean(), revision: readUuid, replayed: t.Boolean() });
export type FollowResult = Static<typeof followResult>;
export const batchFollowCommand = t.Object({ profile: t.Literal('follow-batch-v1'), actingSubject: readId,
  targets: t.Array(t.Object({ target: followTargetId, kind: followKind }, { additionalProperties: false }),
    { minItems: 1, maxItems: 20 }) }, { additionalProperties: false });
export type BatchFollowCommand = Static<typeof batchFollowCommand>;
export const batchFollowResult = t.Object({ profile: t.Literal('follow-batch-receipt-v1'),
  actingSubject: readId, items: t.Array(t.Object({ target: followTargetId, kind: followKind,
    following: t.Literal(true), revision: readUuid }), { maxItems: 20 }), replayed: t.Boolean() });
export type BatchFollowResult = Static<typeof batchFollowResult>;
export const followTarget = t.Object({ id: followTargetId, kind: followKind, name: readName,
  icon: readAvatar, realm: t.Nullable(readId), href: t.String() });
export const followsQuery = t.Object({ ...pageQuery, actingSubject: readId,
  kind: t.Optional(followKind), include: t.Optional(t.Literal('newSince')) }, { additionalProperties: false });
const newSince = t.Object({ state: t.Union([t.Literal('unvisited'), t.Literal('new'), t.Literal('none'),
  t.Literal('more-unverified'), t.Literal('projecting')]),
  count: t.Nullable(t.Object({ value: t.Integer({ minimum: 0 }),
    kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) })),
  updatedAt: t.Nullable(t.String()) });
export const followsPage = t.Object({ profile: t.Literal('follows-v1'),
  items: t.Array(t.Union([
    t.Object({ ...followTarget.properties, available: t.Literal(true), revision: readUuid,
      newSince: t.Optional(newSince) }),
    t.Object({ id: followTargetId, kind: followKind, available: t.Literal(false), revision: readUuid,
      name: t.Null(), icon: t.Null(), realm: t.Null(), href: t.Null() }),
  ]), { maxItems: 20 }), ...pageFields });
export const authorFollowKind = t.Union([t.Literal('agent'), t.Literal('external-author')]);
export const followedAuthorsQuery = t.Object({ ...pageQuery, actingSubject: readId }, { additionalProperties: false });
/**
 * The authors a reader follows, REZICS Agents and Open Library authors alike,
 * each with their newest public Work on REZICS (null when they have none). An
 * author who is no longer public stays listed, unnamed, so it can be unfollowed.
 */
export const followedAuthorsPage = t.Object({ profile: t.Literal('followed-authors-v1'),
  items: t.Array(t.Union([
    t.Object({ ...followTarget.properties, kind: authorFollowKind, available: t.Literal(true), revision: readUuid,
      newestWork: t.Nullable(shelfWork) }),
    t.Object({ id: followTargetId, kind: authorFollowKind, available: t.Literal(false), revision: readUuid,
      name: t.Null(), icon: t.Null(), realm: t.Null(), href: t.Null(), newestWork: t.Null() }),
  ]), { maxItems: 8 }), ...pageFields });
export const followState = t.Object({ profile: t.Literal('follow-state-v1'), target: followTarget,
  following: t.Nullable(t.Boolean()), revision: t.Nullable(readUuid),
  followers: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }) });

/** Indexed private seek: P+1 rows, at most P public hydrations; count reads at
 * most 1001 rows. Writes lock one principal inventory, one relationship and
 * original person-Agent control proof. No follower identities are public.
 * A feed card matches at most seven identities: its Realm, Zone, Work and
 * actor, and the three authors it credits. */
export const FOLLOWS_COST = { pageSize: 20, candidates: 8, maximumFollowing: 1000, countProbe: 1001,
  matchCards: 20, matchIdentities: 7 } as const;
