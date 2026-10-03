import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessMemberships } from '../../../services/main/src/modules/access/memberships.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import type { FollowResult } from '../../../services/main/src/modules/follows/contract.ts';
import { startMediaStack } from './media-support.ts';

interface Policy {
  policyRevision: string;
  termsRevision: string;
  membershipGeneration: string;
}

test('G-1007: public Follow → Highlights → Join → Leave retains interest; Join alone leaves no follow', async () => {
  const s = await startMediaStack('g-1007-public-follow');
  try {
    const owner = await s.member('owner'), reader = await s.member('reader'), newcomer = await s.member('newcomer'),
      legacy = await s.member('legacy');
    const people = [owner, reader, newcomer, legacy];
    const app = createMainApp(s.fuseki, {
      environment: s.env, access: s.access,
      agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      realmAdmin: new AccessRealmManagement(s.accessPool),
      realmJoining: new AccessRealmJoining(s.accessPool, s.env),
      memberships: new AccessMemberships(s.accessPool), follows: new FollowsStore(s.accessPool),
      account: { verify: async request => {
        const person = people.find(candidate => request.headers.get('authorization') === `Bearer ${candidate.token}`);
        if (!person) throw new AccountAssertionDenied('Authentication required');
        const principal = { ...person.principal, emailVerified: true };
        return { ...principal, currentAssertion: async () => principal };
      } },
    });
    const call = (person: typeof owner, method: string, path: string, body?: object, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        authorization: `Bearer ${person.token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(pending: Promise<Response> | Response, status = 200): Promise<T> => {
      const response = await pending, body = await response.text();
      expect({ status: response.status, ...(response.status === status ? {} : { body }) }).toEqual({ status });
      return JSON.parse(body) as T;
    };
    const provision = async (person: typeof owner) => (await json<{ agent: string }>(call(person, 'POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: person.name,
    }), 201)).agent;
    const ownerAgent = await provision(owner), readerAgent = await provision(reader), newcomerAgent = await provision(newcomer),
      legacyAgent = await provision(legacy);
    const { realm, space } = await json<{ realm: string; space: string }>(call(owner, 'POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'G-1007 community', language: 'en', capabilities: ['realm'], actingSubject: ownerAgent,
    }), 201);
    const root = `/v1/realms/${realm.slice(-36)}`, settingsPath = `/v1/spaces/${space.slice(-36)}/settings`;
    await json(call(owner, 'POST', `${root}/management`, { actingSubject: ownerAgent }));
    const current = await json<{ generation: string; settings: object }>(
      call(owner, 'GET', `${settingsPath}?actingSubject=${encodeURIComponent(ownerAgent)}`));
    await json(call(owner, 'PUT', settingsPath, { actingSubject: ownerAgent, expectedGeneration: current.generation,
      reason: 'Exercise independent follow and membership', settings: { ...current.settings, visibility: 'public', admission: 'open' } }), 201);
    const state = (person: typeof owner, agent: string) => json<FollowResult>(call(person, 'GET',
      `/v1/me/follow-state?target=${encodeURIComponent(space)}&kind=space&actingSubject=${encodeURIComponent(agent)}`));
    const inventory = (person: typeof owner, agent: string, kind: 'follows' | 'memberships') =>
      json<{ items: object[] }>(call(person, 'GET', `/v1/me/${kind}?actingSubject=${encodeURIComponent(agent)}&q=G-1007`));
    const policy = (person: typeof owner, agent: string) => json<Policy>(call(person, 'GET',
      `${root}/joining?actingSubject=${encodeURIComponent(agent)}`));
    const join = async (person: typeof owner, agent: string) => {
      const basis = await policy(person, agent), key = randomUUID();
      const body = { actingSubject: agent, expectedMembershipGeneration: basis.membershipGeneration,
        expectedPolicyRevision: basis.policyRevision, termsRevision: basis.termsRevision, listed: false };
      expect((await call(person, 'POST', `${root}/join`, { ...body, expectedPolicyRevision: '0' })).status).toBe(409);
      const receipts = await Promise.all([json<{ membershipGeneration: string; replayed: boolean }>(
        call(person, 'POST', `${root}/join`, body, key)), json<{ membershipGeneration: string; replayed: boolean }>(
        call(person, 'POST', `${root}/join`, body, key))]);
      expect(receipts.map(receipt => receipt.replayed).sort()).toEqual([false, true]);
      expect(receipts[0]!.membershipGeneration).toBe(receipts[1]!.membershipGeneration);
      expect(await json(call(person, 'POST', `${root}/join`, body, key))).toMatchObject({
        membershipGeneration: receipts[0]!.membershipGeneration, replayed: true,
      });
      return receipts[0]!.membershipGeneration;
    };
    const leave = async (person: typeof owner, agent: string, generation: string) => {
      const basis = await policy(person, agent), key = randomUUID();
      const body = { profile: 'access-membership-change-v1', kind: 'realm', ownerSubject: realm,
        memberSubject: agent, action: 'leave', expectedGeneration: generation, expectedPolicyRevision: basis.policyRevision };
      expect((await call(person, 'POST', '/v1/access/membership-changes', { ...body, expectedGeneration: '0' })).status).toBe(409);
      const left = await json(call(person, 'POST', '/v1/access/membership-changes', body, key));
      expect(left).toMatchObject({ state: 'left' });
      expect(await json(call(person, 'POST', '/v1/access/membership-changes', body, key))).toMatchObject({
        ...(left as object), replayed: true,
      });
      expect((await inventory(person, agent, 'memberships')).items).toEqual([]);
    };
    const followed = await json<FollowResult>(call(reader, 'POST', '/v1/follows', {
      profile: 'follow-command-v1', target: space, actingSubject: readerAgent, following: true, expectedRevision: null, level: 'all',
    }));
    const highlights = await json<FollowResult>(call(reader, 'POST', '/v1/follows', {
      profile: 'follow-command-v1', target: space, actingSubject: readerAgent, following: true,
      expectedRevision: followed.revision, level: 'highlights', pinPosition: 3,
    }));
    const retained = { following: true, source: 'explicit', level: 'highlights', pinPosition: 3, revision: highlights.revision };
    for (let episode = 0; episode < 2; episode++) {
      const generation = await join(reader, readerAgent);
      expect(await state(reader, readerAgent)).toMatchObject(retained);
      expect((await inventory(reader, readerAgent, 'memberships')).items).toMatchObject([
        { space, following: true, source: 'explicit', level: 'highlights' },
      ]);
      await leave(reader, readerAgent, generation);
      expect(await state(reader, readerAgent)).toMatchObject(retained);
      expect((await inventory(reader, readerAgent, 'follows')).items).toMatchObject([
        { id: space, source: 'explicit', level: 'highlights', pinPosition: 3, revision: highlights.revision },
      ]);
    }
    for (let episode = 0; episode < 2; episode++) {
      const generation = await join(newcomer, newcomerAgent);
      expect(await state(newcomer, newcomerAgent)).toMatchObject({ following: true, source: 'join', level: 'highlights' });
      await leave(newcomer, newcomerAgent, generation);
      expect(await state(newcomer, newcomerAgent)).toMatchObject({ following: false, source: 'join' });
      expect((await inventory(newcomer, newcomerAgent, 'follows')).items).toEqual([]);
    }
    // A pre-canonicalization Realm follow is proven explicit intent. Join
    // must expose the same settings in both the membership and follow APIs.
    const legacyRevision = randomUUID();
    await s.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,source,level,pin_position)
      VALUES($1,$2,'realm',$3,true,$4,'explicit','off',7)`, [legacy.principalId, realm, legacyAgent, legacyRevision]);
    const generation = await join(legacy, legacyAgent);
    expect((await inventory(legacy, legacyAgent, 'memberships')).items).toMatchObject([
      { space, following: true, source: 'explicit', level: 'off', pinPosition: 7 },
    ]);
    await leave(legacy, legacyAgent, generation);
    expect(await state(legacy, legacyAgent)).toMatchObject({ following: true, source: 'explicit', level: 'off', pinPosition: 7,
      revision: legacyRevision });
    expect((await inventory(legacy, legacyAgent, 'follows')).items).toMatchObject([
      { id: space, source: 'explicit', level: 'off', pinPosition: 7, revision: legacyRevision },
    ]);
  } finally { await s.stop(); }
}, 180_000);

test('G-1007: automatic relationships retain explicit/library bells, aliases and opt-outs under recovery and concurrency', async () => {
  const s = await startMediaStack('g-1007-automatic-follow');
  try {
    const reader = await s.member('reader');
    const automatic = (target: string, enabled: boolean, newEpisode = false, origin = 'join') =>
      s.accessPool.query<{ applied: boolean }>('SELECT access.automatic_follow($1,$2,$3,$4,$5,$6,NULL,$7) AS applied',
        [reader.principalId, reader.actor, target, 'space', origin, enabled, newEpisode]);
    const row = async (target: string) => (await s.accessPool.query(
      'SELECT following,source,level,pin_position,revision::text,changed_at FROM access.follow WHERE principal_id=$1 AND target=$2',
      [reader.principalId, target])).rows[0];
    for (const source of ['explicit', 'library'] as const) for (const level of ['all', 'highlights', 'off']) {
      const target = `urn:rezics:id:${randomUUID()}`;
      await s.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,source,level,pin_position)
        VALUES($1,$2,'space',$3,true,$4,$5,$6,4)`, [reader.principalId, target, reader.actor, randomUUID(), source, level]);
      const before = await row(target);
      for (const newEpisode of [true, false]) {
        await automatic(target, true, newEpisode);
        await automatic(target, false);
        expect(await row(target)).toEqual(before);
      }
    }
    // An explicit opt-out stays off during reconciliation, while a deliberate
    // fresh Join renews interest without downgrading its original source or bell.
    const optedOut = `urn:rezics:id:${randomUUID()}`;
    await s.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,source,level)
      VALUES($1,$2,'space',$3,false,$4,'explicit','off')`, [reader.principalId, optedOut, reader.actor, randomUUID()]);
    const before = await row(optedOut);
    await automatic(optedOut, true);
    expect(await row(optedOut)).toEqual(before);
    await automatic(optedOut, true, true);
    expect(await row(optedOut)).toMatchObject({ following: true, source: 'explicit', level: 'off' });
    await automatic(optedOut, false);
    expect(await row(optedOut)).toMatchObject({ following: true, source: 'explicit', level: 'off' });

    const space = `urn:rezics:id:${randomUUID()}`, realm = `urn:rezics:id:${randomUUID()}`;
    await s.accessPool.query('INSERT INTO access.follow_space_alias(alias,space,realm) VALUES($1,$2,$1),($2,$2,$1)', [realm, space]);
    await s.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,source,level,pin_position)
      VALUES($1,$2,'realm',$3,true,$4,'explicit','all',2)`, [reader.principalId, realm, reader.actor, randomUUID()]);
    const aliasBefore = await row(realm);
    await automatic(space, true, true);
    await automatic(space, false);
    expect(await row(space)).toEqual(aliasBefore);
    expect(await row(realm)).toBeUndefined();
    // Leave must also clear legacy join interest if recovery has not yet
    // canonicalized its Realm alias.
    await s.accessPool.query("UPDATE access.follow SET target=$2,kind='realm',source='join' WHERE principal_id=$1 AND target=$3",
      [reader.principalId, realm, space]);
    await automatic(space, false);
    expect(await row(realm)).toMatchObject({ following: false, source: 'join', level: 'all', pin_position: null });
    const fresh = `urn:rezics:id:${randomUUID()}`;
    await Promise.all([automatic(fresh, true, true), automatic(fresh, true, true)]);
    const joined = await row(fresh);
    expect(joined).toMatchObject({ following: true, source: 'join', level: 'highlights' });
    await automatic(fresh, true, true);
    expect(await row(fresh)).toEqual(joined);
    await automatic(fresh, false);
    expect(await row(fresh)).toMatchObject({ following: false, source: 'join' });
    // The shared function still promotes/removes automatic Library interest.
    const work = `urn:rezics:id:${randomUUID()}`;
    await automatic(work, true, false, 'library');
    expect(await row(work)).toMatchObject({ following: true, source: 'library', level: 'all' });
    await automatic(work, false, false, 'library');
    expect(await row(work)).toMatchObject({ following: false, source: 'library', level: 'all' });
    const inventory = (await s.accessPool.query(`SELECT active_count,
      (SELECT count(*)::integer FROM access.follow WHERE principal_id=$1 AND following) AS actual
      FROM access.follow_inventory WHERE principal_id=$1`, [reader.principalId])).rows[0];
    expect(inventory.active_count).toBe(inventory.actual);
  } finally { await s.stop(); }
}, 180_000);

test('G-1007: migration leaves overwritten provenance ambiguous rather than guessing from old Follow receipts', async () => {
  const s = await startMediaStack('g-1007-follow-repair');
  const client = await s.accessPool.connect();
  try {
    const reader = await s.member('reader'), target = `urn:rezics:id:${randomUUID()}`;
    await client.query('BEGIN');
    await client.query(readFileSync(new URL('../../../services/main/migrations/access/1014_relationship_follows.sql', import.meta.url), 'utf8')
      .split('CREATE FUNCTION access.automatic_follow')[1]!.split('CREATE FUNCTION access.membership_follow')[0]!
      .replace(/^\(/, 'CREATE OR REPLACE FUNCTION access.automatic_follow('));
    const explicitRevision = randomUUID();
    await client.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,source,level)
      VALUES($1,$2,'space',$3,true,$4,'explicit','off')`, [reader.principalId, target, reader.actor, explicitRevision]);
    await client.query(`INSERT INTO access.follow_receipt(principal_id,idempotency_key,request_digest,result)
      VALUES($1,$2,$3,$4)`, [reader.principalId, randomUUID(), '0'.repeat(64), {
        profile: 'follow-receipt-v1', target, kind: 'space', actingSubject: reader.actor,
        following: true, revision: explicitRevision, source: 'explicit', level: 'off', pinPosition: null, replayed: false,
      }]);
    await client.query("SELECT access.automatic_follow($1,$2,$3,'space','join',true,NULL,true)", [reader.principalId, reader.actor, target]);
    const before = (await client.query('SELECT * FROM access.follow WHERE principal_id=$1 AND target=$2', [reader.principalId, target])).rows[0];
    expect(before).toMatchObject({ source: 'join', following: true, level: 'off' });
    await client.query(readFileSync(new URL('../../../services/main/migrations/access/1028_preserve_follow_provenance.sql', import.meta.url), 'utf8'));
    expect((await client.query('SELECT * FROM access.follow WHERE principal_id=$1 AND target=$2', [reader.principalId, target])).rows[0]).toEqual(before);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await s.stop();
  }
}, 180_000);
