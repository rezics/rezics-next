import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

test('G-415: a visible Recipe Work page scales the pinned ingredient revision and fences private reads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-work-page-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', await f.authoredBody({
      language: 'en', profile: 'metadata-only-v1', title: 'Measured pancakes',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const path = `/v1/recipes/works/${shortId(work.work)}`;
    const query = `?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json(await f.call('GET', path + query), 200)).toBeNull();
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', {
          profile: 'recipe-composition',
          work: work.work,
          mainVersion: work.mainVersion,
          actingSubject: f.actor,
        },
      `recipe-${randomUUID()}`), 201);
    const changed = await f.json<{ revision: string }>(await f.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, {
          profile: 'recipe-composition',
          expectedHead: created.revision,
          actingSubject: f.actor,
          operations: [
            {
              op: 'insert',
              parent: created.structure,
              position: 'last',
              role: 'ingredient',
              qualifier: {
                type: 'ingredient-line',
                originalText: { value: '1 1/2 cups flour', language: 'en' },
                amountLexical: '1 1/2',
                amount: { numerator: 3, denominator: 2 },
                unitText: 'cups',
                optional: false,
                scaling: 'linear',
                substituteFor: [],
                parseStatus: 'parsed',
              },
            },
            {
              op: 'insert',
              parent: created.structure,
              position: 'last',
              role: 'step',
              qualifier: {
                type: 'recipe-step',
                instructionText: { value: 'Cook for 5 minutes.', language: 'en' },
                usesIngredient: [],
                media: [],
                scaling: 'linear',
              },
            },
          ],
        }, `recipe-${randomUUID()}`), 200);
    await f.json(await f.call('POST', `/v1/recipes/${shortId(created.structure)}/measures`, {
      expectedHead: changed.revision, actingSubject: f.actor,
      yield: { value: { numerator: 4, denominator: 1 }, unitText: 'servings',
        coverage: 'complete', provenance: 'declared' },
      servings: { value: { numerator: 4, denominator: 1 },
        coverage: 'complete', provenance: 'declared' },
      nutrition: { basis: 'whole-recipe', inputs: [] },
    }, `recipe-${randomUUID()}`), 200);
    const page = await f.json<{ profile: string; occurrences: unknown[];
      ingredients: Array<{ amount: { numerator: number; denominator: number }; originalText: string }>;
      measures: Array<{ kind: string }>; cost: { pages: number; pagesRead: number; occurrences: number } }>(
      await f.call('GET', `${path}${query}&servings=10`), 200);
    expect(page).toMatchObject({ profile: 'recipe-work-page-v1',
      ingredients: [{ originalText: '1 1/2 cups flour', amount: { numerator: 15, denominator: 4 },
        line: '3 ¾ cups flour', alternateLine: '900 ml flour', alternateSystem: 'metric',
        hint: '1 1/2 cups flour', scaled: true }],
      cost: { occurrences: 2 } });
    expect(page.occurrences).toHaveLength(2);
    expect(page.measures.map(item => item.kind)).toContain('servings');
    expect(page.cost.pages).toBeGreaterThanOrEqual(1);
    expect(page.cost.pagesRead).toBeGreaterThanOrEqual(page.cost.pages);
    expect((await f.call('GET', `${path}${query}&servings=1.5`)).status).toBe(400);
    expect((await f.call('GET', `${path}${query}&servings=101`)).status).toBe(400);
    expect((await f.call('GET', path + query, undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
  } finally { await f.close(); }
}, 180_000);
