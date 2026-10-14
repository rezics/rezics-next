import { entries as related0 } from './access-admissions.entries.ts';
import { randomUUID } from 'node:crypto';
import { AccessAgentControl } from '../../src/modules/access/agent-control.ts';
import { ControlConflict, ControlDenied } from '../../src/modules/access/topology-control.ts';
import { deactivateFixtureController, ensureFixtureScopeGate, grantFixtureAuthority, reduceFixtureGrant } from '../../src/modules/access/fixture-authority.ts';
import { AccessMembershipConsents } from '../../src/modules/access/membership-consents.ts';
import { MembershipConflict, MembershipDenied } from '../../src/modules/access/memberships.ts';
import { AccessRealmManagement, realmAdminScope } from '../../src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../src/modules/access/realm-management-joining.ts';
import { RealmAdminConflict, RealmAdminDenied, type MemberCommand, type RoleCommand } from '../../src/modules/realm-admin/contract.ts';
import { createAdmittedRealmSpace } from '../../src/modules/space/create-admitted.ts';
import { hash } from '../../src/modules/work/activate.ts';
import { type ReplayEntry, type Member, type Loss, stack, principal, request, graphSnapshot } from './fixtures.ts';

async function endGrant(grant: string, loss: Loss) {
  await reduceFixtureGrant(stack.accessPool, grant, loss === 'revoked'
    ? { active: false } : { validUntil: new Date(0) });
}

async function realmFixture() {
  const member = await stack.member(randomUUID());
  await member.grant('space:create:root', 'space.create');
  const owner = new AccessRealmManagement(stack.accessPool);
  const created = await createAdmittedRealmSpace(stack.env, stack.composition.dependencies.account,
    stack.access, request(member), { name: 'Replay authority community', language: 'en',
      actingSubject: member.actor, idempotencyKey: randomUUID(), initialSettings: {
        visibility: 'public', reviewRequired: true, reviewMode: 'mandatory',
        whoMaySubmit: 'granted', selfJoin: true, rules: [],
      } }, owner);
  await member.grant('work:create:root', 'agent.control');
  const realm = created.realm!, space = created.space!;
  const joining = new AccessRealmJoining(stack.accessPool, stack.env);
  const grant = async (action: string) => (await stack.accessPool.query<{ id: string }>(`
    SELECT id FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
      AND action = $3 AND active ORDER BY id`, [member.actor, realmAdminScope(realm), action])).rows[0]!.id;
  const generation = async () => (await stack.accessPool.query<{ generation: string }>(`
    SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1`, [realm])).rows[0]!.generation;
  const snapshot = async () => ({ graph: await graphSnapshot(realm, space),
    state: (await stack.accessPool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM access.realm_admin_receipt r WHERE realm = $1) AS receipts,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM access.realm_join_receipt r WHERE principal_id = $2) AS joining,
      (SELECT to_jsonb(r) FROM access.realm_admin_revision r WHERE realm = $1) AS revision,
      (SELECT to_jsonb(r) FROM access.realm_admin_settings r WHERE realm = $1) AS settings,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM access.realm_admin_role r WHERE realm = $1) AS roles,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.role_id,r.member) FROM access.realm_admin_assignment r WHERE realm = $1) AS assignments,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.grant_id) FROM access.realm_admin_role_grant r WHERE realm = $1) AS role_grants,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM access.membership r WHERE owner_subject = $1) AS memberships,
      (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.membership_id,h.generation) FROM access.membership_history h
        JOIN access.membership m ON m.id = h.membership_id WHERE m.owner_subject = $1) AS history,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_subject) FROM access.membership_ban r WHERE owner_subject = $1) AS bans`,
    [realm, member.principalId])).rows });
  const consent = async (recipient: Member) => {
    const policy = await joining.policyFor(await principal(recipient), realm, recipient.actor);
    const input = { kind: 'realm' as const, ownerSubject: realm, memberSubject: recipient.actor,
      expectedGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
      termsRevision: policy.termsRevision };
    return new AccessMembershipConsents(stack.accessPool).issue({ ...input,
      principal: await principal(recipient), idempotencyKey: randomUUID(), requestDigest: hash(JSON.stringify(input)) });
  };
  const join = async (recipient: Member) => {
    await recipient.grant('work:create:root', 'access.membership.consent');
    const policy = await joining.policyFor(await principal(recipient), realm, recipient.actor);
    return joining.selfJoin(await principal(recipient), realm, { actingSubject: recipient.actor,
      expectedMembershipGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
      termsRevision: policy.termsRevision, listed: true }, randomUUID());
  };
  return { member, owner, joining, realm, space, grant, generation, snapshot, consent, join };
}

const membershipConsentEntries: ReplayEntry[] = ['domain-grant', 'controller'].map(authorityClass => ({
  operation: 'POST /v1/me/membership-consents', authorityClass: authorityClass as 'domain-grant' | 'controller',
  scope: 'work:create:root', action: 'access.membership.consent', family: `Membership consent ${authorityClass}`,
  owners: ['modules/access/membership-consents.ts#AccessMembershipConsents.issue'], subcases: ['Realm recipient'],
  ...(authorityClass === 'controller' ? { losses: ['revoked'] as Loss[] } : {}),
  denied: MembershipDenied, conflict: MembershipConflict, registration: 'registered-failing',
  requestBuilder: async () => {
    const fixture = await realmFixture(), recipient = await stack.member(randomUUID());
    let grant: string, controller: string | undefined;
    if (authorityClass === 'controller') {
      const spare = await stack.member(randomUUID());
      const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: recipient.principalId, actor: recipient.actor, action: 'agent.control', lifetime: 'infinity' },
          { principalId: spare.principalId, actor: recipient.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: recipient.actor, action: 'access.membership.consent', lifetime: '8 hours' } });
      grant = authority.grantId; controller = authority.representationIds[0]!;
    } else grant = await recipient.grant('work:create:root', 'access.membership.consent');
    const policy = await fixture.joining.policyFor(await principal(recipient), fixture.realm, recipient.actor);
    const input = { kind: 'realm' as const, ownerSubject: fixture.realm, memberSubject: recipient.actor,
      expectedGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
      termsRevision: policy.termsRevision };
    const owner = new AccessMembershipConsents(stack.accessPool), key = randomUUID();
    return { command: async (fresh, changed) => {
      const intent = changed ? { ...input, termsRevision: `${input.termsRevision}-different` } : input;
      return owner.issue({ ...intent, principal: await principal(recipient),
        idempotencyKey: fresh ? randomUUID() : key, requestDigest: hash(JSON.stringify(intent)) });
    }, lose: loss => controller ? deactivateFixtureController(stack.accessPool, controller) : endGrant(grant, loss),
    snapshot: async () => (await stack.accessPool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM access.membership_consent c WHERE principal_id = $1) AS consents,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM access.membership_consent_receipt r WHERE principal_id = $1) AS receipts`,
    [recipient.principalId])).rows };
  },
}));

const invitationEntries: ReplayEntry[] = ['invite', 'revoke'].map(command => ({
  operation: command === 'invite' ? 'POST /v1/realms/{}/invitations' : 'POST /v1/realms/{}/invitations/{}/revoke',
  authorityClass: 'domain-grant', scope: 'governance:realm:<Realm>', action: 'realm.members.manage',
  family: `Realm invitation ${command}`, owners: [`modules/access/realm-management-joining.ts#AccessRealmJoining.${command}`],
  subcases: ['manager grant'], denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
  requestBuilder: async () => {
    const f = await realmFixture(), recipient = await stack.member(randomUUID());
    const grant = await f.grant('realm.members.manage'), key = randomUUID();
    const input = { actingSubject: f.member.actor, member: recipient.actor, expiresInSeconds: 3600 };
    const invitation = command === 'revoke'
      ? await f.joining.invite(await principal(f.member), f.realm, input, randomUUID()) : undefined;
    return { command: async (fresh, changed) => command === 'invite'
      ? f.joining.invite(await principal(f.member), f.realm, { ...input,
        ...(changed ? { expiresInSeconds: 1800 } : {}) }, fresh ? randomUUID() : key)
      : f.joining.revoke(await principal(f.member), f.realm,
        changed ? randomUUID() : invitation!.invitation.id, f.member.actor, fresh ? randomUUID() : key),
    lose: loss => endGrant(grant, loss), snapshot: async () => ({ state: await f.snapshot(),
      invitations: (await stack.accessPool.query(`SELECT to_jsonb(i) AS row
        FROM access.realm_invitation i WHERE realm = $1 ORDER BY id`, [f.realm])).rows }) };
  },
}));

const realmRoleEntry: ReplayEntry = {
  operation: 'POST /v1/realms/{}/role-changes', authorityClass: 'domain-grant',
  scope: 'governance:realm:<Realm>', action: 'realm.roles.manage', family: 'Realm role command',
  owners: ['modules/access/realm-management.ts#AccessRealmManagement.write'], subcases: ['role', 'assignment'],
  denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const f = await realmFixture(), recipient = await stack.member(randomUUID());
    await f.join(recipient);
    const grant = await f.grant('realm.roles.manage'), key = randomUUID(), roleId = randomUUID();
    const role: RoleCommand = { actingSubject: f.member.actor, expectedGeneration: await f.generation(),
      reason: 'Create a community role', change: { kind: 'role', roleId, name: 'Reader', permissions: [] } };
    if (subcase === 'assignment') {
      const impact = await f.owner.preview(await principal(f.member), f.realm, role);
      await f.owner.changeRole(await principal(f.member), f.realm, role, randomUUID(), impact.digest);
    }
    const input: RoleCommand = subcase === 'role' ? role : { ...role, expectedGeneration: await f.generation(),
      change: { kind: 'assignment', roleId, member: recipient.actor, assigned: true,
        validUntil: new Date(Date.now() + 3600_000).toISOString() } };
    const impact = await f.owner.preview(await principal(f.member), f.realm, input);
    return { command: async (fresh, changed) => f.owner.changeRole(await principal(f.member), f.realm,
      { ...input, ...(fresh ? { expectedGeneration: await f.generation() } : {}),
        ...(changed ? { reason: 'Different role intent' } : {}) }, fresh ? randomUUID() : key, impact.digest),
    advance: async () => {
      const next: RoleCommand = { ...role, expectedGeneration: await f.generation(), reason: 'Advance management head',
        change: { kind: 'role', roleId: randomUUID(), name: 'Later role', permissions: [] } };
      const preview = await f.owner.preview(await principal(f.member), f.realm, next);
      await f.owner.changeRole(await principal(f.member), f.realm, next, randomUUID(), preview.digest);
    }, lose: loss => endGrant(grant, loss), snapshot: f.snapshot };
  },
};

const realmMemberEntry: ReplayEntry = {
  operation: 'POST /v1/realms/{}/members', authorityClass: 'domain-grant',
  scope: 'governance:realm:<Realm>', action: 'realm.members.manage', family: 'Realm member command',
  owners: ['modules/access/realm-management.ts#AccessRealmManagement.write'], subcases: ['add', 'remove', 'ban', 'unban'],
  denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const f = await realmFixture(), recipient = await stack.member(randomUUID());
    await recipient.grant('work:create:root', 'access.membership.consent');
    if (subcase === 'remove') await f.join(recipient);
    const input: MemberCommand = { actingSubject: f.member.actor, member: recipient.actor,
      expectedGeneration: await f.generation(), expectedMembershipGeneration: subcase === 'remove' ? '1' : '0',
      reason: 'Change community participation', action: subcase as MemberCommand['action'],
      consent: subcase === 'add' ? (await f.consent(recipient)).consentReference : null, durationSeconds: null };
    if (subcase === 'unban') {
      await f.owner.changeMember(await principal(f.member), f.realm, { ...input, action: 'ban' }, randomUUID(), stack.env);
      input.expectedGeneration = await f.generation();
    }
    const grant = await f.grant('realm.members.manage'), key = randomUUID();
    return { command: async (fresh, changed) => f.owner.changeMember(await principal(f.member), f.realm,
      { ...input, ...(fresh ? { expectedGeneration: await f.generation() } : {}),
        ...(changed ? { reason: 'Different participation intent' } : {}) }, fresh ? randomUUID() : key, stack.env),
    advance: async () => {
      const other = await stack.member(randomUUID());
      await f.owner.changeMember(await principal(f.member), f.realm, { ...input, member: other.actor,
        expectedGeneration: await f.generation(), expectedMembershipGeneration: '0', action: 'ban',
        consent: null }, randomUUID(), stack.env);
    }, lose: loss => endGrant(grant, loss), snapshot: f.snapshot };
  },
};

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/agents/control", authorityClass: 'controller',
    scope: "access:representation-topology", action: "agent.control", family: 'Agent control policy (authorized before shared receipted helper)',
    owners: ['modules/access/agent-control.ts#AccessAgentControl.configure'],
    subcases: ['controller policy'], losses: ['revoked'], denied: ControlDenied, conflict: ControlConflict,
    registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID()), recovery = await stack.member(randomUUID());
      const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
          { principalId: recovery.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      await ensureFixtureScopeGate(stack.accessPool, 'access:representation-topology', { open: true });
      const owner = new AccessAgentControl(stack.accessPool);
      const input = { subjectId: member.actor, recoverySubject: recovery.actor, recoveryApprovals: 1,
        recoveryDelaySeconds: 0, minControllers: 1, maxControllers: 8 };
      const receipt = { idempotencyKey: randomUUID(), requestDigest: hash(JSON.stringify(input)) };
      return { command: async (fresh, changed) => {
        const intent = changed ? { ...input, maxControllers: 7 } : input;
        return owner.configure(await principal(member), { ...receipt, requestDigest: hash(JSON.stringify(intent)),
          ...(fresh ? { idempotencyKey: randomUUID() } : {}) }, intent);
      },
      lose: async () => { await deactivateFixtureController(stack.accessPool, authority.representationIds[0]!); },
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(c) AS row
        FROM access.agent_control c WHERE subject_id = $1`, [member.actor])).rows };
    } },
  ...membershipConsentEntries, ...invitationEntries, realmRoleEntry, realmMemberEntry,
];

export const area = "access";
export const moduleOwners = ["access"];
export const replayEntries = [...entries, ...related0];
// A command can have independent controller and domain-grant witnesses.
export const coveredOperations = [...new Set(replayEntries.map(entry => entry.operation))];
export const uncoveredOperations: string[] = [
  "POST /v1/access/membership-changes",
  "POST /v1/access/revocations",
  "POST /v1/access/interaction-blocks",
  "PUT /v1/me/interaction-mutes",
  "POST /v1/access/policy-changes",
  "PUT /v1/me/main-agent-preference",
  "PUT /v1/me/session-agent",
  "PUT /v1/me/acting-context-preferences/work.create",
  "POST /v1/realms/{}/invitations/{}/response",
  "POST /v1/realms/{}/join",
  "POST /v1/realms/{}/escalations",
  "PUT /v1/realms/{}/settings",
  "POST /v1/realms/{}/management",
  "PUT /v1/spaces/{}/settings",
  "POST /v1/recipes/{}/file-imports",
  "POST /v1/recipes/{}/timings",
  "POST /v1/recipes/{}/measures"
];
