import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccessRealmManagement, realmAdminScope } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { startMediaStack } from './media-support.ts';

function keysOf(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => keysOf(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { keys.push(key); keysOf(item, keys); }
  }
  return keys;
}

test('a banned member appeals once, moderators resolve it without unbanning, and the read hides the decider', async () => {
  const stack = await startMediaStack('realm-sanction-appeal');
  const owner = await stack.member('owner');
  const banned = await stack.member('banned');
  const other = await stack.member('other');
  const otherModerator = await stack.member('other-moderator');
  const members = [owner, banned, other, otherModerator];
  try {
    await owner.grant('space:create:root', 'space.create');
    const created = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Appeal realm',
      capabilities: ['realm'], actingSubject: owner.actor });
    expect(created.status).toBe(201);
    const realm = (await created.json() as { realm: string }).realm;
    const scope = realmAdminScope(realm);
    for (const action of ['realm.owner', 'governance.moderate', 'realm.members.manage']) await owner.grant(scope, action);
    await banned.grant(`agent:control:${banned.actor}`, 'agent.control');
    await other.grant(`agent:control:${other.actor}`, 'agent.control');
    const otherRealm = `https://rezics.com/id/${randomUUID()}`;
    await otherModerator.grant(realmAdminScope(otherRealm), 'governance.moderate');
    const pool = stack.accessPool;
    for (const member of members) {
      const grantId = randomUUID();
      await pool.query(`INSERT INTO access.principal_permission_grant
        (id,issuer_subject,principal_id,scope_id,action,valid_until)
        VALUES ($1,$2,$3,'platform:access','platform:use:realm-appeals',now()+interval '1 hour')`,
      [grantId, member.actor, member.principalId]);
      await pool.query(`INSERT INTO access.platform_grant_episode
        (id,principal_grant_id,issuer_subject,permission,scope_id,assigned_by_principal,receipt)
        VALUES ($1,$1,$2,'platform:use:realm-appeals','platform:access',$3,$4)`,
      [grantId, member.actor, member.principalId,
        `urn:rezics:access-receipt:${createHash('sha256').update(grantId).digest('hex')}`]);
    }
    await pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution') ON CONFLICT DO NOTHING`, [realm]);
    await pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,1,'terms-v1') ON CONFLICT DO NOTHING`, [realm]);
    const revision = await pool.query<{ generation: string }>(
      `SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1`, [realm]);
    const store = new GovernanceStore(pool,
      { capture: async () => { throw new Error('sanction appeals do not capture evidence'); } },
      { current: async () => { throw new Error('sanction appeals do not read target heads'); } },
      { current: async () => { throw new Error('sanction appeals do not read rules'); } });
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      realmAdmin: new AccessRealmManagement(pool), platformAccess: new AccessExposure(pool),
      governance: { store }, account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = members.find(candidate => candidate.token === token);
        if (!member) throw new AccountAssertionDenied('Bearer required');
        return member.principal;
      } } });
    const root = `/v1/realms/${realm.slice(-36)}`;
    const call = async (method: string, path: string, body?: object, token?: string, key?: string) => {
      const response = await app.handle(new Request(`http://main.test${path}`, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined }));
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
    };
    const appeal = `${root}/member-receipts`;
    const hidden = (body: unknown) => {
      expect(keysOf(body).filter(key => /acting.?subject|decider|moderator|principal/i.test(key))).toEqual([]);
      const raw = JSON.stringify(body);
      expect(raw.includes(owner.actor)).toBe(false);
      expect(raw.includes(owner.principalId)).toBe(false);
      expect(raw.includes('acting_subject')).toBe(false);
      expect(raw.includes('actingSubject')).toBe(false);
    };
    const anonymous = await call('POST', `${appeal}/${randomUUID()}/appeal`, { statement: 'I appeal.' });
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.code).toBe('platform_closed');
    const unsigned = await call('GET', `${appeal}/${randomUUID()}/appeal`, undefined, 'not-a-token');
    expect(unsigned.status).toBe(401);
    const bannedBody = { actingSubject: owner.actor, member: banned.actor,
      expectedGeneration: revision.rows[0]?.generation ?? '0', expectedMembershipGeneration: '0',
      reason: 'Repeated rule violations', action: 'ban', consent: null, durationSeconds: null };
    const ban = await call('POST', `${root}/members`, bannedBody, owner.token, randomUUID());
    expect({ status: ban.status, body: ban.body }).toMatchObject({ status: 201 });
    const receiptId = String(ban.body.receiptId);
    const path = `${appeal}/${receiptId}/appeal`;
    expect((await call('POST', path, { statement: 'I appeal.' }, banned.token)).body.code).toBe('invalid_idempotency_key');
    expect((await call('POST', path, { statement: 'I appeal.' }, other.token, randomUUID())).status).toBe(404);
    expect((await call('GET', path, undefined, other.token)).status).toBe(404);
    expect((await call('POST', path, { statement: 'I appeal.' }, otherModerator.token, randomUUID())).status).toBe(404);
    expect((await call('GET', path, undefined, otherModerator.token)).status).toBe(404);
    expect((await call('POST', path, { statement: 'I appeal.' }, owner.token, randomUUID())).status).toBe(404);
    const before = await call('GET', path, undefined, banned.token);
    expect(before.status).toBe(200);
    expect(before.body.appeal).toEqual({ state: 'none' });
    hidden(before.body);
    const key = randomUUID();
    const opened = await call('POST', path, { statement: 'I was banned in error.' }, banned.token, key);
    expect({ status: opened.status, body: opened.body }).toMatchObject({ status: 201, body: { replayed: false, state: 'open' } });
    const caseId = String(opened.body.caseId);
    const replay = await call('POST', path, { statement: 'I was banned in error.' }, banned.token, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ caseId, replayed: true, state: 'open' });
    const changed = await call('POST', path, { statement: 'A different statement.' }, banned.token, key);
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('idempotency_conflict');
    const second = await call('POST', path, { statement: 'Please review this again.' }, banned.token, randomUUID());
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('appeal_already_open');
    const reading = await call('GET', path, undefined, owner.token);
    expect(reading.status).toBe(200);
    expect(reading.body).toMatchObject({ realm, receiptId, action: 'ban', reason: 'Repeated rule violations',
      bannedUntil: null, permanent: true, appeal: { state: 'open', caseId, statement: 'I was banned in error.' } });
    expect(typeof reading.body.happenedAt).toBe('string');
    hidden(reading.body);
    const decisionKey = randomUUID();
    const staleKey = randomUUID();
    const decision = { profile: 'moderation-decision-v1', outcome: 'restore', caseId, expectedGeneration: '0',
      actingSubject: owner.actor, targets: [], rule: { ref: 'urn:rule:unused', revision: '1', digest: 'a'.repeat(64) },
      evidenceDigest: 'b'.repeat(64), reversesDecisionId: null, answersStepId: null,
      rationale: 'The ban remains in place.', disclosure: 'parties', idempotencyKey: decisionKey,
      reasons: { facts: 'The statement was read.', scope: 'Realm membership', duration: 'The ban is unchanged.',
        automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' } };
    const stale = await call('POST', '/v1/moderation/decisions', { ...decision, expectedGeneration: '9',
      idempotencyKey: staleKey }, owner.token, staleKey);
    expect(stale.status).toBe(409);
    const decided = await call('POST', '/v1/moderation/decisions', decision, owner.token, decisionKey);
    expect({ status: decided.status, body: decided.body }).toMatchObject({ status: 200,
      body: { outcome: 'restore', replayed: false } });
    const resolved = await call('GET', path, undefined, banned.token);
    expect(resolved.status).toBe(200);
    expect(resolved.body.appeal).toEqual({ state: 'decided', caseId, statement: 'I was banned in error.',
      outcome: 'restore', rationale: 'The ban remains in place.' });
    hidden(resolved.body);
    const banRow = await pool.query<{ active: boolean; reason_ref: string }>(`SELECT active, reason_ref
      FROM access.membership_ban WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`,
    [realm, banned.actor]);
    expect(banRow.rows[0]).toEqual({ active: true, reason_ref: receiptId });
    const again = await call('POST', path, { statement: 'I was banned in error.' }, banned.token, key);
    expect(again.body).toMatchObject({ caseId, replayed: true, state: 'decided' });
  } finally { await stack.stop(); }
}, 180_000);
