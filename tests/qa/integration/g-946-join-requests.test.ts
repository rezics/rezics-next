import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { RealmJoinRequests } from '../../../services/main/src/modules/realm-admin/join-requests.ts';
import type { SpaceSettings } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { readRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';

async function fixture(label: string) {
  const s = await startMediaStack(label);
  const owner = await s.member('owner'), a = await s.member('requester-a'), b = await s.member('requester-b'), c = await s.member('requester-c');
  for (const member of [owner,a,b,c]) await member.grant('work:create:root','agent.control');
  await owner.grant('space:create:root','space.create');
  const created = await owner.send('POST','/v1/spaces',{ profile: 'space-realm-v1',name: 'Requests Realm',capabilities: ['realm'],actingSubject: owner.actor });
  expect(created.status).toBe(201);
  const { realm,space } = await created.json() as { realm: string; space: string };
  const admin = new AccessRealmManagement(s.accessPool);
  await admin.initialize(owner.principal,realm,owner.actor,s.env);
  const app = createMainApp(s.fuseki,{ environment: s.env,access: s.access,realmAdmin: admin,realmJoinRequests: new RealmJoinRequests(s.accessPool,s.env),
    account: { verify: async request => [owner,a,b,c].find(member => request.headers.get('authorization') === `Bearer ${member.token}`)!.principal } });
  const root = `/v1/realms/${realm.slice(-36)}/join-requests`;
  const call = async (method: string,path: string,body?: object,member = owner,key = randomUUID()) => {
    const url = new URL(`http://main.test${path}`);
    if (method === 'GET') url.searchParams.set('actingSubject',member.actor);
    const result = await app.handle(new Request(url,{ method,headers: { authorization: `Bearer ${member.token}`,
      'content-type': 'application/json','idempotency-key': key },body: body ? JSON.stringify(body) : undefined }));
    return { status: result.status,body: await result.json() as Record<string,any> };
  };
  const set = async (settings: SpaceSettings) => {
    const basis = await admin.spaceSettings(owner.principal,space,owner.actor,s.env);
    await admin.changeSpaceSettings(owner.principal,space,{ actingSubject: owner.actor,expectedGeneration: basis.generation,
      reason: 'Manage admission',settings },randomUUID(),s.env);
  };
  await set({ visibility: 'private',listing: 'listed',history: 'from-admission',admission: 'request' });
  const request = async (member = a,key = randomUUID()) => {
    const basis = await call('GET',`${root}/basis`,undefined,member);
    expect(basis.status,JSON.stringify(basis.body)).toBe(200);
    const input = { actingSubject: member.actor,expectedMembershipGeneration: basis.body.membershipGeneration,
      expectedPolicyRevision: basis.body.policyRevision,termsRevision: basis.body.termsRevision,reason: 'Join the community' };
    const sent = await call('POST',root,input,member,key);
    return { ...sent,input,key };
  };
  const decide = async (id: string,decision: 'accepted'|'declined' = 'accepted',key = randomUUID()) => {
    const current = await admin.spaceSettings(owner.principal,space,owner.actor,s.env);
    const input = { actingSubject: owner.actor,expectedGeneration: current.generation,expectedRequestGeneration: '0',decision,reason: 'Review request' };
    return { ...await call('POST',`${root}/${id}/decisions`,input,owner,key),input,key };
  };
  const withdraw = (id: string,member = a,key = randomUUID()) => call('POST',`${root}/${id}/withdraw`,{
    actingSubject: member.actor,expectedRequestGeneration: '0',reason: 'Withdraw request' },member,key);
  return { s,owner,a,b,c,realm,space,root,admin,call,set,request,decide,withdraw };
}

test('G-946: requests stay immutable, have one pending episode, paginate, withdraw, decline and accept exactly once without consent', async () => {
  const f = await fixture('g-946-request-lifecycle');
  try {
    const first = await f.request();
    expect(first.status,JSON.stringify(first.body)).toBe(201);
    expect((await f.call('POST',f.root,first.input,f.a,first.key)).body).toMatchObject({ requestId: first.body.requestId,replayed: true });
    expect((await f.request()).status).toBe(409);
    const others = await Promise.all([f.request(f.b),f.request(f.c)]);
    expect(others.map(result => result.status)).toEqual([201,201]);
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = await f.call('GET',`${f.root}?limit=1${after ? `&after=${after}` : ''}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((item: { id: string }) => item.id));
      after = page.body.nextCursor;
    } while (after);
    expect(new Set(seen)).toEqual(new Set([first.body.requestId,...others.map(result => result.body.requestId)]));
    expect((await f.s.accessPool.query('SELECT count(*)::int AS n FROM access.membership_consent WHERE owner_subject = $1',[f.realm])).rows[0].n).toBe(0);
    expect((await f.withdraw(first.body.requestId,f.b)).status).toBe(403);
    const withdrawKey = randomUUID();
    expect((await f.withdraw(first.body.requestId,f.a,withdrawKey)).body.state).toBe('withdrawn');
    expect((await f.withdraw(first.body.requestId,f.a,withdrawKey)).body.replayed).toBe(true);
    expect((await f.withdraw(first.body.requestId)).status).toBe(409);
    expect((await f.request()).status).toBe(201);
    const id = others[0]!.body.requestId;
    const current = await f.admin.spaceSettings(f.owner.principal,f.space,f.owner.actor,f.s.env);
    const input = { actingSubject: f.owner.actor,expectedGeneration: current.generation,expectedRequestGeneration: '0',decision: 'accepted',reason: 'Approve member' };
    expect((await f.call('POST',`${f.root}/${id}/decisions`,{ ...input,actingSubject: f.c.actor },f.c)).status).toBe(403);
    expect((await f.call('POST',`${f.root}/${id}/decisions`,{ ...input,expectedGeneration: '0' })).status).toBe(409);
    const key = randomUUID(), secondKey = randomUUID();
    const race = await Promise.all([f.call('POST',`${f.root}/${id}/decisions`,input,f.owner,key),f.call('POST',`${f.root}/${id}/decisions`,input,f.owner,secondKey)]);
    expect(race.map(result => result.status).sort()).toEqual([201,409]);
    const successful = race.find(result => result.status === 201)!;
    const replay = await f.call('POST',`${f.root}/${id}/decisions`,input,f.owner,race[0]!.status === 201 ? key : secondKey);
    expect(replay.body).toMatchObject({ receiptId: successful.body.receiptId,replayed: true });
    const episode = (await f.s.accessPool.query(`SELECT id,generation::text,consent_reference FROM access.membership WHERE kind = 'realm'
      AND owner_subject = $1 AND member_subject = $2`,[f.realm,f.b.actor])).rows[0];
    expect(episode).toMatchObject({ generation: '1',consent_reference: `urn:rezics:realm-join-request:${id}` });
    expect((await f.s.accessPool.query('SELECT count(*)::int AS n FROM access.realm_history_admission WHERE membership_id = $1',[episode.id])).rows[0].n).toBe(1);
    expect((await f.s.accessPool.query('SELECT count(*)::int AS n FROM access.membership_history WHERE membership_id = $1',[episode.id])).rows[0].n).toBe(1);
    const declined = await f.decide(others[1]!.body.requestId,'declined');
    expect(declined.status,JSON.stringify(declined.body)).toBe(201);
    expect(declined.body.membershipId).toBeNull();
    expect((await f.s.accessPool.query('SELECT count(*)::int AS n FROM access.membership_consent WHERE owner_subject = $1',[f.realm])).rows[0].n).toBe(0);
    expect((await f.call('GET',f.root)).body.items).toHaveLength(1);
    await expect(f.s.accessPool.query('UPDATE access.realm_join_request SET reason = $2 WHERE id = $1',[id,'Edited intent'])).rejects.toMatchObject({ code: '23514' });
    await expect(f.s.accessPool.query('DELETE FROM access.realm_join_request_decision WHERE request_id = $1',[id])).rejects.toMatchObject({ code: '23514' });
  } finally { await f.s.stop(); }
},180_000);

test('G-946: request decisions recheck terms, membership generations, bans and retained requester authority; graph-cut failure rolls every effect back', async () => {
  const f = await fixture('g-946-request-guards');
  try {
    const initial = await f.request();
    await f.s.accessPool.query(`UPDATE access.membership_policy SET revision = revision + 1,terms_revision = 'terms-v2'
      WHERE kind = 'realm' AND owner_subject = $1`,[f.realm]);
    expect((await f.decide(initial.body.requestId)).status).toBe(409);
    expect((await f.call('GET',f.root)).body.items).toHaveLength(1);
    expect((await f.withdraw(initial.body.requestId)).status).toBe(201);
    const banned = await f.request();
    await f.s.accessPool.query(`INSERT INTO access.membership_ban (kind,owner_subject,member_subject,reason_ref)
      VALUES ('realm',$1,$2,'ban')`,[f.realm,f.a.actor]);
    expect((await f.decide(banned.body.requestId)).status).toBe(403);
    expect((await f.withdraw(banned.body.requestId)).status).toBe(201);
    const stale = await f.request(f.b);
    await f.s.accessPool.query(`INSERT INTO access.membership (id,kind,owner_subject,member_subject,state,generation,policy_revision)
      VALUES ($1,'realm',$2,$3,'left',1,2)`,[randomUUID(),f.realm,f.b.actor]);
    expect((await f.decide(stale.body.requestId)).status).toBe(409);
    expect((await f.withdraw(stale.body.requestId,f.b)).status).toBe(201);
    const revoked = await f.request(f.c);
    await f.s.accessPool.query(`UPDATE access.representation SET generation = generation + 1 WHERE principal_id = $1
      AND subject_id = $2 AND action = 'agent.control'`,[f.c.principalId,f.c.actor]);
    expect((await f.decide(revoked.body.requestId)).status).toBe(403);
    expect((await f.decide(revoked.body.requestId,'declined')).status).toBe(201);
    const recoverable = await f.request(f.b);
    const query = f.s.fuseki.query.bind(f.s.fuseki);
    f.s.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT ?sequence WHERE')) throw new Error('Interrupted history cut');
      return query(...args);
    };
    const key = randomUUID();
    const failed = await f.decide(recoverable.body.requestId,'accepted',key);
    expect(failed.status,JSON.stringify(failed.body)).toBe(503);
    f.s.fuseki.query = query;
    expect((await f.s.accessPool.query('SELECT state,generation::text FROM access.membership WHERE member_subject = $1',[f.b.actor])).rows[0])
      .toMatchObject({ state: 'left',generation: '1' });
    expect((await f.s.accessPool.query('SELECT count(*)::int AS n FROM access.realm_join_request_decision WHERE request_id = $1',[recoverable.body.requestId])).rows[0].n).toBe(0);
    expect((await f.s.accessPool.query(`SELECT count(*)::int AS n FROM access.realm_history_admission WHERE membership_id =
      (SELECT id FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2)`,[f.realm,f.b.actor])).rows[0].n).toBe(0);
    const recovered = await f.call('POST',`${f.root}/${recoverable.body.requestId}/decisions`,failed.input,f.owner,key);
    expect(recovered.status,JSON.stringify(recovered.body)).toBe(201);
    expect(recovered.body.membershipGeneration).toBe('2');
    expect((await f.call('POST',`${f.root}/${recoverable.body.requestId}/decisions`,failed.input,f.owner,key)).body.replayed).toBe(true);
  } finally { await f.s.stop(); }
},180_000);

test('G-946: missing and non-request private Realms return identical 404 basis and request problems, including an old request retry', async () => {
  const f = await fixture('g-946-request-disclosure');
  try {
    const old = await f.request();
    const missing = `/v1/realms/${randomUUID()}/join-requests`;
    const missingBasis = await f.call('GET',`${missing}/basis`,undefined,f.a);
    const missingPost = await f.call('POST',missing,old.input,f.a);
    expect(missingBasis.status).toBe(404);
    expect(missingPost.body).toEqual(missingBasis.body);
    for (const admission of ['open','invitation'] as const) {
      await f.set({ visibility: 'private',listing: 'listed',history: 'from-admission',admission });
      const basis = await f.call('GET',`${f.root}/basis`,undefined,f.a);
      const posted = await f.call('POST',f.root,old.input,f.a,old.key);
      expect(basis.status).toBe(404);
      expect(posted.status).toBe(404);
      expect(basis.body).toEqual(missingBasis.body);
      expect(posted.body).toEqual(missingPost.body);
    }
    const legacy = await f.admin.settings(f.owner.principal,f.realm,f.owner.actor,f.s.env);
    await f.admin.changeSettings(f.owner.principal,f.realm,{ actingSubject: f.owner.actor,expectedGeneration: legacy.generation,
      expectedRulesRevision: legacy.ruleBasis.revision,reason: 'Require members for participation',
      settings: { visibility: 'restricted',reviewRequired: true,reviewMode: 'mandatory',whoMaySubmit: 'granted',rules: [] } },randomUUID(),f.s.env);
    await f.set({ visibility: 'public',listing: 'unlisted',history: 'everything',admission: 'invitation' });
    expect((await f.s.accessPool.query('SELECT visibility FROM access.realm_admin_settings WHERE realm = $1',[f.realm])).rows[0].visibility).toBe('restricted');
    expect((await readRealmPolicy(f.s.env,f.realm))!.visibility).toBe('restricted');
  } finally { await f.s.stop(); }
},180_000);
