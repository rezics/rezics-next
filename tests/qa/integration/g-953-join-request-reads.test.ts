import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { RealmJoinRequests } from '../../../services/main/src/modules/realm-admin/join-requests.ts';
import { allocateAgentHandle } from '../../../services/main/src/modules/agent/handle.ts';

async function fixture(label: string) {
  const s = await startMediaStack(label);
  const owner = await s.member('manager');
  const people = await Promise.all(['Ａｌｉｃｅ 王','Other requester','Alice 王','Different requester','王 Alice','Literal_%\\']
    .map(name => s.member(name)));
  const noRequest = await s.member('no-request');
  const members = [owner,...people,noRequest];
  for (const member of members) await member.grant('work:create:root','agent.control');
  // These isolated Access fixtures model the existing immutable active name
  // source. They deliberately use no Account names as searchable public text.
  for (const member of people) {
    const representation = (await s.accessPool.query(`SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,[member.principalId,member.actor])).rows[0].id;
    await s.accessPool.query(`INSERT INTO access.agent_provision
      (id,principal_id,idempotency_key,request_digest,agent_id,agent_kind,display_name,principal_epoch,state,
        graph_data_epoch,graph_sequence,representation_id)
      VALUES ($1,$2,$3,$4,$5,'person',$6,0,'active',$7,0,$8)`,
    [randomUUID(),member.principalId,randomUUID(),'0'.repeat(64),member.actor,member.name,s.env.lineage.dataEpoch,representation]);
  }
  await owner.grant('space:create:root','space.create');
  const created = await owner.send('POST','/v1/spaces',{ profile: 'space-realm-v1',name: 'Search requests',
    capabilities: ['realm'],actingSubject: owner.actor });
  expect(created.status).toBe(201);
  const { realm,space } = await created.json() as { realm: string; space: string };
  const admin = new AccessRealmManagement(s.accessPool);
  await admin.initialize(owner.principal,realm,owner.actor,s.env);
  const settings = await admin.spaceSettings(owner.principal,space,owner.actor,s.env);
  await admin.changeSpaceSettings(owner.principal,space,{ actingSubject: owner.actor,expectedGeneration: settings.generation,
    reason: 'Require join requests',settings: { visibility: 'private',listing: 'unlisted',history: 'from-admission',admission: 'request' } },randomUUID(),s.env);
  const app = createMainApp(s.fuseki,{ environment: s.env,access: s.access,realmAdmin: admin,
    realmJoinRequests: new RealmJoinRequests(s.accessPool,s.env),account: { verify: async request => {
      const member = members.find(item => request.headers.get('authorization') === `Bearer ${item.token}`);
      if (!member) throw new Error('Unknown fixture bearer');
      return member.principal;
    } } });
  const root = `/v1/realms/${realm.slice(-36)}/join-requests`;
  const call = async (method: string,path: string,body?: object,member = owner,actingSubject = member.actor) => {
    const url = new URL(`http://main.test${path}`);
    if (method === 'GET') url.searchParams.set('actingSubject',actingSubject);
    const response = await app.handle(new Request(url,{ method,headers: { authorization: `Bearer ${member.token}`,
      'content-type': 'application/json','idempotency-key': randomUUID() },body: body ? JSON.stringify(body) : undefined }));
    return { status: response.status,body: await response.json() as Record<string,any>,headers: response.headers };
  };
  const request = async (member = people[0]!) => {
    const basis = await call('GET',`${root}/basis`,undefined,member);
    expect(basis.status,JSON.stringify(basis.body)).toBe(200);
    const sent = await call('POST',root,{ actingSubject: member.actor,expectedMembershipGeneration: basis.body.membershipGeneration,
      expectedPolicyRevision: basis.body.policyRevision,termsRevision: basis.body.termsRevision,reason: 'Join' },member);
    expect(sent.status,JSON.stringify(sent.body)).toBe(201);
    return sent.body.requestId as string;
  };
  const decide = async (id: string,decision: 'accepted'|'declined') => {
    const current = await admin.spaceSettings(owner.principal,space,owner.actor,s.env);
    const result = await call('POST',`${root}/${id}/decisions`,{ actingSubject: owner.actor,
      expectedGeneration: current.generation,expectedRequestGeneration: '0',decision,reason: 'Review request' });
    expect(result.status,JSON.stringify(result.body)).toBe(201);
  };
  return { s,owner,people,noRequest,realm,space,admin,root,call,request,decide };
}

test('G-953: database search traverses matching pages, folds Unicode and filters native/current handles before paging', async () => {
  const f = await fixture('g-953-inbox');
  try {
    const ids = await Promise.all(f.people.map(person => f.request(person)));
    for (const q of ['alice','王']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ q,limit: '1',...(cursor ? { cursor } : {}) });
        const page = await f.call('GET',`${f.root}?${query}`);
        expect(page.status,JSON.stringify(page.body)).toBe(200);
        expect(page.body.items).toHaveLength(1);
        expect(page.body.complete).toBe(page.body.nextCursor === null);
        expect(page.headers.get('cache-control')).toBe('private, no-store');
        seen.push(page.body.items[0].id);
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual([ids[0],ids[2],ids[4]].sort());
    }
    const literal = await f.call('GET',`${f.root}?q=${encodeURIComponent('_%\\')}`);
    expect(literal.body.items.map((item: { id: string }) => item.id)).toEqual([ids[5]]);
    const native = await f.call('GET',`${f.root}?q=${allocateAgentHandle(f.people[1]!.actor)}`);
    expect(native.body.items.map((item: { id: string }) => item.id)).toEqual([ids[1]]);
    const handle = `current_${randomUUID().replaceAll('-','').slice(0,12)}`;
    const retired = `retired_${randomUUID().replaceAll('-','').slice(0,12)}`;
    await f.s.accessPool.query(`INSERT INTO access.agent_handle (handle,agent_id,state,retired_until)
      VALUES ($1,$2,'current',NULL),($3,$2,'retired','infinity')`,[handle,f.people[1]!.actor,retired]);
    expect((await f.call('GET',`${f.root}?q=@${handle}`)).body.items.map((item: { id: string }) => item.id)).toEqual([ids[1]]);
    expect((await f.call('GET',`${f.root}?q=${retired}`)).body).toMatchObject({ items: [],complete: true,nextCursor: null });
    const first = await f.call('GET',`${f.root}?q=alice&limit=1`);
    expect((await f.call('GET',`${f.root}?q=other&cursor=${first.body.nextCursor}`)).status).toBe(409);
    await f.request(f.noRequest);
    expect((await f.call('GET',`${f.root}?q=alice&cursor=${first.body.nextCursor}`)).status).toBe(409);
    const beforeWithdrawal = await f.call('GET',`${f.root}?q=alice&limit=1`);
    expect((await f.call('POST',`${f.root}/${ids[5]}/withdraw`,{ actingSubject: f.people[5]!.actor,
      expectedRequestGeneration: '0',reason: 'Withdraw' },f.people[5])).status).toBe(201);
    expect((await f.call('GET',`${f.root}?q=alice&cursor=${beforeWithdrawal.body.nextCursor}`)).status).toBe(409);
    const beforeDecision = await f.call('GET',`${f.root}?q=alice&limit=1`);
    await f.decide(ids[1]!,'declined');
    expect((await f.call('GET',`${f.root}?q=alice&cursor=${beforeDecision.body.nextCursor}`)).status).toBe(409);
    expect((await f.call('GET',f.root,undefined,f.people[0])).status).toBe(403);
    const current = await f.call('GET',`${f.root}?q=alice&limit=1`);
    await f.s.accessPool.query(`UPDATE access.representation SET generation = generation + 1
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,[f.owner.principalId,f.owner.actor]);
    expect((await f.call('GET',`${f.root}?q=alice&cursor=${current.body.nextCursor}`)).status).toBe(409);
    await f.s.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'realm.members.manage'`,[f.owner.actor,`governance:realm:${f.realm}`]);
    expect((await f.call('GET',f.root)).status).toBe(403);
  } finally { await f.s.stop(); }
},180_000);

test('G-953: own status survives every decision and policy changes without disclosing other requesters or private Realm existence', async () => {
  const f = await fixture('g-953-own-status');
  try {
    const person = f.people[0]!, other = f.people[1]!;
    const missing = `/v1/realms/${randomUUID()}/join-requests/mine`;
    const absent = await f.call('GET',missing,undefined,f.noRequest);
    expect(absent.status).toBe(404);
    const noRequest = await f.call('GET',`${f.root}/mine`,undefined,f.noRequest);
    expect(noRequest.status).toBe(404);
    expect(noRequest.body).toEqual(absent.body);
    await f.request(other);
    const first = await f.request(person);
    const own = () => f.call('GET',`${f.root}/mine`,undefined,person);
    const pending = await own();
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0]).toMatchObject({ id: first,state: 'pending',decidedAt: null });
    expect((await f.call('GET',`${f.root}/mine`,undefined,other,person.actor)).status).toBe(403);
    // Even a current representative of the same Agent cannot inherit the
    // original requester's private history by changing actingSubject.
    await f.s.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'access.membership.consent',now() + interval '1 hour')`,[randomUUID(),other.principalId,person.actor]);
    const differentRequester = await f.call('GET',`${f.root}/mine`,undefined,other,person.actor);
    expect(differentRequester.status).toBe(404);
    expect(differentRequester.body).toEqual(absent.body);
    expect((await f.call('POST',`${f.root}/${first}/withdraw`,{ actingSubject: person.actor,
      expectedRequestGeneration: '0',reason: 'Withdraw' },person)).status).toBe(201);
    expect((await own()).body.items[0]).toMatchObject({ id: first,state: 'withdrawn',requestGeneration: '1' });
    const second = await f.request(person);
    await f.decide(second,'declined');
    expect((await own()).body.items.find((item: { id: string }) => item.id === second))
      .toMatchObject({ state: 'declined',requestGeneration: '1' });
    const third = await f.request(person);
    await f.decide(third,'accepted');
    const complete = await own();
    expect(complete.body.items).toHaveLength(3);
    expect(complete.body.items.map((item: { state: string }) => item.state).sort()).toEqual(['accepted','declined','withdrawn']);
    for (const item of complete.body.items) {
      expect(item.member).toBe(person.actor);
      const decision = (await f.s.accessPool.query('SELECT decided_at FROM access.realm_join_request_decision WHERE request_id = $1',[item.id])).rows[0];
      expect(item.decidedAt).toBe(decision.decided_at.toISOString());
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await f.call('GET',`${f.root}/mine?limit=1${cursor ? `&cursor=${cursor}` : ''}`,undefined,person);
      expect(page.status).toBe(200);
      seen.push(page.body.items[0].id);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([first,second,third].sort());
    const current = await f.admin.spaceSettings(f.owner.principal,f.space,f.owner.actor,f.s.env);
    await f.admin.changeSpaceSettings(f.owner.principal,f.space,{ actingSubject: f.owner.actor,
      expectedGeneration: current.generation,reason: 'Close requests',settings: { ...current.settings,admission: 'invitation' } },randomUUID(),f.s.env);
    expect((await own()).body.items).toEqual(complete.body.items);
    const page = await f.call('GET',`${f.root}/mine?limit=1`,undefined,person);
    await f.s.accessPool.query(`UPDATE access.representation SET generation = generation + 1
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,[person.principalId,person.actor]);
    expect((await f.call('GET',`${f.root}/mine?cursor=${page.body.nextCursor}`,undefined,person)).status).toBe(409);
    await f.s.accessPool.query(`UPDATE access.representation SET active = false
      WHERE principal_id = $1 AND subject_id = $2`,[person.principalId,person.actor]);
    expect((await own()).status).toBe(403);
  } finally { await f.s.stop(); }
},180_000);
