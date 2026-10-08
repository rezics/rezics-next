import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { RECIPE_WORK_PAGE_OCCURRENCES, RECIPE_WORK_PAGE_READ_BOUND }
  from '../../../services/main/src/modules/recipe/work-page.ts';

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
    expect(page).not.toHaveProperty('next');
  } finally { await f.close(); }
}, 180_000);

test('a paged Recipe keeps depth-first order, the servings pin and a stale cursor', async () => {
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
      language: 'en', profile: 'metadata-only-v1', title: 'Paged stew',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
        actingSubject: f.actor }, `recipe-${randomUUID()}`), 201);
    const line = (text: string, parent: string) => ({ op: 'insert' as const, parent, position: 'last' as const,
      role: 'ingredient' as const, qualifier: { type: 'ingredient-line', originalText: { value: text, language: 'en' },
        amountLexical: '1', amount: { numerator: 1, denominator: 1 }, unitText: 'cup', optional: false,
        scaling: 'linear', substituteFor: [], parseStatus: 'parsed' } });
    let revision = created.revision;
    const change = async (operations: object[]) => {
      const written: string[] = [];
      for (let index = 0; index < operations.length; index += 16) {
        const result = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
          `/v1/compositions/${shortId(created.structure)}/changes`, { profile: 'recipe-composition',
            expectedHead: revision, actingSubject: f.actor, operations: operations.slice(index, index + 16) },
          `recipe-${randomUUID()}`), 200);
        revision = result.revision;
        written.push(...result.occurrences);
      }
      return written;
    };
    const rootIngredients = Array.from({ length: 100 }, (_, index) => line(`1 cup flour ${index}`, created.structure));
    const [group] = await change([{ op: 'insert', parent: created.structure, position: 'last', role: 'group',
      label: { value: 'Sauce', language: 'en' } }, ...rootIngredients.slice(0, 15)]);
    await change([line('1 cup tomato', group!), line('1 cup salt', group!)]);
    await change(rootIngredients.slice(15));
    const measured = await f.json<{ revision: string }>(await f.call('POST',
      `/v1/recipes/${shortId(created.structure)}/measures`, { expectedHead: revision, actingSubject: f.actor,
        yield: { value: { numerator: 4, denominator: 1 }, unitText: 'servings', coverage: 'complete', provenance: 'declared' },
        servings: { value: { numerator: 4, denominator: 1 }, coverage: 'complete', provenance: 'declared' },
        nutrition: { basis: 'per-serving', inputs: [{ coverage: 'complete', values: [{
          nutrient: 'https://example.test/energy', unit: 'https://example.test/kcal',
          amount: { numerator: 12, denominator: 1 } }] }] } }, `recipe-${randomUUID()}`), 200);
    const path = `/v1/recipes/works/${shortId(work.work)}`;
    const query = `?actingSubject=${encodeURIComponent(f.actor)}`;
    type Page = { profile: string; revision: string; occurrences: Array<{ role: string; labels: Array<{ value: string }>;
      qualifier?: { originalText?: { value: string } } }>; measures?: Array<{ kind: string; basis: string }>;
      ingredients: Array<{ originalText: string; amount?: { numerator: number; denominator: number } }>;
      next?: string; cost: { pages: number; occurrences: number } };
    const load = async (cursor?: string, servings?: number) => {
      const suffix = `${query}${servings === undefined ? '' : `&servings=${servings}`}`
        + `${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      return f.json<Page>(await f.call('GET', path + suffix), 200);
    };
    const first = await load(undefined, 8);
    expect(first.revision).toBe(measured.revision);
    expect(first.occurrences.map(item => item.role)).toEqual(['group']);
    expect(first.occurrences[0]?.labels[0]?.value).toBe('Sauce');
    expect(first.measures?.map(item => item.kind)).toEqual(expect.arrayContaining(['servings', 'nutrient']));
    expect(first.measures?.find(item => item.kind === 'nutrient')?.basis).toBe('per-serving');
    expect(first.cost.occurrences).toBe(1);
    expect(first.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
    expect(first.next).toBeString();
    const cursor = first.next!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    expect((await f.call('GET', `${path}${query}&cursor=${encodeURIComponent(tampered)}`)).status)
      .toBe(400);
    expect((await f.call('GET', `${path}${query}&cursor=${encodeURIComponent(cursor)}&servings=3`)).status).toBe(400);
    const second = await load(cursor);
    expect(second.measures?.map(item => item.kind)).toEqual(expect.arrayContaining(['servings', 'nutrient']));
    expect(second.occurrences.map(item => item.qualifier?.originalText?.value)).toEqual(['1 cup tomato', '1 cup salt']);
    expect(second.ingredients.map(item => item.amount)).toEqual([
      { numerator: 2, denominator: 1 }, { numerator: 2, denominator: 1 }]);
    expect(second.cost.occurrences).toBeLessThanOrEqual(RECIPE_WORK_PAGE_OCCURRENCES);
    const replay = await load(cursor);
    expect(replay.occurrences.map(item => item.qualifier?.originalText?.value)).toEqual(['1 cup tomato', '1 cup salt']);
    const third = await load(second.next);
    expect(third.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
    expect(third.occurrences.every(item => item.qualifier?.originalText?.value?.startsWith('1 cup flour'))).toBe(true);
    expect(third.ingredients[0]?.amount).toEqual({ numerator: 2, denominator: 1 });
    expect(third.measures?.map(item => item.kind)).toEqual(expect.arrayContaining(['servings', 'nutrient']));
    expect(third.next).toBeUndefined();
    expect(third.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
    const added = await f.json<{ revision: string }>(await f.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, { profile: 'recipe-composition',
        expectedHead: measured.revision, actingSubject: f.actor,
        operations: [line('1 cup parsley', created.structure)] }, `recipe-${randomUUID()}`), 200);
    const stale = await f.json<{ profile: string; revision: string; cursorRevision: string; occurrences?: unknown }>(
      await f.call('GET', `${path}${query}&cursor=${encodeURIComponent(cursor)}`), 409);
    expect(stale).toEqual({ profile: 'recipe-work-page-stale', structure: created.structure,
      revision: added.revision, cursorRevision: measured.revision });
  } finally { await f.close(); }
}, 180_000);
