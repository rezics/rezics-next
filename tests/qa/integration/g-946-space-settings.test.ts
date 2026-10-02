import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { RealmJoinRequests } from '../../../services/main/src/modules/realm-admin/join-requests.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { DisclosureStore } from '../../../services/main/src/modules/disclosure/read.ts';
import { readResourceVisibility } from '../../../services/main/src/modules/space/visibility.ts';
import { deliverRealmPolicy, readRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';
import type { SpaceSettings } from '../../../services/main/src/modules/realm-admin/contract.ts';

test('G-946: Space settings recheck authority, serialize CAS/retries, recover delivery, and disclose only a request page', async () => {
  const s = await startMediaStack('g-946-settings');
  try {
    const owner = await s.member('owner'), outsider = await s.member('outsider');
    await owner.grant('work:create:root','agent.control');
    await owner.grant('space:create:root','space.create');
    const created = await owner.send('POST','/v1/spaces',{ profile: 'space-realm-v1',name: 'Settings Realm',
      capabilities: ['realm'],actingSubject: owner.actor });
    expect(created.status).toBe(201);
    const { realm,space } = await created.json() as { realm: string; space: string };
    const admin = new AccessRealmManagement(s.accessPool);
    await admin.initialize(owner.principal,realm,owner.actor,s.env);
    const requests = new RealmJoinRequests(s.accessPool,s.env);
    const app = createMainApp(s.fuseki,{ environment: s.env,access: s.access,realmAdmin: admin,realmJoinRequests: requests,
      governance: { store: { disclosure: new DisclosureStore(s.accessPool) }, rules: new GovernanceRules(s.accessPool) } as never,
      account: { verify: async request => request.headers.get('authorization') === `Bearer ${owner.token}` ? owner.principal : outsider.principal } });
    const root = `/v1/realms/${realm.slice(-36)}`, settings = `/v1/spaces/${space.slice(-36)}/settings`;
    const call = async (method: string, path: string, body?: object, person: typeof owner | null = owner,key = randomUUID()) => {
      const url = new URL(`http://main.test${path}`);
      if (method === 'GET' && person) url.searchParams.set('actingSubject',person.actor);
      const response = await app.handle(new Request(url,{ method,headers: { 'content-type': 'application/json',
        'idempotency-key': key,...(person ? { authorization: `Bearer ${person.token}` } : {}) },body: body ? JSON.stringify(body) : undefined }));
      return { status: response.status,headers: response.headers,body: await response.json() as Record<string, any> };
    };
    const initial = await call('GET',settings);
    expect(initial.body).toMatchObject({ generation: '0',settings: { visibility: 'public',listing: 'listed',history: 'everything',admission: 'invitation' } });
    expect((await call('GET',settings,undefined,outsider)).status).toBe(403);
    const input = { actingSubject: owner.actor,expectedGeneration: '0',reason: 'Link-only community',
      settings: { visibility: 'public',listing: 'unlisted',history: 'everything',admission: 'open' } satisfies SpaceSettings };
    const key = randomUUID();
    const changed = await call('PUT',settings,input,owner,key);
    expect(changed.status,JSON.stringify(changed.body)).toBe(201);
    expect((await call('PUT',settings,input,owner,key)).body).toMatchObject({ receiptId: changed.body.receiptId,generation: '1',replayed: true });
    expect((await call('PUT',settings,input)).status).toBe(409);
    expect((await call('PUT',settings,{ ...input,reason: 'Different intent' },owner,key)).status).toBe(409);
    expect((await call('PUT',settings,{ ...input,actingSubject: outsider.actor },outsider)).status).toBe(403);
    const header = await call('GET',root,undefined,null);
    expect(header.status,JSON.stringify(header.body)).toBe(200);
    expect(header.headers.get('x-robots-tag')).toBe('noindex');
    expect(header.headers.get('referrer-policy')).toBe('no-referrer');
    expect(header.body).toMatchObject({ listing: 'unlisted',discovery: { indexable: false,robots: 'noindex',referrerPolicy: 'no-referrer' } });
    expect(await readResourceVisibility(s.env,space)).toMatchObject({ readable: true,findable: false });
    const privateInput = { ...input,expectedGeneration: '1',settings: { visibility: 'private',listing: 'listed',
      history: 'from-admission',admission: 'request' } satisfies SpaceSettings };
    const results = await Promise.all([1,2].map(() => call('PUT',settings,privateInput)));
    expect(results.map(result => result.status).sort()).toEqual([201,409]);
    for (const path of [root,`${root}/works`,`${root}/decisions`,`${root}/zone`]) {
      expect((await call('GET',path,undefined,null)).status,path).toBe(404);
    }
    const landing = await call('GET',`${root}/join-page`,undefined,null);
    expect(landing.status,JSON.stringify(landing.body)).toBe(200);
    expect(landing.body).toMatchObject({ profile: 'realm-join-page-v1',name: { value: 'Settings Realm' },action: { kind: 'request',method: 'POST' } });
    for (const key of ['membership','moderators','banner','icon','links','reviewMode']) expect(key in landing.body).toBe(false);
    expect(landing.headers.get('x-robots-tag')).toBe('noindex');
    expect(await readResourceVisibility(s.env,space)).toMatchObject({ readable: false,findable: false,admission: 'request' });
    await outsider.grant('work:create:root','access.membership.consent');
    const p = await call('GET',landing.body.action.basis,undefined,outsider);
    expect(p.status,JSON.stringify(p.body)).toBe(200);
    const requestInput = { actingSubject: outsider.actor,expectedMembershipGeneration: p.body.membershipGeneration,expectedPolicyRevision: p.body.policyRevision,
      termsRevision: p.body.termsRevision,reason: 'Participate in the community' };
    const requestKey = randomUUID();
    const requested = await call('POST',`${root}/join-requests`,requestInput,outsider,requestKey);
    expect(requested.status,JSON.stringify(requested.body)).toBe(201);
    expect((await call('POST',`${root}/join-requests`,requestInput,outsider,requestKey)).body.replayed).toBe(true);
    expect((await call('GET',root,undefined,outsider)).status).toBe(404);
    const inbox = await call('GET',`${root}/join-requests`);
    expect(inbox.status,JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.items).toHaveLength(1);
    const accepted = await call('POST',`${root}/members`,{ actingSubject: owner.actor,member: outsider.actor,
      expectedGeneration: '2',expectedMembershipGeneration: '0',action: 'add',consent: inbox.body.items[0].consent,
      durationSeconds: null,reason: 'Approve request' });
    expect(accepted.status,JSON.stringify(accepted.body)).toBe(201);
    expect((await call('GET',root,undefined,outsider)).status).toBe(200);
    expect((await call('GET',`${root}/join-requests`)).body.items).toEqual([]);
    const cut = await s.access.realmHistoryFloor(outsider.principal,outsider.actor,realm);
    expect(cut?.dataEpoch).toBe(s.env.lineage.dataEpoch);
    expect(cut?.sequence).toMatch(/^\d+$/);
    // A graph failure leaves a durable intent; retry settles the same receipt.
    const command = s.fuseki.commandWithReceipt.bind(s.fuseki);
    s.fuseki.commandWithReceipt = async () => { throw new Error('Interrupted delivery'); };
    const next = { ...input,expectedGeneration: '3',settings: { ...input.settings,admission: 'invitation' as const } };
    const nextKey = randomUUID();
    expect((await call('PUT',settings,next,owner,nextKey)).status).toBe(503);
    s.fuseki.commandWithReceipt = command;
    expect((await call('PUT',settings,next,owner,nextKey)).body).toMatchObject({ replayed: true,generation: '4' });
    expect((await readRealmPolicy(s.env,realm))?.listing).toBe('unlisted');
    await s.accessPool.query(`UPDATE access.permission_grant SET active = false WHERE scope_id = $1
      AND recipient_subject = $2 AND action = 'realm.settings.manage'`,[`governance:realm:${realm}`,owner.actor]);
    expect((await call('PUT',settings,next,owner,nextKey)).status).toBe(403);
  } finally { await s.stop(); }
},180_000);

test('G-946: Agent listing is controller-owned, CAS/idempotent and independent of public profile/library visibility', async () => {
  const s = await startMediaStack('g-946-listing',{ profileCredits: true });
  try {
    const owner = await s.member('owner'), outsider = await s.member('outsider');
    await owner.grant('work:create:root','agent.control');
    const profiles = new ProfilesAccess(s.accessPool);
    const app = createMainApp(s.fuseki,{ environment: s.env,access: s.access,profiles,
      personPreferences: new PersonPreferencesStore(s.accessPool),
      account: { verify: async request => request.headers.get('authorization') === `Bearer ${owner.token}` ? owner.principal : outsider.principal } });
    const path = `/v1/agents/${owner.actor.slice(-36)}`;
    const send = async (method: string,suffix: string,body?: object,person: typeof owner | null = owner,key = randomUUID()) => {
      const response = await app.handle(new Request(`http://main.test${path}${suffix}`,{ method,
        headers: { 'content-type': 'application/json','idempotency-key': key,...(person ? { authorization: `Bearer ${person.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined }));
      return { status: response.status,headers: response.headers,body: await response.json() as Record<string,any> };
    };
    expect((await send('GET','/listing')).body).toMatchObject({ listing: 'listed',version: 0 });
    expect((await send('PUT','/listing',{ listing: 'unlisted',expectedVersion: 0 },outsider)).status).toBe(403);
    const key = randomUUID(), input = { listing: 'unlisted',expectedVersion: 0 };
    expect((await send('PUT','/listing',input,owner,key)).body).toMatchObject({ listing: 'unlisted',version: 1,replayed: false });
    expect((await send('PUT','/listing',input,owner,key)).body.replayed).toBe(true);
    expect((await send('PUT','/listing',input)).status).toBe(409);
    const page = await send('GET','',undefined,null);
    expect(page.status,JSON.stringify(page.body)).toBe(200);
    expect(page.body).toMatchObject({ disclosure: 'public',listing: 'unlisted',library: { visibility: 'private' },discovery: { indexable: false } });
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    for (const suffix of ['/works','/collections']) {
      const linked = await send('GET',suffix,undefined,null);
      expect(linked.status,JSON.stringify(linked.body)).toBe(200);
      expect(linked.headers.get('referrer-policy')).toBe('no-referrer');
      expect(linked.headers.get('x-robots-tag')).toBe('noindex');
    }
    expect(await readResourceVisibility(s.env,owner.actor,{ agentListing: async agent => (await profiles.listing.read(agent)).listing }))
      .toMatchObject({ readable: true,findable: false });
    const race = await Promise.all([1,2].map(() => send('PUT','/listing',{ listing: 'listed',expectedVersion: 1 })));
    expect(race.map(result => result.status).sort()).toEqual([200,409]);
    expect((await send('GET','',undefined,null)).headers.get('x-robots-tag')).toBeNull();
    expect((await profiles.listing.readBatch([owner.actor])).get(owner.actor)).toBe('listed');
  } finally { await s.stop(); }
},120_000);

test('G-946: a policy receipt delivered with the pre-migration envelope replays explicit defaults without another graph command', async () => {
  const s = await startMediaStack('g-946-legacy-policy');
  try {
    const owner = await s.member('owner');
    await owner.grant('space:create:root','space.create');
    const created = await owner.send('POST','/v1/spaces',{ profile: 'space-realm-v1',name: 'Legacy policy',
      capabilities: ['realm'],actingSubject: owner.actor });
    const { realm } = await created.json() as { realm: string };
    const old = { realm,receipt_id: randomUUID(),generation: '1',visibility: 'private' as const,review_mode: 'mandatory' as const };
    await deliverRealmPolicy(s.env,old);
    s.fuseki.commandWithReceipt = async () => { throw new Error('A committed old envelope must not be dispatched again'); };
    await deliverRealmPolicy(s.env,{ ...old,listing: 'listed',history: 'everything',admission: 'invitation' });
    expect(await readRealmPolicy(s.env,realm)).toMatchObject({ visibility: 'private',listing: 'listed',history: 'everything',admission: 'invitation' });
  } finally { await s.stop(); }
},120_000);
