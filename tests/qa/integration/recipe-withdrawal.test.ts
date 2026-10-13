import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { sourceFieldOccurrence } from '../../../services/main/src/modules/source/support-attach.ts';
import type { FieldSupportResult } from '../../../services/main/src/modules/source/withdrawal.ts';

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
      '/v1/compositions', {
          profile: 'recipe-composition',
          work: work.work,
          mainVersion: work.mainVersion,
          actingSubject: h.actor,
        },
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
      `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
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
      `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    expect(after.revision).toBe(second.revision);
    expect(after.occurrences).toContainEqual(expect.objectContaining({ occurrence: salt!.occurrence,
      qualifier: expect.objectContaining({ originalText: { value: 'salt', language: 'en' } }) }));

    const partial = await intake(['herbs', { '@type': 'PropertyValue',
      value: '1/2', name: 'flour', unitText: 'cup' }], `partial-${randomUUID()}`);
    const partialBody = { sourceObservation: partial.observation.observation,
      expectedHead: second.revision, actingSubject: h.actor };
    const partialKey = `recipe-import-${randomUUID()}`;
    const partialImport = await h.json<{ revision: string; conversion: string;
      sourceObservation: string; residualDigest: string; supports: string[];
      unboundSourceKeys: string[] }>(await h.call('POST', `${recipePath}/imports`,
      partialBody, partialKey), 200);
    const retained = { recipeIngredient: ['herbs', { '@type': 'PropertyValue',
      value: '1/2', name: 'flour', unitText: 'cup' }] };
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const residualDigest = digest(retained);
    const observation = await h.json<{ observation: string; record: string;
      rawBytesBase64: string; byteDigest: string; byteLength: number }>(await h.call('GET',
      `/v1/sources/observations/${shortId(partial.observation.observation)}`), 200);
    const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
    expect(observation).toMatchObject({ observation: partial.observation.observation,
      record: partial.observation.record, byteDigest: residualDigest, byteLength: 102 });
    expect(bytes.toString('utf8')).toBe(JSON.stringify(retained));
    const resolved = JSON.parse(bytes.toString('utf8')) as {
      recipeIngredient: [string, { '@type': string; value: string; name: string; unitText: string }] };
    expect(resolved.recipeIngredient[0]).toBe('herbs');
    expect(resolved.recipeIngredient[1].name).toBe('flour');
    expect(resolved.recipeIngredient[1].value).toBe('1/2');
    expect(resolved.recipeIngredient[1].unitText).toBe('cup');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(residualDigest);
    expect(partialImport).toMatchObject({ sourceObservation: observation.observation,
      residualDigest, unboundSourceKeys: [] });
    expect(partialImport.supports).toHaveLength(2);
    type RecipePage = { revision: string; occurrences: Array<{ occurrence: string;
      sourceKey?: string; qualifier: { type: string; originalText: { value: string; language: string };
        name?: string; amount?: { numerator: number; denominator: number }; unitText?: string;
        amountLexical?: string; textParts?: unknown; residual?: string } }> };
    const compositionPath = `/v1/compositions/${shortId(created.structure)}`;
    const acting = `?actingSubject=${encodeURIComponent(h.actor)}`;
    const imported = await h.json<RecipePage>(await h.call('GET',
      `${compositionPath}/revisions/${shortId(partialImport.revision)}${acting}`), 200);
    expect(imported.revision).toBe(partialImport.revision);
    const herbs = imported.occurrences.filter(row =>
      row.sourceKey === `${observation.observation}#/recipeIngredient/0`);
    const flour = imported.occurrences.filter(row =>
      row.sourceKey === `${observation.observation}#/recipeIngredient/1`);
    expect(herbs).toHaveLength(1);
    expect(flour).toHaveLength(1);
    const herbsOccurrence = herbs[0]!, flourOccurrence = flour[0]!;
    expect(herbsOccurrence.occurrence).not.toBe(flourOccurrence.occurrence);
    expect(herbsOccurrence.sourceKey).not.toBe(flourOccurrence.sourceKey);
    expect(herbsOccurrence.qualifier.originalText).toEqual({ value: 'herbs', language: 'en' });
    expect(herbsOccurrence.qualifier.residual).toBe(`sha256:${residualDigest}`);
    expect(flourOccurrence.qualifier.originalText).toEqual({ value: 'flour', language: 'en' });
    expect(flourOccurrence.qualifier.residual).toBe(`sha256:${residualDigest}`);
    expect(flourOccurrence.qualifier).toMatchObject({ type: 'ingredient-line', name: 'flour',
      amount: { numerator: 1, denominator: 2 }, unitText: 'cup' });
    expect(flourOccurrence.qualifier).not.toHaveProperty('amountLexical');
    expect(flourOccurrence.qualifier).not.toHaveProperty('textParts');
    const supports = await Promise.all(partialImport.supports.map(async support =>
      h.json<FieldSupportResult>(await h.call('GET',
        `/v1/sources/field-supports/${shortId(support)}`), 200)));
    expect(supports.map(support => support.support)).toEqual(partialImport.supports);
    expect(new Set(partialImport.supports).size).toBe(2);
    for (const [occurrence, pointer, scalar] of [
      [herbsOccurrence, '/recipeIngredient/0', resolved.recipeIngredient[0]],
      [flourOccurrence, '/recipeIngredient/1/name', resolved.recipeIngredient[1].name],
    ] as const) {
      const matching = supports.filter(support => support.occurrence === occurrence.occurrence);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({ state: 'recorded', target: work.work,
        context: created.structure, occurrence: occurrence.occurrence,
        nativeRevision: partialImport.revision, sourceRecord: observation.record,
        conversion: partialImport.conversion, grain: 'recipe', sourceField: 'recipeIngredient',
        slot: 'structure-occurrence-v1#qualifier.originalText.value', valueDigest: digest(scalar),
        sourceOccurrence: sourceFieldOccurrence(observation.observation, 'recipe', 'recipeIngredient', pointer) });
    }
    const flourSupport = supports.find(support => support.occurrence === flourOccurrence.occurrence)!;
    expect(flourSupport.sourceOccurrence).not.toBe(sourceFieldOccurrence(observation.observation,
      'recipe', 'recipeIngredient', '/recipeIngredient/1'));

    // A fresh occurrence prevents a settled-support conflict from masking scalar equality.
    const controlWork = await h.json<{ work: string; mainVersion: string }>(await h.call('POST',
      '/v1/works', await h.authoredBody({ language: 'en', profile: 'metadata-only-v1',
        title: 'Recipe lexical attachment control', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: h.actor })), 201);
    await h.grant(`work:edit:${controlWork.work}`, 'recipe.edit');
    await h.grant(`work:edit:${controlWork.work}`, 'work.edit');
    await h.grant(`work:read:${controlWork.work}`, 'work.read');
    const control = await h.json<{ structure: string; revision: string }>(await h.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: controlWork.work,
        mainVersion: controlWork.mainVersion, actingSubject: h.actor }, `recipe-${randomUUID()}`), 201);
    const controlPath = `/v1/compositions/${shortId(control.structure)}`;
    const controlInsert = await h.json<{ revision: string; occurrences: string[] }>(await h.call('POST',
      `${controlPath}/changes`, { profile: 'recipe-composition', expectedHead: control.revision,
        actingSubject: h.actor, operations: [{ op: 'insert', parent: control.structure,
          position: 'last', role: 'ingredient', qualifier: flourOccurrence.qualifier,
          sourceKey: flourOccurrence.sourceKey }] }, `recipe-control-${randomUUID()}`), 200);
    const controlBefore = await h.json<RecipePage>(await h.call('GET', `${controlPath}${acting}`), 200);
    expect(controlBefore.revision).toBe(controlInsert.revision);
    expect(controlBefore.occurrences).toHaveLength(1);
    expect(controlBefore.occurrences[0]!.occurrence).toBe(controlInsert.occurrences[0]!);
    const attachKey = `recipe-support-${randomUUID()}`;
    const attachBody = { profile: 'source-field-support-attachment-v1', target: controlWork.work,
      slot: 'structure-occurrence-v1#qualifier.originalText.value',
      occurrence: controlInsert.occurrences[0]!, context: control.structure,
      sourceRecord: observation.record, conversion: partialImport.conversion,
      grain: 'recipe', sourceField: 'recipeIngredient', expectedHead: controlInsert.revision,
      actingSubject: h.actor };
    expect(digest(resolved.recipeIngredient[1])).not.toBe(digest(resolved.recipeIngredient[1].name));
    const rejected = await h.json<{ code: string; support?: unknown }>(await h.call('POST',
      '/v1/sources/field-supports', { ...attachBody, sourcePointer: '/recipeIngredient/1',
        sourceOccurrence: sourceFieldOccurrence(observation.observation, 'recipe',
          'recipeIngredient', '/recipeIngredient/1') }, attachKey), 409);
    expect(rejected.code).toBe('source_support_changed');
    expect(rejected).not.toHaveProperty('support');
    const controlAfter = await h.json<RecipePage>(await h.call('GET', `${controlPath}${acting}`), 200);
    expect(controlAfter.revision).toBe(controlBefore.revision);
    expect(controlAfter.occurrences).toEqual(controlBefore.occurrences);
    // Reusing the failed key for a fresh scalar attachment proves no support was settled.
    const validControl = await h.json<{ support: FieldSupportResult; replayed: boolean }>(await h.call('POST',
      '/v1/sources/field-supports', { ...attachBody, sourcePointer: '/recipeIngredient/1/name',
        sourceOccurrence: flourSupport.sourceOccurrence }, attachKey), 201);
    expect(validControl.replayed).toBe(false);
    expect(validControl.support).toMatchObject({ state: 'recorded',
      occurrence: controlInsert.occurrences[0]!, valueDigest: digest('flour'),
      nativeRevision: controlInsert.revision, sourceOccurrence: flourSupport.sourceOccurrence });

    const replay = await h.json<typeof partialImport>(await h.call('POST', `${recipePath}/imports`,
      partialBody, partialKey), 200);
    expect(replay).toMatchObject({ revision: partialImport.revision,
      conversion: partialImport.conversion, supports: partialImport.supports,
      sourceObservation: observation.observation, residualDigest });
    const flourWithdrawal = await h.json<{ support: FieldSupportResult }>(await h.call('POST',
      '/v1/sources/withdrawals', { profile: 'source-support-withdrawal-v1',
        support: flourSupport.support, expectedSupport: flourSupport.supportIdentity,
        reason: 'Human confirmed the retained flour name is withdrawn' },
      `recipe-withdraw-${randomUUID()}`), 201);
    expect(flourWithdrawal.support).toMatchObject({ state: 'withdrawn',
      support: flourSupport.support, supportIdentity: flourSupport.supportIdentity,
      occurrence: flourOccurrence.occurrence, withdrawal: { nativeEffect: 'none' } });
    for (const support of supports) {
      const current = await h.json<FieldSupportResult>(await h.call('GET',
        `/v1/sources/field-supports/${shortId(support.support)}`), 200);
      expect(current).toMatchObject({ ...support,
        state: support.support === flourSupport.support ? 'withdrawn' : 'recorded',
        withdrawal: support.support === flourSupport.support
          ? flourWithdrawal.support.withdrawal : null });
    }
    expect(await h.json<{ state: string; occurrence: string }>(await h.call('GET',
      `/v1/sources/field-supports/${shortId(independent.support.support)}`), 200))
      .toMatchObject({ state: 'recorded', occurrence: salt!.occurrence });
    const currentNative = await h.json<RecipePage>(await h.call('GET', `${compositionPath}${acting}`), 200);
    expect(currentNative.revision).toBe(partialImport.revision);
    expect(currentNative.occurrences).toEqual(imported.occurrences);
    const reader = await h.json<RecipePage & { structure: string }>(await h.call('GET',
      `/v1/recipes/works/${shortId(work.work)}${acting}`), 200);
    expect(reader.structure).toBe(created.structure);
    expect(reader.revision).toBe(partialImport.revision);
    expect(reader.occurrences.find(row => row.occurrence === flourOccurrence.occurrence))
      .toEqual(flourOccurrence);
    const prior = await h.json<RecipePage>(await h.call('GET',
      `${compositionPath}/revisions/${shortId(second.revision)}${acting}`), 200);
    expect(prior.revision).toBe(second.revision);
    expect(prior.occurrences).toEqual(after.occurrences);
    const importedAgain = await h.json<RecipePage>(await h.call('GET',
      `${compositionPath}/revisions/${shortId(partialImport.revision)}${acting}`), 200);
    expect(importedAgain.occurrences).toEqual(imported.occurrences);
    expect(await h.json<typeof observation>(await h.call('GET',
      `/v1/sources/observations/${shortId(observation.observation)}`), 200)).toEqual(observation);
  } finally { await h.close(); }
}, 180_000);
