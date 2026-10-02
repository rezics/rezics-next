import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';

test('G-946: a private member sees only selections and reply placements after the current admission; policy changes, owner reads and rejoin are live', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public','open');
    const oldSubmission = await h.submit();
    const oldReply = await h.reply();
    expect((await h.call('POST','/v1/realm-reply-placements',oldReply.placement)).status).toBe(201);
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
    const currentReply = await h.reply();
    expect((await h.call('POST','/v1/realm-reply-placements',currentReply.placement)).status).toBe(201);
    const choose = async (history: 'everything' | 'from-admission') => {
      const settings = await h.call('GET',`${h.root}/settings`);
      const changed = await h.call('PUT',`${h.root}/settings`,{ actingSubject: h.actor,
        expectedGeneration: settings.body.generation,expectedRulesRevision: settings.body.ruleBasis.revision,
        reason: 'Manage newcomer history',settings: { ...settings.body.settings,visibility: 'private',history } });
      expect(changed.status,JSON.stringify(changed.body)).toBe(201);
    };
    await choose('from-admission');
    const old = oldSubmission.result.body.submission.selection as string;
    const current = currentSubmission.result.body.submission.selection as string;
    const page = await h.call('GET',`${h.root}/decisions`,undefined,h.pen);
    expect(page.status,JSON.stringify(page.body)).toBe(200);
    expect(page.body.items.map((item: { id: string }) => item.id)).toContain(current);
    expect(page.body.items.map((item: { id: string }) => item.id)).not.toContain(old);
    expect((await h.call('GET',`${h.root}/decisions/${old.slice(-36)}`,undefined,h.pen)).status).toBe(404);
    expect((await h.call('GET',`${h.root}/decisions/${current.slice(-36)}`,undefined,h.pen)).status).toBe(200);
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
