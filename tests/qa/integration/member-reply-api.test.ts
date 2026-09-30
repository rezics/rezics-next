import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';

test('G265: members and pen names author exact contribution comments, edit/delete their own replies, and replay without resurrection', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const input = { profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
      expectedHead: null, body: 'A member comment.', actingSubject: h.pen };
    const key = randomUUID();
    const draft = await h.post('/v1/member-reply-drafts', input, key);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await h.post('/v1/member-reply-drafts', input, key)).body.revisionId).toBe(draft.body.revisionId);
    const identity = { profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: h.pen, rootTarget: input.rootTarget,
      rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null };
    const identityKey = randomUUID();
    expect((await h.post('/v1/realm-replies', { ...identity, author: h.actor })).status).toBe(403);
    const created = await h.post('/v1/realm-replies', identity, identityKey);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.post('/v1/realm-replies', identity, identityKey)).body.replayed).toBe(true);
    const readPath = `/v1/member-replies/${input.reply.split('/').at(-1)}`;
    expect((await h.get(readPath)).body).toMatchObject({ author: h.pen, body: input.body, revisionId: draft.body.revisionId });
    const pagePath = `/v1/member-replies?${new URLSearchParams({ rootTarget: input.rootTarget, rootRevision: input.rootRevision })}`;
    expect((await h.get(pagePath)).body.items).toHaveLength(1);
    const provenance = (await h.contentPool.query('SELECT provenance FROM content.revision WHERE id = $1', [draft.body.revisionId])).rows[0].provenance;
    const admission = (await h.accessPool.query(`SELECT a.acting_subject, a.state, b.source_revision
      FROM access.admission a JOIN access.baseline_admission b ON b.admission_id = a.id WHERE a.id = $1`, [provenance.admissionId])).rows[0];
    expect(admission).toEqual({ acting_subject: h.pen, state: 'sealed', source_revision: input.rootRevision });
    const edit = { ...input, expectedHead: draft.body.revisionId, body: 'An edited comment.' };
    expect((await h.post('/v1/member-reply-drafts', { ...edit, actingSubject: h.actor })).status).toBe(409);
    expect((await h.post('/v1/member-reply-drafts', { ...input, variantId: `urn:rezics:variant:${randomUUID()}`, actingSubject: h.actor })).status).toBe(409);
    const edited = await h.post('/v1/member-reply-drafts', edit);
    expect(edited.status, JSON.stringify(edited.body)).toBe(201);
    expect((await h.post('/v1/member-reply-drafts', edit)).status).toBe(409);
    expect((await h.get(readPath)).body.body).toBe(edit.body);
    const erase = { ...input, expectedHead: edited.body.revisionId, body: null };
    const eraseKey = randomUUID();
    expect((await h.post('/v1/member-reply-drafts', erase, eraseKey)).status).toBe(201);
    expect((await h.post('/v1/member-reply-drafts', erase, eraseKey)).body.replayed).toBe(true);
    expect((await h.post('/v1/member-reply-drafts', input, key)).body.revisionId).toBe(draft.body.revisionId);
    expect((await h.get(readPath)).status).toBe(404);
    expect((await h.get(pagePath)).body.items).toEqual([]);
    expect((await h.accessPool.query(`SELECT id FROM access.permission_grant WHERE recipient_subject = ANY($1)
      AND action <> 'access.membership.consent'`, [[h.actor, h.pen]])).rowCount).toBe(0);
    const plan = await h.contentPool.query(`EXPLAIN (FORMAT JSON) SELECT id FROM content.reply
      WHERE root_target = $1 AND root_revision = $2 AND id > '' ORDER BY id LIMIT 33`, [input.rootTarget, input.rootRevision]);
    expect(JSON.stringify(plan.rows)).toContain('Limit');
    expect((await h.contentPool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'content'
      AND indexname = 'reply_exact_root_page'`)).rows[0].indexdef).toContain('(root_target, root_revision, id)');
  } finally { await h.close(); }
}, 180_000);

test('G265: a Content commit followed by lost Access settlement replays one authored revision', async () => {
  const h = await memberFixture();
  const settle = h.access.recordGraphOutcome.bind(h.access);
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const input = { profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
      expectedHead: null, body: 'A recoverable comment.', actingSubject: h.actor };
    const key = randomUUID();
    h.access.recordGraphOutcome = async () => { throw new Error('injected Access settlement outage'); };
    expect((await h.post('/v1/member-reply-drafts', input, key)).status).toBe(503);
    h.access.recordGraphOutcome = settle;
    const recovered = await h.post('/v1/member-reply-drafts', input, key);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.replayed).toBe(true);
    expect((await h.contentPool.query('SELECT id FROM content.revision WHERE variant_id = $1', [input.variantId])).rowCount).toBe(1);
    expect((await h.accessPool.query('SELECT state FROM access.admission WHERE idempotency_key = $1', [key])).rows[0].state).toBe('sealed');
  } finally { h.access.recordGraphOutcome = settle; await h.close(); }
}, 180_000);

test('G265: reply admission rejects private/erased roots, unverified and suspended Accounts; competing edits have one winner', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const input = { profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
      expectedHead: null, body: 'Another member comment.', actingSubject: h.actor };
    expect((await h.post('/v1/member-reply-drafts', { ...input, reply: nativeId(),
      variantId: `urn:rezics:variant:${randomUUID()}`, rootRevision: h.work.workRevision })).status).toBe(201);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [h.user.id]);
    expect((await h.post('/v1/member-reply-drafts', input)).status).toBe(403);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
    const draft = await h.post('/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await h.post('/v1/realm-replies', { profile: 'realm-reply-identity-v1',
      reply: input.reply, variantId: input.variantId, revisionId: draft.body.revisionId, author: h.actor,
      rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      parentReply: null, parentRevision: null, contextRevision: null })).status).toBe(201);
    const edits = await Promise.all(['edit one', 'edit two'].map(body => h.post('/v1/member-reply-drafts', {
      ...input, expectedHead: draft.body.revisionId, body })));
    expect(edits.map(result => result.status).sort()).toEqual([201, 409]);
    await h.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:revisions> {
      <${input.rootRevision}> a <https://rezics.com/vocab/ErasedRevision> } }`);
    expect((await h.get(`/v1/member-replies/${input.reply.split('/').at(-1)}`)).status).toBe(404);
    expect((await h.post('/v1/member-reply-drafts', { ...input, expectedHead: edits.find(result => result.status === 201)!.body.revisionId })).status).toBe(403);
    await h.accountPool.query('UPDATE rezics_account_security SET suspended_at = now(), generation = generation + 1 WHERE user_id = $1', [h.user.id]);
    expect((await h.post('/v1/member-reply-drafts', input)).status).toBe(401);
  } finally { await h.close(); }
}, 180_000);

test('G265: member replies still require exact Realm review and placement; edits do not inherit approval and deletion suppresses placement', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const realm = await h.post('/v1/spaces', { profile: 'space-realm-v1', name: 'Review Realm', capabilities: ['realm'], actingSubject: h.actor });
    expect(realm.status, JSON.stringify(realm.body)).toBe(201);
    const input = { profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
      expectedHead: null, body: 'Reply for Realm review.', actingSubject: h.pen };
    const draft = await h.post('/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await h.post('/v1/realm-replies', { profile: 'realm-reply-identity-v1',
      reply: input.reply, variantId: input.variantId, revisionId: draft.body.revisionId, author: h.pen,
      rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      parentReply: null, parentRevision: null, contextRevision: null })).status).toBe(201);
    const revisionDigest = (await h.get(`/v1/member-replies/${input.reply.split('/').at(-1)}`)).body.revisionDigest;
    const review = { profile: 'realm-reply-review-v1', realm: realm.body.realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: createHash('sha256').update(input.rootRevision).digest('hex'), reasonReference: null, actingSubject: h.actor };
    expect((await h.post('/v1/realm-reply-reviews', review)).status).toBe(403);
    const principalId = (await h.accessPool.query('SELECT id FROM access.principal WHERE account_subject = $1', [h.user.id])).rows[0].id;
    // Only the reviewer fixture has explicit moderation grants. The member
    // author's draft, identity, edits and deletion retain zero manual grants.
    for (const [prefix, action] of [['review:decide', 'review.decide'], ['reply:place', 'reply.place']]) {
      const scope = `${prefix}:${realm.body.realm}`;
      await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await h.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, h.actor, action]);
      await h.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), h.actor, scope, action]);
    }
    const approved = await h.post('/v1/realm-reply-reviews', review);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const placement = { profile: 'realm-reply-placement-v1', realm: realm.body.realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest, reviewDecisionId: approved.body.decisionId,
      expectedHead: null, actingSubject: h.actor };
    const placed = await h.post('/v1/realm-reply-placements', placement);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const edited = await h.post('/v1/member-reply-drafts', { ...input, body: 'Edited reply.', expectedHead: draft.body.revisionId });
    expect(edited.status).toBe(201);
    expect((await h.post('/v1/realm-reply-placements', { ...placement, revisionId: edited.body.revisionId,
      expectedHead: placed.body.placement })).status).toBe(409);
    expect((await h.replies.visible(realm.body.realm, input.reply))?.revisionId).toBe(draft.body.revisionId);
    expect((await h.post('/v1/member-reply-drafts', { ...input, body: null, expectedHead: edited.body.revisionId })).status).toBe(201);
    expect(await h.replies.visible(realm.body.realm, input.reply)).toBeNull();
  } finally { await h.close(); }
}, 180_000);
