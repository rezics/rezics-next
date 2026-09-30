import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { readResourceSummaries, type ResourceSummary } from '../../../services/main/src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { resolveTargets, TargetNotBound, TargetUnavailable } from '../../../services/main/src/modules/target/resolve.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import type { Capability } from '../../../services/main/src/modules/target/contract.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

interface Work { work: string; mainVersion: string; workRevision: string; mainRevision: string }
interface Publication { contribution: string; draftRevision: string; publicationDecision: string;
  selection: string; mainRevision: string }

test('G-506: API-seeded SAO targets preserve exact grain, owner disclosure and bounded batch cost', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const preparation = Date.now();
  const directory = resolve('.temp', `g-506-${randomUUID()}`);
  // Deliberately omit context:read: Work authority must not admit private Contexts.
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read work:protect context:write classification:define');
  let graphQueries = 0;
  const query = f.env.fuseki.query.bind(f.env.fuseki);
  const graph = new Proxy(f.env.fuseki, { get(target, property) {
    if (property === 'query') return (...args: Parameters<typeof query>) => { graphQueries++; return query(...args); };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const environment = { ...f.env, fuseki: graph };
  const mediaAccess = new MediaAccessBatchReader(f.accessPool, graph);
  const content = new ContentCore(f.pool);
  const structureObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structureObjects.initialize();
  const deps: MainWorkDependencies = { environment, access: f.access, account: f.account.verifier,
    content, contentAuthoring: content, mediaAccess, structureObjects };
  const app = createMainApp(graph, deps);
  const call = (method: string, path: string, body?: object, authenticated = true) => app.handle(new Request(
    `http://main.local${path}`, { method, headers: {
      ...(authenticated ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
      'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const get = (resource: string, authenticated = false) => call('GET', `/v1/resources/${shortId(resource)}`
    + (authenticated ? `?actingSubject=${encodeURIComponent(f.actor)}` : ''), undefined, authenticated);
  const createWork = (title: string) => call('POST', '/v1/works', { profile: 'metadata-only-v1',
    language: 'en', title, semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }).then(response => json<Work>(response, 201));
  const publish = async (work: Work): Promise<Publication> => {
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: `SAO text ${randomUUID()}`,
      actingSubject: f.actor }), 201);
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const decision = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor }), 201);
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await json<{ selection: string; mainRevision: string }>(await call('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: decision.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
    return { ...draft, ...decision, ...selected };
  };
  const releaseOf = async (work: Work) => {
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    const release = nativeId();
    return json<{ release: string; revision: string }>(await call('PUT', `/v1/works/${shortId(work.work)}/releases/${shortId(release)}`, {
      profile: 'release-v1', expectedHead: null, actingSubject: f.actor, id: release,
      kind: 'formal', status: 'official', contentLanguages: ['en'], isTranslation: false,
      originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
      title: { value: 'Sword Art Online volume 1 paperback', language: 'en' }, editionStatement: null,
      publisher: 'Yen Press', publicationYear: 2014, isbn13: null, originalUrl: null,
      fixedRelease: null, coverage: null, evidence: null }), 200);
  };
  const composition = async (work: Work, count = 1) => {
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    const created = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: f.actor }), 201);
    let revision = created.revision;
    const occurrences: string[] = [];
    for (let start = 0; start < count; start += 16) {
      const placed = await json<{ revision: string; occurrences: string[] }>(await call('POST',
        `/v1/compositions/${shortId(created.structure)}/changes`, {
          profile: 'book-composition', expectedHead: revision, actingSubject: f.actor,
          operations: Array.from({ length: Math.min(16, count - start) }, (_, index) => ({ op: 'insert', parent: created.structure,
            position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
            label: { value: `Aincrad chapter ${start + index + 1}`, language: 'en' } })) }), 200);
      revision = placed.revision;
      occurrences.push(...placed.occurrences);
    }
    return { ...created, revision, occurrences };
  };
  const resolveBatch = (resources: string[], capability: Capability = 'discussion', authenticated = false) => workRead(deps,
    new Request('http://main.local/v1/resources', { headers: authenticated
      ? { authorization: `Bearer ${f.account.tokenA}` } : {} }), authenticated ? { actingSubject: f.actor } : {},
    session => resolveTargets(session, resources, capability));
  try {
    expect(Date.now() - preparation).toBeLessThan(600_000);
    // The matching titles are intentional: neither can silently resolve to the other's Work.
    const sao = { web: await createWork('Sword Art Online'), bunko: await createWork('Sword Art Online'),
      volume1: await createWork('Sword Art Online volume 1') };
    const text = { web: await publish(sao.web), bunko: await publish(sao.bunko), volume1: await publish(sao.volume1) };
    const draftOnly = await json<{ contribution: string }>(await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: sao.web.work, language: 'en', body: 'Private unpublished SAO draft',
      actingSubject: f.actor }), 201);
    expect((await get(draftOnly.contribution)).status).toBe(404);
    const draftSummaries = await json<{ summaries: ResourceSummary[] }>(await call('POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources: [sao.web.work, draftOnly.contribution] }, false), 200);
    expect(draftSummaries.summaries[0]).toMatchObject({ status: 'available', work: sao.web.work });
    expect(draftSummaries.summaries[1]).toEqual({ reference: draftOnly.contribution, status: 'unavailable' });
    await expect(resolveBatch([draftOnly.contribution])).rejects.toBeInstanceOf(TargetUnavailable);

    await f.grant('classification:define:global', 'classification.proposition.define');
    const concept = await json<{ concept: string }>(await call('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: 'SAO continuity' }], alternativeLabels: [], broader: [], narrower: [],
      actingSubject: f.actor }), 201);
    expect(await json(await get(concept.concept), 200)).toMatchObject({ status: 'available', base: null, work: null });
    const unsupported = await resolveBatch([concept.concept]).catch(error => error);
    expect(unsupported).toBeInstanceOf(TargetNotBound);
    expect(unsupported).toMatchObject({ status: 422, code: 'target_not_bound' });

    await f.grant('context:create:root', 'context.create');
    const privateContext = await json<{ context: string }>(await call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: null, entries: [], actingSubject: f.actor }), 201);
    await f.grant(`context:read:${privateContext.context}`, 'context.read');
    expect((await get(privateContext.context)).status).toBe(404);
    await expect(resolveBatch([privateContext.context])).rejects.toBeInstanceOf(TargetUnavailable);
    expect((await get(privateContext.context, true)).status).toBe(401);
    await expect(resolveBatch([privateContext.context], 'discussion', true)).rejects.toBeInstanceOf(AccountAssertionDenied);

    const paperback = await releaseOf(sao.volume1);
    await f.grant(`release:seal:${sao.volume1.mainVersion}`, 'release.seal');
    const sealed = await json<{ release: string }>(await call('POST', '/v1/fixed-releases', {
      profile: 'fixed-native-text-release-v1', work: sao.volume1.work, mainVersion: sao.volume1.mainVersion,
      expectedMainRevision: text.volume1.mainRevision, expectedSelection: text.volume1.selection,
      actingSubject: f.actor }), 201);
    const webChapters = await composition(sao.web, 64);
    await f.grant('semantic:create:root', 'semantic.change');
    const semantic = async (types: string[], name: string) => json<{ component: string; revision: string }>(await call('POST',
      '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
        state: { component: 'resource', types, properties: [{ predicate: 'https://schema.org/name',
          value: { kind: 'language-string', lexical: name, language: 'en', direction: 'ltr' } }] } }), 201);
    const character = await semantic([`${RV}Character`], 'Kirito');
    const place = await semantic(['https://schema.org/Place', 'https://example.test/FictionalPlace'], 'Aincrad');
    for (const item of [character, place]) await f.grant(`semantic:read:${item.component}`, 'semantic.read');
    const expected = [
      { resource: sao.web.work, base: 'work', work: sao.web.work, revision: sao.web.workRevision },
      { resource: sao.bunko.work, base: 'work', work: sao.bunko.work, revision: sao.bunko.workRevision },
      { resource: sao.volume1.work, base: 'work', work: sao.volume1.work, revision: sao.volume1.workRevision },
      { resource: paperback.release, base: 'release', work: sao.volume1.work, revision: paperback.revision },
      { resource: sealed.release, base: 'release', work: sao.volume1.work, revision: sealed.release },
      { resource: webChapters.occurrences[0]!, base: 'occurrence', work: sao.web.work, revision: webChapters.revision },
      { resource: text.volume1.contribution, base: 'realization', work: sao.volume1.work, revision: text.volume1.draftRevision },
      { resource: character.component, base: 'resource', work: null, revision: character.revision },
      { resource: place.component, base: 'resource', work: null, revision: place.revision },
    ];
    for (const item of expected) {
      const summary = await json<ResourceSummary>(await get(item.resource, item.work === null), 200);
      expect(summary).toMatchObject({ reference: item.resource, base: item.base, work: item.work, status: 'available' });
    }
    expect((await get(character.component)).status).toBe(404);
    expect((await get(place.component)).status).toBe(404);
    const resolved = await resolveBatch(expected.map(item => item.resource), 'discussion', true);
    resolved.forEach((target, index) => expect(target).toMatchObject(expected[index]!));
    expect(resolved[3]!.types).toContain(`${RV}Release`);
    expect(resolved[4]!.types).toEqual([`${RV}FixedRelease`]);
    expect(resolved[5]!.types).toContain('https://schema.org/ListItem');
    expect(resolved[6]!.types).toContain(`${RV}TextContribution`);
    expect(resolved[0]!.resource).not.toBe(resolved[1]!.resource);
    expect(resolved.at(-1)!.types).toEqual(['http://www.w3.org/2000/01/rdf-schema#Resource',
      'https://example.test/FictionalPlace', 'https://schema.org/Place']);
    expect(resolved[7]!.disclosure).toBe('restricted');
    const batch = await json<{ summaries: ResourceSummary[]; cost: { graphQueries: number; mediaQueries: number;
      accessChecks: number; accessQueries: number } }>(await call('POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources: webChapters.occurrences }, false), 200);
    expect(batch.summaries).toHaveLength(64);
    expect(batch.summaries.every(summary => summary.status === 'available' && summary.base === 'occurrence'
      && summary.work === sao.web.work)).toBe(true);
    expect(batch.cost).toEqual({ graphQueries: 1, mediaQueries: 0, accessChecks: 0, accessQueries: 0 });
    graphQueries = 0;
    await resolveBatch(webChapters.occurrences, 'progress');
    // Two graph-position fences + summary and revision query; no per-target probes.
    expect(graphQueries).toBe(4);
    const mismatch = await resolveBatch([webChapters.occurrences[0]!], 'review').catch(error => error);
    expect(mismatch).toBeInstanceOf(TargetNotBound);
    expect(mismatch).toMatchObject({ status: 422, code: 'target_not_bound' });
    expect(await json(await get(sao.web.mainVersion), 200)).toMatchObject({ base: null, work: sao.web.work });
    await expect(resolveBatch([sao.web.mainVersion])).rejects.toBeInstanceOf(TargetNotBound);
    const missing = nativeId();
    expect((await get(missing)).status).toBe(404);
    await expect(resolveBatch([sao.web.work, missing])).rejects.toBeInstanceOf(TargetUnavailable);
    // A newer unpublished draft must not change the realization's exact published pin.
    await f.grant(`contribution:edit:${text.volume1.contribution}`, 'contribution.edit');
    const unselected = await json<{ draftRevision: string }>(await call('POST', '/v1/contribution-edits', {
      profile: 'text-contribution-v1', contribution: text.volume1.contribution,
      expectedHead: text.volume1.draftRevision, body: 'Unpublished SAO revision', actingSubject: f.actor }), 200);
    expect((await resolveBatch([text.volume1.contribution]))[0]!.revision).toBe(text.volume1.draftRevision);
    await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(unselected.draftRevision)} a <${RV}ErasedRevision> } }`);
    expect((await get(text.volume1.contribution)).status).toBe(200);
    expect((await resolveBatch([text.volume1.contribution]))[0]!.revision).toBe(text.volume1.draftRevision);

    const hidden = await createWork('Private SAO editorial scope');
    const hiddenRelease = await releaseOf(hidden);
    const hiddenChapter = await composition(hidden);
    const privateTargets = [hidden.work, hiddenRelease.release, hiddenChapter.occurrences[0]!];
    for (const resource of privateTargets) {
      expect((await get(resource)).status).toBe(404);
      await expect(resolveBatch([resource])).rejects.toBeInstanceOf(TargetUnavailable);
    }
    await f.grant(`work:read:${hidden.work}`, 'work.read');
    for (const resource of privateTargets) {
      expect(await json(await get(resource, true), 200)).toMatchObject({ work: hidden.work, disclosure: 'restricted' });
    }
    expect((await resolveBatch(privateTargets, 'discussion', true)).every(target => target.work === hidden.work)).toBe(true);
    const privateSummary = await readResourceSummaries(environment, undefined,
      { canReadWorks: works => mediaAccess.canReadWorks({ issuer: f.account.issuer, subject: f.account.a.id }, f.actor, works) },
      { resources: privateTargets, context: DEFAULT_MEDIA_CONTEXT, language: null });
    expect(privateSummary.cost).toEqual({ graphQueries: 1, mediaQueries: 0, accessChecks: 1, accessQueries: 1 });
    await f.access.strongCloseScope(`work:read:${hidden.work}`, '0');
    for (const resource of privateTargets) {
      expect((await get(resource, true)).status).toBe(404);
      await expect(resolveBatch([resource], 'discussion', true)).rejects.toBeInstanceOf(TargetUnavailable);
    }
    // Apply the graph owner's erasure marker to API-created exact revisions.
    await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(text.volume1.draftRevision)} a <${RV}ErasedRevision> . ${iri(character.revision)} a <${RV}ErasedRevision> } }`);
    for (const resource of [sealed.release, text.volume1.contribution, character.component]) {
      expect((await get(resource, true)).status).toBe(404);
      await expect(resolveBatch([resource], 'discussion', true)).rejects.toBeInstanceOf(TargetUnavailable);
    }
    // Removed occurrences retain their identity in storage but have no current placement.
    const removed = await json<{ revision: string }>(await call('POST', `/v1/compositions/${shortId(webChapters.structure)}/changes`, {
      profile: 'book-composition', expectedHead: webChapters.revision, actingSubject: f.actor,
      operations: [{ op: 'remove', occurrence: webChapters.occurrences[0] }] }), 200);
    expect((await get(webChapters.occurrences[0]!)).status).toBe(404);
    await expect(resolveBatch([webChapters.occurrences[0]!])).rejects.toBeInstanceOf(TargetUnavailable);
    await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(paperback.revision)} a <${RV}ErasedRevision> . ${iri(sao.bunko.workRevision)} a <${RV}ErasedRevision> .
      ${iri(removed.revision)} a <${RV}ErasedRevision> } }`);
    for (const resource of [paperback.release, sao.bunko.work, webChapters.occurrences[1]!]) {
      expect((await get(resource, true)).status).toBe(404);
      await expect(resolveBatch([resource], 'discussion', true)).rejects.toBeInstanceOf(TargetUnavailable);
    }
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
