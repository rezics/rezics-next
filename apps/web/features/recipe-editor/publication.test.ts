import { expect, test } from 'bun:test';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { createRecipePublisher } from './publication.ts';
import { actingSubject, fakeMain, fixtureAnswer, id, mainVersion, startRecipe, work } from './fixtures.ts';
import { missingBeforePublishing } from './publish.tsx';
import { publishWhenSettled } from './publish-settled.ts';
import type { MainClient } from '../studio/types.ts';

test('a complete recipe publishes its exact structure without inventing a notes contribution', async () => {
  seedServedTypes();
  const fake = fakeMain({ recipe: startRecipe });
  const publisher = createRecipePublisher({ main: fake.main, work, actingSubject, recipe: () => fake.world().recipe });
  let notesCalls = 0;
  const outcome = await publishWhenSettled({ recipe: { whenIdle: async () => {} }, details: { whenIdle: async () => {} },
    notes: { whenIdle: async () => {}, publish: async () => { notesCalls++; return { kind: 'published' }; } },
    body: '', publishRecipe: publisher.publish });
  expect(outcome).toEqual({ kind: 'published' });
  expect(notesCalls).toBe(0);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]).toMatchObject({ name: 'recipe-publish', body: { profile: 'work-structure-publication-v1',
    operation: 'publish', work, actingSubject, expectedWorkHead: id(701), expectedMainVersion: mainVersion,
    structure: startRecipe.structure, expectedStructureHead: startRecipe.head, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public' } });
  expect(missingBeforePublishing({ title: 'Recipe', ingredients: 2, steps: 1, notes: '' })).toEqual({
    title: false, ingredients: false, steps: false, notes: false,
  });
  expect(missingBeforePublishing({ title: 'Recipe', ingredients: 2, steps: 0, instructions: 1, notes: '' })).toEqual({
    title: false, ingredients: false, steps: false, notes: false,
  });
  expect(publisher.snapshot()).toMatchObject({ busy: false, revision: startRecipe.head, failure: null });
});

test.each(['pending', 'lost'] as const)('a %s publication retries the exact body and key, including a withdrawn predecessor', async mode => {
  const bodies: unknown[] = [], keys: string[] = [];
  let headers = 0;
  const header = { revision: id(701), mainVersion, structurePublicationHead: id(99) };
  const post = async (body: { work: string; structure: string; expectedStructureHead: string }, options: { headers: { 'idempotency-key': string } }) => {
    bodies.push(structuredClone(body)); keys.push(options.headers['idempotency-key']);
    if (bodies.length === 1) {
      if (mode === 'lost') throw new Error('Response lost');
      return { status: 202, data: { operationId: 'queued' }, error: null };
    }
    return { status: 200, data: { work: body.work, structure: body.structure, structureRevision: body.expectedStructureHead,
      publicationDecision: id(100), replayed: true }, error: null };
  };
  const main = { v1: { works: () => ({ get: async () => { headers++; return { data: header, error: null }; } }),
    'work-publications': { post } } } as unknown as MainClient;
  const publisher = createRecipePublisher({ main: () => main, work, actingSubject, recipe: () => startRecipe });
  expect(await publisher.publish()).toEqual({ kind: 'refused', refusal: mode === 'pending' ? 'pending' : 'unavailable' });
  expect(publisher.snapshot().revision).toBeNull();
  expect(await publisher.publish()).toEqual({ kind: 'published' });
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({ expectedPublicationHead: id(99) });
  expect(keys[1]).toBe(keys[0]);
  expect(headers).toBe(1);
});

test('a readable imported structure remains a draft when original publication is refused', async () => {
  seedServedTypes();
  const fake = fakeMain({ recipe: startRecipe });
  const problem = { type: 'about:blank', status: 403, code: 'rights_denied', title: 'Unknown file rights', detail: 'Not an original contribution' };
  fake.main().v1['work-publications'].post = Object.assign(async () => fixtureAnswer(403, { ...problem, status: 403 as const }), { '~path': '/v1/work-publications' }) as MainClient['v1']['work-publications']['post'];
  const publisher = createRecipePublisher({ main: fake.main, work, actingSubject, recipe: () => startRecipe });
  expect(await publisher.publish()).toEqual({ kind: 'refused', refusal: 'denied' });
  expect(publisher.snapshot()).toMatchObject({ busy: false, revision: null, status: 403, problem, detail: problem.detail });
});

test('a header without a known publication head cannot turn missing information into first-publication authority', async () => {
  const main = { v1: { works: () => ({ get: async () => ({ data: { revision: id(701), mainVersion }, error: null }) }) } } as unknown as MainClient;
  const publisher = createRecipePublisher({ main: () => main, work, actingSubject, recipe: () => startRecipe });
  expect(await publisher.publish()).toEqual({ kind: 'refused', refusal: 'unavailable' });
});


test('a refused save lane withholds publication and does not publish an earlier title or notes', async () => {
  let calls = 0;
  const outcome = await publishWhenSettled({ recipe: { whenIdle: async () => {} }, details: { whenIdle: async () => {} },
    notes: { whenIdle: async () => {}, publish: async () => { calls++; return { kind: 'published' }; } },
    body: 'Notes', failure: () => 'denied', publishRecipe: async () => { calls++; return { kind: 'published' }; } });
  expect(outcome).toEqual({ kind: 'refused', refusal: 'denied' });
  expect(calls).toBe(0);
});
