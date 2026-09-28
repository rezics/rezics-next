import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId, readUuid } from '../work/read-contract.ts';
import { generation } from '../realm-admin/contract.ts';

// One Realm and one membership episode per mutation. Invitation pages have at
// most 50 items; commands use <= 48 indexed SQL statements and one graph read.
export const REALM_JOIN_COST = { page: 50, maxLifetimeSeconds: 604800, sqlStatements: 48, graphCalls: 1 } as const;
export const invitationCommand = t.Object({ actingSubject: readId, member: readId,
  expiresInSeconds: t.Integer({ minimum: 60, maximum: REALM_JOIN_COST.maxLifetimeSeconds }) }, { additionalProperties: false });
export const invitationResponse = t.Object({ actingSubject: readId,
  action: t.Union([t.Literal('accept'),t.Literal('decline')]), listed: t.Boolean() }, { additionalProperties: false });
export const selfJoinCommand = t.Object({ actingSubject: readId, expectedMembershipGeneration: generation,
  expectedPolicyRevision: generation, termsRevision: t.String({ minLength: 1,maxLength: 128 }), listed: t.Boolean() },
{ additionalProperties: false });
export type InvitationCommand = Static<typeof invitationCommand>;
export type InvitationResponse = Static<typeof invitationResponse>;
export type SelfJoinCommand = Static<typeof selfJoinCommand>;
export const invitationView = t.Object({ id: readUuid, realm: readId, member: readId, inviter: readId,
  state: t.Union([t.Literal('pending'),t.Literal('expired'),t.Literal('accepted'),t.Literal('declined'),t.Literal('revoked')]),
  createdAt: t.String(), expiresAt: t.String(), policyRevision: generation,
  termsRevision: t.String(), membershipGeneration: generation });
export const invitationResult = t.Object({ invitation: invitationView, replayed: t.Boolean() });
export const joinResult = t.Object({ membershipId: readUuid, member: readId, realm: readId,
  membershipGeneration: generation, listed: t.Boolean(), replayed: t.Boolean() });
export const joinPolicy = t.Object({ realm: readId, policyRevision: generation, termsRevision: t.String(),
  selfJoin: t.Boolean(), open: t.Boolean(), membershipGeneration: generation,
  state: t.Union([t.Literal('joined'),t.Literal('left'),t.Literal('absent')]) });
export const invitationPage = t.Object({ items: t.Array(invitationView, { maxItems: REALM_JOIN_COST.page }), nextCursor: t.Nullable(readUuid) });
