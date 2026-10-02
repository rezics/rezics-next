import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';
import { readRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessPrivateMemberships } from '../../../services/main/src/modules/access/private-memberships.ts';

test('G-946: a private member sees only selections and reply placements after the current admission; policy changes, owner reads and rejoin are live', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public','open');
    const oldSubmission = await h.submit();
    const oldReply = await h.reply();
    const oldPlacement = await h.call('POST','/v1/realm-reply-placements',oldReply.placement);
    expect(oldPlacement.status).toBe(201);
    const policy = await h.admin.spaceSettings(h.principal,(await readRealmPolicy(h.env,h.realm))!.space,h.actor,h.env);
    await h.admin.changeSpaceSettings(h.principal,policy.space,{ actingSubject: h.actor,expectedGeneration: policy.generation,reason: 'Pin newcomer history',
      settings: { visibility: 'public',listing: 'listed',history: 'from-admission',admission: 'invitation' } },randomUUID(),h.env);
    await h.grant(h.pen,'work:create:root','access.membership.consent');
    const consent = async (generation: string) => new AccessMembershipConsents(h.accessPool).issue({
      principal: h.principal,kind: 'realm',ownerSubject: h.realm,memberSubject: h.pen,expectedGeneration: generation,
      expectedPolicyRevision: '0',termsRevision: 'realm-membership-v1',idempotencyKey: randomUUID(),requestDigest: 'a'.repeat(64) });
    const add = async (generation: string) => {
      const current = await h.call('GET',`${h.root}/settings`);
      const issued = await consent(generation);
      const joined = await h.call('POST',`${h.root}/members`,{ actingSubject: h.actor,member: h.pen,action: 'add',
        expectedGeneration: current.body.generation,expectedMembershipGeneration: generation,
        reason: 'Join community',consent: issued.consentReference,durationSeconds: null });
      expect(joined.status,JSON.stringify(joined.body)).toBe(201);
    };
    await add('0');
    const currentSubmission = await h.submit();
    const fresh = await h.post('/v1/works',{ profile: 'metadata-only-v1',authoring: 'own-work',language: 'en',
      title: 'After-admission Work',actingSubject: h.actor });
    expect(fresh.status).toBe(201);
    const draft = await h.post('/v1/contributions',{ profile: 'text-contribution-v1',work: fresh.body.work,
      language: 'en',body: 'A Work first selected after admission.',actingSubject: h.actor });
    expect(draft.status).toBe(201);
    const published = await h.post('/v1/contribution-publications',{ profile: 'text-publication-v1',contribution: draft.body.contribution,
      expectedDraftHead: draft.body.draftRevision,expectedPublicationHead: null,rightsBasis: 'original-contribution',
      disclosure: 'public',actingSubject: h.actor });
    expect(published.status).toBe(201);
    expect((await h.post('/v1/publication-selections',{ profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default',id: fresh.body.mainVersion },work: fresh.body.work,
      contribution: draft.body.contribution,publicationDecision: published.body.publicationDecision,
      expectedSelectionHead: null,selectionBasis: 'main-maintainer',actingSubject: h.actor })).status).toBe(201);
    const freshAdoption = await h.call('POST',`${h.root}/submissions`,{ actingSubject: h.actor,kind: 'contribution',
      work: fresh.body.work,mainVersion: fresh.body.mainVersion,contribution: draft.body.contribution,
      publicationDecision: published.body.publicationDecision,selectedDraft: draft.body.draftRevision,correctionOf: null });
    expect(freshAdoption.status,JSON.stringify(freshAdoption.body)).toBe(201);
    const currentReply = await h.reply();
    expect((await h.call('POST','/v1/realm-reply-placements',currentReply.placement)).status).toBe(201);
    const edit = await h.call('POST','/v1/member-reply-drafts',{ ...oldReply.input,
      expectedHead: oldReply.draft.body.revisionId,body: 'Older thread edited after admission' });
    expect(edit.status,JSON.stringify(edit.body)).toBe(201);
    const edited = await h.call('POST','/v1/realm-reply-placements',{ ...oldReply.placement,
      revisionId: edit.body.revisionId,revisionDigest: edit.body.revisionDigest,expectedHead: oldPlacement.body.placement });
    expect(edited.status,JSON.stringify(edited.body)).toBe(201);
    const choose = async (history: 'everything' | 'from-admission') => {
      const current = await h.admin.spaceSettings(h.principal,policy.space,h.actor,h.env);
      const changed = await h.call('PUT',`/v1/spaces/${policy.space.slice(-36)}/settings`,{ actingSubject: h.actor,
        expectedGeneration: current.generation,reason: 'Manage newcomer history',
        settings: { visibility: 'private',listing: 'listed',admission: 'invitation',history } });
      expect(changed.status,JSON.stringify(changed.body)).toBe(201);
    };
    await choose('from-admission');
    const old = oldSubmission.result.body.submission.selection as string;
    const current = currentSubmission.result.body.submission.selection as string;
    const page = await h.call('GET',`${h.root}/decisions`,undefined,h.pen);
    expect(page.status,JSON.stringify(page.body)).toBe(200);
    expect(page.body.items.map((item: { id: string }) => item.id)).not.toContain(current);
    expect(page.body.items.map((item: { id: string }) => item.id)).not.toContain(old);
    expect(page.body.items.map((item: { id: string }) => item.id)).toContain(freshAdoption.body.submission.selection);
    expect((await h.call('GET',`${h.root}/decisions/${old.slice(-36)}`,undefined,h.pen)).status).toBe(404);
    expect((await h.call('GET',`${h.root}/decisions/${current.slice(-36)}`,undefined,h.pen)).status).toBe(404);
    expect((await h.call('GET',`${h.root}/works`,undefined,h.pen)).body.items.map((item: { id: string }) => item.id)).toEqual([fresh.body.work]);
    expect((await h.call('GET',oldReply.path,undefined,h.pen)).status).toBe(404);
    expect((await h.call('GET',currentReply.path,undefined,h.pen)).status).toBe(200);
    expect((await h.call('GET',oldReply.path)).status).toBe(200);
    await choose('everything');
    expect((await h.call('GET',oldReply.path,undefined,h.pen)).status).toBe(200);
    await choose('from-admission');
    const settings = await h.call('GET',`${h.root}/settings`);
    expect((await h.call('POST',`${h.root}/members`,{ actingSubject: h.actor,member: h.pen,action: 'remove',
      expectedGeneration: settings.body.generation,expectedMembershipGeneration: '1',reason: 'Leave community',
      consent: null,durationSeconds: null })).status).toBe(201);
    expect((await h.call('GET',currentReply.path,undefined,h.pen)).status).toBe(404);
    await add('2');
    expect((await h.call('GET',currentReply.path,undefined,h.pen)).status).toBe(404);
    expect((await h.call('GET',`${h.root}/works`,undefined,h.pen)).body.items).toEqual([]);
    expect((await h.call('GET',`${h.root}/decisions`,undefined,h.pen)).body.items).toEqual([]);
    expect((await h.call('GET',currentReply.path)).status).toBe(200);
    expect((await h.accessPool.query(`SELECT generation::text FROM access.realm_history_admission
      WHERE membership_id = (SELECT id FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2)
      ORDER BY generation`,[h.realm,h.pen])).rows.map(row => row.generation)).toEqual(['1','3']);
  } finally { await h.close(); }
},180_000);

test('G-946: earlier and everything membership episodes without cuts keep full private history', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public','open');
    const old = await h.reply();
    expect((await h.call('POST','/v1/realm-reply-placements',old.placement)).status).toBe(201);
    await h.grant(h.pen,'work:create:root','access.membership.consent');
    const consent = await new AccessMembershipConsents(h.accessPool).issue({ principal: h.principal,kind: 'realm',
      ownerSubject: h.realm,memberSubject: h.pen,expectedGeneration: '0',expectedPolicyRevision: '0',
      termsRevision: 'realm-membership-v1',idempotencyKey: randomUUID(),requestDigest: 'a'.repeat(64) });
    const current = await h.admin.settings(h.principal,h.realm,h.actor,h.env);
    await h.admin.changeMember(h.principal,h.realm,{ actingSubject: h.actor,member: h.pen,action: 'add',
      expectedGeneration: current.generation,expectedMembershipGeneration: '0',reason: 'Earlier membership',
      consent: consent.consentReference,durationSeconds: null },randomUUID(),h.env);
    const policy = (await readRealmPolicy(h.env,h.realm))!;
    const settings = await h.admin.spaceSettings(h.principal,policy.space,h.actor,h.env);
    await h.admin.changeSpaceSettings(h.principal,policy.space,{ actingSubject: h.actor,expectedGeneration: settings.generation,
      reason: 'Restrict future history',settings: { visibility: 'private',listing: 'listed',history: 'from-admission',admission: 'invitation' } },randomUUID(),h.env);
    expect((await h.accessPool.query('SELECT count(*)::int AS n FROM access.realm_history_admission')).rows[0].n).toBe(0);
    expect(await h.access.realmHistoryFloor(h.principal,h.pen,h.realm)).toBeNull();
    expect((await h.call('GET',h.root,undefined,h.pen)).status).toBe(200);
    expect((await h.call('GET',old.path,undefined,h.pen)).status).toBe(200);
    // The same fallback covers private principal episodes admitted before the
    // cut table existed; their Access identity remains private.
    const privateConsent = await new AccessPrivateMemberships(h.accessPool).issue({ principal: h.principal,
      kind: 'realm',ownerSubject: h.realm,expectedGeneration: '0',expectedPolicyRevision: '0',termsRevision: 'realm-membership-v1',
      idempotencyKey: randomUUID(),requestDigest: 'b'.repeat(64) });
    await h.accessPool.query(`INSERT INTO access.private_membership
      (id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,0,'realm-membership-v1',$4)`,[randomUUID(),h.realm,h.principalId,privateConsent.consentReference]);
    expect(await h.access.realmHistoryFloor(h.principal,h.pen,h.realm)).toBeNull();
    expect((await h.call('GET',old.path,undefined,h.pen)).status).toBe(200);
  } finally { await h.close(); }
},180_000);
