import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId, readUuid } from '../work/read-contract.ts';
import { localizedCommunityRule, MAX_RULES } from '../realm-profile/schema.ts';

// Management uses indexed Access reads. Settings also deliver one pending policy
// receipt through a bounded graph command; no Realm contents are scanned.
// Role edits are O(grantRows + affected assignments * permissions); overflow is rejected
// before mutation. A preview never reports a truncated count as exact.
// Community-scoped and temporary bans follow the moderator task described at
// https://support.reddithelp.com/hc/en-us/articles/15484464549524-User-Management-banning-and-muting
// (consulted 2026-09-28); Access remains the enforcement authority here.
export const REALM_ADMIN_COST = { page: 50, roles: 32, assignments: 200,
  permissions: 8, grantRows: 4096, statementTimeoutMs: 5000, lockTimeoutMs: 2000 } as const;
export const realmPermissions = ['governance.moderate', 'governance.rule.publish',
  'realm.members.manage', 'realm.roles.manage', 'realm.settings.manage', 'review.decide', 'publication.adopt', 'rating.configure'] as const;
export type RealmPermission = typeof realmPermissions[number];
export const spaceVisibility = t.Union([t.Literal('public'), t.Literal('private')]);
export const resourceListing = t.Union([t.Literal('listed'), t.Literal('unlisted')]);
export const realmHistory = t.Union([t.Literal('everything'), t.Literal('from-admission')]);
export const realmAdmission = t.Union([t.Literal('open'), t.Literal('request'), t.Literal('invitation')]);
export const realmPermission = t.Union([t.Literal('governance.moderate'), t.Literal('governance.rule.publish'),
  t.Literal('realm.members.manage'), t.Literal('realm.roles.manage'), t.Literal('realm.settings.manage'),
  t.Literal('review.decide'), t.Literal('publication.adopt'), t.Literal('rating.configure')]);
export const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,17})$' });
export const reason = t.String({ minLength: 1, maxLength: 2000 });
export const commandFields = { actingSubject: readId, expectedGeneration: generation, reason };
export const roleChange = t.Union([
  t.Object({ kind: t.Literal('role'), roleId: readUuid, name: t.String({ minLength: 1, maxLength: 80 }),
    permissions: t.Array(realmPermission, { maxItems: REALM_ADMIN_COST.permissions, uniqueItems: true }) },
  { additionalProperties: false }),
  t.Object({ kind: t.Literal('assignment'), roleId: readUuid, member: readId, assigned: t.Boolean(),
    validUntil: t.String({ format: 'date-time' }) }, { additionalProperties: false }),
]);
export type RoleChange = Static<typeof roleChange>;
export const roleCommand = t.Object({ ...commandFields, change: roleChange }, { additionalProperties: false });
export type RoleCommand = Static<typeof roleCommand>;
export const impact = t.Object({ digest: t.String(), exact: t.Literal(true), affectedCount: t.Integer(),
  generation, changes: t.Array(t.Object({ member: readId,
    gained: t.Array(realmPermission), lost: t.Array(realmPermission) }), { maxItems: REALM_ADMIN_COST.assignments }) });
export type RoleImpact = Static<typeof impact>;
export const roleView = t.Object({ id: readUuid, name: t.String(), permissions: t.Array(realmPermission) });
export const roleList = t.Object({ generation, roles: t.Array(roleView, { maxItems: REALM_ADMIN_COST.roles }) });
export const roleReceipt = t.Object({ receiptId: readUuid, generation, replayed: t.Boolean(), impact });
export const escalationCommand = t.Object({ ...commandFields,
  expectedItemGeneration: generation,
  itemKind: t.Union([t.Literal('report'), t.Literal('submission')]), itemId: readUuid },
{ additionalProperties: false });
export type EscalationCommand = Static<typeof escalationCommand>;
export const escalationView = t.Object({ id: readUuid, reason: t.String(), actingSubject: readId,
  escalatedAt: t.String(), target: t.Literal('owners') });
export const escalationReceipt = t.Object({ receiptId: readUuid, generation,
  replayed: t.Boolean(), escalation: escalationView });
export const memberQuery = { actingSubject: readId, search: t.Optional(t.String({ maxLength: 80 })),
  after: t.Optional(readId), limit: t.Optional(t.Integer({ minimum: 1, maximum: REALM_ADMIN_COST.page })) };
export const memberPage = t.Object({ generation, items: t.Array(t.Object({ member: readId,
  joinedAt: t.Nullable(t.String()), membershipGeneration: generation,
  banned: t.Boolean(), bannedUntil: t.Nullable(t.String()),
  state: t.Union([t.Literal('joined'), t.Literal('left'), t.Literal('not_joined')]),
  roles: t.Array(t.Object({ id: readUuid, name: t.String(), validUntil: t.String() })) })),
  nextCursor: t.Nullable(readId) });
export const memberCommand = t.Object({ ...commandFields, member: readId,
  expectedMembershipGeneration: generation,
  action: t.Union([t.Literal('add'), t.Literal('remove'), t.Literal('ban'), t.Literal('unban')]),
  consent: t.Nullable(readUuid),
  durationSeconds: t.Nullable(t.Integer({ minimum: 1, maximum: 31_622_400 })) },
{ additionalProperties: false });
export type MemberCommand = Static<typeof memberCommand>;
export const realmSettings = t.Object({ visibility: t.Union([t.Literal('public'), t.Literal('restricted'), t.Literal('private')]),
  reviewRequired: t.Boolean(),
  reviewMode: t.Optional(t.Union([t.Literal('mandatory'), t.Literal('trusted-members'), t.Literal('open')])),
  whoMaySubmit: t.Union([t.Literal('granted'), t.Literal('members'), t.Literal('closed')]),
  selfJoin: t.Optional(t.Boolean()),
  rules: t.Array(localizedCommunityRule, { maxItems: MAX_RULES }) }, { additionalProperties: false });
export type RealmSettings = Static<typeof realmSettings>;
export const settingsCommand = t.Object({ ...commandFields, settings: realmSettings,
  expectedRulesRevision: t.Nullable(generation) }, { additionalProperties: false });
export type SettingsCommand = Static<typeof settingsCommand>;
export const settingsView = t.Object({ generation, settings: realmSettings,
  ruleBasis: t.Object({ ref: t.String(), revision: t.Nullable(generation), digest: t.Nullable(t.String()) }) });
export const settingsReceipt = t.Object({ ...settingsView.properties, receiptId: readUuid, replayed: t.Boolean() });
/** One command changes the four access/discovery choices without rewriting rules
 * or review policy. The generation is the existing Realm management revision. */
export const spaceSettings = t.Object({ visibility: spaceVisibility, listing: resourceListing,
  history: realmHistory, admission: realmAdmission }, { additionalProperties: false });
export type SpaceSettings = Static<typeof spaceSettings>;
export const spaceSettingsCommand = t.Object({ ...commandFields, settings: spaceSettings }, { additionalProperties: false });
export type SpaceSettingsCommand = Static<typeof spaceSettingsCommand>;
export const spaceSettingsView = t.Object({ space: readId, realm: readId, generation, settings: spaceSettings });
export const spaceSettingsReceipt = t.Object({ ...spaceSettingsView.properties, receiptId: readUuid, replayed: t.Boolean() });
export const memberReceipt = t.Object({ receiptId: readUuid, generation, replayed: t.Boolean(),
  member: readId, membershipGeneration: generation, bannedUntil: t.Nullable(t.String()),
  banned: t.Boolean() });
export class RealmAdminDenied extends Error {}
export class RealmAdminInvalid extends Error {}
export class RealmAdminStale extends Error {}
export class RealmAdminConflict extends Error {}
export class RealmAdminLimit extends Error {}
export class RealmAdminUnavailable extends Error {}
