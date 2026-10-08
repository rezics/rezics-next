import { expect, test } from 'bun:test';
import { actingSubject, fakeMain, id, mainVersion, startRecipe, work } from './fixtures.ts';
import { selectionWhilePending, textWhilePending, toggleIngredient } from './step-selection.ts';
import { createRecipeStore } from './store.ts';

const stepId = id(13);
const instruction = 'Cream the butter with the sugar.';
const bare = {
  ...startRecipe,
  nodes: startRecipe.nodes.map(node => node.occurrence === stepId && node.role === 'step'
    ? { ...node, qualifier: { ...node.qualifier, usesIngredient: [] as string[] } } : node),
};
const gate = () => { let release: () => void = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); return { held, release }; };

test('a second check while a write is pending is added to the newest selection, not written over the saved one', () => {
  const saved: readonly string[] = [];
  const afterA = toggleIngredient(selectionWhilePending(saved, null), 'A', true);
  const afterB = toggleIngredient(selectionWhilePending(saved, afterA), 'B', true);
  expect(afterA).toEqual(['A']);
  expect(afterB).toEqual(['A', 'B']);
  expect(toggleIngredient(selectionWhilePending(saved, afterB), 'A', false)).toEqual(['B']);
});

test('checking a second ingredient before the first save finishes keeps both on the step', async () => {
  const fake = fakeMain({ recipe: bare });
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: bare, main: fake.main });
  const hold = gate();
  fake.interference.gates = { changes: hold.held };
  const saved = () => {
    const node = store.snapshot().state.nodes.find(item => item.occurrence === stepId);
    if (!node || node.role !== 'step') throw new Error('missing step');
    return node.qualifier.usesIngredient;
  };
  let pending: readonly string[] | null = null;
  const check = (occurrence: string) => {
    const next = toggleIngredient(selectionWhilePending(saved(), pending), occurrence, true);
    pending = next;
    return store.submit({ kind: 'editStep', occurrence: stepId, text: instruction, uses: [...next] });
  };
  const first = check(id(21));
  const second = check(id(22));
  hold.release();
  await Promise.all([first, second]);
  const sent = fake.calls.filter(call => call.name === 'changes').map(call =>
    (call.body as { operations: { qualifier: { usesIngredient: string[] } }[] }).operations[0]!.qualifier.usesIngredient);
  expect(sent).toEqual([[id(21)], [id(21), id(22)]]);
  expect(saved()).toEqual([id(21), id(22)]);
});

test('a checkbox commit keeps the newest pending step text when an older save restored the field', () => {
  const saved = 'Melt the butter.';
  const pending = 'Melt the butter slowly.';
  expect(textWhilePending(saved, pending, saved)).toBe(pending);
  expect(textWhilePending(saved, pending, pending)).toBe(pending);
  expect(textWhilePending(saved, pending, 'Brown the butter.')).toBe('Brown the butter.');
  expect(textWhilePending(saved, null, 'Brown the butter.')).toBe('Brown the butter.');
});
