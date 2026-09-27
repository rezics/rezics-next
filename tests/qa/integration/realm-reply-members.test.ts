import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';
import { publishRealmProfile } from '../../../services/main/src/modules/realm-profile/commands.ts';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { realmReplyDigest } from '../../../services/main/src/modules/realm-reply/store.ts';

test('G-277: members place reviewed replies; direct policy respects membership, moderator veto and policy races', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const created = await h.post('/v1/spaces', { profile: 'space-realm-v1', name: 'Reply members',
      capabilities: ['realm'], actingSubject: h.actor });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const realm = created.body.realm as string;
    const principal = await h.principal();
    const principalId = await h.access.activePrincipalId(principal);
    await h.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'institution') ON CONFLICT DO NOTHING", [realm]);
    await h.accessPool.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision) VALUES ('realm',$1,1,'terms-1')`, [realm]);
    const consent = async (generation: number) => {
      const id = randomUUID();
      await h.accessPool.query(`INSERT INTO access.private_membership_consent
        (id, principal_id, principal_epoch, kind, owner_subject, policy_revision, terms_revision, next_generation, expires_at)
        SELECT $1, id, enforcement_epoch, 'realm', $3, 1, 'terms-1', $4, now()+interval '5 minutes'
        FROM access.principal WHERE id=$2`, [id, principalId, realm, generation]);
      return id;
    };
    const membership = randomUUID();
    await h.accessPool.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation, policy_revision, terms_revision, consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'terms-1',$4)`, [membership, realm, principalId, await consent(1)]);
    const grant = async (scope: string, action: string) => {
      await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await h.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,
      [randomUUID(), principalId, h.actor, action]);
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now()+interval '1 hour')`, [randomUUID(), h.actor, scope, action]);
    };
    const input = { profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
      expectedHead: null, body: 'A Realm member reply.', actingSubject: h.actor };
    const draft = await h.post('/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await h.post('/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply: input.reply,
      variantId: input.variantId, revisionId: draft.body.revisionId, author: h.actor,
      rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      parentReply: null, parentRevision: null, contextRevision: null })).status).toBe(201);
    const bytes = (await h.contentPool.query('SELECT byte_digest FROM content.revision WHERE id = $1',
      [draft.body.revisionId])).rows[0].byte_digest;
    const placement = { profile: 'realm-reply-placement-v1', realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest: bytes, reviewDecisionId: null,
      expectedHead: null, actingSubject: h.actor };
    expect((await h.post('/v1/realm-reply-placements', placement)).status).toBe(403);
    const review = { profile: 'realm-reply-review-v1', realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest: bytes, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'moderator-v1', dependencyDigest: 'a'.repeat(64),
      reasonReference: null, actingSubject: h.actor };
    expect((await h.post('/v1/realm-reply-reviews', review)).status).toBe(403);
    await grant(`review:decide:${realm}`, 'review.decide');
    const approved = await h.post('/v1/realm-reply-reviews', review);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const placed = await h.post('/v1/realm-reply-placements', { ...placement, reviewDecisionId: approved.body.decisionId });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect((await h.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND action = 'reply.place'`, [h.actor])).rowCount).toBe(0);
    await grant(`realm:profile:${realm}`, 'realm.profile.publish');
    let profileHead: string | null = null;
    const policy = async (replyPolicy: 'moderated' | 'members-direct') => {
      const result = await publishRealmProfile(h.env, undefined, { verify: async () => principal }, h.access,
        new Request('http://main.local'), { realm, expectedHead: profileHead, actingSubject: h.actor,
          idempotencyKey: randomUUID(), profile: { name: { en: 'Members', 'zh-CN': '成员' },
            description: { en: 'Replies', 'zh-CN': '回复' }, iconSelection: null, bannerSelection: null,
            rules: [], moderators: [], count: { kind: 'unknown', value: null }, replyPolicy } });
      profileHead = result.revision;
    };
    await policy('members-direct');
    const edited = await h.post('/v1/member-reply-drafts', { ...input, expectedHead: draft.body.revisionId, body: 'Direct member reply.' });
    expect(edited.status).toBe(201);
    const editedDigest = (await h.contentPool.query('SELECT byte_digest FROM content.revision WHERE id = $1',
      [edited.body.revisionId])).rows[0].byte_digest;
    const direct = { ...placement, revisionId: edited.body.revisionId, revisionDigest: editedDigest,
      expectedHead: placed.body.placement };
    const key = randomUUID();
    const accepted = await h.post('/v1/realm-reply-placements', direct, key);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect((await h.post('/v1/realm-reply-placements', direct, key)).body.placement).toBe(accepted.body.placement);
    expect((await h.contentPool.query('SELECT method FROM content.realm_review_decision WHERE id = $1',
      [accepted.body.reviewDecisionId])).rows[0].method).toBe('policy');
    const revoked = await h.post('/v1/realm-reply-reviews', { ...review, revisionId: edited.body.revisionId,
      revisionDigest: editedDigest, expectedGeneration: '1', supersedes: accepted.body.reviewDecisionId,
      outcome: 'revoked', reasonReference: 'moderator-veto' });
    expect(revoked.status).toBe(201);
    expect(await h.replies.visible(realm, input.reply)).toBeNull();
    expect((await h.post('/v1/realm-reply-placements', { ...direct, expectedHead: accepted.body.placement })).status).toBe(403);
    // Register before leave/rejoin: the old episode cannot be claimed afterwards.
    const registered = await h.access.register({ principal, actingSubject: h.actor,
      action: 'reply.place', scope: `reply:place:${realm}`, idempotencyKey: randomUUID(),
      requestDigest: realmReplyDigest(direct) });
    await h.accessPool.query(`UPDATE access.private_membership SET state='left', generation=2,
      terms_revision=NULL, consent_reference=NULL WHERE id=$1`, [membership]);
    expect((await h.post('/v1/realm-reply-placements', direct)).status).toBe(403);
    await h.accessPool.query(`UPDATE access.private_membership SET state='joined', generation=3,
      terms_revision='terms-1', consent_reference=$2 WHERE id=$1`, [membership, await consent(3)]);
    await expect(h.access.claim(registered.id, registered.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    await h.accessPool.query(`INSERT INTO access.private_membership_ban
      (kind,owner_subject,principal_id,reason_ref) VALUES ('realm',$1,$2,'moderator-ban')`, [realm, principalId]);
    expect((await h.post('/v1/realm-reply-placements', direct)).status).toBe(403);
    await h.accessPool.query(`UPDATE access.private_membership_ban SET active=false
      WHERE kind='realm' AND owner_subject=$1 AND principal_id=$2`, [realm, principalId]);
    const latest = await h.post('/v1/member-reply-drafts', { ...input, expectedHead: edited.body.revisionId, body: 'Policy race.' });
    const latestDigest = (await h.contentPool.query('SELECT byte_digest FROM content.revision WHERE id=$1',
      [latest.body.revisionId])).rows[0].byte_digest;
    const prepare = h.owner.preparePlacement.bind(h.owner);
    h.owner.preparePlacement = async (...args) => {
      const prepared = await prepare(...args);
      await policy('moderated');
      return prepared;
    };
    const raced = await h.post('/v1/realm-reply-placements', { ...direct,
      revisionId: latest.body.revisionId, revisionDigest: latestDigest, expectedHead: accepted.body.placement });
    expect(raced.status, JSON.stringify(raced.body)).toBe(409);
    expect((await h.contentPool.query(`SELECT status FROM content.publication_preparation
      WHERE revision_id=$1`, [latest.body.revisionId])).rows[0].status).toBe('rejected');
  } finally { await h.close(); }
}, 180_000);
