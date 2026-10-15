import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { memberFixture, nativeId } from '../../../services/main/tests/member-reply-fixture.ts';
import { TARGET_RESOLVE_COST } from '../../../services/main/src/modules/target/resolve.ts';
import { AccessInvitations } from '../../../services/main/src/modules/access/invitation.ts';
import { AdmissionDenied, AdmissionExpired } from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { foregroundCounted } from './support/query-cost-meter.ts';

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
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({ code: 'authority_denied' });
    expect(replay.body).not.toHaveProperty('revisionId');
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

test('Account evidence changes Suitability eligibility for a semantic reply root while admission stays unchanged', async () => {
  const h = await memberFixture({ liveContentEvidence: true });
  try {
    const reader = await h.agent('Restricted semantic reader');
    const principal = await h.principal();
    const principalId = (await h.accessPool.query(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0].id as string;

    async function authority(subject: string, scope: string, action: string) {
      const ids = { representation: randomUUID(), grant: randomUUID() };
      await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await h.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [ids.representation, principalId, subject, action]);
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour')`,
      [ids.grant, h.actor, subject, scope, action]);
      return ids;
    }
    async function revoke(ids: { representation: string; grant: string }) {
      await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1', [ids.representation]);
      await h.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [ids.grant]);
    }

    await authority(h.actor, 'semantic:create:root', 'semantic.change');
    const created = await h.post('/v1/semantic/changes', { profile: 'semantic-change-v1',
      expectedHead: null, actingSubject: h.actor,
      state: { component: 'resource', types: ['https://schema.org/Person'], properties: [] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const root = created.body as { component: string; revision: string };
    expect(root.component).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    expect(root.revision).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);

    const readAs = async (resource: string, subject: string) => {
      const path = `/v1/semantic/resources/${resource.slice(-36)}?actingSubject=${encodeURIComponent(subject)}`;
      const response = await h.app.handle(new Request(`http://main.local${path}`, {
        headers: { authorization: `Bearer ${h.token}` } }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const draftInput = (reply = nativeId()) => ({ profile: 'member-reply-draft-v1', reply,
      variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: root.component, rootRevision: root.revision,
      language: 'en', direction: 'ltr', expectedHead: null, body: 'A restricted semantic-root reply.', actingSubject: reader });
    const writeGrants = async (reply: string) => h.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND ((scope_id = $2 AND action = 'content.draft')
        OR (scope_id = $3 AND action = 'reply.create'))`,
    [reader, `content:draft:${reply}`, `reply:create:${root.component}`]);
    const revisionCount = async (variantId: string) => (await h.contentPool.query(
      'SELECT id FROM content.revision WHERE variant_id = $1', [variantId])).rowCount;
    const replyCount = async (reply: string) => (await h.contentPool.query(
      'SELECT id FROM content.reply WHERE id = $1', [reply])).rowCount;
    const noEffectsBeforeRegistration = async (input: ReturnType<typeof draftInput>, key: string) => {
      expect(await revisionCount(input.variantId)).toBe(0);
      expect(await replyCount(input.reply)).toBe(0);
      expect((await h.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
    };

    const hiddenInput = draftInput();
    const hiddenKey = randomUUID();
    expect((await readAs(root.component, reader)).status).toBe(404);
    expect((await h.post('/v1/member-reply-drafts', hiddenInput, hiddenKey)).status).toBe(404);
    await noEffectsBeforeRegistration(hiddenInput, hiddenKey);

    const workRead = await authority(reader, `work:read:${root.component}`, 'work.read');
    expect(await h.access.canReadWork(principal, reader, root.component)).toBe(true);
    const workOnlyInput = draftInput();
    const workOnlyKey = randomUUID();
    expect((await readAs(root.component, reader)).status).toBe(404);
    expect((await h.post('/v1/member-reply-drafts', workOnlyInput, workOnlyKey)).status).toBe(404);
    await noEffectsBeforeRegistration(workOnlyInput, workOnlyKey);
    expect((await writeGrants(workOnlyInput.reply)).rowCount).toBe(0);

    const semanticRead = await authority(reader, `semantic:read:${root.component}`, 'semantic.read');
    expect(await h.access.canReadSemanticResource(principal, reader, root.component, root.revision, h.fuseki)).toBe(true);
    expect((await readAs(root.component, reader)).status).toBe(200);
    const input = draftInput();
    const key = randomUUID();
    expect((await writeGrants(input.reply)).rowCount).toBe(0);
    const draft = await h.post('/v1/member-reply-drafts', input, key);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(await revisionCount(input.variantId)).toBe(1);
    const identity = { profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: reader, rootTarget: root.component,
      rootRevision: root.revision, parentReply: null, parentRevision: null, contextRevision: null };
    const identityResult = await h.post('/v1/realm-replies', identity);
    expect(identityResult.status, JSON.stringify(identityResult.body)).toBe(201);
    expect(identityResult.body).toMatchObject({ reply: input.reply, author: reader,
      rootTarget: root.component, rootRevision: root.revision });
    expect((await writeGrants(input.reply)).rowCount).toBe(0);

    // The target is selected through the bounded exact-head query, not an inventory scan.
    let selectionCapture: { query: string; rows: number }[] | undefined;
    const originalQuery = h.fuseki.query.bind(h.fuseki);
    h.fuseki.query = async (...args: Parameters<typeof h.fuseki.query>) => {
      const result = await originalQuery(...args);
      const query = args[0];
      if (foregroundCounted() && selectionCapture && query.includes('SELECT ?epoch ?sequence ?r ?revision ?type ?mergedInto')
        && query.includes(`VALUES ?r { <${root.component}> }`)) {
        const rows = result.results?.bindings ?? [];
        selectionCapture.push({ query, rows: rows.filter(row => row.r?.value === root.component).length });
      }
      return result;
    };

    const signedIn = await fetch(`${h.base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.base },
      body: JSON.stringify({ email: h.user.email, password: h.user.password }) });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get('set-cookie')!;
    const accountWrite = async (body: object) => {
      const response = await fetch(`${h.base}/api/account/content-preferences`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: h.base, cookie }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const adultPreferences = await accountWrite({ expectedRevision: 0, birthDate: '1990-01-01', country: 'US',
      categories: { r18: true } });
    expect(adultPreferences.status, JSON.stringify(adultPreferences.body)).toBe(200);

    const assessmentDigest = createHash('sha256').update(`${root.component}:${randomUUID()}`).digest('hex');
    await h.accessPool.query(`INSERT INTO access.suitability_assessment
      (id,target,labels,basis,assessor,principal_id,revision_number,authority_proof,idempotency_key,request_digest)
      VALUES ($1,$2,ARRAY['r18']::text[],'author',$3,$4,1,'{}'::jsonb,$5,$6)`,
    [randomUUID(), root.component, h.actor, principalId, randomUUID(), assessmentDigest]);

    const readSuitability = async () => {
      const observations: { query: string; rows: number }[] = [];
      selectionCapture = observations;
      try { return { ...(await h.post('/v1/suitability/reads', { targets: [root.component], actingSubject: reader })), observations }; }
      finally { selectionCapture = undefined; }
    };
    const adultRead = await readSuitability();
    expect(adultRead.status, JSON.stringify(adultRead.body)).toBe(200);
    expect(adultRead.body.viewer).toMatchObject({ age: 'adult', country: 'US', optIns: { sexual: true } });
    expect(adultRead.body.items[0]).toMatchObject({
      assessment: { status: 'assessed', labels: ['r18'] }, eligible: true, reasons: [],
    });
    // Suitability reads use live Account evidence; interactive reply-root admission still uses the summary channel, so Account preferences do not change admission itself.
    expect(adultRead.observations.length).toBeGreaterThan(0);

    const unrelated: string[] = [];
    for (let index = 0; index < 8; index++) {
      const resource = await h.post('/v1/semantic/changes', { profile: 'semantic-change-v1',
        expectedHead: null, actingSubject: h.actor,
        state: { component: 'resource', types: ['https://schema.org/Person'], properties: [] } });
      expect(resource.status, JSON.stringify(resource.body)).toBe(201);
      unrelated.push(resource.body.component as string);
    }
    expect(new Set(unrelated).size).toBe(8);
    expect(unrelated).not.toContain(root.component);

    const updatedPreferences = await accountWrite({ expectedRevision: adultPreferences.body.revision,
      categories: { r18: false } });
    expect(updatedPreferences.status, JSON.stringify(updatedPreferences.body)).toBe(200);
    const restrictedRead = await readSuitability();
    expect(restrictedRead.status, JSON.stringify(restrictedRead.body)).toBe(200);
    expect(restrictedRead.body.viewer).toMatchObject({ age: 'adult', country: 'US', optIns: { sexual: false } });
    expect(restrictedRead.body.items[0]).toMatchObject({
      assessment: { status: 'assessed', labels: ['r18'] }, eligible: false,
      reasons: ['sexual_opt_in_required'],
    });

    for (const observation of [...adultRead.observations, ...restrictedRead.observations]) {
      expect(observation.query).toContain(`VALUES ?r { <${root.component}> }`);
      expect(observation.query).toContain(`LIMIT ${TARGET_RESOLVE_COST.revisionRows + 1}`);
      expect(observation.rows).toBeGreaterThan(0);
      expect(observation.rows).toBeLessThanOrEqual(TARGET_RESOLVE_COST.typesPerTarget);
    }
    expect(restrictedRead.observations.map(observation => observation.rows))
      .toEqual(adultRead.observations.map(observation => observation.rows));

    const betweenRegisterAndClaim = draftInput();
    const lateKey = randomUUID();
    expect((await writeGrants(betweenRegisterAndClaim.reply)).rowCount).toBe(0);
    const claim = h.access.claim.bind(h.access);
    let revokedAtClaim = false;
    h.access.claim = async (admissionId, digest, accountPrincipal) => {
      revokedAtClaim = true;
      await revoke(semanticRead);
      return claim(admissionId, digest, accountPrincipal);
    };
    let lateResult: Awaited<ReturnType<typeof h.post>> | undefined;
    try { lateResult = await h.post('/v1/member-reply-drafts', betweenRegisterAndClaim, lateKey); }
    finally { h.access.claim = claim; }
    expect(revokedAtClaim).toBe(true);
    expect(lateResult!.status, JSON.stringify(lateResult!.body)).toBe(403);
    expect(await revisionCount(betweenRegisterAndClaim.variantId)).toBe(0);
    expect(await replyCount(betweenRegisterAndClaim.reply)).toBe(0);
    expect((await h.accessPool.query('SELECT state FROM access.admission WHERE idempotency_key = $1', [lateKey]))
      .rowCount).toBe(1);
    expect(await h.access.canReadWork(principal, reader, root.component)).toBe(true);
    await revoke(workRead);
  } finally { await h.close(); }
}, 240_000);

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

test('expired member-reply admissions stay fenced while a fresh key can claim', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const principal = await h.principal();
    const principalId = (await h.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0]!.id;
    const reply = nativeId();
    const digest = createHash('sha256').update(randomUUID()).digest('hex');
    const request = { principal, actingSubject: h.pen, action: 'content.draft',
      scope: `content:draft:${reply}`, requestDigest: digest,
      baselineRelatedWork: h.work.work, baselineSourceRevision: h.first.draftRevision };
    await grantFixtureAuthority(h.accessPool, { scope: request.scope, requireDispatch: false,
      representations: [{ principalId, actor: h.pen, action: 'content.draft', lifetime: '8 hours' }],
      grant: { actor: h.pen, action: 'content.draft', lifetime: '8 hours' } });

    const key = randomUUID();
    const registered = await h.access.register({ ...request, idempotencyKey: key });
    expect(registered.dispatchEligible).toBe(true);
    await h.accessPool.query(`UPDATE access.admission SET expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`, [registered.id]);

    const replay = await h.access.register({ ...request, idempotencyKey: key });
    expect(replay).toMatchObject({ id: registered.id, replayed: true, dispatchEligible: false });
    await expect(h.access.claim(registered.id, digest, principal)).rejects.toBeInstanceOf(AdmissionExpired);
    expect((await h.accessPool.query(`SELECT expires_at < clock_timestamp() AS expired FROM access.admission
      WHERE id = $1`, [registered.id])).rows[0].expired).toBe(true);

    const recovered = await h.access.register({ ...request, idempotencyKey: randomUUID() });
    expect(recovered.dispatchEligible).toBe(true);
    await h.access.claim(recovered.id, digest, principal);
  } finally { await h.close(); }
}, 180_000);

test('revoked Person control cannot be replaced for a saved proof; terminal draft receipt still replays', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const principal = await h.principal();
    const principalId = (await h.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0]!.id;

    const controllerName = `Reply controller ${randomUUID()}`;
    const controllerEmail = `reply-controller-${randomUUID()}@example.test`;
    const controllerPassword = randomUUID().repeat(2);
    const signup = await h.accountApp.handle(new Request(`${h.base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: h.base },
      body: JSON.stringify({ ...signupPolicyFixture, name: controllerName,
        email: controllerEmail, password: controllerPassword }),
    }));
    expect(signup.status).toBe(200);
    const signupBody = await signup.json() as { user: { id: string } };
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [signupBody.user.id]);
    const controllerSignin = await fetch(`${h.base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.base },
      body: JSON.stringify({ email: controllerEmail, password: controllerPassword }),
    });
    expect(controllerSignin.status).toBe(200);
    const controllerToken = (await signIn({ account: h.base, clientId: h.client.client_id,
      redirectUri: h.redirectUri,
      scope: 'openid agent:create work:create work:edit work:read comment:create space:create realm:profile realm:adopt',
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, }, controllerSignin.headers.get('set-cookie')!)).accessToken;
    const controllerPrincipal = await h.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${controllerToken}` },
    }), ['work:edit']);
    const provisionApp = h.main();
    const secondPersonResponse = await h.call(provisionApp, controllerToken, randomUUID(), {
      profile: 'agent-provision-v1', kind: 'person', displayName: controllerName,
    });
    expect(secondPersonResponse.status).toBe(201);
    const secondPerson = (await secondPersonResponse.json() as { agent: string }).agent;
    const rootEpoch = (await h.accessPool.query<{ authority_epoch: string }>(`
      SELECT authority_epoch::text FROM access.scope_gate WHERE id = 'work:create:root'`)).rows[0]!.authority_epoch;
    const invitations = new AccessInvitations(h.accessPool);
    const receipt = () => ({ idempotencyKey: randomUUID(),
      requestDigest: createHash('sha256').update(randomUUID()).digest('hex') });
    const invitationId = randomUUID();
    const offered = await invitations.issue(principal, receipt(), {
      invitationId, issuerSubject: h.pen, recipientSubject: secondPerson,
      offer: 'control', issuerLifetime: 'institutional', expectedAuthorityEpoch: rootEpoch,
    });
    expect(offered).toMatchObject({ offer: 'control', status: 'pending' });
    const accepted = await invitations.accept(controllerPrincipal, receipt(), {
      invitationId,
      representationId: randomUUID(),
      expectedAuthorityEpoch: rootEpoch,
    });
    expect(accepted).toMatchObject({ offer: 'control', status: 'accepted' });
    const secondPrincipalId = (await h.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`,
    [controllerPrincipal.issuer, controllerPrincipal.subject])).rows[0]!.id;

    const staleReply = nativeId();
    const digest = createHash('sha256').update(randomUUID()).digest('hex');
    const staleRequest = { principal, actingSubject: h.pen, action: 'content.draft',
      scope: `content:draft:${staleReply}`, requestDigest: digest,
      baselineRelatedWork: h.work.work, baselineSourceRevision: h.first.draftRevision };
    const staleKey = randomUUID();
    const registered = await h.access.register({ ...staleRequest, idempotencyKey: staleKey });
    expect(registered.dispatchEligible).toBe(true);
    const savedProof = (await h.accessPool.query<{ representation_id: string; representation_generation: string }>(`
      SELECT representation_id, representation_generation::text FROM access.baseline_admission
      WHERE admission_id = $1`, [registered.id])).rows[0]!;

    const input = { profile: 'member-reply-draft-v1', reply: nativeId(),
      variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: h.work.work,
      rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr' as const,
      expectedHead: null, body: 'A committed reply receipt.', actingSubject: h.pen };
    const key = randomUUID();
    const committed = await h.post('/v1/member-reply-drafts', input, key);
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
    const provenance = (await h.contentPool.query<{ admissionId: string }>(
      'SELECT provenance->>\'admissionId\' AS "admissionId" FROM content.revision WHERE id = $1',
      [committed.body.revisionId])).rows[0]!;
    const committedProof = (await h.accessPool.query<{ representation_id: string }>(`
      SELECT representation_id FROM access.baseline_admission WHERE admission_id = $1`,
    [provenance.admissionId])).rows[0]!;
    expect(committedProof.representation_id).toBe(savedProof.representation_id);

    await h.accessPool.query(`UPDATE access.representation SET active = false, generation = generation + 1
      WHERE id = $1`, [savedProof.representation_id]);
    await grantFixtureAuthority(h.accessPool, { scope: staleRequest.scope, requireDispatch: false,
      representations: [{ principalId, actor: h.pen, action: 'content.draft', lifetime: '8 hours' }],
      grant: { actor: h.pen, action: 'content.draft', lifetime: '8 hours' } });

    expect((await h.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'content.draft'
        AND active AND valid_until > clock_timestamp()`, [h.pen, staleRequest.scope])).rowCount).toBe(1);
    expect((await h.contentPool.query('SELECT id FROM content.reply WHERE id = $1', [staleReply])).rowCount).toBe(0);
    const revokedGeneration = (await h.accessPool.query<{ generation: string }>(`SELECT generation::text AS generation
      FROM access.representation WHERE id = $1`, [savedProof.representation_id])).rows[0]!.generation;
    expect(revokedGeneration).not.toBe(savedProof.representation_generation);

    const replacementControl = (await h.accessPool.query<{ id: string }>(`SELECT id
      FROM access.representation WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'
        AND active AND valid_until > clock_timestamp()`, [secondPrincipalId, h.pen])).rows[0]!;
    expect(replacementControl.id).not.toBe(savedProof.representation_id);
    expect((await h.accessPool.query('SELECT access.agent_controller_count($1) AS n', [h.pen]))
      .rows[0]!.n).toBe(1);

    await grantFixtureAuthority(h.accessPool, { scope: `reply:create:${input.rootTarget}`, requireDispatch: false,
      representations: [{ principalId, actor: h.pen, action: 'reply.create', lifetime: '8 hours' }],
      grant: { actor: h.pen, action: 'reply.create', lifetime: '8 hours' } });
    const identity = { profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: committed.body.revisionId, author: h.pen, rootTarget: input.rootTarget,
      rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null };
    const identityKey = randomUUID();
    const refusedIdentity = await h.post('/v1/realm-replies', identity, identityKey);
    expect(refusedIdentity.status, JSON.stringify(refusedIdentity.body)).toBe(403);
    expect(refusedIdentity.body.code).toBe('authority_denied');
    expect((await h.contentPool.query('SELECT id FROM content.reply WHERE id = $1', [input.reply])).rowCount).toBe(0);
    expect((await h.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1',
      [identityKey])).rowCount).toBe(0);

    // The new controller authorizes a new control row for the original
    // principal through the already controlled Person h.actor. This keeps the
    // stale admission's failure tied to its saved proof, not missing control.
    const restoreEpoch = (await h.accessPool.query<{ authority_epoch: string }>(`
      SELECT authority_epoch::text FROM access.scope_gate WHERE id = 'work:create:root'`)).rows[0]!.authority_epoch;
    const restoreInvitationId = randomUUID();
    const restoreOffered = await invitations.issue(controllerPrincipal, receipt(), {
      invitationId: restoreInvitationId, issuerSubject: h.pen, recipientSubject: h.actor,
      offer: 'control', issuerLifetime: 'institutional', expectedAuthorityEpoch: restoreEpoch,
    });
    expect(restoreOffered).toMatchObject({ offer: 'control', status: 'pending' });
    const restoreAccepted = await invitations.accept(principal, receipt(), {
      invitationId: restoreInvitationId, representationId: randomUUID(),
      expectedAuthorityEpoch: restoreEpoch,
    });
    expect(restoreAccepted).toMatchObject({ offer: 'control', status: 'accepted' });
    const restoredControl = (await h.accessPool.query<{ id: string }>(`SELECT id
      FROM access.representation WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'
        AND active AND valid_until > clock_timestamp()`, [principalId, h.pen])).rows[0]!;
    expect(restoredControl.id).not.toBe(savedProof.representation_id);
    expect((await h.accessPool.query('SELECT access.agent_controller_count($1) AS n', [h.pen]))
      .rows[0]!.n).toBe(2);

    const revokedReplay = await h.access.register({ ...staleRequest, idempotencyKey: staleKey });
    expect(revokedReplay).toMatchObject({ id: registered.id, replayed: true, dispatchEligible: false });
    await expect(h.access.claim(registered.id, digest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    const freshAdmission = await h.access.register({ ...staleRequest, idempotencyKey: randomUUID() });
    expect(freshAdmission.dispatchEligible).toBe(true);
    await h.access.claim(freshAdmission.id, digest, principal);

    const replay = await h.post('/v1/member-reply-drafts', input, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ revisionId: committed.body.revisionId, replayed: true });
    expect((await h.contentPool.query('SELECT id FROM content.revision WHERE variant_id = $1',
      [input.variantId])).rowCount).toBe(1);
  } finally { await h.close(); }
}, 180_000);

test('G265: reply admission rejects private/erased roots and competing edits have one winner', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const input = { profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
      expectedHead: null, body: 'Another member comment.', actingSubject: h.actor };
    expect((await h.post('/v1/member-reply-drafts', { ...input, reply: nativeId(),
      variantId: `urn:rezics:variant:${randomUUID()}`, rootRevision: h.work.workRevision })).status).toBe(201);
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
  } finally { await h.close(); }
}, 180_000);

test('unverified and suspended Accounts cannot use scoped action grants for member reply drafts', async () => {
  const h = await memberFixture();
  try {
    expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
    const principal = await h.principal();
    expect(principal.emailVerified).toBe(true);
    const principalId = (await h.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0]!.id;
    const rejected = (reply: string) => ({ profile: 'member-reply-draft-v1', reply,
      variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: h.work.work,
      rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr' as const,
      expectedHead: null, body: 'A reply with a current Account assertion.', actingSubject: h.pen });
    const installDraftGrant = async (input: ReturnType<typeof rejected>) => grantFixtureAuthority(h.accessPool, {
      scope: `content:draft:${input.reply}`, requireDispatch: false,
      representations: [{ principalId, actor: h.pen, action: 'content.draft', lifetime: '8 hours' }],
      grant: { actor: h.pen, action: 'content.draft', lifetime: '8 hours' },
    });
    const makeRequest = (input: ReturnType<typeof rejected>, key: string) => ({
      principal, actingSubject: h.pen, action: 'content.draft', scope: `content:draft:${input.reply}`,
      requestDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      idempotencyKey: key, baselineRelatedWork: h.work.work,
      baselineSourceRevision: h.first.draftRevision,
    });
    const assertNoDraft = async (input: ReturnType<typeof rejected>) => {
      expect((await h.contentPool.query('SELECT id FROM content.revision WHERE variant_id = $1',
        [input.variantId])).rowCount).toBe(0);
      expect((await h.contentPool.query('SELECT id FROM content.reply WHERE id = $1',
        [input.reply])).rowCount).toBe(0);
    };
    const assertGrantStillActive = async (input: ReturnType<typeof rejected>) => {
      expect((await h.accessPool.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'content.draft'
          AND active AND valid_until > clock_timestamp()`, [h.pen, `content:draft:${input.reply}`])).rowCount).toBe(1);
    };

    const unverified = rejected(nativeId());
    await installDraftGrant(unverified);
    const unverifiedKey = randomUUID();
    const unverifiedRequest = makeRequest(unverified, unverifiedKey);
    const unverifiedRegistered = await h.access.register(unverifiedRequest);
    expect(unverifiedRegistered.dispatchEligible).toBe(true);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [h.user.id]);
    const unverifiedState = (await h.accountPool.query<{ email_verified: boolean; suspended_at: Date | null }>(`
      SELECT "user"."emailVerified" AS email_verified, security.suspended_at
      FROM "user" LEFT JOIN rezics_account_security security ON security.user_id = "user".id
      WHERE "user".id = $1`, [h.user.id])).rows[0]!;
    expect(unverifiedState).toEqual({ email_verified: false, suspended_at: null });
    await assertGrantStillActive(unverified);
    const unverifiedHttpKey = randomUUID();
    expect((await h.post('/v1/member-reply-drafts', unverified, unverifiedHttpKey)).status).toBe(403);
    await assertGrantStillActive(unverified);
    await assertNoDraft(unverified);
    expect((await h.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1',
      [unverifiedHttpKey])).rowCount).toBe(0);
    const unverifiedPrincipal = await h.principal();
    await expect(h.access.claim(unverifiedRegistered.id, unverifiedRequest.requestDigest, principal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.access.register({ ...unverifiedRequest, principal: unverifiedPrincipal }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await assertGrantStillActive(unverified);
    await assertNoDraft(unverified);

    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
    const afterVerification = rejected(nativeId());
    await installDraftGrant(afterVerification);
    const verifiedPrincipal = await h.principal();
    expect(verifiedPrincipal.emailVerified).toBe(true);
    const verifiedRequest = { ...makeRequest(afterVerification, randomUUID()), principal: verifiedPrincipal };
    const afterVerificationAdmission = await h.access.register(verifiedRequest);
    expect(afterVerificationAdmission.dispatchEligible).toBe(true);
    await h.access.claim(afterVerificationAdmission.id, verifiedRequest.requestDigest, verifiedPrincipal);
  } finally { await h.close(); }

  const suspendedFixture = await memberFixture();
  try {
    expect((await suspendedFixture.post('/v1/publication-selections', suspendedFixture.selection)).status).toBe(201);
    const suspendedPrincipal = await suspendedFixture.principal();
    expect(suspendedPrincipal.emailVerified).toBe(true);
    const suspendedPrincipalId = (await suspendedFixture.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [suspendedPrincipal.issuer, suspendedPrincipal.subject])).rows[0]!.id;
    const rejected = (reply: string) => ({ profile: 'member-reply-draft-v1', reply,
      variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: suspendedFixture.work.work,
      rootRevision: suspendedFixture.first.draftRevision, language: 'en', direction: 'ltr' as const,
      expectedHead: null, body: 'A reply with a current Account assertion.', actingSubject: suspendedFixture.pen });
    const installDraftGrant = async (input: ReturnType<typeof rejected>) => grantFixtureAuthority(suspendedFixture.accessPool, {
      scope: `content:draft:${input.reply}`, requireDispatch: false,
      representations: [{ principalId: suspendedPrincipalId, actor: suspendedFixture.pen, action: 'content.draft', lifetime: '8 hours' }],
      grant: { actor: suspendedFixture.pen, action: 'content.draft', lifetime: '8 hours' },
    });
    const makeRequest = (input: ReturnType<typeof rejected>, key: string) => ({
      principal: suspendedPrincipal, actingSubject: suspendedFixture.pen, action: 'content.draft', scope: `content:draft:${input.reply}`,
      requestDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      idempotencyKey: key, baselineRelatedWork: suspendedFixture.work.work,
      baselineSourceRevision: suspendedFixture.first.draftRevision,
    });
    const assertNoDraft = async (input: ReturnType<typeof rejected>) => {
      expect((await suspendedFixture.contentPool.query('SELECT id FROM content.revision WHERE variant_id = $1',
        [input.variantId])).rowCount).toBe(0);
      expect((await suspendedFixture.contentPool.query('SELECT id FROM content.reply WHERE id = $1',
        [input.reply])).rowCount).toBe(0);
    };
    const assertGrantStillActive = async (input: ReturnType<typeof rejected>) => {
      expect((await suspendedFixture.accessPool.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'content.draft'
          AND active AND valid_until > clock_timestamp()`, [suspendedFixture.pen, `content:draft:${input.reply}`])).rowCount).toBe(1);
    };

    const suspended = rejected(nativeId());
    await installDraftGrant(suspended);
    const suspendedKey = randomUUID();
    const suspendedRequest = makeRequest(suspended, suspendedKey);
    const suspendedRegistered = await suspendedFixture.access.register(suspendedRequest);
    expect(suspendedRegistered.dispatchEligible).toBe(true);
    await suspendedFixture.accountPool.query('UPDATE rezics_account_security SET suspended_at = now(), generation = generation + 1 WHERE user_id = $1', [suspendedFixture.user.id]);
    const suspendedState = (await suspendedFixture.accountPool.query<{ email_verified: boolean; suspended_at: Date | null }>(`
      SELECT "user"."emailVerified" AS email_verified, security.suspended_at
      FROM "user" JOIN rezics_account_security security ON security.user_id = "user".id
      WHERE "user".id = $1`, [suspendedFixture.user.id])).rows[0]!;
    expect(suspendedState.email_verified).toBe(true);
    expect(suspendedState.suspended_at).not.toBeNull();
    await assertGrantStillActive(suspended);
    const suspendedHttpKey = randomUUID();
    expect((await suspendedFixture.post('/v1/member-reply-drafts', suspended, suspendedHttpKey)).status).toBe(401);
    await assertGrantStillActive(suspended);
    await assertNoDraft(suspended);
    expect((await suspendedFixture.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1',
      [suspendedHttpKey])).rowCount).toBe(0);
    await expect(suspendedFixture.access.claim(suspendedRegistered.id, suspendedRequest.requestDigest, suspendedPrincipal))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(suspendedFixture.principal()).rejects.toThrow();
    await assertGrantStillActive(suspended);
    await assertNoDraft(suspended);

    await suspendedFixture.accountPool.query('UPDATE rezics_account_security SET suspended_at = NULL, generation = generation + 1 WHERE user_id = $1', [suspendedFixture.user.id]);
    const recoveredSignin = await fetch(`${suspendedFixture.base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: suspendedFixture.base },
      body: JSON.stringify({ email: suspendedFixture.user.email, password: suspendedFixture.user.password }),
    });
    expect(recoveredSignin.status).toBe(200);
    const recoveredToken = (await signIn({ account: suspendedFixture.base, clientId: suspendedFixture.client.client_id,
      redirectUri: suspendedFixture.redirectUri,
      scope: 'openid agent:create work:create work:edit work:read comment:create space:create realm:profile realm:adopt',
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, }, recoveredSignin.headers.get('set-cookie')!)).accessToken;
    const recoveredPrincipal = await suspendedFixture.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${recoveredToken}` },
    }), ['work:edit']);
    expect(recoveredPrincipal.emailVerified).toBe(true);
    const afterUnsuspension = rejected(nativeId());
    await installDraftGrant(afterUnsuspension);
    const recoveredRequest = { ...makeRequest(afterUnsuspension, randomUUID()), principal: recoveredPrincipal };
    const recoveredAdmission = await suspendedFixture.access.register(recoveredRequest);
    expect(recoveredAdmission.dispatchEligible).toBe(true);
    await suspendedFixture.access.claim(recoveredAdmission.id, recoveredRequest.requestDigest, recoveredPrincipal);
  } finally { await suspendedFixture.close(); }
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
