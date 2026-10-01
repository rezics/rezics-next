import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { sourceFieldOccurrence } from '../../../services/main/src/modules/source/support-attach.ts';

test('RECIPE06: confirmed source withdrawal leaves independent support on imported Recipe occurrence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const h = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-withdrawal-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (h.env as typeof h.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await h.json<{ work: string; mainVersion: string }>(await h.call('POST', '/v1/works', await h.authoredBody({ language: 'en',
      profile: 'metadata-only-v1', title: 'Recipe source withdrawal',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: h.actor,
    })), 201);
    await h.grant(`work:edit:${work.work}`, 'recipe.edit');
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const created = await h.json<{ structure: string; revision: string }>(await h.call('POST',
      '/v1/recipes', { owner: work.work, mainVersion: work.mainVersion, actingSubject: h.actor },
      `recipe-${randomUUID()}`), 201);
    const recipePath = `/v1/recipes/${shortId(created.structure)}`;
    const intake = async (ingredients: unknown[], externalId: string, instructions?: unknown[],
      mediaType = 'application/json') => h.json<{
      observation: { observation: string; record: string } }>(await h.call('POST',
      '/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'recipe-fixture',
        namespace: 'recipe', externalId, sourceRevision: '1', mediaType,
        retention: 'retained', rawBytesBase64: Buffer.from(JSON.stringify({
          recipeIngredient: ingredients, ...(instructions ? { recipeInstructions: instructions } : {}),
        })).toString('base64'),
        coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'original', note: 'Fixture author confirmed these lines' },
      }, `recipe-intake-${randomUUID()}`), 201);
    const a = await intake(['salt', 'pepper'], `a-${randomUUID()}`,
      [{ '@type': 'HowToStep', text: 'Mix the salt.' }], 'application/ld+json');
    const importA = { sourceObservation: a.observation.observation,
      expectedHead: created.revision, actingSubject: h.actor };
    const importKey = `recipe-import-${randomUUID()}`;
    expect((await h.call('POST', `${recipePath}/imports`, importA, importKey,
      h.account.noScope)).status).toBe(401);
    const first = await h.json<{ revision: string; conversion: string; supports: string[] }>(
      await h.call('POST', `${recipePath}/imports`, importA, importKey), 200);
    expect(first.supports).toHaveLength(3);
    expect(await h.json<{ revision: string; conversion: string; supports: string[] }>(
      await h.call('POST', `${recipePath}/imports`, importA, importKey), 200)).toMatchObject(first);
    const page = await h.json<{ revision: string; occurrences: Array<{ occurrence: string;
      sourceKey: string; qualifier: { originalText: { value: string } } }> }>(await h.call('GET',
      `${recipePath}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    const salt = page.occurrences.find(row => row.qualifier?.originalText?.value === 'salt');
    expect(salt).toBeDefined();
    const sourceSupportA = await h.json<{ supportIdentity: string; occurrence: string;
      sourceOccurrence: string; nativeRevision: string; state: string }>(await h.call('GET',
      `/v1/sources/field-supports/${shortId(first.supports[0]!)}`), 200);
    expect(sourceSupportA).toMatchObject({ state: 'recorded', occurrence: salt!.occurrence,
      sourceOccurrence: sourceFieldOccurrence(a.observation.observation,
        'recipe', 'recipeIngredient', '/recipeIngredient/0'), nativeRevision: first.revision });
    const stepSupport = await h.json<{ slot: string; sourceOccurrence: string; state: string }>(
      await h.call('GET', `/v1/sources/field-supports/${shortId(first.supports[2]!)}`), 200);
    expect(stepSupport).toMatchObject({ state: 'recorded',
      slot: 'structure-occurrence-v1#qualifier.instructionText.value',
      sourceOccurrence: sourceFieldOccurrence(a.observation.observation,
        'recipe', 'recipeInstructions', '/recipeInstructions/0/text') });
    expect((await h.call('GET', `/v1/sources/field-supports/${shortId(first.supports[0]!)}`,
      undefined, randomUUID(), h.account.tokenB)).status).toBe(404);

    const b = await intake(['salt'], `b-${randomUUID()}`);
    const second = await h.json<{ revision: string; conversion: string; supports: string[] }>(
      await h.call('POST', `${recipePath}/imports`, {
        sourceObservation: b.observation.observation, expectedHead: first.revision,
        actingSubject: h.actor }, `recipe-import-${randomUUID()}`), 200);
    expect(second.supports).toHaveLength(1);
    expect(await h.json<{ revision: string; supports: string[] }>(await h.call('POST',
      `${recipePath}/imports`, importA, importKey), 200)).toMatchObject({
      revision: first.revision, supports: first.supports,
    });
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    const independent = await h.json<{ support: { support: string; occurrence: string;
      state: string; sourceRecord: string } }>(await fusekiReadBudget.run(budget,
      () => h.call('POST', '/v1/sources/field-supports', {
      profile: 'source-field-support-attachment-v1', target: work.work,
      slot: 'structure-occurrence-v1#qualifier.originalText.value',
      occurrence: salt!.occurrence, context: created.structure,
      sourceRecord: b.observation.record, conversion: second.conversion,
      grain: 'recipe', sourceField: 'recipeIngredient',
      sourceOccurrence: sourceFieldOccurrence(b.observation.observation,
        'recipe', 'recipeIngredient', '/recipeIngredient/0'),
      sourcePointer: '/recipeIngredient/0', expectedHead: second.revision,
      actingSubject: h.actor,
      }, `recipe-support-${randomUUID()}`)), 201);
    expect(independent.support).toMatchObject({ state: 'recorded',
      occurrence: salt!.occurrence, sourceRecord: b.observation.record });
    expect(64 - budget.callsLeft).toBeLessThanOrEqual(24);
    expect(262_144 - budget.bytesLeft).toBeLessThan(96_000);
    expect((await h.call('POST', `${recipePath}/imports`, {
      ...importA, expectedHead: created.revision,
    }, `recipe-stale-${randomUUID()}`)).status).toBe(409);

    const withdrawal = { profile: 'source-support-withdrawal-v1', support: first.supports[0]!,
      expectedSupport: sourceSupportA.supportIdentity,
      reason: 'Human confirmed the first source no longer supports this ingredient' };
    expect((await h.call('POST', '/v1/sources/withdrawals', withdrawal,
      `recipe-withdraw-${randomUUID()}`, h.account.noScope)).status).toBe(401);
    expect((await h.call('POST', '/v1/sources/withdrawals', { ...withdrawal,
      expectedSupport: first.supports[1]! }, `recipe-withdraw-${randomUUID()}`)).status).toBe(409);
    const withdrawKey = `recipe-withdraw-${randomUUID()}`;
    const concurrent = await Promise.all([1, 2].map(() => h.call('POST',
      '/v1/sources/withdrawals', withdrawal, withdrawKey)));
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
    const withdrawn = await h.json<{ support: { state: string; occurrence: string;
      withdrawal: { nativeEffect: string } }; replayed: boolean }>(concurrent.find(
      response => response.status === 201)!, 201);
    expect(withdrawn.support).toMatchObject({ state: 'withdrawn',
      occurrence: salt!.occurrence, withdrawal: { nativeEffect: 'none' } });
    expect((await h.json<{ replayed: boolean }>(await h.call('POST',
      '/v1/sources/withdrawals', withdrawal, withdrawKey), 200)).replayed).toBe(true);
    expect((await h.json<{ supports: string[] }>(await h.call('POST',
      `${recipePath}/imports`, importA, importKey), 200)).supports).toEqual(first.supports);
    expect((await h.call('POST', '/v1/sources/withdrawals', { ...withdrawal,
      reason: 'Changed reason' }, withdrawKey)).status).toBe(409);
    for (const support of first.supports.slice(1)) {
      const current = await h.json<{ supportIdentity: string }>(await h.call('GET',
        `/v1/sources/field-supports/${shortId(support)}`), 200);
      const result = await h.json<{ support: { state: string;
        withdrawal: { nativeEffect: string } } }>(await h.call('POST', '/v1/sources/withdrawals', {
        profile: 'source-support-withdrawal-v1', support,
        expectedSupport: current.supportIdentity,
        reason: 'Human confirmed the first Recipe source is withdrawn',
      }, `recipe-withdraw-${randomUUID()}`), 201);
      expect(result.support).toMatchObject({ state: 'withdrawn',
        withdrawal: { nativeEffect: 'none' } });
    }
    for (const support of first.supports) {
      expect((await h.json<{ state: string }>(await h.call('GET',
        `/v1/sources/field-supports/${shortId(support)}`), 200)).state).toBe('withdrawn');
    }
    const stillSupported = await h.json<{ state: string; occurrence: string }>(await h.call('GET',
      `/v1/sources/field-supports/${shortId(independent.support.support)}`), 200);
    expect(stillSupported).toMatchObject({ state: 'recorded', occurrence: salt!.occurrence });
    const after = await h.json<{ revision: string; occurrences: Array<{ occurrence: string;
      qualifier: { originalText: { value: string } } }> }>(await h.call('GET',
      `${recipePath}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    expect(after.revision).toBe(second.revision);
    expect(after.occurrences).toContainEqual(expect.objectContaining({ occurrence: salt!.occurrence,
      qualifier: expect.objectContaining({ originalText: { value: 'salt', language: 'en' } }) }));

    const partial = await intake(['herbs', { '@type': 'PropertyValue',
      value: '1/2', name: 'flour', unitText: 'cup' }], `partial-${randomUUID()}`);
    const partialImport = await h.json<{ supports: string[]; unboundSourceKeys: string[] }>(await h.call('POST',
      `${recipePath}/imports`, { sourceObservation: partial.observation.observation,
        expectedHead: second.revision, actingSubject: h.actor },
      `recipe-import-${randomUUID()}`), 200);
    expect(partialImport.supports).toHaveLength(1);
    expect(partialImport.unboundSourceKeys).toEqual([
      `${partial.observation.observation}#/recipeIngredient/1`,
    ]);
  } finally { await h.close(); }
}, 180_000);
