import { expect, test } from 'bun:test';
import { readListPresentationFacts } from '../../src/semantic/list-presentation.ts';
import { createListPresentationFixture } from './support/list-presentation-fixture.ts';

test('native released book film and recipe list facts come from actual adopted values in one original-keyed batch', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const book = await f.create('schema:Book', { 'schema:wordCount': { amount: '+1000001', unit: '1' } });
    const film = await f.create('schema:Movie', {
      'schema:duration': { amount: '+5400', unit: 'http://www.wikidata.org/entity/Q11574' },
    });
    const recipe = await f.create('schema:Recipe', {
      'schema:cookTime': { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' },
    });
    const values = await readListPresentationFacts(await f.deps('anonymous'), [book, film, recipe], {
      languages: ['en'],
    });
    expect(values.get(book)).toEqual({
      id: book,
      facts: { 'schema:wordCount': [{ kind: 'quantity', amount: 1000001, unit: '1' }] },
    });
    expect(values.get(film)).toEqual({
      id: film,
      facts: { 'schema:duration': [{ kind: 'quantity', amount: 5400, unit: 'http://www.wikidata.org/entity/Q11574' }] },
    });
    expect(values.get(recipe)).toEqual({
      id: recipe,
      facts: { 'schema:cookTime': [{ kind: 'quantity', amount: 25, unit: 'http://www.wikidata.org/entity/Q7727' }] },
    });
    expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180000);

test('native current withholding conceals the subject rather than leaking sibling list facts or false empty proof', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const id = await f.create('schema:Book', { 'schema:wordCount': { amount: '+12345', unit: '1' } });
    expect(
      (await readListPresentationFacts(await f.deps('anonymous'), [id])).get(id)?.facts['schema:wordCount'],
    ).toEqual([{ kind: 'quantity', amount: 12345, unit: '1' }]);
    await f.hide(id);
    expect((await readListPresentationFacts(await f.deps('anonymous'), [id])).get(id)).toBeNull();
  } finally {
    await f.close();
  }
}, 180000);
