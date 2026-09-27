import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement, realmAdminScope } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ManagementReadStore } from '../../../services/main/src/modules/management-reads/read-store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { realmMemberProof } from '../../../services/main/src/modules/realm-reply/member-policy.ts';
import type { RoleCommand, RoleImpact } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { RealmSubmissionStore } from '../../../services/main/src/modules/realm-submission/store.ts';
import { REALM_ADMIN_COST } from '../../../services/main/src/modules/realm-admin/contract.ts';

async function setup() {
  const stack = await startMediaStack('realm-admin');
  const owner = await stack.member('owner');
  const moderator = await stack.member('moderator');
  const outsider = await stack.member('outsider');
  await owner.grant('space:create:root', 'space.create');
  const response = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
    name: 'Realm management', capabilities: ['realm'], actingSubject: owner.actor });
  expect(response.status).toBe(201);
  const realm = (await response.json() as { realm: string }).realm;
  const scope = realmAdminScope(realm);
  await owner.grant(scope, 'realm.owner');
  for (const action of ['governance.moderate', 'governance.rule.publish', 'realm.roles.manage',
    'realm.members.manage', 'realm.settings.manage']) await owner.grant(scope, action);
  // Representation is independently required; role assignment grants no identity.
  await stack.accessPool.query(`INSERT INTO access.representation
    (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'governance.moderate',now() + interval '1 hour')`,
  [randomUUID(), moderator.principalId, moderator.actor]);
  const admin = new AccessRealmManagement(stack.accessPool);
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
    realmAdmin: admin, managementReads: new ManagementReadStore(stack.accessPool, stack.env),
    realmSubmissions: new RealmSubmissionStore(stack.accessPool, stack.access, stack.env),
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      const member = [owner, moderator, outsider].find(m => m.token === token);
      if (!member) throw new AccountAssertionDenied('Bearer required');
      return member.principal;
    } } });
  const root = `/v1/realms/${realm.slice(-36)}`;
  const call = async (method: string, path: string, body?: object, token = owner.token, key = randomUUID()) => {
    const response = await app.handle(new Request(`http://main.test${root}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: body ? JSON.stringify(body) : undefined }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const actorQuery = (actor = owner.actor) => `?actingSubject=${encodeURIComponent(actor)}`;
  const roles = async () => (await call('GET', `/roles${actorQuery()}`)).body as { generation: string };
  const command = async (change: RoleCommand['change']): Promise<RoleCommand> => ({ actingSubject: owner.actor,
    expectedGeneration: (await roles()).generation, reason: 'Update Realm staff permissions', change });
  const apply = async (input: RoleCommand, key = randomUUID()) => {
    const preview = await call('POST', '/role-impact', input);
    expect(preview.status).toBe(200);
    const result = await call('POST', '/role-changes', { ...input, impactDigest: preview.body.digest }, owner.token, key);
    return { preview: preview.body as unknown as RoleImpact, result };
  };
  return { stack, owner, moderator, outsider, realm, scope, admin, call, actorQuery, command, apply, roles };
}

test('Realm roles: exact impact matches enforced grants; retries, stale and concurrent changes stay atomic', async () => {
  const s = await setup();
  try {
    const roleId = randomUUID();
    const create = await s.command({ kind: 'role', roleId, name: 'Moderators', permissions: ['governance.moderate'] });
    const created = await s.apply(create);
    expect(created.result.status).toBe(201);
    expect(created.preview).toMatchObject({ exact: true, affectedCount: 0 });
    expect((await s.call('GET', `/roles${s.actorQuery(s.outsider.actor)}`, undefined, s.outsider.token)).status).toBe(403);
    const assignment = await s.command({ kind: 'assignment', roleId, member: s.moderator.actor,
      assigned: true, validUntil: new Date(Date.now() + 600_000).toISOString() });
    const key = randomUUID();
    const assigned = await s.apply(assignment, key);
    expect(assigned.result.status).toBe(201);
    expect(assigned.preview.changes).toEqual([{ member: s.moderator.actor, gained: ['governance.moderate'], lost: [] }]);
    expect((await s.call('GET', `/moderation${s.actorQuery(s.moderator.actor)}`, undefined, s.moderator.token)).status).toBe(200);
    const replay = await s.call('POST', '/role-changes', { ...assignment, impactDigest: assigned.preview.digest }, s.owner.token, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, receiptId: assigned.result.body.receiptId });
    expect((await s.call('POST', '/role-changes', { ...assignment, reason: 'Different intent',
      impactDigest: assigned.preview.digest }, s.owner.token, key)).status).toBe(409);
    expect((await s.call('POST', '/role-impact', assignment)).status).toBe(409);
    const revoke = await s.command({ kind: 'role', roleId, name: 'Moderators', permissions: [] });
    const preview = await s.call('POST', '/role-impact', revoke);
    expect(preview.status).toBe(200);
    // A concurrently acquired independent grant changes effective impact.
    await s.moderator.grant(s.scope, 'governance.moderate');
    expect((await s.call('POST', '/role-changes', { ...revoke, impactDigest: preview.body.digest })).status).toBe(409);
    const independent = await s.apply(revoke);
    expect(independent.preview.affectedCount).toBe(0);
    expect((await s.call('GET', `/moderation${s.actorQuery(s.moderator.actor)}`, undefined, s.moderator.token)).status).toBe(200);
    const race = await s.command({ kind: 'role', roleId, name: 'Staff', permissions: ['governance.rule.publish'] });
    const basis = await s.call('POST', '/role-impact', race);
    const results = await Promise.all([1, 2].map(() => s.call('POST', '/role-changes', { ...race, impactDigest: basis.body.digest })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    // The actual Governance owner accepts the materialized role permission.
    const published = await new GovernanceRules(s.stack.accessPool).publish(s.moderator.principal, {
      actingSubject: s.moderator.actor, ref: `urn:realm-rule:${randomUUID()}`, scopeId: s.scope,
      expectedRevision: null, document: { title: 'Be kind' }, idempotencyKey: randomUUID() });
    expect(published.revision).toBe('1');
    const removed = await s.apply(await s.command({ ...assignment.change, kind: 'assignment', roleId,
      member: s.moderator.actor, assigned: false, validUntil: new Date(Date.now() + 60_000).toISOString() }));
    expect(removed.result.status).toBe(201);
    expect(removed.preview.changes).toEqual([{ member: s.moderator.actor, gained: [], lost: ['governance.rule.publish'] }]);
    await expect(new GovernanceRules(s.stack.accessPool).publish(s.moderator.principal, {
      actingSubject: s.moderator.actor, ref: published.ref, scopeId: s.scope,
      expectedRevision: '1', document: { title: 'Changed' }, idempotencyKey: randomUUID() })).rejects.toThrow('authority is missing');
    await s.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    expect((await s.call('GET', `/roles${s.actorQuery()}`)).status).toBe(503);
    await s.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
  } finally { await s.stack.stop(); }
}, 120_000);

test('Realm settings: atomic rule CAS, localization, submission restrictions and unsupported profiles', async () => {
  const s = await setup();
  try {
    const empty = await s.call('GET', `/settings${s.actorQuery()}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ generation: '0', settings: { visibility: 'public', reviewRequired: true,
      whoMaySubmit: 'granted', rules: [] }, ruleBasis: { revision: null } });
    const input = { actingSubject: s.owner.actor, expectedGeneration: '0', expectedRulesRevision: null,
      reason: 'Require community membership', settings: { visibility: 'public', reviewRequired: true,
        whoMaySubmit: 'members', rules: [{ id: 'kindness', title: { en: 'Be kind', 'zh-CN': '友善交流' },
          body: { en: 'Discuss ideas respectfully.', 'zh-CN': '尊重他人，理性讨论。' }, governanceRule: null }] } };
    const key = randomUUID();
    const changed = await s.call('PUT', '/settings', input, s.owner.token, key);
    expect(changed.status).toBe(201);
    expect(changed.body.settings).toEqual(input.settings);
    const basis = changed.body.ruleBasis as { ref: string; revision: string; digest: string };
    expect(await new GovernanceRules(s.stack.accessPool).current(basis.ref, s.scope))
      .toEqual({ revision: basis.revision, digest: basis.digest });
    expect(await new GovernanceRules(s.stack.accessPool).publishedRealmRules(s.realm)).toEqual(input.settings.rules);
    const sameDocument = await new GovernanceRules(s.stack.accessPool).publish(s.owner.principal, {
      scopeId: s.scope, ref: `urn:comparison:${randomUUID()}`, actingSubject: s.owner.actor,
      expectedRevision: null, document: { rules: input.settings.rules, public: true, profile: 'realm-settings-rules-v1' },
      idempotencyKey: randomUUID() });
    expect(sameDocument.digest).toBe(basis.digest);
    expect((await s.call('PUT', '/settings', input, s.owner.token, key)).body.replayed).toBe(true);
    expect((await s.call('PUT', '/settings', input)).status).toBe(409);
    expect((await s.call('PUT', '/settings', { ...input, expectedGeneration: '1',
      settings: { ...input.settings, visibility: 'private' } })).status).toBe(400);
    expect((await s.call('PUT', '/settings', { ...input, expectedGeneration: '1',
      settings: { ...input.settings, reviewRequired: false } })).status).toBe(400);
    const external = new GovernanceRules(s.stack.accessPool);
    await external.publish(s.owner.principal, { ref: basis.ref, scopeId: s.scope, actingSubject: s.owner.actor,
      expectedRevision: basis.revision, document: { rules: input.settings.rules }, idempotencyKey: randomUUID() });
    expect(await external.publishedRealmRules(s.realm)).toBeNull();
    expect((await s.call('PUT', '/settings', { ...input, expectedGeneration: '1', expectedRulesRevision: basis.revision })).status).toBe(409);
    await s.outsider.grant(`submission:submit:${s.realm}`, 'submission.submit');
    const id = () => `https://rezics.com/id/${randomUUID()}`;
    const denied = await s.call('POST', '/submissions', { actingSubject: s.outsider.actor,
      kind: 'contribution', work: id(), mainVersion: id(), contribution: id(),
      publicationDecision: id(), selectedDraft: id(), correctionOf: null }, s.outsider.token);
    expect(denied.status).toBe(403);
    expect((await s.stack.accessPool.query('SELECT count(*)::int AS n FROM access.realm_submission WHERE realm = $1', [s.realm])).rows[0].n).toBe(0);
  } finally { await s.stack.stop(); }
}, 120_000);

test('Realm owner enrollment: server receipt binds creator; repeat enrollment never revives a grant', async () => {
  const s = await setup();
  try {
    expect((await s.call('POST', '/management', { actingSubject: s.owner.actor }, s.outsider.token)).status).toBe(403);
    const initialized = await s.call('POST', '/management', { actingSubject: s.owner.actor });
    expect(initialized.status).toBe(200);
    expect(initialized.body.replayed).toBe(false);
    await s.stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND action = 'realm.roles.manage'`, [s.scope]);
    const replay = await s.call('POST', '/management', { actingSubject: s.owner.actor });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await s.call('GET', `/roles${s.actorQuery()}`)).status).toBe(403);
  } finally { await s.stack.stop(); }
}, 120_000);

test('Realm role complexity: an oversized impact fails without applying a partial role edit', async () => {
  const s = await setup();
  try {
    const roleId = randomUUID();
    const created = await s.apply(await s.command({ kind: 'role', roleId, name: 'Large team', permissions: [] }));
    expect(created.result.status).toBe(201);
    const members = Array.from({ length: REALM_ADMIN_COST.assignments + 1 }, () => `https://rezics.com/id/${randomUUID()}`);
    await s.stack.accessPool.query(`INSERT INTO access.authority_subject (id,kind)
      SELECT id,'agent' FROM unnest($1::text[]) AS id`, [members]);
    await s.stack.accessPool.query(`INSERT INTO access.realm_admin_assignment (realm,role_id,member,valid_until)
      SELECT $1,$2,member,now() + interval '5 minutes' FROM unnest($3::text[]) AS member`, [s.realm, roleId, members]);
    const input = await s.command({ kind: 'role', roleId, name: 'Large team', permissions: ['governance.moderate'] });
    expect((await s.call('POST', '/role-impact', input)).status).toBe(422);
    expect((await s.call('POST', '/role-changes', { ...input, impactDigest: 'a'.repeat(64) })).status).toBe(422);
    expect((await s.roles()).generation).toBe('1');
    expect((await s.stack.accessPool.query(`SELECT count(*)::int AS n FROM access.realm_admin_role_grant
      WHERE realm = $1`, [s.realm])).rows[0].n).toBe(0);
  } finally { await s.stack.stop(); }
}, 120_000);

test('Realm queue: escalation is scoped, receipted, visible in queue and audit, and invalidates cursors', async () => {
  const s = await setup();
  try {
    const cases = [randomUUID(), randomUUID()];
    for (const id of cases) await s.stack.accessPool.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','realm',$2,$3,'graph',$4,'title','private')`,
    [id, s.scope, s.realm, `https://rezics.com/id/${randomUUID()}`]);
    const before = await s.call('GET', `/moderation${s.actorQuery()}&limit=1`);
    expect(before.status).toBe(200);
    const input = { actingSubject: s.owner.actor, expectedGeneration: '0', reason: 'Owner review required',
      itemKind: 'report', itemId: cases[0], expectedItemGeneration: '0' };
    const key = randomUUID();
    const escalated = await s.call('POST', '/escalations', input, s.owner.token, key);
    expect(escalated.status).toBe(201);
    expect((await s.call('POST', '/escalations', input, s.owner.token, key)).body.replayed).toBe(true);
    const queue = await s.call('GET', `/moderation${s.actorQuery()}`);
    const items = queue.body.items as { id: string; escalation: unknown }[];
    expect(items.find(i => i.id === cases[0])?.escalation).toMatchObject({ reason: input.reason, target: 'owners' });
    expect((await s.call('GET', `/moderation${s.actorQuery()}&limit=1&cursor=${String(before.body.nextCursor)}`)).status).toBe(409);
    const audit = await s.call('GET', `/audit${s.actorQuery()}&kind=realm_management`);
    expect(audit.status).toBe(200);
    expect(audit.body.items).toMatchObject([{ id: escalated.body.receiptId, reason: input.reason }]);
    expect((await s.call('POST', '/escalations', { ...input, expectedGeneration: '1', itemId: randomUUID() })).status).toBe(409);
    expect((await s.call('POST', '/escalations', { ...input, expectedGeneration: '1', itemKind: 'submission' })).status).toBe(403);
    const count = await s.stack.accessPool.query('SELECT count(*)::int AS n FROM access.realm_admin_receipt WHERE realm = $1', [s.realm]);
    expect(count.rows[0].n).toBe(1);
  } finally { await s.stack.stop(); }
}, 120_000);

test('Realm members: recipient consent, dated roster, removal, temporary bans and immutable audit', async () => {
  const s = await setup();
  try {
    await s.stack.accessPool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution')`, [s.realm]);
    await s.stack.accessPool.query(`INSERT INTO access.membership_policy
      (kind,owner_subject,revision,terms_revision) VALUES ('realm',$1,1,'terms-v1')`, [s.realm]);
    await s.moderator.grant('work:create:root', 'access.membership.consent');
    const input = { actingSubject: s.owner.actor, member: s.moderator.actor, expectedGeneration: '0',
      expectedMembershipGeneration: '0', reason: 'Join the community', action: 'add',
      consent: randomUUID(), durationSeconds: null };
    expect((await s.call('POST', '/members', input)).status).toBe(403);
    const consent = await new AccessMembershipConsents(s.stack.accessPool).issue({
      principal: s.moderator.principal, kind: 'realm', ownerSubject: s.realm, memberSubject: s.moderator.actor,
      expectedGeneration: '0', expectedPolicyRevision: '1', termsRevision: 'terms-v1',
      idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const key = randomUUID();
    const added = await s.call('POST', '/members', { ...input, consent: consent.consentReference }, s.owner.token, key);
    expect(added.status).toBe(201);
    expect((await s.call('POST', '/members', { ...input, consent: consent.consentReference }, s.owner.token, key)).body.replayed).toBe(true);
    const roster = await s.call('GET', `/members${s.actorQuery()}&search=${encodeURIComponent(s.moderator.actor)}`);
    expect(roster.status).toBe(200);
    expect(roster.body.items).toMatchObject([{ member: s.moderator.actor, state: 'joined', membershipGeneration: '1' }]);
    expect((roster.body.items as { joinedAt: string }[])[0]!.joinedAt).toBeString();
    await s.moderator.grant(`reply:place:${s.realm}`, 'reply.place');
    const pending = await s.stack.access.register({ principal: s.moderator.principal,
      actingSubject: s.moderator.actor, action: 'reply.place', scope: `reply:place:${s.realm}`,
      idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) });
    const ban = { ...input, action: 'ban', expectedGeneration: '1', expectedMembershipGeneration: '1',
      consent: null, durationSeconds: 60, reason: 'Repeated rule violations' };
    const banned = await s.call('POST', '/members', ban);
    expect(banned.status).toBe(201);
    await expect(s.stack.access.claim(pending.id, 'b'.repeat(64))).rejects.toThrow('banned');
    expect((await s.call('GET', `/members${s.actorQuery()}`)).body.items).toMatchObject([
      { member: s.moderator.actor, banned: true, bannedUntil: banned.body.bannedUntil }]);
    const client = await s.stack.accessPool.connect();
    try {
      expect(await realmMemberProof(client, s.realm, s.moderator.principalId, s.moderator.actor)).toBeNull();
      await client.query(`UPDATE access.membership_ban SET expires_at = now() - interval '1 second'
        WHERE kind = 'realm' AND owner_subject = $1`, [s.realm]);
      expect(await realmMemberProof(client, s.realm, s.moderator.principalId, s.moderator.actor)).toStartWith('agent:');
    } finally { client.release(); }
    expect((await s.call('POST', '/members', { ...ban, durationSeconds: null, expectedGeneration: '2' })).status).toBe(201);
    const unbanned = await s.call('POST', '/members', { ...ban, action: 'unban', durationSeconds: null,
      expectedGeneration: '3' });
    expect(unbanned.status).toBe(201);
    expect(unbanned.body.banned).toBe(false);
    expect((await s.call('POST', '/members', { ...ban, action: 'remove', durationSeconds: null,
      expectedGeneration: '4' })).status).toBe(201);
    const receipts = await s.stack.accessPool.query(`SELECT count(*)::int AS n FROM access.realm_admin_receipt WHERE realm = $1`, [s.realm]);
    expect(receipts.rows[0].n).toBe(5);
    await expect(s.stack.accessPool.query(`DELETE FROM access.realm_admin_receipt WHERE realm = $1`, [s.realm]))
      .rejects.toMatchObject({ code: '23514' });
  } finally { await s.stack.stop(); }
}, 120_000);
