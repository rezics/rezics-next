import { afterAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { operationTools, type CapabilityDocument } from '../../../services/main/src/modules/mcp/capabilities.ts';
import { dispatchTool } from '../../../services/main/src/modules/mcp/dispatch.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';

interface Report { erasureId: string; targets: { owner: string; kind: string; ref: string }[] }
interface Scene {
  app: ReturnType<typeof createMainApp>;
  actor: string;
  token: string;
  work: string;
  mainVersion: string;
  heads: { first: string; erased: string; current: string };
  draft: { contribution: string; kept: string; erased: string };
  releases: { kept: string; erased: string };
  fixed: string;
  fixedPosition: { dataEpoch: string; sequence: string };
  call: (method: string, path: string, body?: object, token?: string | null) => Promise<Response>;
  erase: (revision: string, resourceId: string) => Promise<Report>;
  grant: (scope: string, action: string) => Promise<unknown>;
  close: () => Promise<void>;
}

const uuidOf = (value: string) => value.slice('https://rezics.com/id/'.length);

let scenePromise: Promise<Scene> | undefined;
let tail: Promise<void> = Promise.resolve();

function serial(name: string, run: (scene: Scene) => Promise<void>) {
  test(name, async () => {
    const turn = tail.then(async () => run(await scene()));
    tail = turn.then(() => undefined, () => undefined);
    await turn;
  });
}

function scene() {
  return scenePromise ??= build();
}

async function build(): Promise<Scene> {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = resolve('.temp', `erasure-readers-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid access:manage work:create work:edit work:read work:protect classification:define');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const content = new ContentCore(f.pool);
  const structureObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structureObjects.initialize();
  await provisionFixtureAuthor(f.env, f.actor);
  const mediaAccess = new MediaAccessBatchReader(f.accessPool, f.env.fuseki);
  const deps: MainWorkDependencies = { environment: f.env, catalogueIntake: f.catalogueIntake,
    access: f.access, account: f.account.verifier, content, contentAuthoring: content, mediaAccess,
    structureObjects, platformAccess: new AccessExposure(f.accessPool),
    erasures: new ErasureService(relay, f.pool, f.accessPool), exports: new ExportStore(f.pool),
    mcp: { issuer: f.account.issuer, resource: 'http://main.local' } };
  const app = createMainApp(f.env.fuseki, deps);
  const call = (method: string, path: string, body?: object, token: string | null = f.account.tokenA) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const erase = async (revision: string, resourceId: string) => {
    await f.grant(`erasure:${resourceId}`, 'erasure.request');
    const response = await app.handle(new Request('http://main.local/v1/erasures', { method: 'POST', headers: {
      authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
      'idempotency-key': randomUUID() },
    body: JSON.stringify({ profile: 'content-revision-erasure-v1', actingSubject: f.actor, resourceId,
      revisionIds: [uuidOf(revision)] }) }));
    return json<Report>(response, 200);
  };
  await f.grant('catalogue:verify:root', 'catalogue.verify');
  const created = await json<{ work: string; mainVersion: string; workRevision: string }>(await call('POST',
    '/v1/works', await f.catalogueBody({ profile: 'metadata-only-v1', language: 'en',
      title: 'ErasureReaderFirstTitle', semanticTypes: ['https://schema.org/Book'],
      actingSubject: f.actor })), 201);
  await f.grant(`work:edit:${created.work}`, 'work.edit');
  await f.grant(`work:read:${created.work}`, 'work.read');
  const edit = async (expectedHead: string, title: string) => json<{ revision: string }>(await call('POST',
    '/v1/content-edits', { profile: 'metadata-only-v1', work: created.work, expectedHead, title,
      actingSubject: f.actor }), 200);
  const middle = await edit(created.workRevision, 'ErasureReaderGoneTitle');
  const current = await edit(middle.revision, 'ErasureReaderKeptTitle');
  await f.grant(`contribution:create:${created.work}`, 'contribution.create');
  const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions',
    { profile: 'text-contribution-v1', work: created.work, language: 'en', body: 'keptdrafttoken',
      actingSubject: f.actor }), 201);
  await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
  await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
  const decision = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications',
    { profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: f.actor }), 201);
  await f.grant(`publication:select:${created.mainVersion}`, 'publication.select');
  const selected = await json<{ selection: string; mainRevision: string }>(await call('POST',
    '/v1/publication-selections', { profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: created.mainVersion }, work: created.work,
    contribution: draft.contribution, publicationDecision: decision.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
  await f.grant(`contribution:edit:${draft.contribution}`, 'contribution.edit');
  const later = await json<{ draftRevision: string }>(await call('POST', '/v1/contribution-edits',
    { profile: 'text-contribution-v1', contribution: draft.contribution, expectedHead: draft.draftRevision,
      body: 'gonedrafttoken', actingSubject: f.actor }), 200);
  const releaseOf = async (title: string) => {
    const id = nativeId();
    return json<{ release: string; revision: string }>(await call('PUT',
      `/v1/works/${shortId(created.work)}/releases/${shortId(id)}`, { profile: 'release-v1',
        expectedHead: null, actingSubject: f.actor, id, kind: 'formal', status: 'official',
        contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en',
        tracklistLanguage: null, title: { value: title, language: 'en' }, editionStatement: null,
        publisher: 'Example', publicationYear: 2026, isbn13: null, originalUrl: null, fixedRelease: null,
        coverage: null, evidence: null }), 200);
  };
  const keptRelease = await releaseOf('ErasureReaderKeptRelease');
  const erasedRelease = await releaseOf('ErasureReaderGoneRelease');
  await f.grant(`release:seal:${created.mainVersion}`, 'release.seal');
  const sealed = await json<{ release: string }>(await call('POST', '/v1/fixed-releases', {
    profile: 'fixed-native-text-release-v1', work: created.work, mainVersion: created.mainVersion,
    expectedMainRevision: selected.mainRevision, expectedSelection: selected.selection,
    actingSubject: f.actor }), 201);
  await erase(middle.revision, created.work);
  await erase(later.draftRevision, draft.contribution);
  await erase(erasedRelease.revision, erasedRelease.release);
  const fixedRows = (await f.nativeFuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH <${GRAPHS.revisions}> { <${sealed.release}> rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  } LIMIT 2`)).results?.bindings ?? [];
  const fixedEpoch = fixedRows[0]?.epoch?.value;
  const fixedSequence = fixedRows[0]?.sequence?.value;
  if (fixedRows.length !== 1 || !fixedEpoch || !fixedSequence) throw new Error('fixed release position is missing');
  return {
    app, actor: f.actor, token: f.account.tokenA, work: created.work, mainVersion: created.mainVersion,
    heads: { first: created.workRevision, erased: middle.revision, current: current.revision },
    draft: { contribution: draft.contribution, kept: draft.draftRevision, erased: later.draftRevision },
    releases: { kept: keptRelease.release, erased: erasedRelease.release }, fixed: sealed.release,
    fixedPosition: { dataEpoch: fixedEpoch, sequence: fixedSequence }, call, erase, grant: f.grant,
    close: async () => {
      await relay.end();
      await f.pool.end();
      await f.accessPool.end();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

afterAll(async () => { if (scenePromise) await (await scenePromise).close(); });

const body = async (response: Response) => ({ status: response.status, text: await response.text() });
const subject = (actor: string) => `actingSubject=${encodeURIComponent(actor)}`;

serial('public Work reads omit an erased revision and keep its siblings', async (scene) => {
  const head = (revision: string) => scene.call('GET',
    `/v1/revisions/${uuidOf(revision)}?${subject(scene.actor)}`);
  const erasedHead = await body(await head(scene.heads.erased));
  const first = await body(await head(scene.heads.first));
  const current = await body(await head(scene.heads.current));
  expect(erasedHead.status).toBe(404);
  expect(first.status).toBe(200);
  expect(current.status).toBe(200);
  expect(first.text).toContain(scene.work);
  expect(current.text).toContain('ErasureReaderKeptTitle');
  expect(current.text).not.toContain(uuidOf(scene.heads.erased));
  const draft = (revision: string) => scene.call('GET',
    `/v1/contributions/${uuidOf(scene.draft.contribution)}/drafts/${uuidOf(revision)}?${subject(scene.actor)}`);
  const erasedDraft = await body(await draft(scene.draft.erased));
  const keptDraft = await body(await draft(scene.draft.kept));
  expect(erasedDraft.status).toBe(404);
  expect(keptDraft.status).toBe(200);
  expect(keptDraft.text).toContain('keptdrafttoken');
  expect(keptDraft.text).not.toContain('gonedrafttoken');
  const list = await body(await scene.call('GET', `/v1/works/${uuidOf(scene.work)}/releases?limit=20`));
  expect(list.status).toBe(200);
  expect(list.text).toContain(scene.releases.kept);
  expect(list.text).not.toContain(scene.releases.erased);
  const gone = await body(await scene.call('GET',
    `/v1/works/${uuidOf(scene.work)}/releases/${uuidOf(scene.releases.erased)}`));
  const kept = await body(await scene.call('GET',
    `/v1/works/${uuidOf(scene.work)}/releases/${uuidOf(scene.releases.kept)}`));
  expect(gone.status).toBe(404);
  expect(kept.status).toBe(200);
  expect(kept.text).toContain('ErasureReaderKeptRelease');
});

serial('Statement reads do not return an erased revision', async (scene) => {
  await scene.grant(`statement:speak:${scene.actor}`, 'statement.record');
  const meaning = { subject: scene.mainVersion, predicate: 'https://example.org/erasure-reader',
    relationDefinition: nativeId(), value: { kind: 'resource' as const, iri: scene.releases.kept },
    applicability: [], interpretation: { kind: 'selected' as const }, evidence: [] };
  const written = await scene.call('POST', '/v1/statements', { profile: 'statement-v1',
    speaker: { kind: 'personal' }, ...meaning, actingSubject: scene.actor });
  const created = await body(written);
  expect(created.status).toBe(201);
  const statement = (JSON.parse(created.text) as { statement: string }).statement;
  const read = await body(await scene.call('GET', `/v1/statements/${uuidOf(statement)}`, undefined, null));
  expect(read.status).toBe(200);
  expect(read.text).toContain(scene.releases.kept);
  expect(read.text).not.toContain(scene.releases.erased);
  expect(read.text).not.toContain(scene.heads.erased);
  expect(read.text).not.toContain(scene.draft.erased);
});

serial('query templates omit an erased revision and keep its siblings', async (scene) => {
  const response = await body(await scene.call('POST', '/v1/query', {
    profile: 'template-query-v1', query: 'https://rezics.com/query/work-versions', revision: 1,
    parameters: { roots: [scene.work] }, limit: 64 }));
  expect(response.status).toBe(200);
  expect(response.text).toContain(scene.draft.kept);
  expect(response.text).toContain(scene.fixed);
  expect(response.text).not.toContain(scene.draft.erased);
  expect(response.text).not.toContain(scene.releases.erased);
  expect(response.text).not.toContain(scene.heads.erased);
});

serial('text search omits an erased revision and keeps the remaining title', async (scene) => {
  const search = async (q: string) => body(await scene.call('GET',
    `/v1/search/catalogue?q=${encodeURIComponent(q)}&limit=20`, undefined, null));
  const kept = await search('keptdrafttoken');
  const goneDraft = await search('gonedrafttoken');
  const goneTitle = await search('ErasureReaderGoneTitle');
  expect(kept.status, kept.text).toBe(200);
  expect(goneDraft.status, goneDraft.text).toBe(200);
  expect(goneTitle.status, goneTitle.text).toBe(200);
  expect(kept.text).toContain(scene.work);
  expect(kept.text).not.toContain(scene.draft.erased);
  expect(goneDraft.text).not.toContain(scene.draft.erased);
  expect(goneDraft.text).not.toContain('gonedrafttoken');
  expect(goneTitle.text).not.toContain(scene.heads.erased);
});

serial('release facets omit an erased release and keep its sibling', async (scene) => {
  const query = async (continuation?: string) => body(await scene.call('POST', '/v1/query', {
    context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 20, ...(continuation ? { continuation } : {}) },
    filter: { all: [{ facet: 'https://rezics.com/definition/facet-release-v1', where: { all: [
      { facet: 'https://rezics.com/definition/facet-release-language-v1', any: ['en'] },
    ] } }] } }, undefined, null));
  let continuation: string | undefined;
  let found = '';
  for (let page = 0; page < 8 && !found.includes(scene.work); page++) {
    const result = await query(continuation);
    expect(result.status, result.text).toBe(200);
    if (result.text.includes(scene.work)) found = result.text;
    const next = (JSON.parse(result.text) as { result?: { next?: string | null } }).result?.next;
    if (!next) break;
    continuation = next;
  }
  expect(found).toContain(scene.work);
  expect(found).toContain(scene.releases.kept);
  expect(found).not.toContain(scene.releases.erased);
});

serial('export omits an erased fixed release and the other release remains', async (scene) => {
  await scene.grant(`export:${scene.fixed}`, 'export.create');
  const payload = { profile: 'export-create-v1', actingSubject: scene.actor, useScope: 'evaluation',
    selection: { kind: 'fixed-release', reference: scene.fixed, expectedPosition: scene.fixedPosition } };
  const before = await body(await scene.call('POST', '/v1/exports', payload));
  expect(before.status, before.text).toBe(201);
  expect(before.text).toContain(scene.fixed);
  expect(before.text).not.toContain(scene.releases.erased);
  expect(before.text).not.toContain(scene.heads.erased);
  expect(before.text).not.toContain(scene.draft.erased);
  await scene.erase(scene.fixed, scene.fixed);
  const after = await body(await scene.call('POST', '/v1/exports', payload));
  expect(after.status, after.text).toBe(404);
  const list = await body(await scene.call('GET', `/v1/works/${uuidOf(scene.work)}/releases?limit=20`));
  expect(list.status).toBe(200);
  expect(list.text).toContain(scene.releases.kept);
  expect(list.text).not.toContain(scene.releases.erased);
  expect(list.text).not.toContain(scene.fixed);
});

serial('MCP reads omit an erased revision and keep its siblings', async (scene) => {
  const document = JSON.parse(readFileSync(resolve('generated/openapi/main/public.json'), 'utf8')) as CapabilityDocument;
  const tools = operationTools(document);
  const resource = tools.find(tool => tool.name === 'read_resource');
  const editions = tools.find(tool => tool.name === 'work_editions');
  if (!resource || !editions) throw new Error('MCP tools are not declared');
  const caller = new Request('http://main.local/mcp', { headers: { authorization: `Bearer ${scene.token}` } });
  const read = async (id: string) => dispatchTool(resource, { path: { resource: uuidOf(id) } }, caller,
    request => scene.app.handle(request));
  const work = await read(scene.work);
  const kept = await read(scene.releases.kept);
  const erased = await read(scene.releases.erased);
  const page = await dispatchTool(editions, { path: { id: uuidOf(scene.work) }, query: { limit: 20 } }, caller,
    request => scene.app.handle(request));
  const text = JSON.stringify({ work, kept, erased, page });
  expect(work.structuredContent.status).toBe(200);
  expect(kept.structuredContent.status).toBe(200);
  expect(erased.structuredContent.status).toBe(404);
  expect(page.structuredContent.status).toBe(200);
  expect(text).toContain(scene.releases.kept);
  expect(text).not.toContain(scene.releases.erased);
  expect(text).not.toContain(scene.heads.erased);
  expect(text).not.toContain(scene.draft.erased);
});

serial('entity pages omit an erased revision and keep its siblings', async (scene) => {
  const entity = (id: string) => scene.call('GET', `/v1/resources/${uuidOf(id)}`, undefined, null);
  const work = await body(await entity(scene.work));
  const kept = await body(await entity(scene.releases.kept));
  const erased = await body(await entity(scene.releases.erased));
  expect(work.status, work.text).toBe(200);
  expect(kept.status, kept.text).toBe(200);
  expect(erased.status).toBe(404);
  expect(work.text).toContain(scene.work);
  expect(work.text).not.toContain(scene.heads.erased);
  expect(work.text).not.toContain(scene.draft.erased);
  expect(kept.text).toContain(scene.releases.kept);
  expect(kept.text).not.toContain(scene.releases.erased);
});

serial('sitemaps keep a work whose current head remains and omit an erased revision', async (scene) => {
  let after: string | undefined;
  let found = '';
  for (let page = 0; page < 8 && !found.includes(scene.work); page++) {
    const result = await body(await scene.call('GET',
      `/v1/sitemap${after ? `?after=${encodeURIComponent(after)}` : ''}`, undefined, null));
    expect(result.status, result.text).toBe(200);
    if (result.text.includes(scene.work)) found = result.text;
    const next = (JSON.parse(result.text) as { next?: string | null }).next;
    if (!next) break;
    after = next;
  }
  expect(found).toContain(scene.work);
  expect(found).not.toContain(scene.heads.erased);
  expect(found).not.toContain(scene.releases.erased);
  expect(found).not.toContain(scene.draft.erased);
});
