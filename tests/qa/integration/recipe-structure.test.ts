import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

test('RECIPE01/RECIPE02/RECIPE03: recipe Structure retains duplicate lines, scales exactly and imports source', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-structure-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Recipe structure acceptance',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    }), 201);
    const createBody = { owner: work.work, mainVersion: work.mainVersion, actingSubject: f.actor };
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`work:edit:${work.work}`]);
    expect((await f.call('POST', '/v1/recipes', createBody, `recipe-${randomUUID()}`)).status).toBe(403);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const denied = await f.call('POST', '/v1/recipes', { owner: work.work,
      mainVersion: work.mainVersion, actingSubject: f.actor }, `recipe-${randomUUID()}`, f.account.noScope);
    expect(denied.status).toBe(401);

    const createKey = `recipe-${randomUUID()}`;
    const created = await f.json<{ structure: string; revision: string; receipt: string }>(
      await f.call('POST', '/v1/recipes', createBody, createKey), 201);
    expect(await f.json<{ structure: string; revision: string; replayed: boolean }>(
      await f.call('POST', '/v1/recipes', createBody, createKey), 200)).toMatchObject({
      structure: created.structure, revision: created.revision, replayed: true,
    });
    const groups = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/recipes/${shortId(created.structure)}/changes`, { expectedHead: created.revision,
        actingSubject: f.actor, operations: [
          { op: 'insert', parent: created.structure, position: 'last', role: 'group', sourceKey: 'stage-a' },
          { op: 'insert', parent: created.structure, position: 'last', role: 'group', sourceKey: 'stage-b' },
        ] }, `recipe-${randomUUID()}`), 200);
    const line = (amount: number, denominator: number, sourceKey: string) => ({
      op: 'insert', parent: '', position: 'last', role: 'ingredient', sourceKey,
      qualifier: { type: 'ingredient-line', originalText: { value: 'flour', language: 'en' },
        amountLexical: `${amount}/${denominator} cup`, amount: { numerator: amount, denominator },
        unitText: 'cup', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' },
    });
    const recipePath = `/v1/recipes/${shortId(created.structure)}`;
    const ingredientChange = { expectedHead: groups.revision, actingSubject: f.actor,
      operations: [line(3, 2, 'stage-a/flour'), line(1, 4, 'stage-b/flour')]
        .map((item, index) => ({ ...item, parent: groups.occurrences[index] })) };
    const ingredientKey = `recipe-${randomUUID()}`;
    const changed = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `${recipePath}/changes`, { expectedHead: groups.revision, actingSubject: f.actor,
        operations: ingredientChange.operations }, ingredientKey), 200);
    expect(changed.occurrences).toHaveLength(2);
    expect(new Set(changed.occurrences).size).toBe(2);
    expect((changed as typeof changed & { cost: { placementsWritten: number } }).cost.placementsWritten).toBe(2);
    expect(await f.json<{ revision: string; replayed: boolean }>(await f.call('POST',
      `${recipePath}/changes`, ingredientChange, ingredientKey), 200)).toMatchObject({
      revision: changed.revision, replayed: true,
    });
    expect((await f.call('POST', `${recipePath}/changes`, { ...ingredientChange,
      operations: ingredientChange.operations.slice(0, 1) }, ingredientKey)).status).toBe(409);
    const stageA = await f.json<{ occurrences: Array<{ occurrence: string; qualifier: unknown }> }>(
      await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(groups.occurrences[0]!)}`), 200);
    const stageB = await f.json<{ occurrences: Array<{ occurrence: string; qualifier: unknown }> }>(
      await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(groups.occurrences[1]!)}`), 200);
    expect(stageA.occurrences[0]?.qualifier).toMatchObject({ type: 'ingredient-line',
      amount: { numerator: 3, denominator: 2 }, unitText: 'cup' });
    expect(stageB.occurrences[0]?.qualifier).toMatchObject({ type: 'ingredient-line',
      amount: { numerator: 1, denominator: 4 }, unitText: 'cup' });
    expect(stageA.occurrences[0]?.occurrence).not.toBe(stageB.occurrences[0]?.occurrence);
    expect((await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`,
      undefined, randomUUID(), f.account.tokenB)).status).toBe(404);

    const scaled = await f.json<{ cost: { pages: number; pagesRead: number; occurrences: number };
      ingredients: Array<{ amount: { numerator: number; denominator: number };
        sourceLexical?: string; unitText?: string }> }>(await f.call('POST', `${recipePath}/scalings`, {
      actingSubject: f.actor, factor: { numerator: 2, denominator: 3 },
    }), 200);
    expect(scaled.ingredients.map(item => item.amount)).toEqual([
      { numerator: 1, denominator: 1 }, { numerator: 1, denominator: 6 },
    ]);
    expect(scaled.ingredients.every(item => item.unitText === 'cup')).toBe(true);
    expect(scaled.ingredients.map(item => item.sourceLexical)).toEqual(['3/2 cup', '1/4 cup']);
    expect(scaled.cost).toMatchObject({ pages: 4, occurrences: 4 });
    expect(scaled.cost.pagesRead).toBeGreaterThanOrEqual(scaled.cost.pages);

    const nutrition = await f.json<{ basis: string; coverage: string;
      nutrients: Array<{ amount: { numerator: number; denominator: number } }> }>(await f.call('POST',
      '/v1/recipes/nutrition', { basis: 'whole-recipe', inputs: [
        { coverage: 'complete', values: [{ nutrient: 'protein', unit: 'g',
          amount: { numerator: 1, denominator: 3 } }] },
        { coverage: 'partial', values: [{ nutrient: 'protein', unit: 'g',
          amount: { numerator: 1, denominator: 6 } }] },
      ] }), 200);
    expect(nutrition).toMatchObject({ basis: 'whole-recipe', coverage: 'partial',
      nutrients: [{ amount: { numerator: 1, denominator: 2 } }] });

    const sourceExternalId = randomUUID();
    const sourceBytes = Buffer.from(JSON.stringify({ recipeIngredient: [
      '2 tbsp olive oil', { '@type': 'PropertyValue', value: '1/2', name: 'salt', unitText: 'tsp' }],
      recipeInstructions: [{ '@type': 'HowToSection', name: 'Finish', itemListElement: [
        { '@type': 'HowToStep', text: 'Stir until glossy.' },
      ] }], extra: { retained: true } })).toString('base64');
    const intake = await f.json<{ observation: { observation: string } }>(await f.call('POST', '/v1/sources/intakes', {
      profile: 'source-manual-intake-v1', provider: 'recipe-test', namespace: 'recipe-test',
      externalId: sourceExternalId, sourceRevision: '1', mediaType: 'application/ld+json',
      retention: 'retained', rawBytesBase64: sourceBytes,
      coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'original', note: 'Created for the integration fixture' },
    }, `source-${randomUUID()}`), 201);
    const retainedSource = await f.json<{ rawBytesBase64: string }>(await f.call('GET',
      `/v1/sources/observations/${shortId(intake.observation.observation)}`), 200);
    expect(JSON.parse(Buffer.from(retainedSource.rawBytesBase64, 'base64').toString('utf8')))
      .toMatchObject({ extra: { retained: true } });
    const importBody = { sourceObservation: intake.observation.observation,
      expectedHead: changed.revision, actingSubject: f.actor };
    const importKey = `recipe-import-${randomUUID()}`;
    expect((await f.call('POST', `${recipePath}/imports`, importBody,
      `recipe-import-${randomUUID()}`, f.account.noScope)).status).toBe(401);
    const imported = await f.json<{ revision: string; residualDigest: string }>(await f.call('POST',
      `${recipePath}/imports`, importBody, importKey), 200);
    expect(imported.residualDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await f.json<{ revision: string; residualDigest: string }>(await f.call('POST',
      `${recipePath}/imports`, importBody, importKey), 200)).toMatchObject(imported);
    const earlier = await f.json<{ revision: string; occurrences: Array<{ role: string; sourceKey?: string }> }>(
      await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`
        + `&revision=${encodeURIComponent(changed.revision)}`), 200);
    expect(earlier.revision).toBe(changed.revision);
    expect(earlier.occurrences.some(row => row.sourceKey?.includes(intake.observation.observation))).toBe(false);
    const oldManifest = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(changed.revision)} rv:manifest ?manifest . } }`);
    const oldDigest = oldManifest.results!.bindings[0]!.manifest!.value.slice(-64);
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = {
      put: bytes => objects.put(bytes), get: digest => digest === oldDigest
        ? Promise.reject(new ObjectUnavailable('missing immutable revision')) : objects.get(digest),
    };
    try {
      expect((await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`
        + `&revision=${encodeURIComponent(changed.revision)}`)).status).toBe(503);
    } finally {
      (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    }
    expect((await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`
      + `&revision=${encodeURIComponent(changed.revision)}`)).status).toBe(200);
    const latest = await f.json<{ occurrences: Array<{ occurrence: string; sourceKey?: string;
      role: string; labels?: Array<{ value: string; language: string }> }> }>(
      await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    const importedGroup = latest.occurrences.find(row => row.role === 'group' && row.sourceKey?.includes(intake.observation.observation));
    expect(importedGroup).toBeDefined();
    expect(importedGroup?.labels).toContainEqual({ value: 'Finish', language: 'en' });
    const importedChildren = await f.json<{ occurrences: Array<{ role: string; qualifier?: unknown }> }>(
      await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(importedGroup!.occurrence)}`), 200);
    expect(importedChildren.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'step', qualifier: expect.objectContaining({
        type: 'recipe-step', instructionText: { value: 'Stir until glossy.', language: 'en' },
      }) }),
    ]));

    const exported = await f.json<{ recipe: { recipeIngredient: Array<unknown>;
      recipeInstructions: Array<{ '@type': string; name?: string;
        itemListElement?: Array<{ text: string }> }> }; residuals: Array<{ residual: string }>;
      sourceObservations: string[]; cost: { pages: number; pagesRead: number;
        occurrences: number } }>(await f.call('GET', `${recipePath}/exports/schema-org`
      + `?actingSubject=${encodeURIComponent(f.actor)}&revision=${encodeURIComponent(imported.revision)}`), 200);
    expect(exported.cost.occurrences).toBeGreaterThan(4);
    expect(exported.cost.pagesRead).toBeGreaterThanOrEqual(exported.cost.pages);
    expect(exported.recipe.recipeIngredient).toContain('2 tbsp olive oil');
    expect(exported.recipe.recipeIngredient).toContainEqual(expect.objectContaining({
      '@type': 'PropertyValue', name: '1/2 tsp salt', value: '1/2', unitText: 'tsp',
    }));
    expect(exported.recipe.recipeInstructions).toContainEqual(expect.objectContaining({
      '@type': 'HowToSection', name: 'Finish', itemListElement: [
        expect.objectContaining({ text: 'Stir until glossy.' }),
      ],
    }));
    expect(exported.residuals).toContainEqual(expect.objectContaining({
      residual: `sha256:${imported.residualDigest}`,
    }));
    expect(exported.sourceObservations).toContain(intake.observation.observation);
    expect((await f.call('GET', `${recipePath}/exports/schema-org`
      + `?actingSubject=${encodeURIComponent(f.actor)}&revision=${encodeURIComponent(imported.revision)}`,
    undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const partialIntake = await f.json<{ observation: { observation: string } }>(await f.call('POST',
      '/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'recipe-test',
        namespace: 'recipe-test', externalId: sourceExternalId, sourceRevision: '2',
        mediaType: 'application/ld+json', retention: 'retained',
        rawBytesBase64: Buffer.from(JSON.stringify({ recipeInstructions: [
          { '@type': 'HowToStep', text: 'Chill before serving.' },
        ], extra: { refreshed: true } })).toString('base64'),
        coverage: { scope: 'complete-recipe', complete: false, omittedFields: ['recipeIngredient'] },
        rightsEvidence: { basis: 'original', note: 'Partial fixture refresh' },
      }, `recipe-source-${randomUUID()}`), 201);
    const refreshed = await f.json<{ revision: string }>(await f.call('POST',
      `${recipePath}/imports`, { sourceObservation: partialIntake.observation.observation,
        expectedHead: imported.revision, actingSubject: f.actor },
      `recipe-refresh-${randomUUID()}`), 200);
    const afterRefresh = await f.json<{ recipe: { recipeIngredient: unknown[];
      recipeInstructions: Array<{ text?: string }> } }>(await f.call('GET',
      `${recipePath}/exports/schema-org?actingSubject=${encodeURIComponent(f.actor)}`
        + `&revision=${encodeURIComponent(refreshed.revision)}`), 200);
    expect(afterRefresh.recipe.recipeIngredient).toEqual(exported.recipe.recipeIngredient);
    expect(afterRefresh.recipe.recipeInstructions).toContainEqual(expect.objectContaining({
      text: 'Chill before serving.',
    }));

    const raceBody = (sourceKey: string) => ({ expectedHead: refreshed.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'group', sourceKey }] });
    const races = await Promise.all([
      f.call('POST', `${recipePath}/changes`, raceBody('race-a'), `recipe-${randomUUID()}`),
      f.call('POST', `${recipePath}/changes`, raceBody('race-b'), `recipe-${randomUUID()}`),
    ]);
    expect(races.map(response => response.status).sort()).toEqual([200, 409]);
  } finally { await f.close(); }
}, 180_000);
