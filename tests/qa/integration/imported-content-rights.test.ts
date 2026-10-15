import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { uiLocales } from '../../../apps/web/i18n/define.ts';
import { seedImportedCatalogue, type ImportedCatalogueFixture } from '../fixtures/imported-catalogue.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { safetyFixture, json, png, type Receipt } from './g-744-support.ts';
import type { DecisionResult } from '../../../services/main/src/modules/governance/store.ts';
import { BANGUMI_LICENSE, GUTENBERG_LICENSE, OPEN_LIBRARY_LICENSE, VNDB_LICENSE }
  from '../../../services/main/src/modules/rights/import-policy.ts';
import { MANAGE_SCOPE, MANAGE_ACTION } from '../../../services/main/src/modules/recommendation/derived-generation.ts';

const directory = resolve('.temp/imported-content-rights', randomUUID());
let f: Awaited<ReturnType<typeof safetyFixture>>;
let imported: ImportedCatalogueFixture;
const short = (iri: string) => iri.slice(-36);

beforeAll(async () => {
  mkdirSync(directory, { recursive: true });
  f = await safetyFixture('imported-content-rights');
  await grantRecordedPlatformUse(f.stack.accessPool, f.author.principalId, ['catalogue-import']);
  for (const [scope, action] of [['work:create:catalogue-import', 'work.create'],
    ['work:create:root', 'work.create'], ['rights:assess', 'rights.assess']])
    await f.author.grant(scope!, action!);
  imported = await seedImportedCatalogue({ actor: f.author.actor, root: directory,
    request: (method, path, body, key) => f.author.send(method, path, body, key) });
  for (const work of imported.works) await f.author.grant(`work:read:${work.work}`, 'work.read');
  await f.author.grant(MANAGE_SCOPE, MANAGE_ACTION);
  let generation = await json<{ generation: string; checkpoint: string; complete: boolean }>(
    await f.author.send('POST', '/v1/discovery/generation-builds', {
      profile: 'discovery-generation-build-v1', actingSubject: f.author.actor,
      basis: { scope: 'global', realm: null, context: null },
    }));
  while (!generation.complete) generation = await json(await f.author.send('POST',
    `/v1/discovery/generations/${generation.generation}/advance`, {
      actingSubject: f.author.actor, expectedCheckpoint: generation.checkpoint,
    }));
  await json(await f.author.send('POST', '/v1/discovery/generation-activations', {
    profile: 'discovery-generation-activation-v1', actingSubject: f.author.actor,
    generation: generation.generation, expectedHeadRevision: null,
  }));
});
afterAll(async () => { await f?.stack.stop(); rmSync(directory, { recursive: true, force: true }); });

test('visitor: every UI language receives the source and exact licence on imported Work hubs and catalogue cards', async () => {
  const instruments = { bangumi: BANGUMI_LICENSE, vndb: VNDB_LICENSE,
    'open-library': OPEN_LIBRARY_LICENSE, 'project-gutenberg': GUTENBERG_LICENSE };
  for (const locale of uiLocales) for (const work of imported.works) {
    const response = await f.stack.call('GET', `/v1/works/${short(work.work)}?language=${locale}`);
    const header = await json<{ factObligations: { status: string; instrument: string;
      obligations: Array<{ kind: string; notice: string }> }; description: { value: string } | null;
      descriptionObligations: { instrument: string; obligations: Array<{ kind: string }> } }>(response);
    expect(header.factObligations.status).toBe('assessed');
    expect(header.factObligations.instrument).toBe(work.provider === 'project-gutenberg' ? null : instruments[work.provider]);
    expect(header.factObligations.obligations.some(item => item.kind === 'attribution' && item.notice.includes(work.url))).toBe(true);
    if (work.provider === 'bangumi') {
      expect(header.description?.value).toBe(imported.summary);
      expect(header.descriptionObligations.instrument).toBe(BANGUMI_LICENSE);
      expect(header.descriptionObligations.obligations.some(item => item.kind === 'share_alike')).toBe(true);
    }
  }
  const page = await json<{ result: { items: Array<{ id: string; work?: { factObligations?: { status: string } } }> } }>(
    await f.stack.call('POST', '/v1/query', { body: { profile: 'resource-list-v1', context: 'global',
      scope: { kind: 'all' }, sort: 'newest', limit: 64,
      filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] } } }));
  for (const work of imported.works) expect(page.result.items.find(item => item.id === work.work)?.work?.factObligations?.status).toBe('assessed');
});

test('redistributor: exact Bangumi revision answers retain source credit and share-alike', async () => {
  const work = imported.works.find(item => item.provider === 'bangumi')!;
  const response = await f.author.read(`/v1/revisions/${short(work.revision)}`);
  const body = await json<{ description: { value: string }; descriptionObligations: {
    instrument: string; obligations: Array<{ kind: string; notice: string }> } }>(response);
  expect(body.description.value).toBe(imported.summary);
  expect(body.descriptionObligations.instrument).toBe(BANGUMI_LICENSE);
  expect(body.descriptionObligations.obligations.some(item => item.kind === 'share_alike')).toBe(true);
  expect(body.descriptionObligations.obligations.some(item => item.notice.includes(work.url))).toBe(true);
});

test('redistributor: native and Schema.org Recipe files retain public-domain source and author credit', async () => {
  const work = imported.works.find(item => item.provider === 'project-gutenberg')!;
  for (const action of ['work.edit', 'recipe.edit']) await f.author.grant(`work:edit:${work.work}`, action);
  await f.author.grant(`work:read:${work.work}`, 'work.read');
  const header = await json<{ mainVersion: string }>(await f.stack.call('GET', `/v1/works/${short(work.work)}`));
  const composition = await json<{ structure: string; revision: string }>(await f.author.send('POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: header.mainVersion, actingSubject: f.author.actor,
  }), 201);
  const file = { '@context': 'https://schema.org', '@type': 'Recipe', name: work.title,
    inLanguage: 'en', recipeIngredient: ['4 apples'], recipeInstructions: ['Bake the apples.'] };
  const importedFile = await f.author.send('POST', `/v1/recipes/${short(composition.structure)}/file-imports`
    + `?actingSubject=${encodeURIComponent(f.author.actor)}&expectedHead=${encodeURIComponent(composition.revision)}`, file);
  expect(importedFile.ok, await importedFile.clone().text()).toBe(true);
  await importedFile.arrayBuffer();
  for (const suffix of ['/export?format=native', '/export?format=schema-org', '/exports/schema-org?']) {
    const response = await f.author.read(`/v1/recipes/${short(composition.structure)}${suffix}`);
    const body = await json<{ rights: Array<{ basisKind: string; notice: string }> }>(response);
    expect(body.rights.some(item => item.basisKind === 'public_domain' && item.notice.includes(work.url)
      && item.notice.includes('Fannie Merritt Farmer'))).toBe(true);
    expect(response.headers.get('cache-control')).toContain('no-store');
  }
});

test('rights holder and operator: an imported cover is credited and an asset restriction closes every served cover use', async () => {
  const work = imported.works.find(item => item.provider === 'vndb')!;
  const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
  const bytes = png(128, 128);
  const externalId = 'v11';
  const source = { provider: 'vndb', namespace: 'vn', externalId, sourceRevision: 'fixture-1',
    component: null, datasetSnapshotDigest: digest('fixture-snapshot'), recordDigest: digest('fixture-record'),
    fieldLocator: '/image/url', displayName: 'VNDB', href: work.url };
  const image = { captureUrl: 'https://t.vndb.org/cv/fixture.png', captureDigest: digest(bytes),
    byteLength: bytes.length, mediaType: 'image/png' };
  const holderEvidence = { name: 'Fixture artwork rights holder', fieldLocator: '/rightsHolder' };
  const envelope = Buffer.from(JSON.stringify({ profile: 'source-cover-evidence-v1', source, image, holderEvidence }));
  const evidence = await json<{ observation: { record: string; observation: string; byteDigest: string } }>(
    await f.author.send('POST', '/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'vndb',
      namespace: 'vn', externalId, sourceRevision: source.sourceRevision, mediaType: 'application/json',
      retention: 'retained', rawBytesBase64: envelope.toString('base64'),
      coverage: { scope: 'cover-evidence', complete: false, omittedFields: ['description'] },
      rightsEvidence: { basis: 'unknown', note: 'Fixture artwork has its own rights holder.' } }), 201);
  const upload = await json<{ uploadUrl: string; asset: string }>(await f.author.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
    sha256: digest(bytes), disclosure: 'public', actingSubject: f.author.actor,
    importedCover: { format: 'media-imported-cover-v1', targetWork: work.work,
      source: { ...source, record: evidence.observation.record, observation: evidence.observation.observation,
        observationDigest: evidence.observation.byteDigest, component: null },
      image, originalDigest: digest(bytes), holderEvidence },
  }), 201);
  const activated = await json<{ revision: string }>(await f.stack.call('PUT', upload.uploadUrl,
    { token: f.author.token, raw: bytes }), 201);
  await f.author.grant(`media:avatar:${work.work}`, 'media.avatar');
  await json(await f.author.send('PUT', `/v1/resources/${short(work.work)}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: upload.asset, crop: null, actingSubject: f.author.actor,
  }), 201);
  const before = await json<{ cover: { kind: string; selection: string; url: string; coverCredit: { text: string } } }>(
    await f.stack.call('GET', `/v1/works/${short(work.work)}`));
  expect(before.cover.coverCredit.text).toBe(holderEvidence.name);
  const warmed = await f.stack.call('GET', before.cover.url);
  expect(warmed.status).toBe(200);
  await warmed.arrayBuffer();
  const receipt = await json<Receipt>(await f.call('POST', '/v1/public-reports', {
    profile: 'public-report-v1', target: work.work, category: 'copyright', contentLanguage: 'en',
    selection: { component: 'cover', revision: before.cover.selection, locator: null },
    statement: 'I hold the rights to this imported artwork and request its removal.',
    contactEmail: 'artwork-holder@example.test', copyright: { signature: holderEvidence.name,
      claimantName: holderEvidence.name, claimantAddress: '1 Example Street', claimantPhone: '+1 555 555 0100',
      claimedWork: 'The original cover artwork', materialLocation: work.work,
      goodFaith: true, accurateAndAuthorizedUnderPerjury: true },
  }), 201);
  const decision = await f.input(receipt, { ...upload, revision: activated.revision } as Parameters<typeof f.input>[1], 'final_restrict');
  const review = await json<{ evidence: Array<{ owner: string; resource: string; component: string;
    revision: string; locator: string }> }>(await f.read(`/v1/reports/${receipt.reportId}`));
  const evidenceTarget = review.evidence[0]!;
  decision.targets = [{ owner: evidenceTarget.owner, resource: evidenceTarget.resource,
    component: evidenceTarget.component, revision: evidenceTarget.revision, locator: evidenceTarget.locator,
    scopeKind: 'exact_revision', expectedHead: activated.revision, effect: 'disclosure' }];
  let completed: DecisionResult | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = await f.decide(decision);
    expect([200, 202], await answer.clone().text()).toContain(answer.status);
    completed = await answer.json() as DecisionResult;
    if (completed.operation.status === 'completed') break;
  }
  expect(completed?.operation.status).toBe('completed');
  const after = await json<{ cover: { kind: string } }>(await f.stack.call('GET', `/v1/works/${short(work.work)}`));
  expect(after.cover.kind).toBe('fallback');
  const oldUrl = await f.stack.call('GET', before.cover.url);
  expect(oldUrl.status).not.toBe(200);
  await oldUrl.arrayBuffer();
});

test('rights holder and operator: an anonymous text complaint removes the synopsis from warm reads and exact revisions with an audited decision', async () => {
  const work = imported.works.find(item => item.provider === 'bangumi')!;
  const path = `/v1/works/${short(work.work)}`;
  const warm = await f.stack.call('GET', path);
  expect(await warm.text()).toContain(imported.summary);
  const receipt = await json<Receipt>(await f.call('POST', '/v1/public-reports', {
    profile: 'public-report-v1', target: work.work, category: 'copyright',
    selection: { component: 'synopsis', revision: work.revision, locator: null },
    statement: 'I hold the rights to the synopsis displayed on this imported Work.', contentLanguage: 'en',
    contactEmail: 'rights-holder@example.test', copyright: { signature: 'Rights holder', claimantName: 'Rights holder',
      claimantAddress: '1 Example Street', claimantPhone: '+1 555 555 0100', claimedWork: 'The original synopsis',
      materialLocation: work.work, goodFaith: true, accurateAndAuthorizedUnderPerjury: true },
  }), 201);
  const image = await f.author.upload(png(64, 64));
  const decision = await f.input(receipt, image, 'final_restrict');
  decision.targets = [{ owner: 'graph', resource: work.work, component: 'synopsis', locator: null,
    scopeKind: 'component', revision: null, expectedHead: work.revision, effect: 'disclosure' }];
  let result: DecisionResult | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await f.decide(decision);
    expect([200, 202], await response.clone().text()).toContain(response.status);
    result = await response.json() as DecisionResult;
    if (result.operation.status === 'completed') break;
  }
  expect(result?.operation.status).toBe('completed');
  for (let attempt = 0; attempt < 2; attempt++) {
    const header = await json<{ description: unknown }>(await f.stack.call('GET', path));
    expect(header.description).toBeNull();
    const exact = await f.author.read(`/v1/revisions/${short(work.revision)}`);
    expect(await exact.text()).not.toContain(imported.summary);
  }
  const status = await f.call('GET', `/v1/public-reports/${receipt.caseId}`, undefined, undefined,
    undefined, receipt.credential);
  expect(status.status).toBe(200);
  expect(await status.text()).toContain(result!.decisionId);
});
