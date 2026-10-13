import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { graphErasureReceipt } from '../../../services/main/src/modules/erasure/graph.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { CONTRIBUTION_PROFILE } from '../../../services/main/src/modules/contribution/draft.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';

interface Report {
  erasureId: string; erasureEpoch: string; replayed: boolean;
  targets: { owner: string; kind: string; ref: string;
    completionState: string; completedAt: string | null }[];
}

test('Work, Contribution, Release, Composition and semantic revisions tombstone through one erasure operation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = resolve('.temp', `erasure-revision-kinds-${randomUUID()}`);
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
    erasures: new ErasureService(relay, f.pool, f.accessPool) };
  const app = createMainApp(f.env.fuseki, deps);
  const call = (method: string, path: string, body?: object, authenticated = true) => app.handle(new Request(
    `http://main.local${path}`, { method, headers: {
      ...(authenticated ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
      'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const uuidOf = (value: string) => {
    const id = value.slice('https://rezics.com/id/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`revision is not an id: ${value}`);
    return id;
  };
  const postErasure = (revision: string, resourceId: string, key = randomUUID()) => app.handle(
    new Request('http://main.local/v1/erasures', { method: 'POST', headers: {
      authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ profile: 'content-revision-erasure-v1', actingSubject: f.actor, resourceId,
      revisionIds: [uuidOf(revision)] }) }));
  const sourceObjects = new Map<string, string[]>();
  const objectDigest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const captureSourceObjects = async (revision: string) => {
    if (sourceObjects.has(revision)) return sourceObjects.get(revision)!;
    const refs: string[] = [];
    const anchors = (await f.nativeFuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH <${GRAPHS.revisions}> { <${revision}> rv:modelRevision <${CONTRIBUTION_PROFILE}> ;
        rv:manifest ?manifest }
    } LIMIT 2`)).results?.bindings ?? [];
    expect(anchors.length).toBeLessThanOrEqual(1);
    for (const anchor of anchors) {
      const manifest = anchor.manifest!.value;
      expect(manifest).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
      const stored = JSON.parse(readFileSync(join(f.env.objectDirectory, manifest.slice(-64)), 'utf8')) as { payload: string };
      expect(stored.payload).toMatch(/^sha256:[0-9a-f]{64}$/);
      const payload = readFileSync(join(f.env.objectDirectory, stored.payload.slice(7)));
      expect(objectDigest(payload)).toBe(stored.payload);
      refs.push(stored.payload);
    }
    // Capture the actual command-source bytes before erasure, independently
    // of the erasure inventory's claimed object hashes.
    const custody = (await f.accessPool.query<{ payload: Buffer }>(
      'SELECT payload FROM access.command_custody WHERE revision=$1 LIMIT 2', [revision])).rows;
    expect(custody.length).toBeLessThanOrEqual(1);
    refs.push(...custody.map(row => objectDigest(row.payload)));
    const unique = [...new Set(refs)];
    sourceObjects.set(revision, unique);
    return unique;
  };
  const erase = async (revision: string, resourceId: string, key = randomUUID()) => {
    const objects = await captureSourceObjects(revision);
    await f.grant(`erasure:${resourceId}`, 'erasure.request');
    const response = await postErasure(revision, resourceId, key);
    const body = await response.json() as Report & { code?: string };
    if (response.status !== 200) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
    return { ...body, key, objects };
  };
  const completedTargets = (report: { objects: string[] }, kind: string, revision: string) => [
    { owner: 'graph', kind, ref: uuidOf(revision), completionState: 'completed', completedAt: expect.any(String) },
    ...report.objects.map(ref => ({ owner: 'object', kind: 'object', ref,
      completionState: 'completed', completedAt: expect.any(String) })),
  ];
  const proof = async (revision: string, report: Report) => {
    const receipt = graphErasureReceipt(report.erasureId);
    const result = await f.nativeFuseki.query(`PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?sequence WHERE {
        GRAPH <${GRAPHS.revisions}> { <${revision}> a rv:ErasedRevision ;
          rv:erasureEpoch "${report.erasureEpoch}"^^xsd:integer . }
        GRAPH <${GRAPHS.receipts}> { <${receipt}> a rv:OperationReceipt ;
          rv:erasureId "${report.erasureId}" ; rv:erasureEpoch "${report.erasureEpoch}"^^xsd:integer ;
          rv:sequence ?sequence . }
      } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sequence?.value).toMatch(/^[1-9][0-9]*$/);
  };
  const hidden = async (resource: string, authenticated = false) => {
    expect((await call('GET', `/v1/resources/${shortId(resource)}`
      + (authenticated ? `?actingSubject=${encodeURIComponent(f.actor)}` : ''), undefined, authenticated)).status)
      .toBe(404);
  };
  try {
    await f.grant('catalogue:verify:root', 'catalogue.verify');
    const work = await json<{ work: string; mainVersion: string; workRevision: string }>(await call('POST',
      '/v1/works', await f.catalogueBody({ profile: 'metadata-only-v1', language: 'en', title: 'Erasure kinds',
        semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor })), 201);
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions',
      { profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'Published text',
        actingSubject: f.actor }), 201);
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const decision = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications',
      { profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: f.actor }), 201);
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await json<{ selection: string; mainRevision: string }>(await call('POST',
      '/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
      contribution: draft.contribution, publicationDecision: decision.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
    await f.grant(`contribution:edit:${draft.contribution}`, 'contribution.edit');
    const unselected = await json<{ draftRevision: string }>(await call('POST', '/v1/contribution-edits',
      { profile: 'text-contribution-v1', contribution: draft.contribution, expectedHead: draft.draftRevision,
        body: 'Unpublished later draft', actingSubject: f.actor }), 200);

    const unpublished = await erase(unselected.draftRevision, draft.contribution);
    expect(unpublished.targets).toEqual(completedTargets(unpublished, 'text_contribution_draft', unselected.draftRevision));
    await proof(unselected.draftRevision, unpublished);
    expect((await call('GET', `/v1/resources/${shortId(draft.contribution)}`)).status).toBe(200);
    const pin = await f.nativeFuseki.query(`PREFIX rv: <${RV}> SELECT ?draft WHERE {
      GRAPH <${GRAPHS.current}> { <${draft.contribution}> rv:publicationHead ?decision }
      GRAPH <${GRAPHS.revisions}> { ?decision rv:selectedDraft ?draft .
        FILTER NOT EXISTS { <${draft.draftRevision}> a rv:ErasedRevision } }
    } LIMIT 2`);
    expect(pin.results?.bindings.map(row => row.draft?.value)).toEqual([draft.draftRevision]);
    const replayed = await erase(unselected.draftRevision, draft.contribution, unpublished.key);
    expect(replayed).toMatchObject({ erasureId: unpublished.erasureId, replayed: true });

    await f.grant(`work:edit:${work.work}`, 'work.edit');
    const release = nativeId();
    const paperback = await json<{ release: string; revision: string }>(await call('PUT',
      `/v1/works/${shortId(work.work)}/releases/${shortId(release)}`, { profile: 'release-v1',
        expectedHead: null, actingSubject: f.actor, id: release, kind: 'formal', status: 'official',
        contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en',
        tracklistLanguage: null, title: { value: 'Erasure paperback', language: 'en' }, editionStatement: null,
        publisher: 'Example', publicationYear: 2026, isbn13: null, originalUrl: null, fixedRelease: null,
        coverage: null, evidence: null }), 200);
    await f.grant(`release:seal:${work.mainVersion}`, 'release.seal');
    const sealed = await json<{ release: string }>(await call('POST', '/v1/fixed-releases', {
      profile: 'fixed-native-text-release-v1', work: work.work, mainVersion: work.mainVersion,
      expectedMainRevision: selected.mainRevision, expectedSelection: selected.selection,
      actingSubject: f.actor }), 201);

    const published = await erase(draft.draftRevision, draft.contribution);
    expect(published.targets).toEqual(completedTargets(published, 'text_contribution_draft', draft.draftRevision));
    await proof(draft.draftRevision, published);
    await hidden(draft.contribution);

    const released = await erase(paperback.revision, paperback.release);
    expect(released.targets).toEqual(completedTargets(released, 'release_revision', paperback.revision));
    await proof(paperback.revision, released);
    await hidden(paperback.release);
    const fixed = await erase(sealed.release, sealed.release);
    expect(fixed.targets).toEqual(completedTargets(fixed, 'release_revision', sealed.release));
    await proof(sealed.release, fixed);
    await hidden(sealed.release);

    const created = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions',
      { profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: f.actor }), 201);
    const placed = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, { profile: 'book-composition',
        expectedHead: created.revision, actingSubject: f.actor, operations: [{ op: 'insert', parent: created.structure,
          position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
          label: { value: 'Chapter', language: 'en' } }] }), 200);
    const composed = await erase(placed.revision, created.structure);
    expect(composed.targets).toEqual(completedTargets(composed, 'composition_revision', placed.revision));
    await proof(placed.revision, composed);
    await hidden(placed.occurrences[0]!);

    await f.grant('semantic:create:root', 'semantic.change');
    const character = await json<{ component: string; revision: string }>(await call('POST', '/v1/semantic/changes',
      { profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor, state: { component: 'resource',
        types: [`${RV}Character`], properties: [{ predicate: 'https://schema.org/name',
          value: { kind: 'language-string', lexical: 'Erased character', language: 'en', direction: 'ltr' } }] } }),
    201);
    await f.grant(`semantic:read:${character.component}`, 'semantic.read');
    const semantic = await erase(character.revision, character.component);
    expect(semantic.targets).toEqual(completedTargets(semantic, 'semantic_revision', character.revision));
    await proof(character.revision, semantic);
    await hidden(character.component, true);

    await f.grant(`erasure:${paperback.release}`, 'erasure.request');
    expect((await postErasure(work.workRevision, paperback.release)).status).toBe(400);
    await f.grant(`erasure:${work.work}`, 'erasure.request');
    expect((await postErasure(`https://rezics.com/id/${randomUUID()}`, work.work)).status).toBe(400);
    const head = await erase(work.workRevision, work.work);
    expect(head.targets).toEqual(completedTargets(head, 'work_head', work.workRevision));
    await proof(work.workRevision, head);
    await hidden(work.work);
  } finally {
    await f.close();
    await relay.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
