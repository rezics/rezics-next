import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import authoringJson from '../../../../tests/qa/fixtures/outcomes/recipes/author-a-recipe.json';
import exchangeJson from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { settle } from '../studio/read.ts';
import { loadRecipeAuthoring, readRecipeNotes } from './authoring-page.ts';
import { fakeMain, fixtureAnswer, id, noNotes, startRecipe, work, actingSubject } from './fixtures.ts';
import { plan } from './intents.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { stateOf } from './model.ts';

const personas: AnswerPersona[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
for (const record of [authoringJson, exchangeJson] as AnswerRecord[]) {
  test.each(personas)(`${record.row}: %s opens through the production authoring reader`, async persona => {
    seedServedTypes();
    const samples = record.personas[persona];
    const header = samples.find(sample => sample.label === 'editor-work-header')!;
    const id = header.path.split('?')[0]!.split('/').pop()!;
    const actingSubject = persona === 'visitor' ? null : new URL(header.path, 'https://recorded.invalid').searchParams.get('actingSubject');
    const selections = samples.filter(sample => sample.label.startsWith('editor-')).map(sample => ({ label: sample.label, state: 'populated' as const }));
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const requests: string[] = [], misses: unknown[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      try { return await replay.fetcher(input, init); } catch (error) { misses.push(error); throw error; }
    }) as typeof fetch;
    const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher });
    try {
      const view = await loadRecipeAuthoring(main, { id, actingSubject, signedIn: persona !== 'visitor' });
      expect(misses).toEqual([]);
      if (persona === 'owner') {
        expect(view.kind).toBe('editor');
        if (view.kind !== 'editor') throw new Error('Author did not reach the editor');
        const page = samples.find(sample => sample.label === 'editor-private-recipe')
          ?? samples.find(sample => sample.label === 'editor-recipe-draft' || sample.label === 'editor-recipe')!;
        expect(view.actingSubject).toBe(actingSubject!);
        expect(view.initial.recipe).toEqual(stateOf(page.answer as Parameters<typeof stateOf>[0]));
        expect(view.initial.recipe.nodes.filter(node => node.role === 'ingredient')).toHaveLength(2);
        expect(view.initial.notes).toEqual(noNotes);
        expect(requests).toHaveLength(record.row === 'recipes/author-a-recipe' ? 8 : 7);
      } else {
        expect(view).toEqual({ kind: 'no-authority', signedIn: persona !== 'visitor' });
        expect(requests).toHaveLength(persona === 'visitor' ? 1 : 2);
        expect(requests.some(path => path.includes('/recipes/') || path.includes('/contributions'))).toBe(false);
      }
    } finally { replay.dispose(); }
  });
}

test('notes failures and an unfinished inventory do not become an empty editable draft', async () => {
  seedServedTypes();
  const fake = fakeMain({ recipe: startRecipe });
  const main = fake.main();
  const originalGet = main.v1.me.contributions.get;
  const problem = { type: 'about:blank', status: 403, code: 'authority_denied', title: 'No access', detail: 'Revoked', extension: ['kept'] };
  main.v1.me.contributions.get = Object.assign(async () => fixtureAnswer(403, { ...problem, status: 403 as const }), { '~path': '/v1/me/contributions' }) as typeof main.v1.me.contributions.get;
  expect(await readRecipeNotes(main, actingSubject, work, 'en')).toEqual({ ok: false, failure: 'denied', status: 403, problem });
  expect(await loadRecipeAuthoring(main, { id: work.slice(-36), actingSubject, signedIn: true })).toEqual({
    kind: 'unavailable', refusal: { ok: false, failure: 'denied', status: 403, problem },
  });
  main.v1.me.contributions.get = Object.assign(async () => {
    const first = await originalGet();
    return fixtureAnswer(200, { ...first.data!, items: [], nextCursor: 'still-more' });
  }, { '~path': '/v1/me/contributions' }) as typeof main.v1.me.contributions.get;
  expect(await readRecipeNotes(main, actingSubject, work, 'en')).toEqual({ ok: false, failure: 'unavailable' });
});

test('metadata failures cannot replace advanced authored metadata with empty values', async () => {
  seedServedTypes();
  const fake = fakeMain({ recipe: startRecipe });
  const main = fake.main();
  const original = main.v1.works;
  const problem = { title: 'Unavailable', code: 'read_unavailable', status: 503, detail: 'Metadata held' };
  main.v1.works = ((input: Parameters<typeof original>[0]) => ({ ...original(input), metadata: {
    ...original(input).metadata, get: async () => ({ data: null, error: { status: 503, value: problem } }),
  } })) as typeof original;
  expect(await loadRecipeAuthoring(main, { id: work.slice(-36), actingSubject, signedIn: true })).toEqual({
    kind: 'unavailable', refusal: { ok: false, failure: 'unavailable', status: 503, problem },
  });
});

test('editing imported lines, preparation and sections retains their authored languages', () => {
  const previous = { ...qualifierOf(parseLine('3/2 cup farine'), 'fr'), preparation: { value: 'tamisée', language: 'fr' } };
  const changed = qualifierOf({ quantity: '1/4', unit: 'cup', name: 'farine', note: 'tamisée' }, 'en', previous);
  expect(changed.originalText.language).toBe('fr');
  expect(changed.preparation?.language).toBe('fr');
  const state = { ...startRecipe, nodes: [{ occurrence: id(11), parent: startRecipe.structure!, role: 'group' as const,
    label: { value: 'Pâte', language: 'fr' } }] };
  expect(plan(state, { kind: 'renameSection', occurrence: id(11), label: 'Glaçage', language: 'en' })).toMatchObject({
    operations: [{ label: { value: 'Glaçage', language: 'fr' } }],
  });
});

test('a local absence and thrown transport failure invent no HTTP refusal', async () => {
  expect(await settle(async () => ({ data: null, error: null }))).toEqual({ ok: false, failure: 'unavailable' });
  expect(await settle(async () => { throw new Error('Offline'); })).toEqual({ ok: false, failure: 'unavailable' });
});
