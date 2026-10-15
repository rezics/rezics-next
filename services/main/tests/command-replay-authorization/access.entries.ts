import { entries as related0 } from './access-admissions.entries.ts';
import { randomUUID } from 'node:crypto';
import { AccessAgentControl } from '../../src/modules/access/agent-control.ts';
import { ControlConflict, ControlDenied } from '../../src/modules/access/topology-control.ts';
import { deactivateFixtureController, ensureFixtureScopeGate, grantFixtureAuthority, reduceFixtureGrant } from '../../src/modules/access/fixture-authority.ts';
import { AccessMembershipConsents } from '../../src/modules/access/membership-consents.ts';
import { MembershipConflict, MembershipDenied } from '../../src/modules/access/memberships.ts';
import { AccessRealmManagement, realmAdminScope } from '../../src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../src/modules/access/realm-management-joining.ts';
import { RealmAdminConflict, RealmAdminDenied, type MemberCommand, type RoleCommand, type SettingsCommand, type SpaceSettingsCommand } from '../../src/modules/realm-admin/contract.ts';
import { AccessRevocations, type RevocationRequest } from '../../src/modules/access/revocation-requests.ts';
import { AccessPolicyChanges, type PolicyChange } from '../../src/modules/access/policy-changes.ts';
import { PolicyConflict, PolicyDenied } from '../../src/modules/access/policy-errors.ts';
import { createAdmittedRealmSpace } from '../../src/modules/space/create-admitted.ts';
import { hash } from '../../src/modules/work/activate.ts';
import { type ReplayEntry, type Member, type Loss, stack, principal, request, graphSnapshot } from './fixtures.ts';

async function endGrant(grant: string, loss: Loss) {
  await reduceFixtureGrant(stack.accessPool, grant, loss === 'revoked'
    ? { active: false } : { validUntil: new Date(0) });
}

async function controllerRemoval(member: Member) {
  const spare = await stack.member(randomUUID());
  const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
      { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
  return () => deactivateFixtureController(stack.accessPool, authority.representationIds[0]!);
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
      (SELECT jsonb_agg(jsonb_build_object('link',to_jsonb(r),'grant',to_jsonb(g)) ORDER BY r.grant_id)
        FROM access.realm_admin_role_grant r JOIN access.permission_grant g ON g.id = r.grant_id WHERE realm = $1) AS role_grants,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ref,r.revision) FROM access.governance_rule_revision r
        WHERE ref IN (SELECT ref FROM access.governance_rule_head WHERE scope_id = $3)) AS rules,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ref) FROM access.governance_rule_head r WHERE scope_id = $3) AS rule_heads,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.generation) FROM access.realm_policy_delivery r WHERE realm = $1) AS deliveries,
      (SELECT to_jsonb(r) FROM access.membership_policy r WHERE kind = 'realm' AND owner_subject = $1) AS membership_policy,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM access.membership r WHERE owner_subject = $1) AS memberships,
      (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.membership_id,h.generation) FROM access.membership_history h
        JOIN access.membership m ON m.id = h.membership_id WHERE m.owner_subject = $1) AS history,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_subject) FROM access.membership_ban r WHERE owner_subject = $1) AS bans`,
    [realm, member.principalId, realmAdminScope(realm)])).rows });
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
  denied: MembershipDenied, conflict: MembershipConflict, registration: 'turned',
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
    let freshInput = input;
    return { command: async (fresh, changed) => {
      const base = fresh ? freshInput : input;
      const intent = changed ? { ...base, termsRevision: `${base.termsRevision}-different` } : base;
      return owner.issue({ ...intent, principal: await principal(recipient),
        idempotencyKey: fresh ? randomUUID() : key, requestDigest: hash(JSON.stringify(intent)) });
    }, advance: async () => {
      // Move the policy head twice without consuming or rewriting the saved consent.
      for (const selfJoin of [false, true]) {
        const current = await fixture.owner.settings(await principal(fixture.member), fixture.realm, fixture.member.actor, stack.env);
        await fixture.owner.changeSettings(await principal(fixture.member), fixture.realm, {
          actingSubject: fixture.member.actor, expectedGeneration: current.generation, reason: 'Advance admission policy',
          expectedRulesRevision: current.ruleBasis.revision, settings: { ...current.settings, selfJoin },
        }, randomUUID(), stack.env);
      }
      const current = await fixture.joining.policyFor(await principal(recipient), fixture.realm, recipient.actor);
      freshInput = { ...input, expectedPolicyRevision: current.policyRevision, termsRevision: current.termsRevision };
    }, lose: loss => controller ? deactivateFixtureController(stack.accessPool, controller) : endGrant(grant, loss),
    restore: async () => {
      if (controller) await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: recipient.principalId, actor: recipient.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: recipient.actor, action: 'access.membership.consent', lifetime: '8 hours' } });
      else await recipient.grant('work:create:root', 'access.membership.consent');
    },
    snapshot: async () => (await stack.accessPool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM access.membership_consent c WHERE principal_id = $1) AS consents,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM access.membership_consent_receipt r WHERE principal_id = $1) AS receipts`,
    [recipient.principalId])).rows };
  },
}));

const invitationEntries: ReplayEntry[] = (['domain-grant', 'controller'] as const).flatMap(authorityClass => ['invite', 'revoke'].map(command => ({
  operation: command === 'invite' ? 'POST /v1/realms/{}/invitations' : 'POST /v1/realms/{}/invitations/{}/revoke',
  authorityClass, scope: 'governance:realm:<Realm>', action: 'realm.members.manage',
  family: `Realm invitation ${command}${authorityClass === 'controller' ? ' controller' : ''}`, owners: [`modules/access/realm-management-joining.ts#AccessRealmJoining.${command}`],
  ...(authorityClass === 'controller' ? { losses: ['revoked'] as Loss[] } : {}),
  subcases: ['manager grant'], denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
  requestBuilder: async () => {
    const f = await realmFixture(), recipient = await stack.member(randomUUID());
    const grant = await f.grant('realm.members.manage'), key = randomUUID();
    const remove = authorityClass === 'controller' ? await controllerRemoval(f.member) : undefined;
    const input = { actingSubject: f.member.actor, member: recipient.actor, expiresInSeconds: 3600 };
    const invitation = command === 'revoke'
      ? await f.joining.invite(await principal(f.member), f.realm, input, randomUUID()) : undefined;
    return { command: async (fresh, changed) => command === 'invite'
      ? f.joining.invite(await principal(f.member), f.realm, { ...input,
        ...(changed ? { expiresInSeconds: 1800 } : {}) }, fresh ? randomUUID() : key)
      : f.joining.revoke(await principal(f.member), f.realm,
        changed ? randomUUID() : invitation!.invitation.id, f.member.actor, fresh ? randomUUID() : key),
    advance: async () => {
      const current = await f.owner.settings(await principal(f.member), f.realm, f.member.actor, stack.env);
      await f.owner.changeSettings(await principal(f.member), f.realm, { actingSubject: f.member.actor,
        expectedGeneration: current.generation, expectedRulesRevision: current.ruleBasis.revision,
        reason: 'Advance Realm head after invitation', settings: { ...current.settings, whoMaySubmit: 'members' },
      }, randomUUID(), stack.env);
    }, lose: loss => remove ? remove() : endGrant(grant, loss), snapshot: async () => ({ state: await f.snapshot(),
      invitations: (await stack.accessPool.query(`SELECT to_jsonb(i) AS row
        FROM access.realm_invitation i WHERE realm = $1 ORDER BY id`, [f.realm])).rows }) };
  },
})));

const realmRoleEntries: ReplayEntry[] = (['domain-grant', 'controller'] as const).map(authorityClass => ({
  operation: 'POST /v1/realms/{}/role-changes', authorityClass,
  scope: 'governance:realm:<Realm>', action: 'realm.roles.manage', family: `Realm role command${authorityClass === 'controller' ? ' controller' : ''}`,
  ...(authorityClass === 'controller' ? { losses: ['revoked'] as Loss[] } : {}),
  owners: ['modules/access/realm-management.ts#AccessRealmManagement.write'], subcases: ['role', 'assignment'],
  denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const f = await realmFixture(), recipient = await stack.member(randomUUID());
    await f.join(recipient);
    const grant = await f.grant('realm.roles.manage'), key = randomUUID(), roleId = randomUUID();
    const remove = authorityClass === 'controller' ? await controllerRemoval(f.member) : undefined;
    const role: RoleCommand = { actingSubject: f.member.actor, expectedGeneration: await f.generation(),
      reason: 'Create a community role', change: { kind: 'role', roleId, name: 'Reader', permissions: ['realm.members.manage'] } };
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
    }, lose: loss => remove ? remove() : endGrant(grant, loss), snapshot: f.snapshot };
  },
}));

const realmMemberEntries: ReplayEntry[] = (['domain-grant', 'controller'] as const).map(authorityClass => ({
  operation: 'POST /v1/realms/{}/members', authorityClass,
  scope: 'governance:realm:<Realm>', action: 'realm.members.manage', family: `Realm member command${authorityClass === 'controller' ? ' controller' : ''}`,
  ...(authorityClass === 'controller' ? { losses: ['revoked'] as Loss[] } : {}),
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
    const remove = authorityClass === 'controller' ? await controllerRemoval(f.member) : undefined;
    return { command: async (fresh, changed) => f.owner.changeMember(await principal(f.member), f.realm,
      { ...input, ...(fresh ? { expectedGeneration: await f.generation() } : {}),
        ...(changed ? { reason: 'Different participation intent' } : {}) }, fresh ? randomUUID() : key, stack.env),
    advance: async () => {
      const other = await stack.member(randomUUID());
      await f.owner.changeMember(await principal(f.member), f.realm, { ...input, member: other.actor,
        expectedGeneration: await f.generation(), expectedMembershipGeneration: '0', action: 'ban',
        consent: null }, randomUUID(), stack.env);
    }, lose: loss => remove ? remove() : endGrant(grant, loss), snapshot: f.snapshot };
  },
}));

const realmSettingsEntries: ReplayEntry[] = [
  { authorityClass: 'domain-grant', lossAction: 'realm.settings.manage', registration: 'turned' },
  { authorityClass: 'controller', lossAction: 'realm.settings.manage', registration: 'turned' },
  { authorityClass: 'domain-grant', lossAction: 'governance.rule.publish', registration: 'turned' },
].map(spec => ({
  operation: 'PUT /v1/realms/{}/settings', authorityClass: spec.authorityClass as ReplayEntry['authorityClass'],
  scope: 'governance:realm:<Realm>', action: spec.lossAction,
  family: `Realm settings ${spec.authorityClass} ${spec.lossAction}`,
  owners: ['modules/access/realm-management.ts#AccessRealmManagement.write', 'modules/governance/rules.ts#publishRuleRevision'],
  subcases: ['rules and access'], ...(spec.authorityClass === 'controller' ? { losses: ['revoked'] as Loss[] } : {}),
  denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: spec.registration as ReplayEntry['registration'],
  requestBuilder: async () => {
    const f = await realmFixture(), grant = await f.grant(spec.lossAction), key = randomUUID();
    const remove = spec.authorityClass === 'controller' ? await controllerRemoval(f.member) : undefined;
    const current = await f.owner.settings(await principal(f.member), f.realm, f.member.actor, stack.env);
    const input: SettingsCommand = { actingSubject: f.member.actor, expectedGeneration: current.generation,
      expectedRulesRevision: current.ruleBasis.revision, reason: 'Change Realm settings',
      settings: { ...current.settings, whoMaySubmit: 'members' } };
    let freshInput = input;
    return { command: async (fresh, changed) => f.owner.changeSettings(await principal(f.member), f.realm,
      { ...(fresh ? freshInput : input), ...(changed ? { reason: 'Different settings intent' } : {}) },
      fresh ? randomUUID() : key, stack.env),
    advance: async () => {
      const head = await f.owner.settings(await principal(f.member), f.realm, f.member.actor, stack.env);
      const advanced = await f.owner.changeSettings(await principal(f.member), f.realm, {
        ...input, expectedGeneration: head.generation, expectedRulesRevision: head.ruleBasis.revision,
        settings: { ...input.settings, whoMaySubmit: 'granted' },
      }, randomUUID(), stack.env);
      freshInput = { ...input, expectedGeneration: advanced.generation, expectedRulesRevision: advanced.ruleBasis.revision };
    }, lose: loss => remove ? remove() : endGrant(grant, loss), snapshot: f.snapshot };
  },
}));

// These commands also have credential/resource paths awaiting the shared input.
// Their supported classes execute now, while the complete command stays uncovered.
export const partialReplayEntries: ReplayEntry[] = [
  ...(['domain-grant', 'controller'] as const).map<ReplayEntry>(authorityClass => ({
    operation: 'PUT /v1/spaces/{}/settings', authorityClass, scope: 'governance:realm:<Realm>',
    action: 'realm.settings.manage', family: `Realm Space settings ${authorityClass}`,
    owners: ['modules/access/realm-management.ts#AccessRealmManagement.write'], subcases: ['Realm Space'],
    ...(authorityClass === 'controller' ? { losses: ['revoked'] as Loss[] } : {}),
    denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
    requestBuilder: async () => {
      const f = await realmFixture(), grant = await f.grant('realm.settings.manage'), key = randomUUID();
      const remove = authorityClass === 'controller' ? await controllerRemoval(f.member) : undefined;
      const input: SpaceSettingsCommand = { actingSubject: f.member.actor, expectedGeneration: await f.generation(),
        reason: 'Change Space discovery', settings: { visibility: 'public', listing: 'unlisted', history: 'everything', admission: 'open' } };
      let freshGeneration = input.expectedGeneration;
      return { command: async (fresh, changed) => f.owner.changeSpaceSettings(await principal(f.member), f.space,
        { ...input, ...(fresh ? { expectedGeneration: freshGeneration } : {}),
          ...(changed ? { reason: 'Different Space intent' } : {}) }, fresh ? randomUUID() : key, stack.env),
      advance: async () => {
        const result = await f.owner.changeSpaceSettings(await principal(f.member), f.space, {
          ...input, expectedGeneration: await f.generation(),
          settings: { visibility: 'public', listing: 'listed', history: 'everything', admission: 'open' },
        }, randomUUID(), stack.env);
        freshGeneration = result.generation;
      }, lose: loss => remove ? remove() : endGrant(grant, loss), snapshot: f.snapshot };
    },
  })),
  { operation: 'POST /v1/access/revocations', authorityClass: 'controller', scope: 'media:owner:<Agent>',
    action: 'access.revoke', family: 'Access revocation controller',
    owners: ['modules/access/revocation-requests.ts#AccessRevocations.revoke'],
    subcases: ['ordinary permission_grant', 'strong permission_grant', 'ordinary representation', 'strong representation'],
    losses: ['revoked'], denied: PolicyDenied, conflict: PolicyConflict, registration: 'turned',
    requestBuilder: async subcase => {
      const member = await stack.member(randomUUID()), remove = await controllerRemoval(member);
      const kind = subcase.endsWith('permission_grant') ? 'permission_grant' : 'representation';
      const scope = `media:owner:${member.actor}`;
      const target = (await stack.accessPool.query<{ id: string; generation: string }>(kind === 'permission_grant'
        ? `SELECT id,generation::text FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'media.upload' AND active`
        : `SELECT id,generation::text FROM access.representation WHERE principal_id = $3 AND subject_id = $1 AND action = 'media.upload' AND active AND $2::text IS NOT NULL`,
      [member.actor, scope, ...(kind === 'representation' ? [member.principalId] : [])])).rows[0]!;
      const epoch = (await stack.accessPool.query<{ authority_epoch: string }>(`
        SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1`, [scope])).rows[0]!.authority_epoch;
      const input: RevocationRequest = { revocationId: randomUUID(), issuerSubject: member.actor,
        mode: subcase.startsWith('strong') ? 'strong' : 'ordinary', scopeId: scope, expectedAuthorityEpoch: epoch,
        target: { kind, id: target.id, expectedGeneration: target.generation } };
      const owner = new AccessRevocations(stack.accessPool), key = randomUUID();
      return { command: async (fresh, changed) => {
        const intent = changed ? { ...input, mode: input.mode === 'strong' ? 'ordinary' as const : 'strong' as const } : input;
        return owner.revoke(await principal(member), intent, { idempotencyKey: fresh ? randomUUID() : key,
          requestDigest: hash(JSON.stringify(intent)) });
      }, lose: remove, snapshot: async () => (await stack.accessPool.query(`SELECT
        (SELECT to_jsonb(r) FROM access.revocation r WHERE id = $1) AS revocation,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM access.revocation_receipt r WHERE revocation_id = $1) AS receipts,
        (SELECT to_jsonb(r) FROM access.${kind} r WHERE id = $2) AS source`, [input.revocationId, target.id])).rows };
    } },
  { operation: 'POST /v1/access/policy-changes', authorityClass: 'domain-grant', scope: 'replay:policy:<Scope>',
    action: 'access.policy.manage', family: 'Access policy publication domain-grant',
    owners: ['modules/access/policy-changes.ts#AccessPolicyChanges.change'], subcases: ['publish revision'],
    denied: PolicyDenied, conflict: PolicyConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID()), scope = `replay:policy:${randomUUID()}`;
      const grant = await member.grant(scope, 'access.policy.manage'), key = randomUUID();
      const owner = new AccessPolicyChanges(stack.accessPool);
      const input: Extract<PolicyChange, { action: 'publish-revision' }> = { action: 'publish-revision',
        scopeId: scope, policyId: randomUUID(), expectedHeadRevision: '0', mandatory: [], ordered: [] };
      const epoch = (await stack.accessPool.query<{ authority_epoch: string }>(`
        SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1`, [scope])).rows[0]!.authority_epoch;
      let freshRevision = '0', freshEpoch = epoch;
      let saved: Awaited<ReturnType<typeof owner.change>>;
      const invoke = async (change: typeof input, idempotencyKey: string, expectedAuthorityEpoch: string) =>
        owner.change({ principal: await principal(member), issuerSubject: member.actor, expectedAuthorityEpoch,
          idempotencyKey, requestDigest: hash(JSON.stringify({ ...change, issuerSubject: member.actor, expectedAuthorityEpoch })) }, change);
      return { command: async (fresh, changed) => {
        const result = await invoke({ ...input,
          ...(fresh ? { expectedHeadRevision: freshRevision } : {}), ...(changed ? { policyId: randomUUID() } : {}) },
        fresh ? randomUUID() : key, fresh ? freshEpoch : epoch);
        saved ??= result;
        return result;
      },
      advance: async () => {
        const advanced = await invoke({ ...input, expectedHeadRevision: saved.revision! }, randomUUID(), saved.authorityEpoch);
        freshRevision = advanced.revision!; freshEpoch = advanced.authorityEpoch;
      }, lose: loss => endGrant(grant, loss), snapshot: async () => (await stack.accessPool.query(`SELECT
        (SELECT to_jsonb(p) FROM access.policy p WHERE scope_id = $1) AS policy,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision) FROM access.policy_revision r WHERE policy_id = $2) AS revisions,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.idempotency_key) FROM access.policy_change_receipt r WHERE policy_id = $2) AS receipts`,
      [scope, input.policyId])).rows };
    } },
];

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
  ...membershipConsentEntries, ...invitationEntries, ...realmRoleEntries, ...realmMemberEntries, ...realmSettingsEntries,
];

export const area = "access";
export const moduleOwners = ["access"];
export const replayEntries = [...entries, ...partialReplayEntries, ...related0];
// A command can have independent controller and domain-grant witnesses.
export const coveredOperations = [...new Set([...entries, ...related0].map(entry => entry.operation))];
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
  "POST /v1/realms/{}/management",
  "PUT /v1/spaces/{}/settings",
  "POST /v1/recipes/{}/file-imports",
  "POST /v1/recipes/{}/timings",
  "POST /v1/recipes/{}/measures"
];
