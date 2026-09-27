import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { runZoneQueryBlocks, ZoneQueryBudgetExceeded }
  from '../../../services/main/src/modules/zone/query-budget.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE }
  from '../../../services/main/src/modules/zone/config-format.ts';

test('WIKI04/VIEW05: saved dynamic query and captured Collection retain separate exact state', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `collection-dynamic-${randomUUID()}`),
    'openid work:create work:read collection:edit semantic:read space:create zone:edit');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  const phrase = `wikicapture${randomUUID().replaceAll('-', '')}`;
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: f.principalId, actingSubject: f.actor, scope, action,
      idempotencyKey: `wiki-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  async function publishSearchableWork() {
    const created = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `Wiki result ${randomUUID()}`, actingSubject: f.actor,
    }), 201);
    await f.grant(`work:read:${created.work}`, 'work.read');
    const draftInput = { work: created.work, language: 'en', body: `${phrase} published`,
      actingSubject: f.actor };
    const draft = await activateTextContribution(f.env,
      admission(`contribution:create:${created.work}`, 'contribution.create',
        textContributionDigest(draftInput)), draftInput);
    if (!draft.contribution || !draft.draftRevision) throw new Error('Contribution draft missing');
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: f.actor };
    const published = await publishTextContribution(f.env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publishInput)), publishInput);
    if (!published.publicationDecision) throw new Error('Publication decision missing');
    const selectionInput = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: f.actor };
    await selectMainDefault(f.env,
      admission(`publication:select:${created.mainVersion}`, 'publication.select',
        mainSelectionDigest(selectionInput)), selectionInput);
    return created.work;
  }
  try {
    const firstWork = await publishSearchableWork();
    const definition = nativeId();
    await f.grant(`collection:edit:${definition}`, 'collection.edit');
    await f.grant(`semantic:read:${definition}`, 'semantic.read');
    const createDefinition = { definition, name: 'Dynamic wiki references', disclosure: 'public',
      actingSubject: f.actor, query: { phrase, language: 'en' }, resultBudget: 16 };
    const definitionKey = `definition-${randomUUID()}`;
    const saved = await f.json<{ revision: string; replayed: boolean }>(await f.call('POST',
      '/v1/collection-definitions', createDefinition, definitionKey), 201);
    expect((await f.json<{ revision: string; replayed: boolean }>(await f.call('POST',
      '/v1/collection-definitions', createDefinition, definitionKey), 200)))
      .toMatchObject({ revision: saved.revision, replayed: true });
    const definitionPath = `/v1/collection-definitions/${shortId(definition)}`;
    const before = await f.json<{ total: number; members: Array<{ work: string }> }>(await f.call(
      'POST', `${definitionPath}/queries`, { actingSubject: f.actor }), 200);
    expect(before.total).toBe(1);
    expect(before.members.map(item => item.work)).toEqual([firstWork]);
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const captureBody = { definitionRevision: saved.revision, collection, name: 'Captured wiki',
      disclosure: 'public', actingSubject: f.actor };
    const captureKey = `capture-${randomUUID()}`;
    const captured = await f.json<{ revision: string; coverage: string; members: number }>(await f.call(
      'POST', `${definitionPath}/captures`, captureBody, captureKey), 201);
    expect(captured).toMatchObject({ coverage: 'complete', members: 1 });
    const membersPath = `/v1/collections/${shortId(collection)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const firstSnapshot = await f.json<{ occurrences: Array<{ target: string }> }>(await f.call(
      'GET', membersPath), 200);
    expect(firstSnapshot.occurrences.map(item => item.target)).toEqual([firstWork]);
    const secondWork = await publishSearchableWork();
    const later = await f.json<{ total: number; members: Array<{ work: string }> }>(await f.call(
      'POST', `${definitionPath}/queries`, { actingSubject: f.actor }), 200);
    expect(later.total).toBe(2);
    expect(later.members.map(item => item.work).sort()).toEqual([firstWork, secondWork].sort());
    const boundedDefinition = nativeId();
    await f.grant(`collection:edit:${boundedDefinition}`, 'collection.edit');
    await f.grant(`semantic:read:${boundedDefinition}`, 'semantic.read');
    const bounded = await f.json<{ revision: string }>(await f.call('POST',
      '/v1/collection-definitions', { ...createDefinition, definition: boundedDefinition,
        resultBudget: 1 }), 201);
    const partialCollection = nativeId();
    await f.grant(`collection:edit:${partialCollection}`, 'collection.edit');
    await f.grant(`semantic:read:${partialCollection}`, 'semantic.read');
    const partial = await f.json<{ coverage: string; members: number }>(await f.call('POST',
      `/v1/collection-definitions/${shortId(boundedDefinition)}/captures`, {
        definitionRevision: bounded.revision, collection: partialCollection,
        name: 'Bounded capture', disclosure: 'public', actingSubject: f.actor,
      }), 201);
    expect(partial).toMatchObject({ coverage: 'partial', members: 1 });
    expect((await f.json<{ occurrences: Array<{ target: string }> }>(await f.call('GET',
      `/v1/collections/${shortId(partialCollection)}?actingSubject=${encodeURIComponent(f.actor)}`), 200))
      .occurrences).toHaveLength(1);
    // VIEW05: child and parent query Blocks debit the same Zone row budget.
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Dynamic wiki Zone', capabilities: ['realm'],
      actingSubject: f.actor }), 201);
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    await f.json(await f.call('POST', '/v1/zones', { zone, space: space.space,
      disclosure: 'public', actingSubject: f.actor }), 201);
    const configPath = `/v1/zones/${shortId(zone)}/configuration`;
    const config = await readZoneConfiguration(f.env, zone);
    const configured = await f.json<{ revision: string }>(await f.call('PUT', configPath, {
      expectedHead: config.revision, actingSubject: f.actor,
      budget: { rows: 1, timeMs: 2000 }, queryBlocks: [
        { block: 'parent', definition, maxRows: 1 },
        { block: 'child', definition, parent: 'parent', maxRows: 1 },
      ] }), 200);
    const queryBlocks = await f.json<{ revision: string; results: Array<{ state: string;
      members: Array<{ work: string }> }>; cost: { rowsReturned: number; blocksExecuted: number } }>(
      await f.call('GET', `/v1/zones/${shortId(zone)}/query-blocks`
        + `?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(queryBlocks.revision).toBe(configured.revision);
    expect(queryBlocks.cost).toMatchObject({ rowsReturned: 1, blocksExecuted: 1 });
    expect(queryBlocks.results.map(block => block.state)).toEqual(['partial', 'skipped']);
    expect(queryBlocks.results[0]?.members).toHaveLength(1);
    expect(queryBlocks.results[1]?.members).toEqual([]);
    const revisionBody = { expectedHead: saved.revision, actingSubject: f.actor,
      query: { phrase: `absent${randomUUID().replaceAll('-', '')}`, language: 'en' },
      resultBudget: 16 };
    const revisionKey = `definition-revise-${randomUUID()}`;
    const revised = await f.json<{ revision: string; replayed: boolean }>(await f.call('POST',
      `${definitionPath}/revisions`, revisionBody, revisionKey), 200);
    expect(revised.revision).not.toBe(saved.revision);
    expect((await f.json<{ revision: string; replayed: boolean }>(await f.call('POST',
      `${definitionPath}/revisions`, revisionBody, revisionKey), 200)))
      .toMatchObject({ revision: revised.revision, replayed: true });
    expect((await f.call('POST', `${definitionPath}/revisions`, revisionBody)).status).toBe(409);
    const exact = await f.json<{ revision: string; query: { phrase: string } }>(await f.call('GET',
      `${definitionPath}?actingSubject=${encodeURIComponent(f.actor)}`
        + `&revision=${encodeURIComponent(saved.revision)}`), 200);
    expect(exact).toMatchObject({ revision: saved.revision, query: { phrase } });
    expect((await f.json<{ total: number }>(await f.call('POST', `${definitionPath}/queries`,
      { actingSubject: f.actor }), 200)).total).toBe(0);
    expect((await f.json<{ total: number }>(await f.call('POST', `${definitionPath}/queries`,
      { actingSubject: f.actor, revision: saved.revision }), 200)).total).toBe(2);
    expect((await f.json<{ occurrences: Array<{ target: string }> }>(await f.call('GET', membersPath), 200))
      .occurrences.map(item => item.target)).toEqual([firstWork]);
    const replay = await f.json<{ revision: string; members: number; replayed: boolean }>(await f.call(
      'POST', `${definitionPath}/captures`, captureBody, captureKey), 200);
    expect(replay).toMatchObject({ revision: captured.revision, members: 1, replayed: true });
    expect((await f.call('POST', `${definitionPath}/captures`,
      { ...captureBody, name: 'Changed intent' }, captureKey)).status).toBe(409);
    expect((await f.call('GET', `${definitionPath}?actingSubject=${encodeURIComponent(f.actor)}`,
      undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
  } finally { await f.close(); }
}, 180_000);

test('VIEW05: a nested query cannot renew the shared time ceiling', async () => {
  const id = nativeId();
  const config = { format: ZONE_CONFIG_FORMAT, zone: nativeId(), space: nativeId(),
    navigation: nativeId(), state: 'active' as const, disclosure: 'public' as const,
    budget: { timeMs: 10, rows: 2 }, queryBlocks: [
      { block: 'parent', definition: id, maxRows: 1 },
      { block: 'child', parent: 'parent', definition: id, maxRows: 1 },
    ], model: ZONE_PROFILE };
  let clock = 0;
  let queries = 0;
  await expect(runZoneQueryBlocks(config, async () => {
    queries++;
    clock += 11;
    return { total: 1, coverage: 'complete' as const, members: [{ work: nativeId(),
      selection: nativeId() }], sourcePosition: { datasetId: 'product' as const,
      dataEpoch: randomUUID(), sequence: '1' } };
  }, () => clock)).rejects.toBeInstanceOf(ZoneQueryBudgetExceeded);
  expect(queries).toBe(1);
});
