import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';
import { encodeReadCursor } from '../../../services/main/src/modules/work/read-session.ts';
import { readRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import type { AuthorityWitness } from '../../../services/main/src/modules/access/authority-witness.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';

test('policy-only Realm replies retain identity witnesses and lose dispatch when outsider policy closes', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    expect((await h.accessPool.query(`SELECT 1 FROM access.membership
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2
      UNION ALL SELECT 1 FROM access.private_membership
      WHERE kind = 'realm' AND owner_subject = $1 AND principal_id = $3`,
    [h.realm, h.pen, h.principalId])).rowCount).toBe(0);
    expect((await h.accessPool.query(`SELECT 1 FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'reply.place'`,
    [h.pen, `reply:place:${h.realm}`])).rowCount).toBe(0);
    const request = () => ({ principal: h.principal, actingSubject: h.pen, action: 'reply.place',
      scope: `reply:place:${h.realm}`, idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const admitted = await h.access.register(request());
    const saved = (await h.accessPool.query<{ realm_membership: string; authority_witness: AuthorityWitness[] }>(`
      SELECT b.realm_membership,a.authority_witness FROM access.admission a
      JOIN access.baseline_admission b ON b.admission_id = a.id WHERE a.id = $1`, [admitted.id])).rows[0]!;
    expect(saved.realm_membership).toBe('open');
    expect(saved.authority_witness.map(source => source.table).sort())
      .toEqual(['authority_subject', 'principal', 'representation']);
    expect((await h.access.claim(admitted.id, admitted.requestDigest, h.principal)).state).toBe('claimed');

    for (const [visibility, reviewMode] of [
      ['public', 'mandatory'], ['public', 'trusted-members'], ['restricted', 'open'], ['private', 'open'],
    ] as const) {
      await h.policy('public', 'open');
      const intent = request();
      const pending = await h.access.register(intent);
      await h.policy(visibility, reviewMode);
      await expect(h.access.claim(pending.id, pending.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
      expect((await h.access.register(intent)).dispatchEligible, `${visibility}/${reviewMode}`).toBe(false);
      expect((await h.accessPool.query('SELECT state FROM access.admission WHERE id = $1', [pending.id])).rows[0]!.state)
        .toBe('registered');
      await expect(h.access.register(request())).rejects.toBeInstanceOf(AdmissionDenied);
    }
  } finally { await h.close(); }
}, 180_000);

test('public submissions use author baseline and open Realm self-join uses recipient consent', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    // The fixture offers an explicit submission grant; remove it to exercise
    // the author's baseline rather than a substitute grant path.
    await h.accessPool.query(`UPDATE access.permission_grant SET active = false,generation = generation + 1
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'submission.submit'`,
    [h.pen, `submission:submit:${h.realm}`]);
    const submitted = await h.submit(h.pen);
    expect(submitted.result.status, JSON.stringify(submitted.result.body)).toBe(201);
    expect(submitted.result.body.submission).toMatchObject({ state: 'accepted', reviewer: null });
    const proof = (await h.accessPool.query<{ realm_membership: string | null; authority_witness: AuthorityWitness[] }>(`
      SELECT b.realm_membership,a.authority_witness FROM access.admission a
      JOIN access.baseline_admission b ON b.admission_id = a.id
      WHERE a.action = 'submission.submit' AND a.idempotency_key = $1`, [submitted.key])).rows[0]!;
    expect(proof.realm_membership).toBeNull();
    expect(proof.authority_witness.map(source => source.table).sort())
      .toEqual(['authority_subject', 'principal', 'representation']);

    const candidate = await h.contribution('A pending public submission', h.pen);
    const intent = { principal: h.principal, actingSubject: h.pen, action: 'submission.submit',
      scope: `submission:submit:${h.realm}`, baselineContribution: candidate.contribution,
      idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) };
    const pending = await h.access.register(intent);
    const closed = await h.settingsInput('public', 'open');
    const settings = { ...closed, settings: { ...closed.settings, whoMaySubmit: 'closed' } };
    expect((await h.call('PUT', `${h.root}/settings`, settings)).status).toBe(201);
    await expect(h.access.claim(pending.id, pending.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.access.register(intent)).dispatchEligible).toBe(false);
    expect((await h.submit(h.pen)).result.status).toBe(403);

    // Self-join needs the recipient's consent mandate, with no Realm grant.
    await h.grant(h.pen, 'work:create:root', 'access.membership.consent');
    const joining = new AccessRealmJoining(h.accessPool, h.env);
    const input = await h.settingsInput('public', 'open');
    expect((await h.call('PUT', `${h.root}/settings`, {
      ...input, settings: { ...input.settings, selfJoin: true },
    })).status).toBe(201);
    const basis = await joining.policyFor(h.principal, h.realm, h.pen);
    expect(basis).toMatchObject({ selfJoin: true, state: 'absent' });
    const join = { actingSubject: h.pen, expectedMembershipGeneration: basis.membershipGeneration,
      expectedPolicyRevision: basis.policyRevision, termsRevision: basis.termsRevision, listed: true };
    const key = randomUUID();
    const joined = await joining.selfJoin(h.principal, h.realm, join, key);
    expect(joined).toMatchObject({ member: h.pen, membershipGeneration: '1', replayed: false });
    expect(await joining.selfJoin(h.principal, h.realm, join, key)).toMatchObject({
      membershipId: joined.membershipId, membershipGeneration: '1', replayed: true,
    });
  } finally { await h.close(); }
}, 180_000);

// Origin is bound before identity/publication, so even an interrupted creation
// never exposes Realm text through the separately public reply API.
test('G-298: origin disclosure, all visibility/review transitions, indexed reads and membership revocation', async () => {
  const h = await realmVisibilityFixture();
  try {
    const origin = await h.reply();
    const legacy = await h.reply(h.actor, null);
    const other = await h.post('/v1/spaces', { profile: 'space-realm-v1', name: 'Other community',
      capabilities: ['realm'], actingSubject: h.actor });
    await h.grant(h.actor, `review:decide:${other.body.realm}`, 'review.decide');
    const foreignReview = await h.call('POST', '/v1/realm-reply-reviews', { profile: 'realm-reply-review-v1',
      realm: other.body.realm, reply: origin.input.reply, revisionId: origin.draft.body.revisionId,
      revisionDigest: origin.placement.revisionDigest, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'moderator-v1', dependencyDigest: 'a'.repeat(64),
      reasonReference: null, actingSubject: h.actor });
    expect(foreignReview.status, JSON.stringify(foreignReview.body)).toBe(403);
    expect((await h.call('GET', origin.path, undefined, null)).status).toBe(404);
    expect((await h.call('GET', legacy.path, undefined, null)).status).toBe(200);
    expect((await h.call('POST', '/v1/realm-reply-placements', origin.placement)).status).toBe(403);
    const pending = await h.submit();
    expect(pending.result.status, JSON.stringify(pending.result.body)).toBe(201);
    expect(pending.result.body.submission.state).toBe('pending');
    const changedOrigin = await h.call('POST', '/v1/member-reply-drafts', { ...origin.input,
      expectedHead: origin.draft.body.revisionId, originRealm: null });
    expect([400,403,409]).toContain(changedOrigin.status);
    await h.policy('public', 'open');
    const placed = await h.call('POST', '/v1/realm-reply-placements', origin.placement);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const downloaded = await h.call('GET', origin.path, undefined, null);
    expect(downloaded.status, JSON.stringify(downloaded.body)).toBe(200);
    expect(downloaded.headers.get('cache-control')).toBe('no-store');
    const anonymousList = new URLSearchParams({ rootTarget: h.work.work, rootRevision: h.first.draftRevision });
    const global = await h.call('GET', `/v1/member-replies?${anonymousList}`, undefined, null);
    expect(global.status).toBe(200);
    expect(global.body.items.map((row: { reply: string }) => row.reply)).toContain(legacy.input.reply);
    expect(global.body.items.map((row: { reply: string }) => row.reply)).not.toContain(origin.input.reply);
    const outsiderReply = await h.reply(h.pen);
    const outsiderPlaced = await h.call('POST', '/v1/realm-reply-placements', outsiderReply.placement, h.pen);
    expect(outsiderPlaced.status, JSON.stringify(outsiderPlaced.body)).toBe(201);
    const automatic = await h.submit(h.pen);
    expect(automatic.result.status, JSON.stringify(automatic.result.body)).toBe(201);
    expect(automatic.result.body.submission).toMatchObject({ state: 'accepted', reviewer: null });
    expect((await h.call('POST', `${h.root}/submissions`, automatic.input, h.pen, automatic.key)).body.submission.selection)
      .toBe(automatic.result.body.submission.selection);
    const eventFor = async (receipt: string) => {
      const row = (await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:sequence ?sequence } }`)).results!.bindings[0]!;
      const batch = await readNextMainOutboxBatch(h.fuseki, h.env.lineage.dataEpoch,
        (BigInt(row.sequence!.value) - 1n).toString());
      expect(batch?.eventIds).toHaveLength(1);
      return readMainOutboxEnvelope(h.fuseki, batch!, batch!.eventIds[0]!);
    };
    const selectionEvent = await eventFor(automatic.result.body.submission.adoptionReceipt);
    expect(selectionEvent.type).toBe('com.rezics.realm.submission-selected.v1');
    expect(selectionEvent.data.receipt).toMatchObject({ work: h.work.work,
      mainVersion: h.work.mainVersion, selectedDraft: automatic.input.selectedDraft, submittingAgent: h.pen });
    expect(selectionEvent.data.receipt.selectionManifest).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
    const policyEvent = await eventFor((await readRealmPolicy(h.env,h.realm))!.revision!);
    expect(policyEvent.type).toBe('com.rezics.realm.policy-changed.v1');
    expect((await h.accessPool.query(`SELECT 1 FROM access.permission_grant
      WHERE recipient_subject=$1 AND action='publication.adopt'`, [h.pen])).rowCount).toBe(0);
    const local = await h.call('GET', `${h.root}/works`, undefined, null);
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    expect(local.body.items.map((item: { id: string }) => item.id)).toContain(h.work.work);
    const cursor = encodeReadCursor(['realm-works-v1', h.realm, null], local.body.sourcePosition, h.work.work);
    await waitForRealmDirectory(h.env, () => h.app.handle(new Request('http://main.local/v1/realms?q=Visibility')),
      page => page.items.some(item => item.id === h.realm));
    const warmDirectory = await h.call('GET', '/v1/realms?q=Visibility', undefined, null);
    expect(warmDirectory.status).toBe(200);
    expect(JSON.stringify(warmDirectory.body)).toContain(h.realm);
    const warmSearch = await h.call('POST', '/v1/queries', { profile: 'public-realm-phrase-v1',
      context: { kind: 'realm-local', id: h.realm }, phrase: 'Policy submission', language: 'en' }, null);
    expect(warmSearch.status, JSON.stringify(warmSearch.body)).toBe(200);
    expect(JSON.stringify(warmSearch.body)).toContain(automatic.input.selectedDraft);
    await h.policy('restricted', 'open');
    expect((await h.call('GET', h.root, undefined, null)).status).toBe(200);
    expect((await h.call('GET', `${h.root}/works?cursor=${cursor}`, undefined, null)).status).toBe(409);
    expect((await h.call('POST', '/v1/member-reply-drafts', h.draftInput(h.pen), h.pen)).status).toBe(403);
    expect((await h.call('POST', `${h.root}/submissions`, automatic.input, h.pen)).status).toBe(403);
    await h.policy('private', 'trusted-members');
    for (const path of [h.root, `${h.root}/works`, `${h.root}/decisions`, origin.path,
      `/v1/member-replies?${anonymousList}&realm=${encodeURIComponent(h.realm)}`]) {
      expect((await h.call('GET', path, undefined, null)).status, path).toBe(404);
      expect((await h.call('GET', path, undefined, h.pen)).status, path).toBe(404);
      const member = await h.call('GET', path);
      expect(member.status, `${path}: ${JSON.stringify(member.body)}`).toBe(200);
    }
    expect((await h.call('GET', legacy.path, undefined, null)).status).toBe(200);
    // A downloaded response is an independent copy; the server cannot recall it.
    expect(downloaded.body.body).toBe('Realm discussion secret');
    const memberDirect = await h.reply();
    const memberPlacement = await h.call('POST', '/v1/realm-reply-placements', memberDirect.placement);
    expect(memberPlacement.status, JSON.stringify(memberPlacement.body)).toBe(201);
    expect((await h.submit()).result.body.submission.state).toBe('accepted');
    await waitForRealmDirectory(h.env, () => h.app.handle(new Request('http://main.local/v1/realms?q=Visibility')),
      page => page.items.every(item => item.id !== h.realm));
    const directory = await h.call('GET', '/v1/realms?q=Visibility', undefined, null);
    expect(directory.status, JSON.stringify(directory.body)).toBe(200);
    expect(JSON.stringify(directory.body)).not.toContain(h.realm);
    const search = await h.call('POST', '/v1/queries', { profile: 'public-realm-phrase-v1',
      context: { kind: 'realm-local', id: h.realm }, phrase: 'Policy submission', language: 'en' }, null);
    expect([200,404]).toContain(search.status);
    expect(JSON.stringify(search.body)).not.toContain(automatic.input.selectedDraft);
    const discovery = await h.call('GET', `/v1/works?scope=realm&realm=${encodeURIComponent(h.realm)}`, undefined, null);
    expect(discovery.status).toBe(404);
    const feed = await h.call('GET', `/v1/resources/${h.work.work.slice(-36)}/discussion`, undefined, null);
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect(JSON.stringify(feed.body)).not.toContain(h.realm);
    // A moderator veto still dominates automatic policy approval.
    await h.grant(h.actor, `review:decide:${h.realm}`, 'review.decide');
    expect((await h.call('POST', '/v1/realm-reply-reviews', { ...memberDirect.placement, profile: 'realm-reply-review-v1', expectedGeneration: memberPlacement.body.reviewGeneration, supersedes: memberPlacement.body.reviewDecisionId,
      outcome: 'revoked', method: 'human', methodRevision: 'moderator-v1', dependencyDigest: 'a'.repeat(64),
      reasonReference: 'moderator-veto', expectedHead: undefined, reviewDecisionId: undefined })).status).toBe(201);
    expect((await h.call('GET', memberDirect.path)).status).toBe(404);
    await h.policy('public', 'trusted-members');
    expect((await h.submit(h.pen)).result.body.submission.state).toBe('pending');
    const untrusted = await h.reply(h.pen);
    expect((await h.call('POST', '/v1/realm-reply-placements', untrusted.placement, h.pen)).status).toBe(403);
    expect((await h.call('GET', origin.path, undefined, null)).status).toBe(200);
    // A policy head is part of the immutable selection audit, not a fabricated moderator decision.
    const policies = (await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:context ${iri(h.realm)} ;
        rv:selectionBasis rv:RealmPolicy ; rv:realmPolicyHead ?policy ; rv:submittingAgent ?submitter .
        FILTER NOT EXISTS { ?selection rv:reviewer ?reviewer } } }`)).boolean;
    expect(policies).toBe(true);
    await h.policy('private', 'mandatory');
    await h.grant(h.pen, 'work:create:root', 'access.membership.consent');
    const consent = await new AccessMembershipConsents(h.accessPool).issue({ principal: h.principal,
      kind: 'realm', ownerSubject: h.realm, memberSubject: h.pen, expectedGeneration: '0',
      expectedPolicyRevision: '0', termsRevision: 'realm-membership-v1', idempotencyKey: randomUUID(),
      requestDigest: 'a'.repeat(64) });
    const settings = await h.call('GET', `${h.root}/settings`);
    const joined = await h.call('POST', `${h.root}/members`, { actingSubject: h.actor, member: h.pen,
      action: 'add', expectedGeneration: settings.body.generation, expectedMembershipGeneration: '0',
      reason: 'Join private discussion', consent: consent.consentReference, durationSeconds: null });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect((await h.call('GET', origin.path, undefined, h.pen)).status).toBe(200);
    expect((await h.call('POST', `${h.root}/members`, { actingSubject: h.actor, member: h.pen,
      action: 'ban', expectedGeneration: joined.body.generation, expectedMembershipGeneration: '1',
      reason: 'Revoke private discussion access', consent: null, durationSeconds: null })).status).toBe(201);
    expect((await h.call('GET', origin.path, undefined, h.pen)).status).toBe(404);
    // Revoke after graph authorization but before the read's final Access fence.
    const summary = h.access.realmReadProof.bind(h.access);
    let calls = 0;
    h.access.realmReadProof = async (...args) => {
      const proof = await summary(...args);
      if (++calls === 1) await h.accessPool.query(`UPDATE access.permission_grant SET active=false,
        generation=generation+1 WHERE scope_id=$1 AND recipient_subject=$2 AND action='realm.owner'`,
      [`governance:realm:${h.realm}`,h.actor]);
      return proof;
    };
    expect((await h.call('GET', h.root)).status).toBe(404);
    h.access.realmReadProof = summary;
  } finally { await h.close(); }
}, 180_000);

test('G-298: policy delivery recovers ambiguous outcomes and stale concurrent changes cannot reopen reads', async () => {
  const h = await realmVisibilityFixture();
  try {
    const input = await h.settingsInput('private', 'open');
    const key = randomUUID();
    const command = h.fuseki.commandWithReceipt.bind(h.fuseki);
    let block = true;
    h.fuseki.commandWithReceipt = async envelope => {
      if (block && envelope.receipt.startsWith('urn:rezics:realm-policy:')) throw new Error('graph unavailable');
      return command(envelope);
    };
    expect((await h.call('PUT', `${h.root}/settings`, input, h.actor, key)).status).toBe(503);
    expect((await h.call('POST', '/v1/member-reply-drafts', h.draftInput())).status).toBe(503);
    block = false;
    const replay = await h.call('PUT', `${h.root}/settings`, input, h.actor, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await h.call('GET', h.root, undefined, null)).status).toBe(404);
    // The graph commits but transport loses the response: the exact receipt proves delivery.
    h.fuseki.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      if (envelope.receipt.startsWith('urn:rezics:realm-policy:')) throw new Error('response lost after commit');
      return result;
    };
    await h.policy('restricted', 'mandatory');
    expect((await readRealmPolicy(h.env,h.realm))?.visibility).toBe('restricted');
    h.fuseki.commandWithReceipt = command;
    const race = await h.settingsInput('private', 'mandatory');
    const outcomes = await Promise.all([1,2].map(() => h.call('PUT', `${h.root}/settings`, race)));
    expect(outcomes.map(result => result.status).sort()).toEqual([201,409]);
    expect((await h.call('GET', h.root, undefined, null)).status).toBe(404);
  } finally { await h.close(); }
}, 180_000);


test('G-298: a changed review policy cancels an unfinished automatic adoption; committed replay survives transport loss', async () => {
  const h = await realmVisibilityFixture();
  try {
    await h.policy('public', 'open');
    const command = h.fuseki.commandWithReceipt.bind(h.fuseki);
    let change = true;
    h.fuseki.commandWithReceipt = async envelope => {
      if (change && envelope.update.includes('RealmSubmissionSelectedEvent')) {
        change = false;
        await h.policy('public', 'mandatory');
      }
      return command(envelope);
    };
    const stale = await h.submit();
    expect(stale.result.status, JSON.stringify(stale.result.body)).toBe(201);
    expect(stale.result.body.submission).toMatchObject({ state: 'stale', selection: null });
    h.fuseki.commandWithReceipt = command;
    await h.policy('public', 'open');
    h.fuseki.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      if (envelope.update.includes('RealmSubmissionSelectedEvent')) throw new Error('reply lost after graph commit');
      return result;
    };
    const accepted = await h.submit();
    expect(accepted.result.status, JSON.stringify(accepted.result.body)).toBe(201);
    expect(accepted.result.body.submission.state).toBe('accepted');
    h.fuseki.commandWithReceipt = command;
    const replay = await h.call('POST', `${h.root}/submissions`, accepted.input, h.actor, accepted.key);
    expect(replay.status).toBe(200);
    expect(replay.body.submission).toEqual(accepted.result.body.submission);
  } finally { await h.close(); }
}, 180_000);
