import { t } from 'elysia';
import type { Static } from 'typebox';
import { pageFields, pageQuery, readAvatar, readId, readName, readUuid } from '../work/read-contract.ts';

export const followKind = t.Union([t.Literal('realm'), t.Literal('zone'), t.Literal('work'), t.Literal('agent')]);
export type FollowKind = Static<typeof followKind>;
export const followCommand = t.Object({ profile: t.Literal('follow-command-v1'),
  target: readId, kind: followKind, actingSubject: readId, following: t.Boolean(),
  expectedRevision: t.Nullable(readUuid) }, { additionalProperties: false });
export type FollowCommand = Static<typeof followCommand>;
export const followResult = t.Object({ profile: t.Literal('follow-receipt-v1'), target: readId,
  kind: followKind, actingSubject: readId, following: t.Boolean(), revision: readUuid, replayed: t.Boolean() });
export type FollowResult = Static<typeof followResult>;
export const batchFollowCommand = t.Object({ profile: t.Literal('follow-batch-v1'), actingSubject: readId,
  targets: t.Array(t.Object({ target: readId, kind: followKind }, { additionalProperties: false }),
    { minItems: 1, maxItems: 20 }) }, { additionalProperties: false });
export type BatchFollowCommand = Static<typeof batchFollowCommand>;
export const batchFollowResult = t.Object({ profile: t.Literal('follow-batch-receipt-v1'),
  actingSubject: readId, items: t.Array(t.Object({ target: readId, kind: followKind,
    following: t.Literal(true), revision: readUuid }), { maxItems: 20 }), replayed: t.Boolean() });
export type BatchFollowResult = Static<typeof batchFollowResult>;
export const followTarget = t.Object({ id: readId, kind: followKind, name: readName,
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
    t.Object({ id: readId, kind: followKind, available: t.Literal(false), revision: readUuid,
      name: t.Null(), icon: t.Null(), realm: t.Null(), href: t.Null() }),
  ]), { maxItems: 20 }), ...pageFields });
export const followState = t.Object({ profile: t.Literal('follow-state-v1'), target: followTarget,
  following: t.Nullable(t.Boolean()), revision: t.Nullable(readUuid),
  followers: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }) });

/** Indexed private seek: P+1 rows, at most P public hydrations; count reads at
 * most 1001 rows. Writes lock one principal inventory, one relationship and
 * original person-Agent control proof. No follower identities are public. */
export const FOLLOWS_COST = { pageSize: 20, candidates: 8, maximumFollowing: 1000, countProbe: 1001 } as const;
