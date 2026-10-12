import { expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { grantFixtureAuthority, ensureFixtureScopeGate } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessAgentControl } from '../../../services/main/src/modules/access/agent-control.ts';
import { groupChangeIntentDigest } from '../../../services/main/src/modules/access/scope-gates.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { applyContentErasure, checkContentErasureTargets } from '../../../services/main/src/modules/erasure/content.ts';
import { resolveErasureRevisions } from '../../../services/main/src/modules/erasure/revision-kind.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { suppressGraphContentRevisions } from '../../../services/main/src/modules/erasure/graph.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { resolveContentTarget } from '../../../services/main/src/modules/content-publication/draft.ts';
import { WorkMaintainers } from '../../../services/main/src/modules/work/maintainers.ts';
import { readZoneConfiguration, readZoneSitePublicationReceipt, type ZoneSitePublicationReceipt } from '../../../services/main/src/modules/zone/configuration.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

interface SavedDraft { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }
interface SelectedPage { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }
interface Home { page?: { reference: { resourceId: string; revisionId: string }; document: DocumentSnapshot } }
type Publication = ZoneSitePublicationReceipt & { homeDocument: string; homeRevision: string; replayed: boolean };

async function fixture(reserve = true, erasure = false) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-home-identity-${randomUUID()}`),
    'openid agent:create work:create work:edit work:read space:create zone:edit access:manage');
  const revocationContext = new AsyncResource('zone-editor-revocation');
  const relay = erasure ? new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 1 }) : undefined;
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = ANY($1::text[])', [[f.account.a.id, f.account.b.id]]); }
    finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    const provisioned = await new AgentProvisioning(f.accessPool, f.env).provision(f.account.verifier,
      new Request('http://main.local/v1/agents', { headers: { authorization: `Bearer ${f.account.tokenA}` } }),
      { kind: 'person', displayName: 'Home identity author' }, randomUUID());
    expect(provisioned.state).toBe('active');
    f.actor = provisioned.agent;
    const authoredBody = async <T extends { actingSubject: string }>(body: T) => {
      expect(body.actingSubject).toBe(f.actor);
      return { ...body, authoring: 'own-work' as const };
    };
    const grant = async (scope: string, action: string) => grantFixtureAuthority(f.accessPool, {
      scope, requireDispatch: false,
      representations: [{ principalId: f.principalId, actor: f.actor, action, lifetime: 'infinity' }],
      grant: { actor: f.actor, action, lifetime: 'infinity' },
    });
    const editorControl = await grant(`agent:control:${f.actor}`, 'agent.control');
    await grant('work:create:root', 'work.create');
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const core = new ContentCore(f.pool);
    if (erasure) {
      const graph = f.env.fuseki;
      f.env.fuseki = new Proxy(graph, { get(target, property) {
        if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
          const result = await target.commandWithReceipt(...args);
          if (result.status === 'invalid') console.error('Home cut validation failed', result.report);
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    let failSettlement = false, revokeBeforeSwitch = false;
    let zone: string | undefined;
    const revokeEditor = () => revocationContext.runInAsyncScope(async () => {
      // Keep the Agent's controller floor while withdrawing the editor's live mandate.
      await grantFixtureAuthority(f.accessPool, {
        scope: `agent:control:${f.actor}`, requireDispatch: true,
        representations: [{ principalId: f.otherPrincipal, actor: f.actor,
          action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: f.actor, action: 'agent.control', lifetime: 'infinity' },
      });
      const replacement = await f.account.verifier.verify(new Request('http://fixture.test', {
        headers: { authorization: `Bearer ${f.account.tokenB}` },
      }), ['access:manage']);
      const controller = (await f.accessPool.query<{ generation: string }>(
        'SELECT generation::text FROM access.representation WHERE id = $1',
        [editorControl.representationIds[0]])).rows[0]!;
      const change = { subjectId: f.actor, representationId: editorControl.representationIds[0]!,
        expectedGeneration: controller.generation };
      const result = await new AccessAgentControl(f.accessPool).removeController(replacement, {
        idempotencyKey: randomUUID(), requestDigest: groupChangeIntentDigest(change),
      }, change);
      expect(result.liveControllers).toBe(1);
      expect(result.revocationIds).toHaveLength(1);
      await ensureFixtureScopeGate(f.accessPool, `zone:edit:${zone!}`, { open: false });
    });
    const content = new Proxy(core, { get(target, property) {
      if (property === 'settlePublication') return async (...args: Parameters<typeof target.settlePublication>) => {
        if (failSettlement) { failSettlement = false; throw new Error('interrupted before Content settlement'); }
        return target.settlePublication(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const access = new Proxy(f.access, { get(target, property) {
      if (property === 'withOwnerAuthority') return async (...args: Parameters<typeof target.withOwnerAuthority>) => {
        if (revokeBeforeSwitch && args[0].action === 'zone.edit') {
          revokeBeforeSwitch = false;
          await revokeEditor();
        }
        return target.withOwnerAuthority(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
      access, content, contentAuthoring: content, catalogueIntake: f.catalogueIntake,
      ...(relay ? { erasures: new ErasureService(relay, f.pool, f.accessPool) } : {}),
      realmAdmin: new AccessRealmManagement(f.accessPool) });
    const call = (method: string, path: string, body?: object, key = randomUUID(),
      token: string | null = f.account.tokenA, headers: Record<string, string> = {}) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    await grant('space:create:root', 'space.create');
    const created = await f.json<{ space: string; zone: string; navigationRevision: string }>(
      await call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Home identity site',
        capabilities: ['zone'], actingSubject: f.actor, visibility: 'public' }), 201);
    zone = created.zone;
    await grant(`zone:edit:${zone}`, 'zone.edit');
    const path = `/v1/zones/${shortId(zone)}`;
    const prepare = async () => {
      const before = await readZoneConfiguration(f.env, created.zone);
      await f.json(await call('PUT', `${path}/configuration`, {
        expectedHead: before.revision, prepareHomeDocument: true, actingSubject: f.actor,
      }), 200);
      const current = await readZoneConfiguration(f.env, created.zone);
      const exposed = await f.json<{ configuration: { homeDocument?: string } }>(await call('GET',
        `${path}/configuration?actingSubject=${encodeURIComponent(f.actor)}`), 200);
      expect(exposed.configuration.homeDocument).toBe(current.configuration.homeDocument);
      expect(current.configuration.homeDocument).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
      expect(current.configuration.homeDocument).not.toBe(created.zone);
      return current.configuration.homeDocument!;
    };
    const homeDocument = reserve ? await prepare() : null;
    const draftBody = (resourceId: string, text = 'Published home', expectedHead: string | null = null,
      variantId = `urn:rezics:variant:${randomUUID()}`, language = 'en') => ({
      profile: 'content-text-v1', resourceId, variantId, expectedHead, document: fromPlainText(text, 'blocks'),
      language: { kind: 'tag', tag: language, originalTag: language }, direction: 'ltr', actingSubject: f.actor,
    });
    const save = async (text = 'Published home', expectedHead: string | null = null,
      variantId = `urn:rezics:variant:${randomUUID()}`, resourceId = homeDocument ?? created.zone, language = 'en') => {
      const saved = await f.json<SavedDraft>(await call('POST', '/v1/content-drafts',
        draftBody(resourceId, text, expectedHead, variantId, language)), 201);
      return { page: resourceId, variantId, revisionId: saved.revisionId,
        byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch } satisfies SelectedPage;
    };
    const publish = async (pages: SelectedPage[], key = randomUUID(), expectedHead?: string) =>
      call('POST', `${path}/site-publications`, { pages, routesRevision: created.navigationRevision,
        navigationRevision: created.navigationRevision,
        expectedHead: expectedHead ?? (await readZoneConfiguration(f.env, created.zone)).revision,
        actingSubject: f.actor }, key);
    const home = async (language = 'en') => f.json<Home>(await call('GET', `${path}/routes?path=%2F`,
      undefined, randomUUID(), null, { 'accept-language': language }), 200);
    const exact = (revision: string, editor = false) => call('GET', `/v1/content-revisions/${revision}${editor
      ? `?actingSubject=${encodeURIComponent(f.actor)}` : ''}`, undefined, randomUUID(), editor ? f.account.tokenA : null);
    expect((await normalizeStoredMembership(f.env)).complete).toBe(true);
    return { ...f, ...created, path, homeDocument, authoredBody, grant, prepare, draftBody, call, save, publish, home, exact, core,
      close: async () => { revocationContext.emitDestroy(); await relay?.end(); await f.close(); },
      failSettlement: () => { failSettlement = true; },
      revokeBeforeSwitch: () => { revokeBeforeSwitch = true; }, revokeEditor };
  } catch (error) { revocationContext.emitDestroy(); await relay?.end(); await f.close(); throw error; }
}

async function anchor(f: Awaited<ReturnType<typeof fixture>>, revision: string) {
  const rows = (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?component ?count ?binding ?variant ?selected ?selectedDigest ?predecessor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:ZoneHomeRevision, rv:RevisionAnchor ; rv:component ?component ;
          rv:publishedPageCount ?count ; rv:publishedPage ?binding .
        ?binding rv:variant ?variant ; rv:contentRevision ?selected ; rv:byteDigest ?selectedDigest .
        OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
      }
    } LIMIT 128`, 65_536)).results?.bindings ?? [];
  return { components: [...new Set(rows.map(row => row.component!.value))],
    counts: [...new Set(rows.map(row => row.count!.value))],
    digests: [...new Set(rows.map(row => row.selectedDigest!.value))].sort(),
    variants: [...new Set(rows.map(row => row.variant!.value))].sort(),
    selections: [...new Set(rows.map(row => row.selected!.value))].sort(),
    exact: [...new Set(rows.map(row => `${row.variant!.value}\0${row.selected!.value}\0${row.selectedDigest!.value}`))].sort(),
    predecessors: [...new Set(rows.flatMap(row => row.predecessor ? [row.predecessor.value] : []))] };
}

test('one home identity retains multilingual exact anchors while publication moves only the selected cut', async () => {
  const f = await fixture();
  try {
    const english = await f.save('First English home');
    const french = await f.save('Accueil publié', null, undefined, f.homeDocument!, 'fr');
    const prepared = await readZoneConfiguration(f.env, f.zone);
    expect(prepared.homeRevision).toBeNull();
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(f.homeDocument!)} a rv:ZoneHomeDocument }
    }`, 1024)).boolean).toBe(false);
    expect((await f.home()).page).toBeUndefined();
    expect((await f.exact(english.revisionId)).status).toBe(404);
    const first = await f.json<Publication>(await f.publish([english, french]), 201);
    expect(first.homeDocument).toBe(f.homeDocument);
    expect(first.homeRevision).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    expect(first.homeRevision).not.toBe(first.revision);
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(f.zone)} rv:homeDocument ${iri(f.homeDocument!)} ;
        rv:sitePublicationHead ${iri(first.revision)} .
        ${iri(f.homeDocument!)} a rv:ZoneHomeDocument ; rv:homeDocumentHead ${iri(first.homeRevision)} }
    }`, 1024)).boolean).toBe(true);
    expect(first.pages).toEqual(expect.arrayContaining([english, french].map(({ contentEpoch: _epoch, ...page }) => expect.objectContaining(page))));
    const expectedAnchor = { components: [f.homeDocument!],
      counts: ['2'],
      digests: [english.byteDigest, french.byteDigest].sort(),
      variants: [english.variantId, french.variantId].sort(),
      selections: [english, french].map(page => `urn:rezics:content:revision:${page.revisionId}`).sort(),
      exact: [english, french].map(page => `${page.variantId}\0urn:rezics:content:revision:${page.revisionId}\0${page.byteDigest}`).sort(),
      predecessors: [] };
    expect(await anchor(f, first.homeRevision)).toEqual(expectedAnchor);
    const exactEnglish = (await f.core.readExactBatch([english.revisionId], async ids => new Set(ids)))[0];
    expect(exactEnglish?.status).toBe('available');
    const englishHome = (await f.home('en-US,en;q=0.9')).page;
    expect(englishHome?.reference).toMatchObject({ resourceId: f.homeDocument, revisionId: english.revisionId });
    expect(englishHome?.document).toEqual(exactEnglish?.status === 'available' ? exactEnglish.body.document : null);
    expect((await f.home('fr-FR,fr;q=0.9,en;q=0.5')).page?.reference.revisionId).toBe(french.revisionId);
    const frenchDraft = await f.save('Brouillon privé', french.revisionId, french.variantId, f.homeDocument!, 'fr');
    expect((await f.exact(frenchDraft.revisionId)).status).toBe(404);
    expect((await f.home('fr')).page?.reference.revisionId).toBe(french.revisionId);
    const second = await f.json<Publication>(await f.publish([english, frenchDraft]), 201);
    expect(second.homeDocument).toBe(first.homeDocument);
    expect(second.homeRevision).not.toBe(first.homeRevision);
    expect((await anchor(f, second.homeRevision)).predecessors).toEqual([first.homeRevision]);
    // A retained root names its original immutable H even after later publication.
    expect(await anchor(f, first.homeRevision)).toEqual(expectedAnchor);
    expect((await readZoneSitePublicationReceipt(f.env, first.receipt))?.homeRevision).toBe(first.homeRevision);
    expect((await f.exact(french.revisionId)).status).toBe(404);
    expect((await f.exact(frenchDraft.revisionId)).status).toBe(200);
    expect((await f.home('fr')).page?.reference.revisionId).toBe(frenchDraft.revisionId);
  } finally { await f.close(); }
}, 120_000);

test('stale and concurrent home publishers select one atomic P and H bundle', async () => {
  const f = await fixture();
  try {
    const one = await f.save('First concurrent cut'), two = await f.save('Second concurrent cut');
    const expected = (await readZoneConfiguration(f.env, f.zone)).revision;
    const responses = await Promise.all([f.publish([one], randomUUID(), expected), f.publish([two], randomUUID(), expected)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = await f.json<Publication>(responses.find(response => response.status === 201)!, 201);
    const current = await readZoneConfiguration(f.env, f.zone);
    expect(current.homeDocument).toBe(f.homeDocument);
    expect(current.homeRevision).toBe(winner.homeRevision);
    expect(current.publicationRevision).toBe(winner.revision);
    expect((await f.publish([one], randomUUID(), expected)).status).toBe(409);
    expect((await f.home()).page?.reference.revisionId).toBe(winner.pages[0]!.revisionId);
    const anchors = (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?anchor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?anchor a rv:ZoneHomeRevision ; rv:component ${iri(f.homeDocument!)} }
    } LIMIT 3`, 4096)).results?.bindings ?? [];
    expect(anchors.map(row => row.anchor!.value)).toEqual([winner.homeRevision]);
  } finally { await f.close(); }
}, 120_000);

test('a Zone authority revoked after Content pinning cannot activate P or H', async () => {
  const f = await fixture();
  try {
    const page = await f.save();
    const before = await readZoneConfiguration(f.env, f.zone);
    f.revokeBeforeSwitch();
    expect((await f.publish([page], randomUUID(), before.revision)).status).toBe(403);
    const after = await readZoneConfiguration(f.env, f.zone);
    expect(after.revision).toBe(before.revision);
    expect(after.homeRevision).toBeNull();
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(f.homeDocument!)} a rv:ZoneHomeDocument }
    }`, 1024)).boolean).toBe(false);
    expect((await f.home()).page).toBeUndefined();
    expect((await f.pool.query<{ status: string; pin_active: boolean }>(
      'SELECT status, pin_active FROM content.publication_preparation WHERE revision_id = $1', [page.revisionId])).rows)
      .toEqual([{ status: 'rejected', pin_active: false }]);
  } finally { await f.close(); }
}, 120_000);

test('Work authority cannot edit a home document after Zone stewardship ends', async () => {
  const f = await fixture();
  try {
    const originalPage = await f.save();
    const work = await f.json<{ work: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ profile: 'metadata-only-v1', title: 'Retained Work authority', language: 'en', actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${f.homeDocument!}`, 'work.edit');
    await f.grant(`content:draft:${f.homeDocument!}`, 'content.draft');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`content:draft:${work.work}`, 'content.draft');
    await f.revokeEditor();
    expect((await f.call('POST', '/v1/content-drafts', f.draftBody(f.homeDocument!))).status).toBe(403);
    const workPage = await f.save('Authorized Work body', null, undefined, work.work);
    expect(workPage.page).toBe(work.work);
    expect((await f.exact(originalPage.revisionId, true)).status).toBe(404);
  } finally { await f.close(); }
}, 120_000);

test('lazy allocation and a new P variant preserve legacy Zone Content identity and exact bytes', async () => {
  const f = await fixture(false);
  try {
    const legacy = await f.save('Retained legacy Zone home');
    const original = await f.json<{ reference: { resourceId: string }; serializedJson: string }>(await f.exact(legacy.revisionId, true), 200);
    expect(await f.core.owningResourceForRevision(legacy.revisionId)).toBe(f.zone);
    const document = await f.prepare();
    const replacement = await f.save('New home document variant', null, undefined, document);
    expect(replacement.variantId).not.toBe(legacy.variantId);
    expect(await f.core.owningResourceForRevision(replacement.revisionId)).toBe(document);
    expect(await f.core.owningResourceForRevision(legacy.revisionId)).toBe(f.zone);
    expect(await resolveContentTarget(f.env, f.zone)).toMatchObject({ zone: f.zone });
    const rejected = await f.call('POST', '/v1/content-drafts', f.draftBody(f.zone, 'New legacy-owned variant'));
    expect(rejected.status).toBe(403);
    const retained = await f.json<{ reference: { resourceId: string }; serializedJson: string }>(await f.exact(legacy.revisionId, true), 200);
    expect(retained.serializedJson).toBe(original.serializedJson);
    expect(retained.reference.resourceId).toBe(f.zone);
    await checkContentErasureTargets(f.pool, f.zone, [legacy.revisionId]);
    await f.json<Publication>(await f.publish([replacement]), 201);
    expect((await f.home()).page?.reference.resourceId).toBe(document);
    expect(await f.core.owningResourceForRevision(legacy.revisionId)).toBe(f.zone);
    expect(await applyContentErasure(f.pool, { preservationAccess: f.accessPool, erasureId: randomUUID(),
      erasureEpoch: '1', resourceId: f.zone, revisionIds: [legacy.revisionId] })).toEqual({ applied: 1 });
    expect((await f.home()).page?.reference.revisionId).toBe(replacement.revisionId);
  } finally { await f.close(); }
}, 120_000);

test('Zone authority cannot substitute for a Work maintainer or Content grant', async () => {
  const f = await fixture();
  try {
    const work = await f.json<{ work: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ profile: 'metadata-only-v1', title: 'Separate Work authority', language: 'en', actingSubject: f.actor })), 201);
    const token = await f.account.tokenFor(f.account.b);
    const replacement = await new AgentProvisioning(f.accessPool, f.env).provision(f.account.verifier,
      new Request('http://main.local/v1/agents', { headers: { authorization: `Bearer ${token}` } }),
      { kind: 'person', displayName: 'Independent Work maintainer' }, randomUUID());
    expect(replacement.state).toBe('active');
    const principal = await f.account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    }), ['work:edit']);
    const maintainers = new WorkMaintainers(f.accessPool, f.env);
    const transferred = await maintainers.change(principal, { work: work.work, actingSubject: f.actor,
      target: replacement.agent, action: 'transfer', expectedGeneration: '0' }, randomUUID());
    expect(transferred).toMatchObject({ generation: '1', owner: replacement.agent, maintainers: [replacement.agent] });
    expect(await maintainers.read(work.work)).toMatchObject({ owner: replacement.agent, maintainers: [replacement.agent] });
    await f.grant(`zone:edit:${work.work}`, 'zone.edit');
    expect((await f.call('POST', '/v1/content-drafts', f.draftBody(work.work))).status).toBe(403);
    expect((await f.save('Authorized Zone home')).page).toBe(f.homeDocument);
  } finally { await f.close(); }
}, 120_000);

test('replay after interrupted Content settlement keeps one H and settles the exact document bytes', async () => {
  const f = await fixture();
  try {
    const page = await f.save('Recoverable exact home');
    const expected = (await readZoneConfiguration(f.env, f.zone)).revision, key = randomUUID();
    f.failSettlement();
    expect((await f.publish([page], key, expected)).status).toBe(503);
    const committed = await readZoneConfiguration(f.env, f.zone);
    expect(committed.homeRevision).not.toBeNull();
    const pending = (await f.pool.query<{ operation_id: string; status: string; pin_active: boolean }>(
      'SELECT operation_id, status, pin_active FROM content.publication_preparation WHERE revision_id = $1', [page.revisionId])).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'pending', pin_active: true });
    const replay = await f.json<Publication>(await f.publish([page], key, expected), 200);
    expect(replay).toMatchObject({ replayed: true, homeDocument: f.homeDocument, homeRevision: committed.homeRevision });
    expect(replay.pages[0]).toMatchObject({ page: f.homeDocument, revisionId: page.revisionId, byteDigest: page.byteDigest });
    expect(await f.core.readPublicationPreparation(pending[0]!.operation_id)).toMatchObject({ status: 'active', pinActive: true });
    expect((await f.home()).page?.reference.revisionId).toBe(page.revisionId);
    const position = await f.core.ownerPosition();
    await f.json<Publication>(await f.publish([page], key, expected), 200);
    expect(await f.core.ownerPosition()).toEqual(position);
  } finally { await f.close(); }
}, 120_000);

test('erasure inventories every selecting H and makes its document cut absent without removing the Zone', async () => {
  const f = await fixture(true, true);
  try {
    const english = await f.save('Erase these selected bytes');
    const french = await f.save('Première sélection', null, undefined, f.homeDocument!, 'fr');
    const first = await f.json<Publication>(await f.publish([english, french]), 201);
    const nextFrench = await f.save('Deuxième sélection', french.revisionId, french.variantId, f.homeDocument!, 'fr');
    const second = await f.json<Publication>(await f.publish([english, nextFrench]), 201);
    const resolved = await resolveErasureRevisions(f.pool, f.env.fuseki, f.homeDocument!, [english.revisionId]);
    const homeTargets = resolved.filter(target => target.kind === 'home_document_revision');
    // Exactly one H per publication cut that selected the erased Content revision.
    expect(homeTargets.map(target => target.graphIri).sort()).toEqual([first.homeRevision, second.homeRevision].sort());
    expect(homeTargets.every(target => target.resourceId === f.homeDocument)).toBe(true);
    expect(resolved).toHaveLength(3);
    // A closure captured before a competing publication cannot silently omit H.
    await expect(suppressGraphContentRevisions(f.env.fuseki, f.env.lineage, randomUUID(), '100',
      [english.revisionId])).rejects.toThrow('did not produce an exact suppression receipt');
    expect((await f.home()).page?.reference.revisionId).toBe(english.revisionId);
    await f.grant(`erasure:${f.homeDocument!}`, 'erasure.request');
    const key = randomUUID();
    const request = { profile: 'content-revision-erasure-v1', actingSubject: f.actor,
      resourceId: f.homeDocument!, revisionIds: [english.revisionId] };
    interface Report { suppression: string; targets: { kind: string; ref: string }[]; replayed: boolean }
    const erased = await f.json<Report>(await f.call('POST', '/v1/erasures', request, key), 200);
    expect(erased.suppression).toBe('suppressed');
    expect(erased.targets.filter(target => [shortId(first.homeRevision), shortId(second.homeRevision)].includes(target.ref)))
      .toHaveLength(2);
    expect(erased.targets.filter(target => target.kind === 'home_document_revision').map(target => target.ref).sort())
      .toEqual([shortId(first.homeRevision), shortId(second.homeRevision)].sort());
    const tombstones = (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?revision WHERE {
      VALUES ?revision { ${iri(first.homeRevision)} ${iri(second.homeRevision)} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision }
    } LIMIT 3`, 4096)).results?.bindings ?? [];
    expect(tombstones.map(row => row.revision!.value).sort()).toEqual([first.homeRevision, second.homeRevision].sort());
    expect((await f.exact(english.revisionId)).status).toBe(404);
    expect((await f.home('en')).page).toBeUndefined();
    expect((await f.home('fr')).page).toBeUndefined();
    const state = await readZoneConfiguration(f.env, f.zone);
    expect(state.state).toBe('active');
    expect(state.homeDocument).toBe(f.homeDocument);
    expect(state.publicationRevision).toBe(second.revision);
    expect((await f.json<Report>(await f.call('POST', '/v1/erasures', request, key), 200)).replayed).toBe(true);
    const replacement = await f.save('Replacement after erasure');
    const recovered = await f.json<Publication>(await f.publish([replacement]), 201);
    expect((await anchor(f, recovered.homeRevision)).predecessors).toEqual([second.homeRevision]);
    expect((await f.home()).page?.reference.revisionId).toBe(replacement.revisionId);
  } finally { await f.close(); }
}, 120_000);
