import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { evenKeys } from '../../../services/main/src/modules/structure/order-key.ts';
import { StructureStageStore, type StructureStage } from '../../../services/main/src/modules/structure/stage.ts';

test('RECIPE_EXPORT_LIMIT: exact revisions export at 4,096 occurrences and deny larger or hidden Recipes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-export-limit-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  const stageApp = createMainApp(f.nativeFuseki, { environment: f.env, account: f.account.verifier,
    access: f.access, structureObjects: objects, structureStages: new StructureStageStore(f.pool, objects) });
  const stageCall = (method: string, path: string, body: object) => stageApp.handle(new Request(
    `http://main.local${path}`, { method, headers: { authorization: `Bearer ${f.account.tokenA}`,
      'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ language: 'en', profile: 'metadata-only-v1',
        title: 'Recipe export occurrence limit', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: f.actor })), 201);
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`work:edit:${work.work}`]);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: f.actor }, `recipe-export-${randomUUID()}`), 201);

    const compositionPath = `/v1/compositions/${shortId(created.structure)}`;
    const stage = await f.json<StructureStage>(await stageCall('POST', `${compositionPath}/stages`, {
      expectedHead: created.revision, actingSubject: f.actor }), 201);
    const segmentKeys = evenKeys(4096 / 32), orderKeys = evenKeys(32);
    const entries = Array.from({ length: 4096 }, (_, index) => ({
      occurrence: `https://rezics.com/id/${randomUUID()}`, state: 'active' as const,
      parent: created.structure, segmentKey: segmentKeys[Math.floor(index / 32)]!,
      orderKey: orderKeys[index % 32]!, role: index === 0 ? 'ingredient' as const : 'equipment' as const,
      ...(index === 0 ? { qualifier: { type: 'ingredient-line' as const,
        originalText: { value: 'water', language: 'en' }, optional: false, scaling: 'linear' as const,
        substituteFor: [], parseStatus: 'parsed' as const } } : {}),
      labels: [], introducedBy: stage.revision,
    }));
    for (let offset = 0; offset < entries.length; offset += 256) {
      const uploaded = await f.json<StructureStage>(await stageCall('PUT',
        `${compositionPath}/stages/${stage.id}/pages/${offset / 256}`, {
        actingSubject: f.actor, holder: stage.holder!, fence: stage.fence,
        entries: entries.slice(offset, offset + 256),
        }), 200);
      expect(uploaded.records).toBe(offset + 256);
    }
    const sealed = await f.json<StructureStage>(await stageCall('POST', `${compositionPath}/stages/${stage.id}/seal`, {
      actingSubject: f.actor, holder: stage.holder!, fence: stage.fence,
    }), 200);
    expect(sealed.status).toBe('sealed');
    const activationPath = `${compositionPath}/stages/${stage.id}/activate`;
    let activated: StructureStage | undefined;
    const activationDeadline = Date.now() + 300_000;
    while (!activated && Date.now() < activationDeadline) {
      const response = await stageCall('POST', activationPath, { actingSubject: f.actor });
      if (response.status === 202) {
        const pending = await response.json() as { status: string; retry: { allowed: boolean; afterMs: number } };
        expect(pending).toMatchObject({ status: 'reconciling', retry: { allowed: true } });
        await Bun.sleep(pending.retry.afterMs);
      } else {
        activated = await f.json<StructureStage>(response, 200);
      }
    }
    if (!activated) throw new Error('Structure stage activation did not settle within five minutes');
    const boundaryRevision = activated.revision;
    const added = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `${compositionPath}/changes`, { profile: 'recipe-composition', expectedHead: boundaryRevision,
        actingSubject: f.actor, operations: [{ op: 'insert', parent: created.structure, position: 'last',
          role: 'ingredient', qualifier: { type: 'ingredient-line',
            originalText: { value: 'water', language: 'en' }, optional: false, scaling: 'linear',
            substituteFor: [], parseStatus: 'parsed' } }] }, `recipe-export-over-limit-${randomUUID()}`), 200);
    expect(added.occurrences).toHaveLength(1);

    const recipePath = `/v1/recipes/${shortId(created.structure)}/exports/schema-org`;
    const exact = await f.json<{ revision: string; recipe: { recipeIngredient: unknown[] };
      cost: { occurrences: number } }>(await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`
        + `&revision=${encodeURIComponent(boundaryRevision)}`), 200);
    expect(exact).toMatchObject({ revision: boundaryRevision, cost: { occurrences: 4096 } });
    expect(exact.recipe.recipeIngredient).toEqual([{ '@type': 'PropertyValue',
      text: 'water', parseStatus: 'parsed', inLanguage: 'en' }]);

    const overLimit = await f.json<{ code: string; status: number }>(await f.call('GET',
      `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`), 413);
    expect(overLimit).toMatchObject({ code: 'recipe_export_too_large', status: 413 });

    const denied = await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`,
      undefined, randomUUID(), f.account.tokenB);
    const absent = await f.call('GET', `/v1/recipes/${randomUUID()}/exports/schema-org`
      + `?actingSubject=${encodeURIComponent(f.actor)}`, undefined, randomUUID(), f.account.tokenB);
    expect(denied.status).toBe(404);
    expect(denied.status).toBe(absent.status);
    expect(await denied.json()).toEqual(await absent.json());
  } finally {
    await f.close();
  }
}, 600_000);
