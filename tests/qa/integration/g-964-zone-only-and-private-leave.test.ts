import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { AccessPrivateMemberships } from '../../../services/main/src/modules/access/private-memberships.ts';
import { AccountAssertionInsufficientScope } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { registerFollowSpace } from '../../../services/main/src/modules/follows/targets.ts';

test('G-964: Zone-only routes/presentation/304s expose discovery signals and either identity follows one Realm-free slot', async () => {
  const h = await startHomeStack('g-964-zone-only');
  try {
    const owner = await h.provision('Independent site owner', h.author.token), reader = await h.provision('Site reader', h.reader.token);
    const created = await h.json<{ space: string; zone: string; zoneRevision: string }>(await h.call('POST', '/v1/spaces',
      { profile: 'space-zone-v1', name: 'Link-only site', language: 'en', capabilities: ['zone'],
        visibility: 'public', listing: 'unlisted', actingSubject: owner }, h.author.token), 201);
    const root = `/v1/zones/${created.zone.slice(-36)}`;
    const signals = (response: Response) => {
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    };
    const route = await h.call('GET', `${root}/routes?path=%2F`);
    signals(route);
    expect(await h.json(route)).toMatchObject({ realm: null, listing: 'unlisted', discovery: { indexable: false } });
    const presentation = await h.call('GET', `${root}/presentation`);
    signals(presentation);
    const etag = presentation.headers.get('etag')!;
    expect(await h.json(presentation)).toMatchObject({ realm: null, listing: 'unlisted', discovery: { indexable: false } });
    const cached = await h.app.handle(new Request(`http://main.local${root}/presentation`, { headers: { 'if-none-match': etag } }));
    expect(cached.status).toBe(304);
    signals(cached);
    const follows = await h.json<{ target: string; revision: string }>(await h.call('POST', '/v1/follows',
      { profile: 'follow-command-v1', target: created.zone, kind: 'zone', actingSubject: reader,
        following: true, expectedRevision: null }, h.reader.token));
    expect(follows.target).toBe(created.space);
    const repeated = await h.json<{ target: string }>(await h.call('POST', '/v1/follows',
      { profile: 'follow-command-v1', target: created.space, actingSubject: reader,
        following: true, expectedRevision: follows.revision }, h.reader.token));
    expect(repeated.target).toBe(created.space);
    const aliases = (await h.stack.accessPool.query(`SELECT alias,realm FROM access.follow_space_alias WHERE space=$1 ORDER BY alias`, [created.space])).rows;
    expect(aliases.map(row => row.alias).sort()).toEqual([created.space, created.zone].sort());
    expect(aliases.every(row => row.realm === null)).toBe(true);
    const acting = `actingSubject=${encodeURIComponent(reader)}`;
    expect(await h.json(await h.call('GET', `/v1/me/follows?${acting}`, undefined, h.reader.token)))
      .toMatchObject({ items: [{ id: created.space, kind: 'space', realm: null, available: true, href: expect.stringMatching(/^\/z\//) }] });
    expect(await h.json(await h.call('GET', `/v1/me/follows?${acting}&kind=zone`, undefined, h.reader.token)))
      .toMatchObject({ items: [{ id: created.zone, kind: 'zone', realm: null, available: true }] });
    expect(await h.json(await h.call('GET', `/v1/me/follows?${acting}&kind=realm`, undefined, h.reader.token)))
      .toMatchObject({ items: [] });
    const secret = await h.json<{ space: string; zone: string }>(await h.call('POST', '/v1/spaces',
      { profile: 'space-zone-v1', name: 'Private independent site', language: 'en', capabilities: ['zone'],
        visibility: 'private', listing: 'unlisted', actingSubject: owner }, h.author.token), 201);
    const privateRoot = `/v1/zones/${secret.zone.slice(-36)}`, ownerQuery = `actingSubject=${encodeURIComponent(owner)}`;
    expect((await h.call('POST', '/v1/follows', { profile: 'follow-command-v1', target: secret.space,
      actingSubject: reader, following: true, expectedRevision: null }, h.reader.token)).status).toBe(404);
    await h.json(await h.call('POST', '/v1/follows', { profile: 'follow-command-v1', target: secret.zone,
      actingSubject: owner, following: true, expectedRevision: null }, h.author.token));
    expect(await h.json(await h.call('GET', `/v1/me/follows?${ownerQuery}`, undefined, h.author.token)))
      .toMatchObject({ items: [{ id: secret.space, available: true, realm: null }] });
    const owned = await h.call('GET', `${privateRoot}/presentation?${ownerQuery}`, undefined, h.author.token);
    signals(owned);
    expect(await h.json(owned)).toMatchObject({ discovery: { indexable: false }, realm: null });
    const privateEtag = owned.headers.get('etag')!;
    expect((await h.app.handle(new Request(`http://main.local${privateRoot}/presentation`, { headers: { 'if-none-match': privateEtag } }))).status).toBe(404);
    const privateCached = await h.app.handle(new Request(`http://main.local${privateRoot}/presentation?${ownerQuery}`,
      { headers: { authorization: `Bearer ${h.author.token}`, 'if-none-match': privateEtag } }));
    expect(privateCached.status).toBe(304);
    signals(privateCached);
  } finally { await h.stop(); }
}, 180_000);

test('G-964: private principals self-leave with consent scope through closed/changed admission, retaining history/bans and withdrawing only join-sourced interest', async () => {
  const h = await startHomeStack('g-964-private-leave');
  try {
    const owner = await h.provision('Private Realm owner', h.author.token), reader = await h.provision('Private member', h.reader.token);
    const created = await h.json<{ realm: string; space: string }>(await h.call('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Private membership', capabilities: ['realm'], actingSubject: owner }, h.author.token), 201);
    const admin = new AccessRealmManagement(h.stack.accessPool);
    await admin.initialize({ ...h.author.principal, emailVerified: true }, created.realm, owner, h.stack.env);
    const client = await h.stack.accessPool.connect();
    const membership = randomUUID(), consent = randomUUID();
    try {
      await registerFollowSpace(client, { space: created.space, realm: created.realm, aliases: [created.space, created.realm] });
      // Retained private episode fixture; the actual self-leave is an HTTP
      // operation against owner SQL and its real automatic-follow trigger.
      await client.query(`INSERT INTO access.private_membership_consent
        (id,principal_id,principal_epoch,kind,owner_subject,policy_revision,terms_revision,next_generation,expires_at)
        VALUES ($1,$2,0,'realm',$3,0,'old-terms',1,now()+interval '5 minutes')`, [consent,h.reader.principalId,created.realm]);
      await client.query(`INSERT INTO access.private_membership
        (id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
        VALUES ($1,'realm',$2,$3,'joined',1,0,'old-terms',$4)`, [membership, created.realm, h.reader.principalId, consent]);
      await client.query(`INSERT INTO access.private_membership_history
        (membership_id,generation,state,policy_revision,terms_revision,consent_reference,changed_by_principal)
        VALUES ($1,1,'joined',0,'old-terms',$2,$3)`, [membership, consent, h.author.principalId]);
      await client.query(`INSERT INTO access.private_membership_ban(kind,owner_subject,principal_id,reason_ref)
        VALUES ('realm',$1,$2,'preserved-ban')`, [created.realm, h.reader.principalId]);
      await client.query(`UPDATE access.membership_policy SET revision=revision+1,open=false,terms_revision='changed-terms'
        WHERE kind='realm' AND owner_subject=$1`, [created.realm]);
    } finally { client.release(); }
    const originalVerify = h.deps.account.verify;
    h.deps.account.verify = async (request: Request, scopes?: string[]) => {
      if (scopes?.includes('access:manage')) throw new AccountAssertionInsufficientScope('management scope withheld');
      return originalVerify(request);
    };
    Object.assign(h.deps, { privateMemberships: new AccessPrivateMemberships(h.stack.accessPool) });
    const command = { profile: 'access-private-membership-change-v1', kind: 'realm', ownerSubject: created.realm,
      membershipId: membership, action: 'leave', expectedGeneration: '1', expectedPolicyRevision: '0' };
    expect((await h.call('POST', '/v1/access/private-membership-changes', command, h.author.token)).status).toBe(403);
    const key = randomUUID();
    const [first, duplicate] = await Promise.all([h.call('POST', '/v1/access/private-membership-changes', command, h.reader.token, key),
      h.call('POST', '/v1/access/private-membership-changes', command, h.reader.token, key)]);
    const ended = await h.json<{ generation: string; policyRevision: string }>(first);
    expect(ended).toMatchObject({ state: 'left', generation: '2', policyRevision: '1' });
    expect(await h.json(duplicate)).toMatchObject({ state: 'left', generation: '2', replayed: true });
    expect(await h.json(await h.call('POST', '/v1/access/private-membership-changes', { ...command, expectedGeneration: '2' }, h.reader.token)))
      .toMatchObject({ state: 'left', generation: '2' });
    expect((await h.call('POST', '/v1/access/private-membership-changes', command, h.reader.token)).status).toBe(409);
    expect((await h.stack.accessPool.query('SELECT state FROM access.private_membership_history WHERE membership_id=$1 ORDER BY generation', [membership])).rows.map(row => row.state))
      .toEqual(['joined', 'left']);
    expect((await h.stack.accessPool.query('SELECT active FROM access.private_membership_ban WHERE principal_id=$1 AND owner_subject=$2',
      [h.reader.principalId, created.realm])).rows[0].active).toBe(true);
    expect(await h.deps.follows.state(created.space, { principal: { ...h.reader.principal, emailVerified: true }, agent: reader }))
      .toMatchObject({ following: false, source: 'join' });
  } finally { await h.stop(); }
}, 180_000);
