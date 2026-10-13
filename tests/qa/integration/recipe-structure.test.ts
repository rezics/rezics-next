import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';
import type { FieldSupportResult } from '../../../services/main/src/modules/source/withdrawal.ts';
import type { StagedSourceObservation } from '../../../services/main/src/modules/source/intake.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';

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
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', await f.authoredBody({ language: 'en',
      profile: 'metadata-only-v1', title: 'Recipe structure acceptance',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    })), 201);
    const createBody = {
      profile: 'recipe-composition',
      work: work.work,
      mainVersion: work.mainVersion,
      actingSubject: f.actor,
    };
    expect(
      (
        await f.call('POST', '/v1/recipes', {
          owner: work.work,
          mainVersion: work.mainVersion,
          actingSubject: f.actor,
        })
      ).status,
    ).toBe(404);
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`work:edit:${work.work}`]);
    expect(
      (await f.call('POST', '/v1/compositions', createBody, `recipe-${randomUUID()}`)).status,
    ).toBe(403);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const denied = await f.call('POST', '/v1/compositions', {
        profile: 'recipe-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: f.actor,
      }, `recipe-${randomUUID()}`, f.account.noScope);
    expect(denied.status).toBe(401);

    const createKey = `recipe-${randomUUID()}`;
    const created = await f.json<{ structure: string; revision: string; receipt: string }>(
      await f.call('POST', '/v1/compositions', createBody, createKey), 201);
    expect(
      await f.json<{ structure: string; revision: string; replayed: boolean }>(
        await f.call('POST', '/v1/compositions', createBody, createKey),
        200,
      ),
    ).toMatchObject({
      structure: created.structure,
      revision: created.revision,
      replayed: true,
    });
    const groups = await f.json<{ revision: string; occurrences: string[] }>(
      await f.call(
        'POST',
        `/v1/compositions/${shortId(created.structure)}/changes`,
        {
          profile: 'recipe-composition',
          expectedHead: created.revision,
          actingSubject: f.actor,
          operations: [
            {
              op: 'insert',
              parent: created.structure,
              position: 'last',
              role: 'group',
              sourceKey: 'stage-a',
            },
            {
              op: 'insert',
              parent: created.structure,
              position: 'last',
              role: 'group',
              sourceKey: 'stage-b',
            },
          ],
        },
        `recipe-${randomUUID()}`,
      ),
      200,
    );
    const line = (amount: number, denominator: number, sourceKey: string) => ({
      op: 'insert', parent: '', position: 'last', role: 'ingredient', sourceKey,
      qualifier: { type: 'ingredient-line', originalText: { value: 'flour', language: 'en' },
        amountLexical: `${amount}/${denominator} cup`, amount: { numerator: amount, denominator },
        unitText: 'cup', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' },
    });
    const recipePath = `/v1/recipes/${shortId(created.structure)}`;
    expect(
      (await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`)).status,
    ).toBe(404);
    expect(
      (
        await f.call('POST', `${recipePath}/changes`, {
          expectedHead: created.revision,
          actingSubject: f.actor,
          operations: [],
        })
      ).status,
    ).toBe(404);
    const ingredientChange = {
      profile: 'recipe-composition',
      expectedHead: groups.revision,
      actingSubject: f.actor,
      operations: [line(3, 2, 'stage-a/flour'), line(1, 4, 'stage-b/flour')].map((item, index) => ({
        ...item,
        parent: groups.occurrences[index],
      })),
    };
    const ingredientKey = `recipe-${randomUUID()}`;
    const changed = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, {
          profile: 'recipe-composition',
          expectedHead: groups.revision,
          actingSubject: f.actor,
          operations: ingredientChange.operations,
        }, ingredientKey), 200);
    const projectedMembership = () => f.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?placement ?item ?position ?qualifier WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.structure)} rv:selectedGeneration ?generation .
        ?placement a schema:ListItem ; rv:generation ?generation ;
          schema:item ?item ; schema:position ?position .
        OPTIONAL { ?placement rv:qualifier ?qualifier }
      } } ORDER BY ?placement`);
    const membership = (await projectedMembership()).results?.bindings ?? [];
    expect(membership).toHaveLength(4);
    const lines = membership.filter(row => row.qualifier);
    expect(lines).toHaveLength(2);
    for (const row of lines) expect(row.item?.value).toBe(row.qualifier?.value);
    // A populated legacy Recipe copy has structural groups and qualifier payloads,
    // neither of which used a resource target predicate before normalization.
    await f.nativeFuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.current)} {
        ?placement a schema:ListItem ; schema:item ?item ; schema:position ?position .
      } } WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.structure)} rv:selectedGeneration ?generation .
        ?placement rv:generation ?generation ; schema:item ?item ; schema:position ?position .
      } }`);
    expect((await projectedMembership()).results?.bindings ?? []).toHaveLength(0);
    expect(await normalizeStoredMembership(f.env)).toMatchObject({
      complete: true, placements: 4, receipts: expect.arrayContaining([expect.any(String)]),
    });
    expect((await projectedMembership()).results?.bindings).toEqual(membership);
    expect(await normalizeStoredMembership(f.env)).toEqual({
      complete: true, placements: 0, receipts: [],
    });
    expect(changed.occurrences).toHaveLength(2);
    expect(new Set(changed.occurrences).size).toBe(2);
    expect((changed as typeof changed & { cost: { placementsWritten: number } }).cost.placementsWritten).toBe(2);
    expect(
      await f.json<{ revision: string; replayed: boolean }>(
        await f.call(
          'POST',
          `/v1/compositions/${shortId(created.structure)}/changes`,
          ingredientChange,
          ingredientKey,
        ),
        200,
      ),
    ).toMatchObject({
      revision: changed.revision,
      replayed: true,
    });
    expect(
      (
        await f.call(
          'POST',
          `/v1/compositions/${shortId(created.structure)}/changes`,
          { ...ingredientChange, operations: ingredientChange.operations.slice(0, 1) },
          ingredientKey,
        )
      ).status,
    ).toBe(409);
    const stageA = await f.json<{ occurrences: Array<{ occurrence: string; qualifier: unknown }> }>(
      await f.call(
        'GET',
        `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(groups.occurrences[0]!)}`,
      ),
      200,
    );
    const stageB = await f.json<{ occurrences: Array<{ occurrence: string; qualifier: unknown }> }>(
      await f.call(
        'GET',
        `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(groups.occurrences[1]!)}`,
      ),
      200,
    );
    expect(stageA.occurrences[0]?.qualifier).toMatchObject({ type: 'ingredient-line',
      amount: { numerator: 3, denominator: 2 }, unitText: 'cup' });
    expect(stageB.occurrences[0]?.qualifier).toMatchObject({ type: 'ingredient-line',
      amount: { numerator: 1, denominator: 4 }, unitText: 'cup' });
    expect(stageA.occurrences[0]?.occurrence).not.toBe(stageB.occurrences[0]?.occurrence);
    expect(
      (
        await f.call(
          'GET',
          `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(f.actor)}`,
          undefined,
          randomUUID(),
          f.account.tokenB,
        )
      ).status,
    ).toBe(404);

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
      await f.call('GET', `/v1/compositions/${shortId(created.structure)}/revisions/${shortId(changed.revision)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
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
      expect(
        (
          await f.call(
            'GET',
            `/v1/compositions/${shortId(created.structure)}/revisions/${shortId(changed.revision)}?actingSubject=${encodeURIComponent(f.actor)}`,
          )
        ).status,
      ).toBe(503);
    } finally {
      (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    }
    expect(
      (
        await f.call(
          'GET',
          `/v1/compositions/${shortId(created.structure)}/revisions/${shortId(changed.revision)}?actingSubject=${encodeURIComponent(f.actor)}`,
        )
      ).status,
    ).toBe(200);
    const latest = await f.json<{
      occurrences: Array<{
        occurrence: string;
        sourceKey?: string;
        role: string;
        labels?: Array<{ value: string; language: string }>;
      }>;
    }>(
      await f.call(
        'GET',
        `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(f.actor)}`,
      ),
      200,
    );
    const importedGroup = latest.occurrences.find(row => row.role === 'group' && row.sourceKey?.includes(intake.observation.observation));
    expect(importedGroup).toBeDefined();
    expect(importedGroup?.labels).toContainEqual({ value: 'Finish', language: 'en' });
    const importedChildren = await f.json<{ occurrences: Array<{ role: string; qualifier?: unknown }> }>(
      await f.call('GET', `/v1/compositions/${shortId(created.structure)}?actingSubject=${encodeURIComponent(f.actor)}&parent=${encodeURIComponent(importedGroup!.occurrence)}`), 200);
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
    // Serve the fixture's real Main handlers over HTTP for the exchange proof.
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      return f.call(request.method, url.pathname + url.search,
        request.method === 'GET' ? undefined : await request.json() as object,
        request.headers.get('idempotency-key') ?? randomUUID(),
        request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null);
    } });
    try {
      const http = async (method: string, path: string, body?: object) => {
        const idempotencyKey = randomUUID();
        const url = new URL(path, server.url);
        const response = await fetch(url, {
          method, headers: { authorization: `Bearer ${f.account.tokenA}`,
            'idempotency-key': idempotencyKey, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        appendFileSync(resolve('.temp', `recipe-exchange-http-${Bun.env.REZICS_QA_RUN_ID}.jsonl`),
          JSON.stringify({ request: { method, url: url.href, idempotencyKey, body },
            response: { status: response.status, body: await response.clone().json() } }) + '\n');
        return response;
      };
      const actorQuery = `actingSubject=${encodeURIComponent(f.actor)}`;
      const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
      type RecipeExport = typeof exported & { revision: string; residuals: Array<{
        sourceKey: string | null; text: string; parseStatus: string; residual: string | null }> };
      const originalExportPath = `${recipePath}/exports/schema-org?${actorQuery}`
        + `&revision=${encodeURIComponent(imported.revision)}`;
      const originalExport = await f.json<RecipeExport>(await http('GET', originalExportPath), 200);
      expect(originalExport).toEqual(exported);
      const originalRevisionPath = `/v1/compositions/${shortId(created.structure)}/revisions/`
        + `${shortId(imported.revision)}?${actorQuery}`;
      const originalRevision = await f.json<{ revision: string; occurrences: OccurrenceRecord[] }>(
        await http('GET', originalRevisionPath), 200);
      expect(originalRevision.revision).toBe(imported.revision);
      const originalSourcePath = `/v1/sources/observations/${shortId(intake.observation.observation)}`;
      const originalSource = await f.json<StagedSourceObservation>(await http('GET', originalSourcePath), 200);
      expect(originalSource.observation).toBe(intake.observation.observation);
      expect(originalSource.rawBytesBase64).toBe(sourceBytes);
      expect(originalSource.byteDigest).toBe(digest(Buffer.from(sourceBytes, 'base64')));
      expect(imported.residualDigest).toBe(originalSource.byteDigest);
      expect(JSON.parse(Buffer.from(originalSource.rawBytesBase64!, 'base64').toString('utf8')))
        .toMatchObject({ extra: { retained: true } });
      const originalKeys = [0, 1].map(index => `${intake.observation.observation}#/recipeIngredient/${index}`);
      const originalIngredients = originalKeys.map(sourceKey => {
        const matches = originalRevision.occurrences.filter(row => row.sourceKey === sourceKey);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.role).toBe('ingredient');
        return matches[0]!;
      });
      const oilParts = { amount: { start: 0, end: 1 }, unit: { start: 2, end: 6 },
        name: { start: 7, end: 16 } };
      expect(originalIngredients[0]!.qualifier).toMatchObject({ type: 'ingredient-line',
        originalText: { value: '2 tbsp olive oil', language: 'en' },
        amount: { numerator: 2, denominator: 1 }, amountLexical: '2', textParts: oilParts,
        unitText: 'tbsp', parseStatus: 'partial', residual: `sha256:${imported.residualDigest}` });
      expect(originalIngredients[1]!.qualifier).toMatchObject({ type: 'ingredient-line',
        originalText: { value: 'salt', language: 'en' }, name: 'salt',
        amount: { numerator: 1, denominator: 2 }, unitText: 'tsp', parseStatus: 'partial',
        residual: `sha256:${imported.residualDigest}` });
      expect(originalIngredients[1]!.qualifier).not.toHaveProperty('amountLexical');
      expect(originalIngredients[1]!.qualifier).not.toHaveProperty('textParts');
      const assertCarrier = (ingredients: unknown[]) => {
        expect(ingredients.slice(0, 2)).toEqual([
          { '@type': 'PropertyValue', text: '2 tbsp olive oil', value: '2', amountLexical: '2',
            textParts: oilParts, unitText: 'tbsp', parseStatus: 'partial', inLanguage: 'en' },
          { '@type': 'PropertyValue', text: 'salt', name: 'salt', value: '1/2',
            unitText: 'tsp', parseStatus: 'partial', inLanguage: 'en' },
        ]);
        expect(ingredients[1]).not.toHaveProperty('amountLexical');
        expect(ingredients[1]).not.toHaveProperty('textParts');
        for (const field of ['text', 'name']) {
          expect((ingredients[1] as Record<string, unknown>)[field]).not.toBe('1/2 tsp salt');
        }
      };
      assertCarrier(originalExport.recipe.recipeIngredient);
      originalIngredients.forEach((row, index) => {
        expect(originalExport.sourceObservations).toContain(intake.observation.observation);
        expect(originalExport.residuals.filter(item => item.sourceKey === originalKeys[index])).toEqual([
          { sourceKey: row.sourceKey, text: index === 0 ? '2 tbsp olive oil' : 'salt',
            parseStatus: 'partial', residual: `sha256:${imported.residualDigest}` },
        ]);
      });
      expect(originalExport.residuals.find(item => item.sourceKey === originalKeys[1])?.text)
        .not.toBe('1/2 tsp salt');

      const roundTripBytes = Buffer.from(JSON.stringify(originalExport.recipe));
      const roundTripIntake = await f.json<{ observation: StagedSourceObservation }>(await http('POST',
        '/v1/sources/intakes', { profile: 'source-manual-intake-v1', provider: 'recipe-test',
          namespace: 'recipe-test', externalId: randomUUID(), sourceRevision: '1',
          mediaType: 'application/ld+json', retention: 'retained',
          rawBytesBase64: roundTripBytes.toString('base64'),
          coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
          rightsEvidence: { basis: 'original', note: 'Retained authorized Recipe export' },
        }), 201);
      const roundTripObservation = roundTripIntake.observation.observation;
      expect(roundTripObservation).not.toBe(intake.observation.observation);
      const roundTripSource = await f.json<StagedSourceObservation>(await http('GET',
        `/v1/sources/observations/${shortId(roundTripObservation)}`), 200);
      expect(roundTripSource.observation).toBe(roundTripObservation);
      expect(roundTripSource.record).not.toBe(originalSource.record);
      expect(roundTripSource.rawBytesBase64).toBe(roundTripBytes.toString('base64'));
      expect(roundTripSource.byteDigest).toBe(digest(roundTripBytes));
      expect(roundTripSource.byteDigest).not.toBe(originalSource.byteDigest);
      const roundTripWork = await f.json<{ work: string; mainVersion: string }>(await http('POST',
        '/v1/works', await f.authoredBody({ language: 'en', profile: 'metadata-only-v1',
          title: 'Recipe exchange acceptance', semanticTypes: ['https://schema.org/Recipe'],
          actingSubject: f.actor })), 201);
      await f.grant(`work:edit:${roundTripWork.work}`, 'recipe.edit');
      await f.grant(`work:edit:${roundTripWork.work}`, 'work.edit');
      await f.grant(`work:read:${roundTripWork.work}`, 'work.read');
      const roundTripCreated = await f.json<{ structure: string; revision: string }>(await http('POST',
        '/v1/compositions', { profile: 'recipe-composition', work: roundTripWork.work,
          mainVersion: roundTripWork.mainVersion, actingSubject: f.actor }), 201);
      expect(roundTripCreated.structure).not.toBe(created.structure);
      const roundTripRecipePath = `/v1/recipes/${shortId(roundTripCreated.structure)}`;
      const roundTripImported = await f.json<{ revision: string; residualDigest: string; supports: string[] }>(
        await http('POST', `${roundTripRecipePath}/imports`, { sourceObservation: roundTripObservation,
          expectedHead: roundTripCreated.revision, actingSubject: f.actor }), 200);
      expect(roundTripImported.residualDigest).toBe(roundTripSource.byteDigest);
      const roundTripRevision = await f.json<{ revision: string; occurrences: OccurrenceRecord[] }>(
        await http('GET', `/v1/compositions/${shortId(roundTripCreated.structure)}/revisions/`
          + `${shortId(roundTripImported.revision)}?${actorQuery}`), 200);
      expect(roundTripRevision.revision).toBe(roundTripImported.revision);
      const roundTripExportPath = `${roundTripRecipePath}/exports/schema-org?${actorQuery}`
        + `&revision=${encodeURIComponent(roundTripImported.revision)}`;
      const roundTripExport = await f.json<RecipeExport>(await http('GET', roundTripExportPath), 200);
      expect(roundTripExport.recipe.recipeIngredient).toEqual(originalExport.recipe.recipeIngredient);
      assertCarrier(roundTripExport.recipe.recipeIngredient);
      const readRevisionPages = async (structure: string, revision: string) => {
        const pages: Array<{ revision: string; occurrences: OccurrenceRecord[]; next: string | null }> = [];
        const parents = [structure];
        for (const parent of parents) {
          let after: string | null = null;
          do {
            const page: (typeof pages)[number] = await f.json(await http('GET',
              `/v1/compositions/${shortId(structure)}/revisions/${shortId(revision)}?${actorQuery}`
                + `&parent=${encodeURIComponent(parent)}&limit=1`
                + (after ? `&after=${encodeURIComponent(after)}` : '')), 200);
            expect(page.revision).toBe(revision);
            pages.push(page);
            parents.push(...page.occurrences.filter(row => row.state === 'active' && row.role === 'group')
              .map(row => row.occurrence));
            after = page.next;
          } while (after);
        }
        return pages;
      };
      const originalPages = await readRevisionPages(created.structure, imported.revision);
      const roundTripPages = await readRevisionPages(roundTripCreated.structure, roundTripImported.revision);
      expect(originalPages.some(page => page.next !== null)).toBe(true);
      expect(roundTripPages.some(page => page.next !== null)).toBe(true);
      await Bun.write(resolve('.temp', `recipe-exchange-${Bun.env.REZICS_QA_RUN_ID}.json`),
        JSON.stringify({ originalExportPath, originalExport, originalRevision, originalPages, originalSource,
          roundTripExportPath, roundTripExport, roundTripRevision, roundTripPages, roundTripSource }, null, 2));
      const allOriginalIngredients = originalPages.flatMap(page => page.occurrences)
        .filter(row => row.role === 'ingredient');
      const allRoundTripIngredients = roundTripPages.flatMap(page => page.occurrences)
        .filter(row => row.role === 'ingredient');
      expect(allOriginalIngredients).toHaveLength(4);
      expect(allRoundTripIngredients).toHaveLength(4);
      expect(new Set(allOriginalIngredients.map(row => row.occurrence)).size).toBe(4);
      expect(new Set(allRoundTripIngredients.map(row => row.occurrence)).size).toBe(4);
      expect(allOriginalIngredients.map(row => row.sourceKey)).toEqual([
        ...originalKeys, 'stage-a/flour', 'stage-b/flour',
      ]);
      expect(originalExport.sourceObservations).toEqual([intake.observation.observation]);
      expect(originalExport.residuals).toEqual(allOriginalIngredients.map(row => ({
        sourceKey: row.sourceKey, text: (row.qualifier as { originalText: { value: string } }).originalText.value,
        parseStatus: 'partial', residual: row.qualifier && 'residual' in row.qualifier
          ? row.qualifier.residual : null,
      })));
      expect(originalExport.recipe.recipeIngredient.slice(2)).toEqual([
        { '@type': 'PropertyValue', text: 'flour', value: '3/2', amountLexical: '3/2 cup',
          unitText: 'cup', parseStatus: 'partial', inLanguage: 'en' },
        { '@type': 'PropertyValue', text: 'flour', value: '1/4', amountLexical: '1/4 cup',
          unitText: 'cup', parseStatus: 'partial', inLanguage: 'en' },
      ]);
      const retainedFields = ['type', 'originalText', 'name', 'amount', 'amountUpper', 'unit',
        'unitText', 'parseStatus', 'amountLexical', 'textParts'] as const;
      allRoundTripIngredients.forEach((row, index) => {
        expect(row.sourceKey).toBe(`${roundTripObservation}#/recipeIngredient/${index}`);
        expect(allOriginalIngredients.map(item => item.occurrence)).not.toContain(row.occurrence);
        for (const field of retainedFields) {
          const before = allOriginalIngredients[index]!.qualifier as Record<string, unknown>;
          const after = row.qualifier as Record<string, unknown>;
          expect(Object.hasOwn(after, field)).toBe(Object.hasOwn(before, field));
          expect(after[field]).toEqual(before[field]);
        }
        expect(row.qualifier).toHaveProperty('residual', `sha256:${roundTripImported.residualDigest}`);
        expect(roundTripExport.residuals.filter(item => item.sourceKey === row.sourceKey)).toEqual([
          { sourceKey: row.sourceKey, text: (row.qualifier as { originalText: { value: string } }).originalText.value,
            parseStatus: 'partial', residual: `sha256:${roundTripImported.residualDigest}` },
        ]);
      });
      const flour = allRoundTripIngredients.filter(row => row.qualifier?.type === 'ingredient-line'
        && row.qualifier.originalText.value === 'flour');
      expect(flour).toHaveLength(2);
      expect(flour[0]!.occurrence).not.toBe(flour[1]!.occurrence);
      expect(flour.map(row => row.qualifier)).toEqual([
        expect.objectContaining({ originalText: { value: 'flour', language: 'en' },
          amount: { numerator: 3, denominator: 2 }, amountLexical: '3/2 cup', unitText: 'cup' }),
        expect.objectContaining({ originalText: { value: 'flour', language: 'en' },
          amount: { numerator: 1, denominator: 4 }, amountLexical: '1/4 cup', unitText: 'cup' }),
      ]);
      expect(roundTripExport.sourceObservations).toEqual([roundTripObservation]);
      const originalSupports = (imported as typeof imported & { supports: string[] }).supports;
      const readSupports = async (supports: string[]) => Promise.all(supports.map(async support =>
        f.json<FieldSupportResult>(await http('GET', `/v1/sources/field-supports/${shortId(support)}`), 200)));
      const originalSupportAnswers = await readSupports(originalSupports);
      const roundTripSupportAnswers = await readSupports(roundTripImported.supports);
      expect(roundTripSupportAnswers.filter(answer => answer.sourceField === 'recipeIngredient'))
        .toHaveLength(4);
      expect(new Set(roundTripSupportAnswers.map(answer => answer.support)).size)
        .toBe(roundTripSupportAnswers.length);
      expect(new Set(roundTripSupportAnswers.map(answer => answer.supportIdentity)).size)
        .toBe(roundTripSupportAnswers.length);
      const assertSupport = (answers: FieldSupportResult[], row: OccurrenceRecord,
        observation: string, pointer: string, nativeRevision: string, target: string, context: string,
        sourceRecord: string) => {
        const matches = answers.filter(answer => answer.occurrence === row.occurrence);
        expect(matches).toHaveLength(1);
        const lexical = (row.qualifier as { originalText: { value: string } }).originalText.value;
        expect(matches[0]).toMatchObject({ state: 'recorded', target, context, nativeRevision, sourceRecord,
          slot: 'structure-occurrence-v1#qualifier.originalText.value', grain: 'recipe',
          sourceField: 'recipeIngredient', valueDigest: digest(JSON.stringify(lexical)),
          sourceOccurrence: `urn:rezics:source-occurrence:${digest(JSON.stringify({ observation,
            grain: 'recipe', field: 'recipeIngredient', pointer }))}` });
        return matches[0]!;
      };
      originalIngredients.forEach((row, index) => assertSupport(originalSupportAnswers, row,
        intake.observation.observation, `/recipeIngredient/${index}${index === 1 ? '/name' : ''}`,
        imported.revision, work.work, created.structure, originalSource.record));
      allRoundTripIngredients.forEach((row, index) => {
        const support = assertSupport(roundTripSupportAnswers, row, roundTripObservation,
          `/recipeIngredient/${index}/text`, roundTripImported.revision,
          roundTripWork.work, roundTripCreated.structure, roundTripSource.record);
        expect(originalSupports).not.toContain(support.support);
        expect(originalSupportAnswers.map(answer => answer.supportIdentity)).not.toContain(support.supportIdentity);
        expect(originalSupportAnswers.map(answer => answer.sourceOccurrence)).not.toContain(support.sourceOccurrence);
      });
      expect(await f.json(await http('GET', originalExportPath), 200)).toEqual(originalExport);
      expect(await f.json(await http('GET', originalRevisionPath), 200)).toEqual(originalRevision);
      expect(await readRevisionPages(created.structure, imported.revision)).toEqual(originalPages);
      expect(await f.json(await http('GET', originalSourcePath), 200)).toEqual(originalSource);
      expect(await readSupports(originalSupports)).toEqual(originalSupportAnswers);
      await Bun.write(resolve('.temp', `recipe-exchange-${Bun.env.REZICS_QA_RUN_ID}.json`),
        JSON.stringify({ originalExportPath, originalExport, originalRevision, originalPages, originalSource,
          originalSupportAnswers, roundTripExportPath, roundTripExport, roundTripRevision, roundTripPages,
          roundTripSource, roundTripSupportAnswers }, null, 2));
    } finally { await server.stop(true); }
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

    const raceBody = (sourceKey: string) => ({
      profile: 'recipe-composition',
      expectedHead: refreshed.revision,
      actingSubject: f.actor,
      operations: [
        { op: 'insert', parent: created.structure, position: 'last', role: 'group', sourceKey },
      ],
    });
    const races = await Promise.all([
      f.call('POST', `/v1/compositions/${shortId(created.structure)}/changes`, raceBody('race-a'), `recipe-${randomUUID()}`),
      f.call('POST', `/v1/compositions/${shortId(created.structure)}/changes`, raceBody('race-b'), `recipe-${randomUUID()}`),
    ]);
    expect(races.map(response => response.status).sort()).toEqual([200, 409]);const compositionPath = `/v1/compositions/${shortId(created.structure)}`;
    const current = await f.json<{ revision: string }>(
      await f.call('GET', `${compositionPath}?actingSubject=${encodeURIComponent(f.actor)}`),
      200,
    );
    const restore = {
      expectedHead: current.revision,
      restoredFrom: changed.revision,
      actingSubject: f.actor,
    };
    expect(
      (
        await f.call(
          'POST',
          `${compositionPath}/restorations`,
          restore,
          randomUUID(),
          f.account.tokenB,
        )
      ).status,
    ).toBe(403);
    const restoreKey = `recipe-restore-${randomUUID()}`;
    const restored = await f.json<{ revision: string; receipt: string }>(
      await f.call('POST', `${compositionPath}/restorations`, restore, restoreKey),
      200,
    );
    expect(
      await f.json(
        await f.call('POST', `${compositionPath}/restorations`, restore, restoreKey),
        200,
      ),
    ).toMatchObject({ revision: restored.revision, receipt: restored.receipt, replayed: true });
    expect(
      await f.json(
        await f.call(
          'GET',
          `${compositionPath}?actingSubject=${encodeURIComponent(f.actor)}` +
            `&parent=${encodeURIComponent(groups.occurrences[0]!)}`,
        ),
        200,
      ),
    ).toMatchObject({
      revision: restored.revision,
      occurrences: [
        {
          occurrence: changed.occurrences[0],
          qualifier: { type: 'ingredient-line', amount: { numerator: 3, denominator: 2 } },
        },
      ],
    });

  } finally { await f.close(); }
}, 180_000);
