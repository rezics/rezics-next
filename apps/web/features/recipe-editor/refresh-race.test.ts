import { expect, test } from 'bun:test';
import { actingSubject, fakeMain, id, mainVersion, startRecipe, work } from './fixtures.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { createRecipeStore } from './store.ts';

const line = (text: string) => qualifierOf(parseLine(text), 'en');

test('a read started at H1 does not replace a write confirmed at H2', async () => {
  const fake = fakeMain({ recipe: startRecipe });
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let reading: () => void = () => {};
  const started = new Promise<void>(resolve => { reading = resolve; });
  let reads = 0;
  fake.interference.dropOccurrences = true;
  fake.interference.recipe = async current => {
    const shot = structuredClone(current());
    reads += 1;
    if (reads === 1) {
      reading();
      await held;
      return shot;
    }
    return current();
  };
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: startRecipe, main: fake.main });
  const added = store.submit({ kind: 'addLine', section: id(11), qualifier: line('1 tsp salt') });
  await started;
  // The older success is still reading H1. This write confirms H2 while that read is in flight.
  fake.interference.acceptStale = true;
  expect(await store.submit({ kind: 'timings', times: { cooking: 30 } })).toEqual({ kind: 'saved' });
  release();
  expect(await added).toEqual({ kind: 'saved' });
  const state = store.snapshot().state;
  expect(state.measures.some(item => item.kind === 'cooking-duration' && item.value.numerator === 30)).toBe(true);
  expect(state.nodes.some(node => node.role === 'ingredient' && node.qualifier.originalText.value === '1 tsp salt')).toBe(true);
  expect(state.head).toBe(fake.world().recipe.head);
  expect(reads).toBeGreaterThanOrEqual(2);
});
