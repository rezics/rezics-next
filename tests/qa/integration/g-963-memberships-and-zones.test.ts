import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { AccessMemberships } from '../../../services/main/src/modules/access/memberships.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { configureFollowGraph } from '../../../services/main/src/modules/follows/recovery.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { readCompositionPage } from '../../../services/main/src/modules/structure/read.ts';

test('G-963: self-leave ends only the current episode, preserves bans/history and only removes join-sourced interest', async () => {
  const home = await startHomeStack('g-963-leave');
  try {
    const { stack, call, json } = home;
    const owner = await home.provision('Realm owner', home.author.token);
    const reader = await home.provision('Leaving member', home.reader.token);
    const principal = { ...home.reader.principal, emailVerified: true };
    const ownerPrincipal = { ...home.author.principal, emailVerified: true };
    const created = await json<{ realm: string; space: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Leave freely', capabilities: ['realm'], actingSubject: owner,
    }, home.author.token), 201);
    const admin = new AccessRealmManagement(stack.accessPool);
    const joining = new AccessRealmJoining(stack.accessPool, stack.env);
    const memberships = new AccessMemberships(stack.accessPool);
    configureFollowGraph(stack.accessPool, stack.fuseki);
    Object.assign(home.deps, { realmJoining: joining, memberships });
    await admin.initialize(ownerPrincipal, created.realm, owner, stack.env);
    const settings = await admin.settings(ownerPrincipal, created.realm, owner, stack.env);
    await admin.changeSettings(ownerPrincipal, created.realm, {
      actingSubject: owner, expectedGeneration: settings.generation,
      expectedRulesRevision: settings.ruleBasis.revision, reason: 'Open membership',
      settings: { ...settings.settings, selfJoin: true },
    }, randomUUID(), stack.env);
    const join = async () => {
      const policy = await joining.policyFor(principal, created.realm, reader);
      return json<{ membershipId: string; membershipGeneration: string }>(await call('POST',
        `/v1/realms/${created.realm.slice(-36)}/join`, { actingSubject: reader,
          expectedMembershipGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
          termsRevision: policy.termsRevision, listed: false }, home.reader.token));
    };
    const joined = await join();
    const policy = await joining.policyFor(principal, created.realm, reader);
    const body = { profile: 'access-membership-change-v1', kind: 'realm', ownerSubject: created.realm,
      memberSubject: reader, action: 'leave', expectedGeneration: joined.membershipGeneration,
      expectedPolicyRevision: policy.policyRevision };
    const leave = (command = body, key = randomUUID(), token = home.reader.token) =>
      call('POST', '/v1/access/membership-changes', command, token, key);
    expect((await leave({ ...body, memberSubject: owner })).status).toBe(403);
    const grant = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until,membership_id,membership_generation)
      VALUES ($1,$2,$3,'work:create:root','work.create',now()+interval '1 hour',$4,$5)`,
    [grant, owner, reader, joined.membershipId, joined.membershipGeneration]);
    await stack.accessPool.query(`INSERT INTO access.membership_ban(kind,owner_subject,member_subject,reason_ref)
      VALUES ('realm',$1,$2,'preserved-ban')`, [created.realm, reader]);
    const before = await home.deps.follows.state(created.space, { principal, agent: reader });
    expect(before).toMatchObject({ following: true, source: 'join' });
    const key = randomUUID();
    const [first, concurrent] = await Promise.all([leave(body, key), leave(body, key)]);
    const ended = await json<{ generation: string; state: string; replayed: boolean }>(first);
    expect(ended.state).toBe('left');
    expect(await json(concurrent)).toMatchObject({ generation: ended.generation, state: 'left' });
    expect(await json(await leave(body, key))).toMatchObject({ generation: ended.generation, replayed: true });
    expect(await json(await leave({ ...body, expectedGeneration: ended.generation })))
      .toMatchObject({ generation: ended.generation, state: 'left' });
    expect((await leave(body)).status).toBe(409);
    expect(await home.deps.follows.state(created.space, { principal, agent: reader }))
      .toMatchObject({ following: false, source: 'join' });
    expect((await stack.accessPool.query('SELECT active FROM access.permission_grant WHERE id=$1', [grant])).rows[0].active).toBe(false);
    expect((await stack.accessPool.query(`SELECT active FROM access.membership_ban
      WHERE kind='realm' AND owner_subject=$1 AND member_subject=$2`, [created.realm, reader])).rows[0].active).toBe(true);
    expect((await stack.accessPool.query(`SELECT state FROM access.membership_history
      WHERE membership_id=$1 ORDER BY generation`, [joined.membershipId])).rows.map(row => row.state))
      .toEqual(['joined', 'left']);
    await stack.accessPool.query(`UPDATE access.membership_ban SET active=false
      WHERE kind='realm' AND owner_subject=$1 AND member_subject=$2`, [created.realm, reader]);
    const next = await join();
    const interest = await home.deps.follows.state(created.space, { principal, agent: reader });
    await json(await call('POST', '/v1/follows', { profile: 'follow-command-v1', target: created.space,
      actingSubject: reader, following: true, expectedRevision: interest.revision }, home.reader.token));
    await json(await leave({ ...body, expectedGeneration: next.membershipGeneration }));
    expect(await home.deps.follows.state(created.space, { principal, agent: reader }))
      .toMatchObject({ following: true, source: 'explicit' });
  } finally { await home.stop(); }
});

test('G-963: Zone-only creation uses ordinary Space authority, retries once and serves public/unlisted/private sites', async () => {
  const home = await startHomeStack('g-963-zone-space');
  try {
    const { stack, call, json } = home;
    const owner = await home.provision('Site owner', home.author.token);
    const outsider = await home.provision('Other reader', home.reader.token);
    const key = randomUUID();
    const command = { profile: 'space-zone-v1', name: 'موقع مستقل', language: 'ar',
      handle: `site-${randomUUID().slice(0, 12)}`, capabilities: ['zone'], actingSubject: owner,
      visibility: 'public', listing: 'unlisted' };
    expect((await call('POST', '/v1/spaces', { ...command, actingSubject: outsider }, home.author.token)).status).toBe(403);
    const created = await json<{ space: string; zone: string; navigation: string;
      navigationRevision: string; zoneRevision: string; capabilities: string[] }>(
      await call('POST', '/v1/spaces', command, home.author.token, key), 201);
    expect(created.capabilities).toEqual(['zone']);
    expect(await json(await call('POST', '/v1/spaces', command, home.author.token, key)))
      .toMatchObject({ ...created, replayed: true });
    expect((await call('POST', '/v1/spaces', { ...command, listing: 'listed' }, home.author.token, key)).status).toBe(409);
    expect((await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.space)} rv:realmCapability ?realm } }`, 1024)).boolean).toBe(false);
    expect(await json(await call('GET', `/v1/spaces/${created.space.slice(-36)}`)))
      .toMatchObject({ name: command.name, capabilities: ['zone'], listing: 'unlisted', direction: 'rtl' });
    expect(await readCompositionHeader(stack.env, created.navigation))
      .toMatchObject({ owner: created.zone, head: created.navigationRevision, profile: 'zone-navigation' });
    expect(await readCompositionPage(stack.env, { structure: created.navigation, limit: 20 }))
      .toMatchObject({ occurrences: [], next: null });
    const root = `/v1/zones/${created.zone.slice(-36)}`;
    const homeRead = await call('GET', `${root}/routes?path=%2F`);
    expect(await json(homeRead)).toMatchObject({ kind: 'home', realm: null, name: command.name });
    const presentation = await call('GET', `${root}/presentation`);
    expect(await json(presentation)).toMatchObject({ zone: created.zone, realm: null, name: command.name,
      navigation: [], address: { key: command.handle } });
    expect(await json(await call('GET', `/v1/addresses/resolve?scope=space&key=${command.handle}`)))
      .toMatchObject({ holder: created.space, capabilities: { zone: created.zone } });
    await json(await call('PUT', `${root}/configuration`, { expectedHead: created.zoneRevision,
      actingSubject: owner, name: 'Renamed independent site', language: 'en' }, home.author.token));
    const secret = await json<{ space: string; zone: string }>(await call('POST', '/v1/spaces', {
      ...command, handle: undefined, name: 'Private site', visibility: 'private', listing: 'unlisted',
    }, home.author.token), 201);
    const privateRoot = `/v1/zones/${secret.zone.slice(-36)}`;
    expect((await call('GET', `${privateRoot}/routes?path=%2F`)).status).toBe(404);
    expect((await call('GET', `${privateRoot}/presentation?actingSubject=${encodeURIComponent(outsider)}`,
      undefined, home.reader.token)).status).toBe(404);
    expect(await json(await call('GET', `${privateRoot}/routes?path=%2F&actingSubject=${encodeURIComponent(owner)}`,
      undefined, home.author.token))).toMatchObject({ kind: 'home', realm: null, name: 'Private site' });
    expect((await call('GET', `/v1/spaces/${secret.space.slice(-36)}`)).status).toBe(404);
    // The relay must consume the new owner event without inventing a Realm.
    await home.project();
  } finally { await home.stop(); }
});
