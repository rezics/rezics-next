import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { realmReplyDigest } from '../../../services/main/src/modules/realm-reply/store.ts';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

type VisibilityFixture = Awaited<ReturnType<typeof realmVisibilityFixture>>;

async function fixtureAuthority(h: VisibilityFixture, actor: string, scope: string, action: string) {
  return grantFixtureAuthority(h.accessPool, { scope, requireDispatch: false,
    representations: [{ principalId: h.principalId, actor, action, lifetime: '8 hours' }],
    grant: { actor, action, lifetime: '8 hours' } });
}

async function penMembership(h: VisibilityFixture) {
  const roster = await h.call('GET', `${h.root}/members`);
  expect(roster.status, JSON.stringify(roster.body)).toBe(200);
  expect(roster.body.nextCursor).toBeNull();
  return (roster.body.items as { member: string; state: string; membershipGeneration: string }[])
    .find(member => member.member === h.pen);
}

async function joinPen(h: VisibilityFixture) {
  const authority = await h.accessPool.query(`SELECT 1 FROM access.permission_grant
    WHERE recipient_subject = $1 AND scope_id = 'work:create:root'
      AND action = 'access.membership.consent' AND active AND valid_until > clock_timestamp()`, [h.pen]);
  if (!authority.rowCount) await h.grant(h.pen, 'work:create:root', 'access.membership.consent');

  const member = await penMembership(h);
  const expectedGeneration = member?.membershipGeneration ?? '0';
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
  const member = (await penMembership(h))!;
  expect(member.state).toBe('joined');
  const settings = await h.call('GET', `${h.root}/settings`);
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const removed = await h.call('POST', `${h.root}/members`, { actingSubject: h.actor, member: h.pen,
    action: 'remove', expectedGeneration: settings.body.generation,
    expectedMembershipGeneration: member.membershipGeneration, reason: 'Leave the Realm conversation',
    consent: null, durationSeconds: null });
  expect(removed.status, JSON.stringify(removed.body)).toBe(201);
}

function placementIntent(h: VisibilityFixture, actor: string, reply: Awaited<ReturnType<VisibilityFixture['reply']>>,
  key = randomUUID()) {
  const digest = realmReplyDigest(reply.placement);
  const request = { principal: h.principal, actingSubject: actor, action: 'reply.place',
    scope: `reply:place:${h.realm}`, idempotencyKey: key, requestDigest: digest };
  return { key, digest, request };
}

async function joinPrivatePen(h: VisibilityFixture) {
  const current = (await h.accessPool.query<{ id: string; generation: string; state: string }>(`SELECT
    id, generation::text, state FROM access.private_membership
    WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2`,
  [h.realm, h.principalId])).rows[0];
  expect(current?.state).not.toBe('joined');
  const policy = (await h.accessPool.query<{ revision: string; terms_revision: string }>(`SELECT
    revision::text, terms_revision FROM access.membership_policy WHERE kind = 'realm' AND owner_subject = $1`,
  [h.realm])).rows[0]!;
  const expectedGeneration = current?.generation ?? '0';
  const generation = (BigInt(expectedGeneration) + 1n).toString();
  const consent = randomUUID();
  await h.accessPool.query(`INSERT INTO access.private_membership_consent
    (id, principal_id, principal_epoch, kind, owner_subject, policy_revision, terms_revision, next_generation, expires_at)
    SELECT $1, id, enforcement_epoch, 'realm', $3, $4, $5, $6, now() + interval '5 minutes'
    FROM access.principal WHERE id = $2`,
  [consent, h.principalId, h.realm, policy.revision, policy.terms_revision, generation]);
  const membershipId = current?.id ?? randomUUID();
  if (current) {
    await h.accessPool.query(`UPDATE access.private_membership SET state = 'joined', generation = $2,
      policy_revision = $3, terms_revision = $4, consent_reference = $5 WHERE id = $1`,
    [membershipId, generation, policy.revision, policy.terms_revision, consent]);
  } else {
    await h.accessPool.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation, policy_revision, terms_revision, consent_reference)
      VALUES ($1, 'realm', $2, $3, 'joined', $4, $5, $6, $7)`,
    [membershipId, h.realm, h.principalId, generation, policy.revision, policy.terms_revision, consent]);
  }
  await h.accessPool.query(`INSERT INTO access.private_membership_history
    (membership_id, generation, state, policy_revision, terms_revision, consent_reference, changed_by_principal)
    VALUES ($1, $2, 'joined', $3, $4, $5, $6)`,
  [membershipId, generation, policy.revision, policy.terms_revision, consent, h.principalId]);
  await h.accessPool.query(`INSERT INTO access.private_membership_consent_use
    (consent_id, membership_id, generation) VALUES ($1, $2, $3)`, [consent, membershipId, generation]);
  return { membershipId, generation, state: 'joined' as const };
}

async function leavePrivatePen(h: VisibilityFixture) {
  const current = (await h.accessPool.query<{ id: string; generation: string; state: string }>(`SELECT
    id, generation::text, state FROM access.private_membership
    WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2`, [h.realm, h.principalId])).rows[0]!;
  expect(current.state).toBe('joined');
  const policy = (await h.accessPool.query<{ revision: string }>(`SELECT revision::text
    FROM access.membership_policy WHERE kind = 'realm' AND owner_subject = $1`, [h.realm])).rows[0]!;
  const generation = (BigInt(current.generation) + 1n).toString();
  await h.accessPool.query(`UPDATE access.private_membership SET state = 'left', generation = $2,
    policy_revision = $3, terms_revision = NULL, consent_reference = NULL WHERE id = $1`,
  [current.id, generation, policy.revision]);
  await h.accessPool.query(`INSERT INTO access.private_membership_history
    (membership_id, generation, state, policy_revision, terms_revision, consent_reference, changed_by_principal)
    VALUES ($1, $2, 'left', $3, NULL, NULL, $4)`,
  [current.id, generation, policy.revision, h.principalId]);
  return { membershipId: current.id, generation, state: 'left' as const };
}

async function registerPlacement(h: VisibilityFixture, actor: string,
  reply: Awaited<ReturnType<VisibilityFixture['reply']>>, key = randomUUID()) {
  const intent = placementIntent(h, actor, reply, key);
  const registered = await h.access.register(intent.request);
  return { ...intent, registered };
}

async function insertPublicBan(h: VisibilityFixture, actor: string, expiresAt: 'never' | 'past' = 'never') {
  await h.accessPool.query(`INSERT INTO access.membership_ban
    (kind, owner_subject, member_subject, active, reason_ref, expires_at)
    VALUES ('realm', $1, $2, true, 'reply-lifecycle-ban',
      CASE WHEN $3 = 'past' THEN clock_timestamp() - interval '1 second' ELSE NULL END)
    ON CONFLICT (kind, owner_subject, member_subject) DO UPDATE
      SET active = true, reason_ref = EXCLUDED.reason_ref, expires_at = EXCLUDED.expires_at`,
  [h.realm, actor, expiresAt]);
}

async function insertPrivateBan(h: VisibilityFixture) {
  await h.accessPool.query(`INSERT INTO access.private_membership_ban
    (kind, owner_subject, principal_id, active, reason_ref)
    VALUES ('realm', $1, $2, true, 'reply-lifecycle-ban')
    ON CONFLICT (kind, owner_subject, principal_id) DO UPDATE SET active = true,
      reason_ref = EXCLUDED.reason_ref`, [h.realm, h.principalId]);
}

async function currentOwnerGrant(h: VisibilityFixture) {
  return (await h.accessPool.query<{ id: string; generation: string }>(`SELECT id, generation::text
    FROM access.permission_grant WHERE scope_id = $1 AND recipient_subject = $2
      AND action = 'realm.owner' AND membership_id IS NULL AND active
      AND valid_until > clock_timestamp() ORDER BY id LIMIT 1`, [`governance:realm:${h.realm}`, h.actor])).rows[0]!;
}

async function replaceOwnerGrant(h: VisibilityFixture) {
  await h.accessPool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1, $2, $2, $3, 'realm.owner', clock_timestamp() + interval '1 hour')`,
  [randomUUID(), h.actor, `governance:realm:${h.realm}`]);
  return currentOwnerGrant(h);
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

async function waitForBlockedRealmPolicyWrite(h: VisibilityFixture) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const blocked = await h.accessPool.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE 'SELECT 1 FROM access.scope_gate WHERE id = $1%'
        AND query LIKE '%FOR UPDATE'
        AND cardinality(pg_blocking_pids(pid)) > 0`);
    if (blocked.rowCount) return;
    await Bun.sleep(10);
  }
  throw new Error('Realm policy write did not wait behind the in-flight placement');
}

test('active public and private bans block fresh replies, including an owner mandate', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    const publicReply = await h.reply(h.pen);
    await insertPublicBan(h, h.pen);
    const publicRefusal = await h.call('POST', '/v1/realm-reply-placements', publicReply.placement, h.pen);
    expect(publicRefusal.status, JSON.stringify(publicRefusal.body)).toBe(403);
    await h.accessPool.query(`UPDATE access.membership_ban SET active = false
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`, [h.realm, h.pen]);

    await h.policy('private', 'open');
    await joinPen(h);
    const privateReply = await h.reply(h.pen);
    await insertPrivateBan(h);
    const privateRefusal = await h.call('POST', '/v1/realm-reply-placements', privateReply.placement, h.pen);
    expect(privateRefusal.status, JSON.stringify(privateRefusal.body)).toBe(403);
    await h.accessPool.query(`UPDATE access.private_membership_ban SET active = false
      WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2`, [h.realm, h.principalId]);

    await h.policy('public', 'trusted-members');
    const ownerSuccess = await h.reply(h.actor);
    expect((await h.call('POST', '/v1/realm-reply-placements', ownerSuccess.placement, h.actor)).status).toBe(201);
    const ownerReply = await h.reply(h.actor);
    await insertPublicBan(h, h.actor);
    const ownerRefusal = await h.call('POST', '/v1/realm-reply-placements', ownerReply.placement, h.actor);
    expect(ownerRefusal.status, JSON.stringify(ownerRefusal.body)).toBe(403);
  } finally { await h.close(); }
}, 180_000);

test('a ban fences a registered placement; an expired public ban permits a fresh intent', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    const beforeBan = await h.reply(h.pen);
    const intent = await registerPlacement(h, h.pen, beforeBan);
    expect(intent.registered.dispatchEligible).toBe(true);
    await insertPublicBan(h, h.pen);
    await expect(h.access.register(intent.request)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.access.claim(intent.registered.id, intent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);

    await h.accessPool.query(`UPDATE access.membership_ban SET expires_at = clock_timestamp() - interval '1 second'
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`, [h.realm, h.pen]);
    const afterExpiry = await h.reply(h.pen);
    const placed = await h.call('POST', '/v1/realm-reply-placements', afterExpiry.placement, h.pen);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.reply).toBe(afterExpiry.input.reply);
  } finally { await h.close(); }
}, 180_000);

test('public membership generations fence old placements across leave and rejoin', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'trusted-members');
    await joinPen(h);
    const beforeLeave = await h.reply(h.pen);
    const intent = await registerPlacement(h, h.pen, beforeLeave);
    expect(intent.registered.dispatchEligible).toBe(true);
    const whileLeft = await h.reply(h.pen);

    await leavePen(h);
    const leftRefusal = await h.call('POST', '/v1/realm-reply-placements', whileLeft.placement, h.pen);
    expect(leftRefusal.status, JSON.stringify(leftRefusal.body)).toBe(403);

    await joinPen(h);
    const replay = await h.access.register(intent.request);
    expect(replay).toMatchObject({ id: intent.registered.id, replayed: true, dispatchEligible: false });
    await expect(h.access.claim(intent.registered.id, intent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);

    const afterRejoin = await h.reply(h.pen);
    const placed = await h.call('POST', '/v1/realm-reply-placements', afterRejoin.placement, h.pen);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.reply).toBe(afterRejoin.input.reply);
  } finally { await h.close(); }
}, 180_000);

test('private membership generations fence old placements across leave and rejoin', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('private', 'open');
    await joinPrivatePen(h);
    const beforeLeave = await h.reply(h.pen);
    const intent = await registerPlacement(h, h.pen, beforeLeave);
    expect(intent.registered.dispatchEligible).toBe(true);
    const whileLeft = await h.reply(h.pen);

    await leavePrivatePen(h);
    const leftRefusal = await h.call('POST', '/v1/realm-reply-placements', whileLeft.placement, h.pen);
    expect(leftRefusal.status, JSON.stringify(leftRefusal.body)).toBe(403);

    await joinPrivatePen(h);
    const replay = await h.access.register(intent.request);
    expect(replay).toMatchObject({ id: intent.registered.id, replayed: true, dispatchEligible: false });
    await expect(h.access.claim(intent.registered.id, intent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);

    const afterRejoin = await h.reply(h.pen);
    const placed = await h.call('POST', '/v1/realm-reply-placements', afterRejoin.placement, h.pen);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.reply).toBe(afterRejoin.input.reply);
  } finally { await h.close(); }
}, 180_000);

test('expired and revoked owner grants fence registered private trusted placements', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('private', 'trusted-members');

    const beforeExpiry = await h.reply(h.actor);
    const firstIntent = await registerPlacement(h, h.actor, beforeExpiry);
    expect(firstIntent.registered.dispatchEligible).toBe(true);
    const originalGrant = await currentOwnerGrant(h);
    await h.accessPool.query(`UPDATE access.permission_grant
      SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [originalGrant.id]);
    await expect(h.access.register(firstIntent.request)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.access.claim(firstIntent.registered.id, firstIntent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await replaceOwnerGrant(h);
    const firstReplayAfterReplacement = await h.access.register(firstIntent.request);
    expect(firstReplayAfterReplacement).toMatchObject({ id: firstIntent.registered.id, replayed: true, dispatchEligible: false });
    await expect(h.access.claim(firstIntent.registered.id, firstIntent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);

    const beforeRevocation = await h.reply(h.actor);
    const secondIntent = await registerPlacement(h, h.actor, beforeRevocation);
    expect(secondIntent.registered.dispatchEligible).toBe(true);
    const currentGrant = await currentOwnerGrant(h);
    await h.accessPool.query(`UPDATE access.permission_grant SET active = false WHERE id = $1`, [currentGrant.id]);
    await expect(h.access.register(secondIntent.request)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.access.claim(secondIntent.registered.id, secondIntent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await replaceOwnerGrant(h);
    const secondReplayAfterReplacement = await h.access.register(secondIntent.request);
    expect(secondReplayAfterReplacement).toMatchObject({ id: secondIntent.registered.id, replayed: true, dispatchEligible: false });
    await expect(h.access.claim(secondIntent.registered.id, secondIntent.digest, h.principal))
      .rejects.toBeInstanceOf(AdmissionDenied);

    const afterReplacement = await h.reply(h.actor);
    const freshPlacement = await h.call('POST', '/v1/realm-reply-placements', afterReplacement.placement, h.actor);
    expect(freshPlacement.status, JSON.stringify(freshPlacement.body)).toBe(201);
  } finally { await h.close(); }
}, 180_000);

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
    expect((await h.accessPool.query(`SELECT 1 FROM access.membership
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2
      UNION ALL SELECT 1 FROM access.private_membership
      WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $3`,
    [h.realm, h.pen, h.principalId])).rowCount).toBe(0);
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

test('private-Realm membership cannot substitute for restricted reply-root readability', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('private', 'open');
    const work = await h.post('/v1/works', { ...h.workBody, authoring: 'own-work',
      title: `Restricted member reply root ${randomUUID()}` });
    expect(work.status, JSON.stringify(work.body)).toBe(201);
    const root = work.body as { work: string; workRevision: string };

    await fixtureAuthority(h, h.pen, 'work:create:root', 'access.membership.consent');
    await joinPrivatePen(h);
    expect((await h.accessPool.query(`SELECT state FROM access.private_membership
      WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2`, [h.realm, h.principalId])).rows[0].state)
      .toBe('joined');
    const principal = h.principal;
    expect(await h.access.canReadWork(principal, h.pen, root.work)).toBe(false);

    const input = { ...h.draftInput(h.pen, h.realm), rootTarget: root.work, rootRevision: root.workRevision };
    const key = randomUUID();
    const refused = await h.call('POST', '/v1/member-reply-drafts', input, h.pen, key);
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(refused.body.code).toBe('resource_unavailable');
    expect((await h.contentPool.query('SELECT id FROM content.variant WHERE id = $1', [input.variantId])).rowCount).toBe(0);
    expect((await h.contentPool.query('SELECT id FROM content.reply WHERE id = $1', [input.reply])).rowCount).toBe(0);
    expect((await h.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
  } finally { await h.close(); }
}, 180_000);

test('restricted-root readability cannot substitute for private-Realm participation', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('private', 'open');
    const work = await h.post('/v1/works', { ...h.workBody, authoring: 'own-work',
      title: `Restricted outsider reply root ${randomUUID()}` });
    expect(work.status, JSON.stringify(work.body)).toBe(201);
    const root = work.body as { work: string; workRevision: string };
    await fixtureAuthority(h, h.pen, `work:read:${root.work}`, 'work.read');
    const principal = h.principal;
    expect(await h.access.canReadWork(principal, h.pen, root.work)).toBe(true);
    expect((await h.accessPool.query(`SELECT id FROM access.private_membership
      WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $2 AND state = 'joined'`,
    [h.realm, h.principalId])).rowCount).toBe(0);

    const input = { ...h.draftInput(h.pen, null), rootTarget: root.work, rootRevision: root.workRevision };
    const draft = await h.call('POST', '/v1/member-reply-drafts', input, h.pen);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const identity = { profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: h.pen, rootTarget: root.work,
      rootRevision: root.workRevision, parentReply: null, parentRevision: null, contextRevision: null };
    const created = await h.call('POST', '/v1/realm-replies', identity, h.pen);
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const placement = { profile: 'realm-reply-placement-v1', realm: h.realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest: draft.body.revisionDigest,
      reviewDecisionId: null, expectedHead: null, actingSubject: h.pen };
    const digest = realmReplyDigest(placement);
    const key = randomUUID();
    await expect(h.access.register({ principal, actingSubject: h.pen,
      action: 'reply.place', scope: `reply:place:${h.realm}`, idempotencyKey: key, requestDigest: digest }))
      .rejects.toThrow('Realm submission policy denies this request');

    const before = await placementEffects(h, draft.body.revisionId, input.reply);
    const refusedKey = randomUUID();
    const refused = await h.call('POST', '/v1/realm-reply-placements', placement, h.pen, refusedKey);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('authority_denied');
    expect(await placementEffects(h, draft.body.revisionId, input.reply)).toEqual(before);
    expect((await h.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1', [refusedKey])).rowCount).toBe(0);
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

test('Realm member direct policy respects membership and vetoes; policy changes serialize with placements', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const created = await h.post('/v1/spaces', { profile: 'space-realm-v1', name: 'Reply members',
      capabilities: ['realm'], actingSubject: h.actor });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const realm = created.body.realm as string;
    const principal = await h.principal();
    const principalId = await h.access.activePrincipalId(principal);
    const admin = new AccessRealmManagement(h.accessPool);
    await admin.initialize(principal, realm, h.actor, h.env);
    await h.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'institution') ON CONFLICT DO NOTHING", [realm]);
    await h.accessPool.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision) VALUES ('realm',$1,1,'terms-1')
      ON CONFLICT (kind, owner_subject) DO UPDATE SET revision = EXCLUDED.revision,
        terms_revision = EXCLUDED.terms_revision`, [realm]);
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
      expectedHead: null, body: 'A Realm member reply.', actingSubject: h.pen };
    const draft = await h.post('/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await h.post('/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply: input.reply,
      variantId: input.variantId, revisionId: draft.body.revisionId, author: h.pen,
      rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      parentReply: null, parentRevision: null, contextRevision: null })).status).toBe(201);
    const bytes = draft.body.revisionDigest;
    const placement = { profile: 'realm-reply-placement-v1', realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest: bytes, reviewDecisionId: null,
      expectedHead: null, actingSubject: h.pen };
    expect((await h.post('/v1/realm-reply-placements', placement)).status).toBe(403);
    const review = { profile: 'realm-reply-review-v1', realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest: bytes, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'moderator-v1', dependencyDigest: 'a'.repeat(64),
      reasonReference: null, actingSubject: h.actor };
    expect((await h.post('/v1/realm-reply-reviews', { ...review, actingSubject: h.pen })).status).toBe(403);
    await grant(`review:decide:${realm}`, 'review.decide');
    const approved = await h.post('/v1/realm-reply-reviews', review);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const placed = await h.post('/v1/realm-reply-placements', { ...placement, reviewDecisionId: approved.body.decisionId });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect((await h.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND action = 'reply.place'`, [h.pen])).rowCount).toBe(0);
    const policy = async (reviewMode: 'mandatory' | 'trusted-members') => {
      const current = await admin.settings(principal, realm, h.actor, h.env);
      await admin.changeSettings(principal, realm, { actingSubject: h.actor,
        expectedGeneration: current.generation, expectedRulesRevision: current.ruleBasis.revision,
        reason: 'Change reply review policy', settings: { visibility: 'public', reviewMode,
          reviewRequired: reviewMode === 'mandatory', whoMaySubmit: 'granted', rules: [] } }, randomUUID(), h.env);
    };
    await policy('trusted-members');
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
    const preChangeDecision = (await h.contentPool.query<{ policy: string; policy_revision: string }>(`
      SELECT policy, policy_revision FROM content.realm_review_decision WHERE id = $1`,
    [accepted.body.reviewDecisionId])).rows[0]!;
    const revoked = await h.post('/v1/realm-reply-reviews', { ...review, revisionId: edited.body.revisionId,
      revisionDigest: editedDigest, expectedGeneration: '1', supersedes: accepted.body.reviewDecisionId,
      outcome: 'revoked', reasonReference: 'moderator-veto' });
    expect(revoked.status).toBe(201);
    expect(await h.replies.visible(realm, input.reply)).toBeNull();
    expect((await h.post('/v1/realm-reply-placements', { ...direct, expectedHead: accepted.body.placement })).status).toBe(403);
    // Register before leave/rejoin: the old episode cannot be claimed afterwards.
    const registered = await h.access.register({ principal, actingSubject: h.pen,
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
    let policyChange: Promise<void> | undefined;
    let policyAcknowledged = false;
    h.owner.preparePlacement = async (...args) => {
      const prepared = await prepare(...args);
      policyChange = policy('mandatory').then(() => { policyAcknowledged = true; });
      void policyChange.catch(() => {});
      await waitForBlockedRealmPolicyWrite(h);
      expect(policyAcknowledged).toBe(false);
      return prepared;
    };
    const settlePublication = h.content.settlePublication.bind(h.content);
    h.content.settlePublication = async (...args: Parameters<typeof h.content.settlePublication>) => {
      const settled = await settlePublication(...args);
      if (args[2].outcome === 'active' && args[2].revisionId === latest.body.revisionId) {
        expect(policyAcknowledged).toBe(false);
      }
      return settled;
    };
    const raced = await h.post('/v1/realm-reply-placements', { ...direct,
      revisionId: latest.body.revisionId, revisionDigest: latestDigest, expectedHead: accepted.body.placement });
    expect(raced.status, JSON.stringify(raced.body)).toBe(201);
    await policyChange;
    expect(policyAcknowledged).toBe(true);
    expect((await admin.settings(principal, realm, h.actor, h.env)).settings.reviewMode).toBe('mandatory');
    const racedDecision = (await h.contentPool.query<{ method: string; policy: string;
      policy_revision: string; direct_policy_revision: string | null }>(`SELECT d.method, d.policy, d.policy_revision,
        placement.direct_policy_revision FROM content.realm_review_decision d
        JOIN content.realm_placement_preparation placement ON placement.review_decision_id = d.id
        WHERE d.id = $1 AND d.revision_id = $2 AND placement.revision_id = $2`,
    [raced.body.reviewDecisionId, latest.body.revisionId])).rows[0];
    expect(racedDecision).toEqual({ method: 'policy', policy: preChangeDecision.policy,
      policy_revision: preChangeDecision.policy_revision,
      direct_policy_revision: preChangeDecision.policy_revision });
    expect((await h.contentPool.query(`SELECT status FROM content.publication_preparation
      WHERE revision_id=$1`, [latest.body.revisionId])).rows[0].status).toBe('active');
  } finally { await h.close(); }
}, 180_000);
