import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccessRealmManagement, realmAdminScope } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { auditItem, moderationItem } from '../../../services/main/src/modules/management-reads/read-contract.ts';
import { ManagementReadStore } from '../../../services/main/src/modules/management-reads/read-store.ts';
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
      managementReads: new ManagementReadStore(pool, stack.env),
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
    const queueActivity = async (db: PoolClient | typeof pool = pool) => {
      const row = (await db.query<{ open_reports: string; escalated_reports: string; report_activity: string | null }>(
        `SELECT open_reports::text AS open_reports, escalated_reports::text AS escalated_reports,
           to_char(report_activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS report_activity
         FROM access.realm_management_activity WHERE realm = $1`, [realm])).rows[0];
      return {
        open_reports: row?.open_reports ?? '0',
        escalated_reports: row?.escalated_reports ?? '0',
        report_activity: row?.report_activity ?? null,
      };
    };
    const realmGeneration = async () => (await pool.query<{ generation: string }>(
      `SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1`, [realm])).rows[0]?.generation ?? '0';
    const escalateAppeal = async (itemId: string) => call('POST', `${root}/escalations`, {
      actingSubject: owner.actor, expectedGeneration: await realmGeneration(),
      reason: 'This appeal is not a report', expectedItemGeneration: '0',
      itemKind: 'report', itemId,
    }, owner.token, randomUUID());
    // The product refuses the escalation. A stored row must still leave the report counters alone,
    // because closing the appeal does not subtract a count it never added.
    const storedEscalation = async (itemId: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const id = randomUUID();
        await client.query(`INSERT INTO access.realm_admin_receipt
          (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,'governance.moderate','Stored appeal escalation','{}'::jsonb)`,
        [id, realm, owner.principalId, owner.actor, id, createHash('sha256').update(id).digest('hex')]);
        await client.query(`INSERT INTO access.realm_admin_escalation
          (id,realm,item_kind,item_id,reason,acting_subject)
          VALUES ($1,$2,'report',$3,'Stored appeal escalation',$4)`,
        [id, realm, itemId, owner.actor]);
        expect(await queueActivity(client)).toEqual(reportsBefore);
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    const listed = (body: Record<string, unknown>) =>
      Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    const moderation = (suffix = '') => call('GET',
      `${root}/moderation?actingSubject=${encodeURIComponent(owner.actor)}${suffix}`, undefined, owner.token);
    const audit = (suffix = '') => call('GET',
      `${root}/audit?actingSubject=${encodeURIComponent(owner.actor)}${suffix}`, undefined, owner.token);
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
    const reportsBefore = await queueActivity();
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
    const appealTarget = { owner: 'membership', resource: receiptId, component: 'sanction' };
    const openQueue = await moderation();
    const openFiltered = await moderation('&type=realm_sanction_appeal');
    const auditBefore = await audit();
    const resolutionBefore = await audit('&kind=realm_sanction_resolution');
    const appealItem = listed(openQueue.body).find(item => item.id === caseId);
    expect(openQueue.status).toBe(200);
    expect(appealItem).toMatchObject({ kind: 'realm_sanction_appeal', state: 'open', context: realm,
      target: appealTarget, authorAgent: null, reasonCode: null, submission: null, decisionHead: null });
    expect(Value.Check(moderationItem, appealItem)).toBe(true);
    expect(JSON.stringify(openQueue.body).includes('I was banned in error.')).toBe(false);
    expect(openFiltered.status).toBe(200);
    expect(listed(openFiltered.body).filter(item => item.kind === 'realm_sanction_appeal').map(item => item.id))
      .toEqual([caseId]);
    expect(auditBefore.status).toBe(200);
    expect(listed(auditBefore.body).some(item => item.kind === 'realm_sanction_resolution')).toBe(false);
    expect(resolutionBefore.status).toBe(200);
    expect(listed(resolutionBefore.body)).toEqual([]);
    expect(await queueActivity()).toEqual(reportsBefore);
    const refused = await escalateAppeal(caseId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('appeal_not_escalable');
    expect((await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM access.realm_admin_escalation WHERE item_id = $1`, [caseId])).rows[0]?.n).toBe(0);
    expect(await queueActivity()).toEqual(reportsBefore);
    await storedEscalation(caseId);
    expect(await queueActivity()).toEqual(reportsBefore);
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
    const stillOpen = await moderation();
    const closedQueue = await moderation('&state=closed');
    const auditAfter = await audit();
    const resolutionAfter = await audit('&kind=realm_sanction_resolution');
    const closedItem = listed(closedQueue.body).find(item => item.id === caseId);
    const resolution = listed(resolutionAfter.body).find(item => item.caseId === caseId);
    expect(stillOpen.status).toBe(200);
    expect(listed(stillOpen.body).some(item => item.id === caseId)).toBe(false);
    expect(closedQueue.status).toBe(200);
    expect(closedItem).toMatchObject({ kind: 'realm_sanction_appeal', state: 'closed', context: realm,
      target: appealTarget });
    expect(Value.Check(moderationItem, closedItem)).toBe(true);
    expect(JSON.stringify(closedQueue.body).includes('I was banned in error.')).toBe(false);
    expect(auditAfter.status).toBe(200);
    expect(resolutionAfter.status).toBe(200);
    expect(resolution).toMatchObject({ kind: 'realm_sanction_resolution', outcome: 'restore',
      reason: 'The ban remains in place.', target: appealTarget, actingSubject: owner.actor });
    expect(Value.Check(auditItem, resolution)).toBe(true);
    expect(JSON.stringify(auditAfter.body).includes('I was banned in error.')).toBe(false);
    expect(await queueActivity()).toEqual(reportsBefore);
    await otherModerator.grant(`agent:control:${otherModerator.actor}`, 'agent.control');
    const sanction = async (member: typeof other) => {
      const generation = await pool.query<{ generation: string }>(
        `SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1`, [realm]);
      const result = await call('POST', `${root}/members`, { actingSubject: owner.actor, member: member.actor,
        expectedGeneration: generation.rows[0]?.generation ?? '0', expectedMembershipGeneration: '0',
        reason: 'Concurrent sanction', action: 'ban', consent: null, durationSeconds: null,
      }, owner.token, randomUUID());
      expect({ status: result.status, body: result.body }).toMatchObject({ status: 201 });
      return String(result.body.receiptId);
    };
    const race = async (receipt: string, token: string, keys: string[], statement: string) => {
      const results = await Promise.all(keys.map(raceKey =>
        call('POST', `${appeal}/${receipt}/appeal`, { statement }, token, raceKey)));
      const rows = await pool.query<{ appeals: number; cases: number }>(`SELECT
        (SELECT count(*)::int FROM access.realm_sanction_appeal WHERE receipt_id = $1) AS appeals,
        (SELECT count(*)::int FROM access.governance_case
          WHERE kind = 'realm_sanction_appeal' AND target_resource = $1::text) AS cases`, [receipt]);
      return { results, appeals: rows.rows[0]?.appeals, cases: rows.rows[0]?.cases };
    };
    const distinctReceipt = await sanction(other);
    const distinct = await race(distinctReceipt, other.token, Array.from({ length: 8 }, () => randomUUID()),
      'I appeal this sanction.');
    const sameKey = randomUUID();
    const sameReceipt = await sanction(otherModerator);
    const same = await race(sameReceipt, otherModerator.token, Array.from({ length: 8 }, () => sameKey),
      'Please read this appeal.');
    const closed = await race(receiptId, banned.token, Array.from({ length: 8 }, () => randomUUID()),
      'The decision is the last word on this sanction.');
    const outcome = (results: { status: number; body: Record<string, unknown> }[]) => ({
      created: results.filter(result => result.status === 201).length,
      replayed: results.filter(result => result.status === 200 && result.body.replayed === true).length,
      conflicts: results.filter(result => result.status === 409 && result.body.code === 'appeal_already_open').length,
      serverErrors: results.filter(result => result.status >= 500).length,
    });
    const createdCase = same.results.find(result => result.status === 201)?.body.caseId;
    expect({
      distinct: { ...outcome(distinct.results), appeals: distinct.appeals, cases: distinct.cases },
      same: { ...outcome(same.results), appeals: same.appeals, cases: same.cases,
        sharedCase: same.results.every(result => result.body.caseId === createdCase) },
      closed: { ...outcome(closed.results), appeals: closed.appeals, cases: closed.cases },
    }).toEqual({
      distinct: { created: 1, replayed: 0, conflicts: 7, serverErrors: 0, appeals: 1, cases: 1 },
      same: { created: 1, replayed: 7, conflicts: 0, serverErrors: 0, appeals: 1, cases: 1, sharedCase: true },
      closed: { created: 0, replayed: 0, conflicts: 8, serverErrors: 0, appeals: 1, cases: 1 },
    });
    const dismissedCase = String(distinct.results.find(result => result.status === 201)?.body.caseId);
    const refusedAgain = await escalateAppeal(dismissedCase);
    expect(refusedAgain.status).toBe(409);
    expect(refusedAgain.body.code).toBe('appeal_not_escalable');
    expect(await queueActivity()).toEqual(reportsBefore);
    const dismissKey = randomUUID();
    const dismissed = await call('POST', '/v1/moderation/decisions', { ...decision, outcome: 'dismiss',
      caseId: dismissedCase, idempotencyKey: dismissKey, rationale: 'The appeal is dismissed.' },
    owner.token, dismissKey);
    expect({ status: dismissed.status, body: dismissed.body }).toMatchObject({ status: 200,
      body: { outcome: 'dismiss', replayed: false } });
    expect(await queueActivity()).toEqual(reportsBefore);
  } finally { await stack.stop(); }
}, 180_000);
