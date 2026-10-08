import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccessRealmManagement, realmAdminScope } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { ManagementReadStore } from '../../../services/main/src/modules/management-reads/read-store.ts';
import { startMediaStack } from './media-support.ts';

function keysOf(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => keysOf(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { keys.push(key); keysOf(item, keys); }
  }
  return keys;
}

test('a banned member reads their own ban and appeal, and every other caller gets the same absence', async () => {
  const stack = await startMediaStack('realm-member-ban');
  const owner = await stack.member('owner');
  const banned = await stack.member('banned');
  const other = await stack.member('other');
  const members = [owner, banned, other];
  try {
    await owner.grant('space:create:root', 'space.create');
    const created = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Member ban realm',
      capabilities: ['realm'], actingSubject: owner.actor });
    expect(created.status).toBe(201);
    const realm = (await created.json() as { realm: string }).realm;
    const realmId = realm.slice(-36);
    const scope = realmAdminScope(realm);
    for (const action of ['realm.owner', 'governance.moderate', 'realm.members.manage']) await owner.grant(scope, action);
    await banned.grant(`agent:control:${banned.actor}`, 'agent.control');
    await other.grant(`agent:control:${other.actor}`, 'agent.control');
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
    const root = `/v1/realms/${realmId}`;
    const call = async (method: string, path: string, body?: object, token?: string, key?: string) => {
      const response = await app.handle(new Request(`http://main.test${path}`, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined }));
      const text = await response.text();
      const headers = [...response.headers.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return { status: response.status, text, headers, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
    };
    const memberBan = (id: string, subject: string) =>
      `${root.replace(realmId, id)}/member-ban?${new URLSearchParams({ actingSubject: subject })}`;
    // Full response bytes. A request id, if one is present, is the only field allowed to differ.
    const signature = (response: { status: number; text: string; headers: [string, string][] }) => {
      const body = response.text.replace(/"(requestId|request_id|request-id)"\s*:\s*"[^"]*"/g, '"$1":"*"');
      const headers = response.headers
        .filter(([name]) => !['x-request-id', 'request-id', 'traceparent', 'tracestate'].includes(name.toLowerCase()))
        .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
        .join('\n');
      return `${response.status}\n${headers}\n${body}`;
    };
    const hidden = (body: unknown) => {
      expect(keysOf(body).filter(key => /acting.?subject|decider|moderator|principal/i.test(key))).toEqual([]);
      const raw = JSON.stringify(body);
      expect(raw.includes(owner.actor)).toBe(false);
      expect(raw.includes(owner.principalId)).toBe(false);
      expect(raw.includes('acting_subject')).toBe(false);
      expect(raw.includes('actingSubject')).toBe(false);
    };
    const realmGeneration = async () => (await pool.query<{ generation: string }>(
      `SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1`, [realm])).rows[0]?.generation ?? '0';
    const ban = async (reason: string, durationSeconds: number | null) => {
      const result = await call('POST', `${root}/members`, {
        actingSubject: owner.actor, member: banned.actor, expectedGeneration: await realmGeneration(),
        expectedMembershipGeneration: '0', reason, action: 'ban', consent: null, durationSeconds,
      }, owner.token, randomUUID());
      expect({ status: result.status, body: result.body }).toMatchObject({ status: 201 });
      return String(result.body.receiptId);
    };
    const own = () => call('GET', memberBan(realmId, banned.actor), undefined, banned.token);
    const probes = () => Promise.all([
      call('GET', memberBan(realmId, banned.actor)),
      call('GET', memberBan(realmId, banned.actor), undefined, other.token),
      call('GET', memberBan(realmId, banned.actor), undefined, owner.token),
      call('GET', memberBan(randomUUID(), banned.actor), undefined, banned.token),
    ]);
    const decidedAt = async (caseId: string) => {
      const row = (await pool.query<{ decided_at: Date }>(
        `SELECT d.decided_at FROM access.moderation_decision d
         JOIN access.governance_case c ON c.decision_head = d.id WHERE c.id = $1`, [caseId])).rows[0];
      return row!.decided_at.toISOString();
    };
    const appeal = async (receiptId: string, statement: string) => {
      const opened = await call('POST', `${root}/member-receipts/${receiptId}/appeal`, { statement }, banned.token, randomUUID());
      expect(opened.status).toBe(201);
      return String(opened.body.caseId);
    };
    const decide = async (caseId: string, outcome: 'dismiss' | 'restore', disclosure: string, rationale: string) => {
      const key = randomUUID();
      const result = await call('POST', '/v1/moderation/decisions', {
        profile: 'moderation-decision-v1', outcome, caseId, expectedGeneration: '0',
        actingSubject: owner.actor, targets: [],
        rule: { ref: 'urn:rule:unused', revision: '1', digest: 'a'.repeat(64) },
        evidenceDigest: 'b'.repeat(64), reversesDecisionId: null, answersStepId: null,
        rationale, disclosure, idempotencyKey: key,
        reasons: { facts: 'The statement was read.', scope: 'Realm membership', duration: 'The ban is unchanged.',
          automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
      }, owner.token, key);
      expect({ status: result.status, body: result.body }).toMatchObject({ status: 200, body: { outcome, replayed: false } });
    };
    const baseline = await own();
    expect(baseline.status).toBe(404);
    expect(baseline.body).toEqual({ type: 'https://rezics.com/problems/appeal_unavailable', title: 'Appeal is unavailable',
      status: 404, code: 'appeal_unavailable' });
    const before = await probes();
    for (const probe of before) expect(signature(probe)).toBe(signature(baseline));
    const older = await ban('Older reason', null);
    const permanent = await own();
    expect(permanent.status).toBe(200);
    expect(permanent.body).toMatchObject({ realm, receiptId: older, action: 'ban', reason: 'Older reason',
      bannedUntil: null, permanent: true, appeal: { state: 'none' } });
    expect(typeof permanent.body.happenedAt).toBe('string');
    hidden(permanent.body);
    const whileBanned = await probes();
    // Controller guard: another member and the moderator still get absence, not the ban.
    expect(whileBanned[1]!.status).toBe(404);
    expect(whileBanned[2]!.status).toBe(404);
    expect(whileBanned[1]!.text.includes('Older reason')).toBe(false);
    expect(whileBanned[1]!.text.includes(older)).toBe(false);
    for (const probe of whileBanned) expect(signature(probe)).toBe(signature(baseline));
    const current = await ban('Current reason', 86_400);
    const timed = await own();
    expect(timed.status).toBe(200);
    expect(timed.body).toMatchObject({ realm, receiptId: current, action: 'ban', reason: 'Current reason',
      permanent: false, appeal: { state: 'none' } });
    expect(timed.body.receiptId).not.toBe(older);
    expect(typeof timed.body.bannedUntil).toBe('string');
    hidden(timed.body);
    const statement = 'I was banned in error.';
    const caseId = await appeal(current, statement);
    const opened = await own();
    expect(opened.status).toBe(200);
    expect(opened.body.appeal).toEqual({ state: 'open', caseId, statement });
    expect(opened.body.appeal).not.toHaveProperty('decidedAt');
    hidden(opened.body);
    const privateRationale = 'Kept for the moderators.';
    await decide(caseId, 'dismiss', 'private', privateRationale);
    const privateRead = await own();
    expect(privateRead.status).toBe(200);
    expect(privateRead.body.appeal).toEqual({ state: 'decided', caseId, statement, outcome: 'dismiss',
      rationale: null, decidedAt: await decidedAt(caseId) });
    expect(JSON.stringify(privateRead.body).includes(privateRationale)).toBe(false);
    hidden(privateRead.body);
    const partiesReceipt = await ban('Parties reason', null);
    const partiesStatement = 'Please share the rationale.';
    const partiesCase = await appeal(partiesReceipt, partiesStatement);
    const partiesRationale = 'Shared with the member.';
    await decide(partiesCase, 'restore', 'parties', partiesRationale);
    const partiesRead = await own();
    expect(partiesRead.body).toMatchObject({ receiptId: partiesReceipt, reason: 'Parties reason', permanent: true,
      appeal: { state: 'decided', caseId: partiesCase, statement: partiesStatement, outcome: 'reversed',
        rationale: partiesRationale, decidedAt: await decidedAt(partiesCase) } });
    const partiesAppeal = partiesRead.body.appeal as { liftedAt: string; liftReceiptId: string };
    expect(partiesAppeal.liftedAt).toEqual(expect.any(String));
    expect(partiesAppeal.liftReceiptId).toMatch(/^[0-9a-f-]{36}$/);
    hidden(partiesRead.body);
    const summaryReceipt = await ban('Summary reason', null);
    const summaryStatement = 'A public summary is enough.';
    const summaryCase = await appeal(summaryReceipt, summaryStatement);
    const summaryRationale = 'A public summary of the appeal.';
    await decide(summaryCase, 'dismiss', 'public_summary', summaryRationale);
    const summaryRead = await own();
    expect(summaryRead.body).toMatchObject({ receiptId: summaryReceipt, reason: 'Summary reason',
      appeal: { state: 'decided', caseId: summaryCase, statement: summaryStatement, outcome: 'dismiss',
        rationale: summaryRationale, decidedAt: await decidedAt(summaryCase) } });
    hidden(summaryRead.body);
    await pool.query(`UPDATE access.membership_ban SET expires_at = clock_timestamp() - interval '1 second'
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`, [realm, banned.actor]);
    const expired = await own();
    expect(signature(expired)).toBe(signature(baseline));
    const afterExpiry = await probes();
    for (const probe of afterExpiry) expect(signature(probe)).toBe(signature(baseline));
  } finally { await stack.stop(); }
}, 180_000);
