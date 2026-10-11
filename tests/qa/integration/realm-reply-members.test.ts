import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';
import { publishRealmProfile } from '../../../services/main/src/modules/realm-profile/commands.ts';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { realmReplyDigest } from '../../../services/main/src/modules/realm-reply/store.ts';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

type VisibilityFixture = Awaited<ReturnType<typeof realmVisibilityFixture>>;

async function joinPen(h: VisibilityFixture) {
  const authority = await h.accessPool.query(`SELECT 1 FROM access.permission_grant
    WHERE recipient_subject = $1 AND scope_id = 'work:create:root'
      AND action = 'access.membership.consent' AND active AND valid_until > clock_timestamp()`, [h.pen]);
  if (!authority.rowCount) await h.grant(h.pen, 'work:create:root', 'access.membership.consent');

  const member = (await h.accessPool.query<{ generation: string; state: string }>(`SELECT generation::text, state
    FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`,
  [h.realm, h.pen])).rows[0];
  const expectedGeneration = member?.generation ?? '0';
  expect(member?.state).not.toBe('joined');
  const membershipPolicy = (await h.accessPool.query<{ revision: string; terms_revision: string }>(`SELECT
    revision::text, terms_revision FROM access.membership_policy WHERE kind = 'realm' AND owner_subject = $1`,
  [h.realm])).rows[0]!;
  const consent = await new AccessMembershipConsents(h.accessPool).issue({ principal: h.principal,
    kind: 'realm', ownerSubject: h.realm, memberSubject: h.pen, expectedGeneration,
    expectedPolicyRevision: membershipPolicy.revision, termsRevision: membershipPolicy.terms_revision,
    idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
  const settings = await h.call('GET', `${h.root}/settings`);
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const joined = await h.call('POST', `${h.root}/members`, { actingSubject: h.actor, member: h.pen,
    action: 'add', expectedGeneration: settings.body.generation,
    expectedMembershipGeneration: expectedGeneration, reason: 'Join the Realm conversation',
    consent: consent.consentReference, durationSeconds: null });
  expect(joined.status, JSON.stringify(joined.body)).toBe(201);
  return joined.body;
}

async function leavePen(h: VisibilityFixture) {
  const member = (await h.accessPool.query<{ generation: string; state: string }>(`SELECT generation::text, state
    FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`,
  [h.realm, h.pen])).rows[0]!;
  expect(member.state).toBe('joined');
  const settings = await h.call('GET', `${h.root}/settings`);
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const removed = await h.call('POST', `${h.root}/members`, { actingSubject: h.actor, member: h.pen,
    action: 'remove', expectedGeneration: settings.body.generation,
    expectedMembershipGeneration: member.generation, reason: 'Leave the Realm conversation',
    consent: null, durationSeconds: null });
  expect(removed.status, JSON.stringify(removed.body)).toBe(201);
}

async function placementEffects(h: VisibilityFixture, revisionId: string, reply: string) {
  const counts = (await h.contentPool.query<{ reviews: string; preparations: string; placementPreparations: string;
    revisionReviews: string; revisionPreparations: string; revisionPlacementPreparations: string }>(`SELECT
      (SELECT count(*)::text FROM content.realm_review_decision WHERE realm = $2) AS reviews,
      (SELECT count(*)::text FROM content.publication_preparation prep
        JOIN content.realm_placement_preparation placement USING (operation_id) WHERE placement.realm = $2) AS preparations,
      (SELECT count(*)::text FROM content.realm_placement_preparation WHERE realm = $2) AS "placementPreparations",
      (SELECT count(*)::text FROM content.realm_review_decision WHERE realm = $2 AND revision_id = $1::uuid) AS "revisionReviews",
      (SELECT count(*)::text FROM content.publication_preparation WHERE revision_id = $1::uuid) AS "revisionPreparations",
      (SELECT count(*)::text FROM content.realm_placement_preparation WHERE realm = $2 AND revision_id = $1::uuid)
        AS "revisionPlacementPreparations"`, [revisionId, h.realm])).rows[0]!;
  const graphCounts = await h.fuseki.query(`PREFIX rv: <${RV}> SELECT
    (COUNT(DISTINCT ?placement) AS ?realmPlacements)
    (COUNT(DISTINCT ?replyPlacement) AS ?replyPlacements) WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ?placement a rv:RealmReplyPlacement ; rv:realm ${iri(h.realm)} ; rv:placementOutcome rv:Accepted .
        OPTIONAL { ?replyPlacement a rv:RealmReplyPlacement ; rv:realm ${iri(h.realm)} ;
          rv:reply ${iri(reply)} ; rv:placementOutcome rv:Accepted . }
      }
    }`);
  const binding = graphCounts.results?.bindings[0];
  return { ...counts, realmPlacements: binding?.realmPlacements?.value,
    replyPlacements: binding?.replyPlacements?.value };
}

test('public open replies allow an unjoined Person; trusted replies require a joined Person', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    expect((await h.accessPool.query(`SELECT 1 FROM access.membership
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2
      UNION ALL SELECT 1 FROM access.private_membership
      WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $3`,
    [h.realm, h.pen, h.principalId])).rowCount).toBe(0);
    const placementGrants = () => h.accessPool.query(`SELECT 1 FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'reply.place' AND active`,
    [h.pen, `reply:place:${h.realm}`]);
    expect((await placementGrants()).rowCount).toBe(0);

    const openReply = await h.reply(h.pen);
    expect((await h.contentPool.query('SELECT author FROM content.reply WHERE id = $1',
      [openReply.input.reply])).rows[0]?.author).toBe(h.pen);
    const openPlaced = await h.call('POST', '/v1/realm-reply-placements', openReply.placement, h.pen);
    expect(openPlaced.status, JSON.stringify(openPlaced.body)).toBe(201);
    expect((await h.contentPool.query('SELECT method, outcome FROM content.realm_review_decision WHERE id = $1',
      [openPlaced.body.reviewDecisionId])).rows[0]).toEqual({ method: 'policy', outcome: 'approved' });
    expect((await placementGrants()).rowCount).toBe(0);

    await h.policy('public', 'trusted-members');
    const outsiderReply = await h.reply(h.pen);
    expect((await h.call('POST', '/v1/realm-reply-placements', outsiderReply.placement, h.pen)).status).toBe(403);
    expect((await placementGrants()).rowCount).toBe(0);
    await joinPen(h);
    const memberReply = await h.reply(h.pen);
    const memberPlaced = await h.call('POST', '/v1/realm-reply-placements', memberReply.placement, h.pen);
    expect(memberPlaced.status, JSON.stringify(memberPlaced.body)).toBe(201);
    expect((await h.contentPool.query('SELECT method, outcome FROM content.realm_review_decision WHERE id = $1',
      [memberPlaced.body.reviewDecisionId])).rows[0]).toEqual({ method: 'policy', outcome: 'approved' });
    expect((await placementGrants()).rowCount).toBe(0);
  } finally { await h.close(); }
}, 180_000);

test('private open and trusted replies refuse outsiders and admit joined non-owners', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('private', 'open');
    const openDraft = h.draftInput(h.pen);
    expect((await h.call('POST', '/v1/member-reply-drafts', openDraft, h.pen)).status).toBe(403);
    expect((await h.contentPool.query('SELECT 1 FROM content.variant WHERE id = $1',
      [openDraft.variantId])).rowCount).toBe(0);
    await joinPen(h);
    const openReply = await h.reply(h.pen);
    const openPlaced = await h.call('POST', '/v1/realm-reply-placements', openReply.placement, h.pen);
    expect(openPlaced.status, JSON.stringify(openPlaced.body)).toBe(201);

    await leavePen(h);
    await h.policy('private', 'trusted-members');
    const trustedDraft = h.draftInput(h.pen);
    expect((await h.call('POST', '/v1/member-reply-drafts', trustedDraft, h.pen)).status).toBe(403);
    expect((await h.contentPool.query('SELECT 1 FROM content.variant WHERE id = $1',
      [trustedDraft.variantId])).rowCount).toBe(0);
    await joinPen(h);
    const trustedReply = await h.reply(h.pen);
    const trustedPlaced = await h.call('POST', '/v1/realm-reply-placements', trustedReply.placement, h.pen);
    expect(trustedPlaced.status, JSON.stringify(trustedPlaced.body)).toBe(201);
  } finally { await h.close(); }
}, 180_000);

test('mandatory review refuses member and owner direct placement without creating review or placement effects', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'mandatory');
    await joinPen(h);
    const refuseWithoutEffects = async (actor: string) => {
      const candidate = await h.reply(actor);
      const before = await placementEffects(h, candidate.draft.body.revisionId, candidate.input.reply);
      const refused = await h.call('POST', '/v1/realm-reply-placements', candidate.placement, actor);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      const after = await placementEffects(h, candidate.draft.body.revisionId, candidate.input.reply);
      expect(after).toEqual(before);
      expect(after.revisionReviews).toBe('0');
      expect(after.revisionPreparations).toBe('0');
      expect(after.revisionPlacementPreparations).toBe('0');
      expect(after.replyPlacements).toBe('0');
      return candidate;
    };
    const memberReply = await refuseWithoutEffects(h.pen);
    const ownerReply = await refuseWithoutEffects(h.actor);

    await h.grant(h.actor, `review:decide:${h.realm}`, 'review.decide');
    const reviewed = await h.reply(h.pen);
    const review = await h.call('POST', '/v1/realm-reply-reviews', { profile: 'realm-reply-review-v1',
      realm: h.realm, reply: reviewed.input.reply, revisionId: reviewed.draft.body.revisionId,
      revisionDigest: reviewed.draft.body.revisionDigest, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: 'a'.repeat(64), reasonReference: null, actingSubject: h.actor });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    const exact = await h.call('POST', '/v1/realm-reply-placements', {
      ...reviewed.placement, reviewDecisionId: review.body.decisionId }, h.pen);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body.reviewDecisionId).toBe(review.body.decisionId);
    expect((await h.contentPool.query(`SELECT revision_id::text, revision_digest, outcome
      FROM content.realm_review_decision WHERE id = $1`, [review.body.decisionId])).rows[0]).toEqual({
      revision_id: reviewed.draft.body.revisionId, revision_digest: reviewed.draft.body.revisionDigest, outcome: 'approved' });

    const edited = await h.call('POST', '/v1/member-reply-drafts', { ...reviewed.input,
      body: 'An edit needs its own review.', expectedHead: reviewed.draft.body.revisionId }, h.pen);
    expect(edited.status, JSON.stringify(edited.body)).toBe(201);
    const reused = await h.call('POST', '/v1/realm-reply-placements', { ...reviewed.placement,
      revisionId: edited.body.revisionId, revisionDigest: edited.body.revisionDigest,
      reviewDecisionId: review.body.decisionId, expectedHead: exact.body.placement }, h.pen);
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect((await h.contentPool.query(`SELECT 1 FROM content.realm_review_decision
      WHERE realm = $1 AND revision_id = $2`, [h.realm, edited.body.revisionId])).rowCount).toBe(0);
    expect((await h.replies.visible(h.realm, reviewed.input.reply))?.revisionId).toBe(reviewed.draft.body.revisionId);
    expect(memberReply.input.reply).not.toBe(ownerReply.input.reply);
  } finally { await h.close(); }
}, 180_000);

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
    const bytes = draft.body.revisionDigest;
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
          idempotencyKey: randomUUID(), profile: { name: { original: 'en', labels: { en: 'Members', 'zh-Hans': '成员' } },
            description: { original: 'en', labels: { en: 'Replies', 'zh-Hans': '回复' } }, iconSelection: null, bannerSelection: null,
            rules: [], moderators: [], count: { kind: 'unknown', value: null }, replyPolicy } });
      profileHead = result.revision;
    };
    await policy('members-direct');
    const edited = await h.post('/v1/member-reply-drafts', { ...input, expectedHead: draft.body.revisionId, body: 'Direct member reply.' });
    expect(edited.status).toBe(201);
    const editedDigest = edited.body.revisionDigest;
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
    const latestDigest = latest.body.revisionDigest;
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
