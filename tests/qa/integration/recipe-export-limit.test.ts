import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { ensureFixtureScopeGate } from '../../../services/main/src/modules/access/fixture-authority.ts';

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
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ language: 'en', profile: 'metadata-only-v1',
        title: 'Recipe export occurrence limit', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: f.actor })), 201);
    await ensureFixtureScopeGate(f.accessPool, `work:edit:${work.work}`);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: f.actor }, `recipe-export-${randomUUID()}`), 201);

    const compositionPath = `/v1/compositions/${shortId(created.structure)}`;
    const entries = Array.from({ length: 4096 }, (_, index) => ({ op: 'insert',
      parent: created.structure, position: 'last', role: index === 0 ? 'ingredient' as const : 'equipment' as const,
      ...(index === 0 ? { qualifier: { type: 'ingredient-line' as const,
        originalText: { value: 'water', language: 'en' }, optional: false, scaling: 'linear' as const,
        substituteFor: [], parseStatus: 'parsed' as const } } : {}),
    }));
    let boundaryRevision = created.revision;
    for (let offset = 0; offset < entries.length; offset += 16) {
      const changed = await f.json<{ revision: string }>(await f.call('POST', `${compositionPath}/changes`, {
        profile: 'recipe-composition', expectedHead: boundaryRevision, actingSubject: f.actor,
        operations: entries.slice(offset, offset + 16),
      }), 200);
      boundaryRevision = changed.revision;
    }
    const added = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `${compositionPath}/changes`, { profile: 'recipe-composition', expectedHead: boundaryRevision,
        actingSubject: f.actor, operations: [{ op: 'insert', parent: created.structure, position: 'last',
          role: 'ingredient', qualifier: { type: 'ingredient-line',
            originalText: { value: 'water', language: 'en' }, optional: false, scaling: 'linear',
            substituteFor: [], parseStatus: 'parsed' } }] }, `recipe-export-over-limit-${randomUUID()}`), 200);
    expect(added.occurrences).toHaveLength(1);

    // The large retained fixture may outlive an OAuth access token. Renew through
    // the real Account owner before checking export rights and refusals.
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    const recipePath = `/v1/recipes/${shortId(created.structure)}/exports/schema-org`;
    const exact = await f.json<{ revision: string; recipe: { recipeIngredient: unknown[] };
      cost: { occurrences: number } }>(await f.call('GET', `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`
        + `&revision=${encodeURIComponent(boundaryRevision)}`), 200);
    expect(exact).toMatchObject({ revision: boundaryRevision, cost: { occurrences: 4096 } });
    expect(exact.recipe.recipeIngredient).toEqual([{ '@type': 'PropertyValue',
      text: 'water', parseStatus: 'parsed', inLanguage: 'en' }, 'water']);

    f.account.tokenA = await f.account.tokenFor(f.account.a);
    const overLimit = await f.json<{ code: string; status: number }>(await f.call('GET',
      `${recipePath}?actingSubject=${encodeURIComponent(f.actor)}`), 413);
    expect(overLimit).toMatchObject({ code: 'recipe_export_too_large', status: 413 });

    f.account.tokenB = await f.account.tokenFor(f.account.b);
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
