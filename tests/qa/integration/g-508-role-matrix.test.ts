import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessRoles } from '../../../services/main/src/modules/access/roles.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { SourceAuthorNameStore } from '../../../services/main/src/modules/source/author-name.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { workScalarEditDigest } from '../../../services/main/src/modules/work/edit.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { workKinds } from '../../../services/main/src/modules/work/work-kinds.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';

const scopes = ['agent:create', 'work:create', 'work:edit', 'work:read', 'source:acquire', 'source:intake', 'access:role'];
const native = () => `https://rezics.com/id/${randomUUID()}`;

test('G508: role matrix gates kinds, retyping, every import entry point and public catalogue editing', async () => {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const original = { account: Bun.env.ACCOUNT_DATABASE_URL, access: Bun.env.ACCESS_DATABASE_URL };
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try {
    Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
    Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
    h = await agentProvisionHarness(scopes);
  } catch (error) { await databases.close(); throw error; }
  finally {
    Bun.env.ACCOUNT_DATABASE_URL = original.account;
    Bun.env.ACCESS_DATABASE_URL = original.access;
  }
  const content = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  try {
    await migrateContent(content);
    const access = new AccessAdmissionRegistry(h.accessPool);
    access.configureBaseline(h.fuseki);
    const contexts = new AccessActingContexts(h.accessPool, h.env);
    let fetches = 0;
    const fetcher = (async (url: string | URL | Request) => {
      fetches++;
      if (String(url) === 'https://openlibrary.org/authors/OL991508A.json') {
        return Response.json({ key: '/authors/OL991508A', type: { key: '/type/author' }, revision: 1, name: 'Imported author' });
      }
      expect(String(url)).toBe('https://openlibrary.org/works/OL1W.json');
      return Response.json({ key: '/works/OL1W', type: { key: '/type/work' }, title: 'Imported Work' });
    }) as typeof fetch;
    const intake = new SourceIntakeStore(content);
    intake.reserveOpenLibrarySlot = async () => {};
    const main = createMainApp(h.fuseki, { environment: h.env, account: h.verifier, access,
      actingContexts: contexts, roles: new AccessRoles(h.accessPool),
      agentProvisioning: new AgentProvisioning(h.accessPool, h.env),
      sourceAcquisitions: sourceAcquisitionServices(content, { reserve: async () => {}, fetcher }),
      sourceIntake: intake, openLibraryFetch: fetcher,
      sourceAuthorNames: new SourceAuthorNameStore(content, intake, fetcher),
    });
    const request = (token: string, method: string, path: string, body?: object, key = randomUUID()) =>
      main.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    async function json<T>(response: Response, status: number): Promise<T> {
      const body = await response.json();
      expect({ status: response.status, ...(response.status !== status ? { body } : {}) })
        .toEqual({ status });
      return body as T;
    }
    async function tokenFor(user: { email: string; password: string }) {
      const session = await h.auth.api.signInEmail({ body: user, asResponse: true });
      const verifier = randomBytes(32).toString('base64url');
      const url = new URL(`${h.base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: h.client.client_id,
        redirect_uri: h.redirectUri, scope: `openid ${scopes.join(' ')}`, state: randomUUID(),
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url') })) url.searchParams.set(key, value);
      const authorized = await fetch(url, { redirect: 'manual', headers: { cookie: session.headers.get('set-cookie')! } });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${h.base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: h.client.client_id,
          code, redirect_uri: h.redirectUri, code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE! }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    async function person(name: string, user = h.user) {
      await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [user.id]);
      const token = await tokenFor(user);
      const provision = await json<{ agent: string }>(await request(token, 'POST', '/v1/agents',
        { profile: 'agent-provision-v1', kind: 'person', displayName: name }), 201);
      return { name, token, subject: provision.agent };
    }
    const administrator = await person('administrator');
    const people = [administrator];
    for (const name of ['ordinary', 'editor', 'author']) {
      const password = randomBytes(24).toString('base64url');
      const email = `g508-${name}-${randomUUID()}@example.test`;
      const result = await h.auth.api.signUpEmail({ body: { name, email, password } });
      people.push(await person(name, { ...h.user, id: result.user.id, email, password }));
    }
    const ordinary = people[1]!, editor = people[2]!, author = people[3]!;
    const principalId = (await h.accessPool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1', [h.user.id])).rows[0]!.id;
    // Bootstrap the existing Access role binding and delegation ceiling. Account
    // operator membership plays no part in any catalogue authorization.
    const adminFamily = randomUUID();
    const bootstrap = await h.accessPool.connect();
    try {
      await bootstrap.query('BEGIN');
      await bootstrap.query(`INSERT INTO access.role_family (id, owner_subject, scope_id, head_revision)
        VALUES ($1,$2,'work:create:root',1)`, [adminFamily, administrator.subject]);
      await bootstrap.query(`INSERT INTO access.role_revision (family_id, revision, permissions)
        VALUES ($1,1,ARRAY['work.create','work.edit'])`, [adminFamily]);
      await bootstrap.query('COMMIT');
    } catch (error) { await bootstrap.query('ROLLBACK'); throw error; }
    finally { bootstrap.release(); }
    await h.accessPool.query(`INSERT INTO access.role_binding (id, family_id, role_revision,
      issuer_subject, recipient_subject, valid_until, assigned_by_principal)
      VALUES ($1,$2,1,$3,$3,now() + interval '1 hour',$4)`,
    [randomUUID(), adminFamily, administrator.subject, principalId]);
    for (const action of ['access.role.manage', 'access.role.bind', 'access.grant.assign.work.create']) {
      await h.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, administrator.subject, action]);
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`, [randomUUID(), administrator.subject, action]);
    }
    const editorFamily = randomUUID();
    await json(await request(administrator.token, 'POST', '/v1/access/roles', {
      profile: 'work-create-role-family-v1', familyId: editorFamily, issuerSubject: administrator.subject,
      expectedAuthorityEpoch: '0', permissions: ['work.edit'] }), 200);
    const epoch = async () => (await contexts.discover(await h.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${administrator.token}` } }), ['access:role']))).authorityEpoch;
    const binding = (issuerSubject: string, recipientSubject: string, expectedAuthorityEpoch: string,
      bindingId = randomUUID()) => ({ profile: 'work-create-role-binding-change-v1', action: 'bind',
      issuerSubject, recipientSubject, expectedAuthorityEpoch, bindingId, familyId: editorFamily,
      roleRevision: '1', validUntil: new Date(Date.now() + 30 * 60_000).toISOString() });
    const editorBinding = randomUUID();
    await json(await request(administrator.token, 'POST', '/v1/access/role-bindings',
      binding(administrator.subject, editor.subject, await epoch(), editorBinding)), 200);
    const create = (person: typeof administrator, types: string[], key = randomUUID()) =>
      request(person.token, 'POST', '/v1/works', { profile: 'metadata-only-v1', title: 'Role matrix Book',
        language: 'en', semanticTypes: types, actingSubject: person.subject }, key);
    type CreatedWork = { work: string; workRevision: string; mainVersion: string };
    const target = await json<CreatedWork>(await create(author, ['https://schema.org/Book']), 201);
    const other = await json<{ work: string; workRevision: string }>(await create(ordinary, ['https://schema.org/Book']), 201);
    const bearer = new Request('http://main.local', { headers: { authorization: `Bearer ${author.token}` } });
    const publish = async (work: CreatedWork) => {
      const contribution = await createAdmittedTextContribution(h.env, h.verifier, access, bearer, {
        work: work.work, language: 'en', body: 'Catalogue text.', actingSubject: author.subject, idempotencyKey: randomUUID() });
      const publication = await publishAdmittedTextContribution(h.env, h.verifier, access, bearer, {
        contribution: contribution.contribution!, expectedDraftHead: contribution.draftRevision!,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: author.subject, idempotencyKey: randomUUID() });
      return { contribution: contribution.contribution!, publicationDecision: publication.publicationDecision! };
    };
    const published = await publish(target);
    const selected = await selectAdmittedMainDefault(h.env, h.verifier, access, bearer, {
      ...published, work: target.work, context: { kind: 'main-version-default', id: target.mainVersion },
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: author.subject, idempotencyKey: randomUUID() });
    expect(selected.outcome).toBe('succeeded');
    await json(await request(ordinary.token, 'GET',
      `/v1/works/${target.work.slice(-36)}?actingSubject=${encodeURIComponent(ordinary.subject)}`), 200);
    const privateWork = await json<CreatedWork>(await create(author, ['https://schema.org/Book']), 201);
    const draftWork = await json<CreatedWork>(await create(author, ['https://schema.org/Book']), 201);
    await publish(draftWork); // A public contribution without Main selection is still a draft Work.
    let head = target.workRevision;
    let editorRevision = '';
    for (const person of people) {
      await json(await create(person, ['https://schema.org/Book']), 201);
      const mod = await create(person, ['https://rezics.com/vocab/ModPackage']);
      const admin = person === administrator;
      const permitted = person === editor || admin;
      const modBody = await json<{ code?: string }>(mod, admin ? 201 : 403);
      if (!admin) expect(modBody.code).toBe('authority_denied');
      const before = fetches;
      const run = await request(person.token, 'POST', '/v1/sources/acquisitions', {
        profile: 'open-library-works-run-v1', workIds: ['OL1W'], editions: false, ratings: false, frontier: false });
      const runBody = await json<{ code?: string; run?: { state: string } }>(run, admin ? 201 : 403);
      if (admin) expect(runBody.run?.state).toBe('completed');
      else { expect(runBody.code).toBe('authority_denied'); expect(fetches).toBe(before); }
      for (const [path, body, status] of [
        ['/v1/sources/acquisitions/open-library/works', { profile: 'open-library-work-acquisition-v1', workId: 'OL1W' }, 201],
        ['/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'fixture', namespace: 'work',
          externalId: randomUUID(), sourceRevision: null, mediaType: 'application/json', retention: 'not-retained',
          coverage: { scope: 'record', complete: false, omittedFields: ['raw'] },
          rightsEvidence: { basis: 'unknown', note: 'Unverified source.' } }, 201],
        ['/v1/sources/open-library/authors/OL991508A/name', { action: 'refresh', expectedRevision: null }, 200],
      ] as const) {
        const beforeFetch = fetches;
        const key = randomUUID();
        const result = await json<{ code?: string }>(await request(person.token, 'POST', path, body, key), admin ? status : 403);
        if (!admin) {
          expect(result.code).toBe('authority_denied');
          expect(fetches).toBe(beforeFetch);
          expect((await content.query('SELECT 1 FROM source.intake_receipt WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
        }
      }
      const work = person === author ? other.work : target.work;
      const edited = await json<{ revision: string; code?: string }>(await request(person.token, 'POST',
        `/v1/works/${work.slice(-36)}/scalar-value`, { profile: 'work-scalar-state-v1',
          expectedHead: person === author ? other.workRevision : head,
          scalarValue: { kind: 'unknown' }, actingSubject: person.subject }), permitted ? 200 : 403);
      if (permitted) { head = edited.revision; if (person === editor) editorRevision = head; }
      else expect(edited.code).toBe('authority_denied');
      const appointment = await json<{ code?: string }>(await request(person.token, 'POST', '/v1/access/role-bindings',
        binding(person.subject, administrator.subject, await epoch())), admin ? 200 : 403);
      if (!admin) expect(appointment.code).toBe('role_denied');
    }
    // The author still edits their own Work; catalogue roles never replace it.
    const ownEdit = await json<{ revision: string }>(await request(author.token, 'POST', `/v1/works/${target.work.slice(-36)}/scalar-value`, {
      profile: 'work-scalar-state-v1', expectedHead: head, scalarValue: { kind: 'no-value' }, actingSubject: author.subject }), 200);
    head = ownEdit.revision;
    const history = await json<{ items: { id: string; actor?: string }[] }>(await request(author.token, 'GET',
      `/v1/works/${target.work.slice(-36)}/history?actingSubject=${encodeURIComponent(author.subject)}`), 200);
    expect(history.items.find(item => item.id === editorRevision)?.actor).toBe(editor.subject);
    expect(history.items.find(item => item.id === editorRevision)?.actor).not.toBe(author.subject);
    const retype = (person: typeof administrator) => request(person.token, 'PUT', `/v1/works/${target.work.slice(-36)}/type`, {
      profile: 'work-type-v2', expectedHead: head, types: ['https://rezics.com/vocab/ModPackage'], actingSubject: person.subject });
    expect((await json<{ code: string }>(await retype(author), 403)).code).toBe('authority_denied');
    head = (await json<{ revision: string }>(await retype(administrator), 200)).revision;
    // Every administrator-configured kind is checked, including mixed types.
    const restricted = Object.entries(workKinds).filter(([, kind]) => kind.creation === 'administrator').map(([type]) => type);
    expect(restricted.sort()).toEqual(['https://rezics.com/vocab/ModPackage',
      'https://schema.org/SoftwareApplication', 'https://schema.org/SoftwareSourceCode'].sort());
    for (const type of restricted) {
      await json(await create(author, [type]), 403);
      await json(await create(administrator, [type]), 201);
    }
    await json(await create(author, ['https://schema.org/SoftwareApplication', 'https://rezics.com/vocab/ModPackage']), 403);
    // A pinned edit role survives a family head change, but not its revocation.
    const principal = await h.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${editor.token}` } }), ['work:edit']);
    for (const hidden of [privateWork, draftWork]) {
      await json(await request(ordinary.token, 'GET',
        `/v1/works/${hidden.work.slice(-36)}?actingSubject=${encodeURIComponent(ordinary.subject)}`), 404);
      const denied = await json<{ code: string }>(await request(editor.token, 'POST',
        `/v1/works/${hidden.work.slice(-36)}/scalar-value`, { profile: 'work-scalar-state-v1',
          expectedHead: hidden.workRevision, scalarValue: { kind: 'unknown' }, actingSubject: editor.subject }), 403);
      expect(denied.code).toBe('authority_denied');
      let committed = false;
      await expect(access.withWorkEditAuthority(principal, editor.subject, hidden.work,
        async () => { committed = true; })).rejects.toBeInstanceOf(AdmissionDenied);
      expect(committed).toBe(false);
    }
    const pending = await access.register({ principal, actingSubject: editor.subject, action: 'work.edit',
      scope: `work:edit:${target.work}`, idempotencyKey: randomUUID(),
      requestDigest: workScalarEditDigest(target.work, head, { kind: 'unknown' }) });
    const sourceProof = await access.withWorkEditAuthority(principal, editor.subject, target.work, async proof => proof);
    expect(sourceProof.role?.bindingId).toBe(editorBinding);
    expect(sourceProof.grantId).toBeNull();
    const selectionLink = `<${target.mainVersion}> <https://rezics.com/vocab/selectionHead> <${selected.selection}>`;
    await h.fuseki.update(`DELETE DATA { GRAPH <urn:rezics:graph:current> { ${selectionLink} } }`);
    await expect(access.claim(pending.id, pending.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await access.register({ principal, actingSubject: editor.subject, action: 'work.edit',
      scope: `work:edit:${target.work}`, idempotencyKey: pending.idempotencyKey,
      requestDigest: pending.requestDigest })).dispatchEligible).toBe(false);
    await expect(access.withWorkEditAuthority(principal, editor.subject, target.work, async proof => proof))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await h.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:current> { ${selectionLink} } }`);
    await json(await request(administrator.token, 'POST', '/v1/access/role-revisions', {
      profile: 'work-create-role-revision-v1', familyId: editorFamily, issuerSubject: administrator.subject,
      expectedAuthorityEpoch: await epoch(), expectedHeadRevision: '1', permissions: [] }), 200);
    await access.claim(pending.id, pending.requestDigest, principal);
    await json(await request(administrator.token, 'POST', '/v1/access/role-bindings', {
      profile: 'work-create-role-binding-change-v1', action: 'revoke', issuerSubject: administrator.subject,
      expectedAuthorityEpoch: await epoch(), bindingId: editorBinding, expectedObjectGeneration: '0' }), 200);
    await expect(access.claim(pending.id, pending.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(access.withWorkEditAuthority(principal, editor.subject, target.work, async proof => proof))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect((await access.register({ principal, actingSubject: editor.subject, action: 'work.edit',
      scope: `work:edit:${target.work}`, idempotencyKey: pending.idempotencyKey,
      requestDigest: pending.requestDigest })).dispatchEligible).toBe(false);
    await expect(access.register({ principal, actingSubject: editor.subject, action: 'work.edit',
      scope: `work:edit:${native()}`, idempotencyKey: randomUUID(), requestDigest: '0'.repeat(64) }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const adminPrincipal = await h.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${administrator.token}` } }), ['work:create']);
    const creation = await access.register({ principal: adminPrincipal, actingSubject: administrator.subject,
      action: 'work.create', scope: 'work:create:root', idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64),
      workSemanticTypes: ['https://rezics.com/vocab/ModPackage'] });
    const saved = (await h.accessPool.query<{ represented_representation_id: string }>(
      'SELECT represented_representation_id FROM access.admission WHERE id = $1', [creation.id])).rows[0]!;
    const controller = (await h.accessPool.query<{ representation_id: string }>(
      'SELECT representation_id FROM access.agent_provision WHERE agent_id = $1', [administrator.subject])).rows[0]!;
    expect(saved.represented_representation_id).toBe(controller.representation_id);
    expect((await h.accountPool.query('SELECT 1 FROM rezics_account_operator WHERE user_id = $1', [h.user.id])).rowCount).toBe(0);
    await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1', [controller.representation_id]);
    await expect(access.claim(creation.id, creation.requestDigest, adminPrincipal)).rejects.toBeInstanceOf(AdmissionDenied);
    const beforeRevokedImport = fetches;
    await json(await request(administrator.token, 'POST', '/v1/sources/acquisitions', {
      profile: 'open-library-works-run-v1', workIds: ['OL1W'], editions: false, ratings: false, frontier: false }), 403);
    expect(fetches).toBe(beforeRevokedImport);
  } finally { await content.end(); await h.close(); await databases.close(); }
}, 240_000);
