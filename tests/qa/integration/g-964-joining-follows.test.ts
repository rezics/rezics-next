import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { RealmAdminDenied } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { relationshipEligible, relationshipRecipients } from '../../../services/main/src/modules/follows/recipients.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { readFollows } from '../../../services/main/src/modules/follows/read.ts';
import { DATASET, GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';

test('G-964: private open admission records self-join/invitation cuts; durable follows pause, resume and keep member notifications', async () => {
  const h = await startHomeStack('g-964-joining');
  const { stack: s, author: owner, reader } = h;
  try {
    const readerAgent = await h.provision('Visibility reader', reader.token);
    const principal = await h.deps.account.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${reader.token}` } }));
    await owner.grant('work:create:root', 'agent.control');
    await owner.grant('space:create:root', 'space.create');
    const created = await h.json<{ realm: string; space: string }>(await h.call('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Visibility community', language: 'en', capabilities: ['realm'], actingSubject: owner.actor }, owner.token), 201);
    const { realm, space } = created;
    const admin = new AccessRealmManagement(s.accessPool), joining = new AccessRealmJoining(s.accessPool, s.env);
    await admin.initialize(owner.principal, realm, owner.actor, s.env);
    const settings = async (visibility: 'public' | 'private', admission: 'open' | 'invitation') => {
      const current = await admin.spaceSettings(owner.principal, space, owner.actor, s.env);
      await admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
        expectedGeneration: current.generation, reason: 'Exercise independent admission and disclosure',
        settings: { visibility, admission, listing: 'unlisted', history: 'from-admission' } }, randomUUID(), s.env);
    };
    let followed = await h.deps.follows.set(principal, { profile: 'follow-command-v1', target: space,
      actingSubject: readerAgent, following: true, expectedRevision: null, level: 'highlights' }, randomUUID(),
    async () => ({ target: space, kind: 'space', space: { space, realm, aliases: [space, realm] } }));
    const notifying = async (expected: boolean) => {
      for (const target of [space, realm]) {
        const input = { targets: [target], highlights: true };
        expect((await relationshipRecipients(s.accessPool, input)).includes(reader.principalId)).toBe(expected);
        expect(await relationshipEligible(s.accessPool, reader.principalId, input)).toBe(expected);
      }
      const row = (await s.accessPool.query(`SELECT following,revision::text,source FROM access.follow
        WHERE principal_id=$1 AND target=$2`, [reader.principalId, space])).rows[0];
      expect(row).toMatchObject({ following: true, revision: followed.revision, source: followed.source });
    };
    const available = async (expected: boolean) => {
      const position = (await s.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } } LIMIT 1`)).results!.bindings[0]!.sequence!.value;
      const session = new WorkReadSession(h.deps, new Request('http://main.local/v1/me/follows'), {},
        { dataEpoch: s.env.lineage.dataEpoch, sequence: position });
      const page = await readFollows(session, h.deps.follows, principal, readerAgent);
      expect(page.items.find(item => item.id === space)).toMatchObject({ available: expected, source: followed.source });
    };
    await notifying(true);
    await settings('private', 'open');
    await notifying(false);
    await available(false);
    const policy = await joining.policyFor(principal, realm, readerAgent);
    expect(policy).toMatchObject({ selfJoin: true, state: 'absent' });
    const input = { actingSubject: readerAgent, expectedMembershipGeneration: policy.membershipGeneration,
      expectedPolicyRevision: policy.policyRevision, termsRevision: policy.termsRevision, listed: false };
    const key = randomUUID();
    const joined = await joining.selfJoin(principal, realm, input, key);
    expect((await joining.selfJoin(principal, realm, input, key)).replayed).toBe(true);
    expect(await s.access.realmHistoryFloor(principal, readerAgent, realm)).toMatchObject({ dataEpoch: s.env.lineage.dataEpoch });
    const joinedFollow = (await s.accessPool.query('SELECT revision::text FROM access.follow WHERE principal_id=$1 AND target=$2',
      [reader.principalId, space])).rows[0];
    // Choosing an explicit follow while joined keeps interest after leaving.
    followed = await h.deps.follows.set(principal, { profile: 'follow-command-v1', target: space,
      actingSubject: readerAgent, following: true, expectedRevision: joinedFollow.revision }, randomUUID(), async () => ({ target: space, kind: 'space' }));
    await notifying(true);
    await available(true);
    const current = await admin.settings(owner.principal, realm, owner.actor);
    await admin.changeMember(owner.principal, realm, { actingSubject: owner.actor, member: readerAgent,
      action: 'remove', expectedGeneration: current.generation, expectedMembershipGeneration: joined.membershipGeneration,
      reason: 'End this membership episode', consent: null, durationSeconds: null }, randomUUID(), s.env);
    await notifying(false);
    await available(false);
    await settings('public', 'open');
    await notifying(true);
    await available(true);
    await settings('private', 'invitation');
    await expect(joining.policyFor(principal, realm, readerAgent)).rejects.toBeInstanceOf(RealmAdminDenied);
    const invitation = await joining.invite(owner.principal, realm,
      { actingSubject: owner.actor, member: readerAgent, expiresInSeconds: 300 }, randomUUID());
    const acceptKey = randomUUID(), accepted = { actingSubject: readerAgent, action: 'accept' as const, listed: false };
    await joining.respond(principal, realm, invitation.invitation.id, accepted, acceptKey);
    expect((await joining.respond(principal, realm, invitation.invitation.id, accepted, acceptKey)).replayed).toBe(true);
    const rejoinedFollow = (await s.accessPool.query('SELECT revision::text FROM access.follow WHERE principal_id=$1 AND target=$2',
      [reader.principalId, space])).rows[0];
    // A new membership episode preserves the existing explicit interest.
    expect(rejoinedFollow.revision).toBe(followed.revision);
    await notifying(true);
    await available(true);
    expect((await s.accessPool.query(`SELECT generation::text FROM access.realm_history_admission
      WHERE membership_id=$1 ORDER BY generation`, [joined.membershipId])).rows.map(row => row.generation)).toEqual(['1', '3']);
    // A different principal's invitation-only join creates a join-sourced follow.
    const member = await h.provision('Visibility owner reader', owner.token);
    const ownPrincipal = await h.deps.account.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${owner.token}` } }));
    const invitationOnly = await joining.invite(owner.principal, realm,
      { actingSubject: owner.actor, member, expiresInSeconds: 300 }, randomUUID());
    await joining.respond(ownPrincipal, realm, invitationOnly.invitation.id,
      { actingSubject: member, action: 'accept', listed: false }, randomUUID());
    expect((await s.accessPool.query(`SELECT following,source FROM access.follow WHERE principal_id=$1 AND target=$2`,
      [owner.principalId, space])).rows[0]).toMatchObject({ following: true, source: 'join' });
    expect(await relationshipEligible(s.accessPool, owner.principalId, { targets: [space], highlights: true })).toBe(true);
  } finally { await h.stop(); }
}, 180_000);
