import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';

test('G265: controlled Persons author exact contribution comments and replay without resurrection', async () => {
  const h = await memberFixture();
  try {
    const organization = await h.agent('Managed organization', 'organization');
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
    const admission = (await h.accessPool.query(`SELECT a.acting_subject, a.state, b.source_revision,
        b.representation_id, p.agent_kind AS selected_kind
      FROM access.admission a JOIN access.baseline_admission b ON b.admission_id = a.id
      JOIN access.agent_provision p ON p.id = b.provision_id WHERE a.id = $1`, [provenance.admissionId])).rows[0];
    expect(admission).toMatchObject({ acting_subject: h.pen, state: 'sealed',
      source_revision: input.rootRevision, selected_kind: 'person' });
    expect((await h.accessPool.query(`SELECT agent_kind FROM access.agent_provision
      WHERE agent_id = $1`, [organization])).rows[0].agent_kind).toBe('organization');
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
    await h.accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [h.pen]);
    const replay = await h.post('/v1/member-reply-drafts', input, key);
    expect(replay.body).toMatchObject({ revisionId: draft.body.revisionId, replayed: true });
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

test('restricted Work reply roots require exact live read authority through draft and identity', async () => {
  const h = await memberFixture();
  try {
    const reader = await h.agent('Restricted Work reader');
    expect(reader).not.toBe(h.actor);
    expect((await h.accessPool.query('SELECT agent_kind FROM access.agent_provision WHERE agent_id = $1', [reader]))
      .rows[0]?.agent_kind).toBe('person');

    const workResponse = await h.post('/v1/works', { ...h.workBody, authoring: 'own-work',
      title: `Restricted reply root ${randomUUID()}` });
    expect(workResponse.status, JSON.stringify(workResponse.body)).toBe(201);
    const root = workResponse.body as { work: string; workRevision: string };
    expect(root.workRevision).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    const workPath = `/v1/works/${root.work.slice(-36)}`;
    const get = async (path: string, bearer?: string) => {
      const response = await h.app.handle(new Request(`http://main.local${path}`,
        bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}));
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    const principal = await h.principal();
    const principalId = (await h.accessPool.query(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0].id as string;
    const workReadScope = `work:read:${root.work}`;
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [workReadScope]);
    async function readerAuthority() {
      const ids = { representation: randomUUID(), grant: randomUUID() };
      await h.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`, [ids.representation, principalId, reader]);
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$3,$4,'work.read',now() + interval '1 hour')`,
      [ids.grant, h.actor, reader, workReadScope]);
      return ids;
    }
    async function revokeReaderAuthority(ids: { representation: string; grant: string }) {
      await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1', [ids.representation]);
      await h.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [ids.grant]);
    }
    const exactRead = await readerAuthority();

    expect((await get(workPath)).status).toBe(404);
    const disclosed = await get(`${workPath}?actingSubject=${encodeURIComponent(reader)}`, h.token);
    expect(disclosed.status, JSON.stringify(disclosed.body)).toBe(200);
    expect(disclosed.body).toMatchObject({ id: root.work, disclosure: 'restricted' });

    const writeGrants = async (reply: string) => h.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND ((scope_id = $2 AND action = 'content.draft')
        OR (scope_id = $3 AND action = 'reply.create'))`,
    [reader, `content:draft:${reply}`, `reply:create:${root.work}`]);
    const draftInput = (reply = nativeId()) => ({ profile: 'member-reply-draft-v1', reply,
      variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: root.work, rootRevision: root.workRevision,
      language: 'en', direction: 'ltr', expectedHead: null, body: 'A restricted-root reply.', actingSubject: reader });
    const revisionCount = async (variantId: string) => (await h.contentPool.query(
      'SELECT id FROM content.revision WHERE variant_id = $1', [variantId])).rowCount;
    const replyCount = async (reply: string) => (await h.contentPool.query(
      'SELECT id FROM content.reply WHERE id = $1', [reply])).rowCount;
    const noContribution = async (input: ReturnType<typeof draftInput>) => {
      expect(await revisionCount(input.variantId)).toBe(0);
      expect(await replyCount(input.reply)).toBe(0);
    };
    const noEffectsBeforeRegistration = async (input: ReturnType<typeof draftInput>, key: string) => {
      await noContribution(input);
      expect((await h.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
    };

    const input = draftInput();
    const key = randomUUID();
    expect((await writeGrants(input.reply)).rowCount).toBe(0);
    const draft = await h.post('/v1/member-reply-drafts', input, key);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const countAfterDraft = await revisionCount(input.variantId);
    expect(countAfterDraft).toBe(1);
    const replay = await h.post('/v1/member-reply-drafts', input, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, replayed: true });
    expect(await revisionCount(input.variantId)).toBe(countAfterDraft);

    const identity = { profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: reader, rootTarget: root.work,
      rootRevision: root.workRevision, parentReply: null, parentRevision: null, contextRevision: null };
    const identityKey = randomUUID();
    const created = await h.post('/v1/realm-replies', identity, identityKey);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ reply: input.reply, author: reader,
      rootTarget: root.work, rootRevision: root.workRevision });
    expect((await h.contentPool.query(`SELECT author, root_target, root_revision FROM content.reply WHERE id = $1`,
      [input.reply])).rows[0]).toEqual({ author: reader, root_target: root.work, root_revision: root.workRevision });
    const identityReplay = await h.post('/v1/realm-replies', identity, identityKey);
    expect(identityReplay.status, JSON.stringify(identityReplay.body)).toBe(200);
    expect(identityReplay.body).toMatchObject({ author: reader, rootTarget: root.work,
      rootRevision: root.workRevision, replayed: true });
    expect(await revisionCount(input.variantId)).toBe(countAfterDraft);
    expect(await replyCount(input.reply)).toBe(1);
    expect((await writeGrants(input.reply)).rowCount).toBe(0);

    const privateSelection = await h.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:current> { ?contribution a rv:TextContribution ; rv:work <${root.work}> ; rv:publicationHead ?decision }
      GRAPH <urn:rezics:graph:revisions> { ?decision a rv:PublicationDecision ; rv:disclosure rv:Public ; rv:selectedDraft ?draft }
    }`);
    expect(privateSelection.boolean).toBe(false);
    expect((await get(workPath)).status).toBe(404);
    expect((await get(`/v1/member-replies/${input.reply.slice(-36)}`)).status).toBe(404);

    // The Content receipt commits before Access settlement, so this retry must
    // resolve the same intent instead of inserting another revision.
    const uncertain = draftInput();
    const uncertainKey = randomUUID();
    const settle = h.access.recordGraphOutcome.bind(h.access);
    h.access.recordGraphOutcome = async () => { throw new Error('injected Access settlement outage'); };
    let failed: Awaited<ReturnType<typeof h.post>> | undefined;
    try { failed = await h.post('/v1/member-reply-drafts', uncertain, uncertainKey); }
    finally { h.access.recordGraphOutcome = settle; }
    expect(failed!.status, JSON.stringify(failed!.body)).toBe(503);
    expect(await revisionCount(uncertain.variantId)).toBe(1);
    const recovered = await h.post('/v1/member-reply-drafts', uncertain, uncertainKey);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body).toMatchObject({ reply: uncertain.reply, variantId: uncertain.variantId,
      revisionId: (await h.contentPool.query('SELECT id FROM content.revision WHERE variant_id = $1',
        [uncertain.variantId])).rows[0].id, replayed: true });
    expect(await revisionCount(uncertain.variantId)).toBe(1);

    await revokeReaderAuthority(exactRead);
    const hidden = draftInput();
    const hiddenKey = randomUUID();
    const hiddenResult = await h.post('/v1/member-reply-drafts', hidden, hiddenKey);
    expect(hiddenResult.status).toBe(404);
    const missing = { ...draftInput(), rootTarget: nativeId(), rootRevision: nativeId() };
    const missingKey = randomUUID();
    const missingResult = await h.post('/v1/member-reply-drafts', missing, missingKey);
    expect(missingResult.status).toBe(404);
    expect(hiddenResult.body).toEqual(missingResult.body);
    await noEffectsBeforeRegistration(hidden, hiddenKey);
    await noEffectsBeforeRegistration(missing, missingKey);

    const claimReader = await readerAuthority();
    const betweenRegisterAndClaim = draftInput();
    const lateKey = randomUUID();
    expect((await writeGrants(betweenRegisterAndClaim.reply)).rowCount).toBe(0);
    const claim = h.access.claim.bind(h.access);
    let revokedAtClaim = false;
    h.access.claim = async (admissionId, digest, accountPrincipal) => {
      revokedAtClaim = true;
      await revokeReaderAuthority(claimReader);
      return claim(admissionId, digest, accountPrincipal);
    };
    let lateResult: Awaited<ReturnType<typeof h.post>> | undefined;
    try { lateResult = await h.post('/v1/member-reply-drafts', betweenRegisterAndClaim, lateKey); }
    finally { h.access.claim = claim; }
    expect(revokedAtClaim).toBe(true);
    expect(lateResult!.status, JSON.stringify(lateResult!.body)).toBe(403);
    await noContribution(betweenRegisterAndClaim);
    expect((await h.accessPool.query('SELECT state FROM access.admission WHERE idempotency_key = $1', [lateKey]))
      .rowCount).toBe(1);
  } finally { await h.close(); }
}, 180_000);

test('G265: Org and legacy PenName action grants cannot author member reply drafts', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const organization = await h.agent('Controlled organization', 'organization');
    const legacyPenName = nativeId();
    const principal = await h.principal();
    const principalId = (await h.accessPool.query(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0].id;
    await h.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [legacyPenName]);
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), principalId, legacyPenName]);
    await h.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${legacyPenName}> a rv:Agent ; rv:agentKind rv:PenNameAgent . }
    }`);

    async function grantReplyDraft(actor: string, reply: string) {
      const scope = `content:draft:${reply}`;
      await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await h.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,'content.draft','infinity')`, [randomUUID(), principalId, actor]);
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$3,$4,'content.draft','infinity')`, [randomUUID(), h.actor, actor, scope]);
    }

    for (const actor of [organization, legacyPenName]) {
      const input = { profile: 'member-reply-draft-v1', reply: nativeId(),
        variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: h.work.work,
        rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
        expectedHead: null, body: 'Must not be drafted by this Agent.', actingSubject: actor };
      await grantReplyDraft(actor, input.reply);
      const before = (await h.contentPool.query('SELECT count(*)::int AS count FROM content.revision')).rows[0].count;
      const response = await h.post('/v1/member-reply-drafts', input);
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect((await h.contentPool.query('SELECT count(*)::int AS count FROM content.revision')).rows[0].count).toBe(before);
      expect((await h.accessPool.query(`SELECT id FROM access.admission
        WHERE scope_id = $1 AND action = 'content.draft'`, [`content:draft:${input.reply}`])).rowCount).toBe(0);
    }
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
