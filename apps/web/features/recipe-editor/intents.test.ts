import { expect, test } from 'bun:test';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { applyPlan, type Intent, plan } from './intents.ts';
import type { RecipeState, StepQualifier } from './model.ts';

const S = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (text: string) => qualifierOf(parseLine(text), 'en');
const step = (text: string, uses: string[] = []): StepQualifier => ({ type: 'recipe-step', instructionText: { value: text, language: 'en' },
  usesIngredient: uses, media: [], scaling: 'linear' });

// Two sections each holding a "butter" line, one root step that uses the cake's butter.
const state: RecipeState = { structure: S, head: id(900), measures: [], nodes: [
  { occurrence: id(1), parent: S, role: 'group', label: { value: 'Cake', language: 'en' } },
  { occurrence: id(2), parent: S, role: 'group', label: { value: 'Icing', language: 'en' } },
  { occurrence: id(3), parent: S, role: 'step', qualifier: step('Cream the butter.', [id(11)]) },
  { occurrence: id(4), parent: S, role: 'step', qualifier: step('Ice it.', [id(21)]) },
  { occurrence: id(11), parent: id(1), role: 'ingredient', qualifier: line('200 g butter') },
  { occurrence: id(12), parent: id(1), role: 'ingredient', qualifier: line('1½ cups flour') },
  { occurrence: id(21), parent: id(2), role: 'ingredient', qualifier: line('100 g butter') },
] };

const changes = (intent: Intent, from = state) => { const planned = plan(from, intent); if (planned.kind !== 'changes') throw new Error(planned.kind); return planned.operations; };
const apply = (intent: Intent, created: string[] = [], from = state) => applyPlan(from, plan(from, intent), id(901), created);
const order = (s: RecipeState, parent: string) => s.nodes.filter(node => node.parent === parent).map(node => node.occurrence);

test('a line is added to its own section and two sections may hold the same ingredient name', () => {
  const intent: Intent = { kind: 'addLine', section: id(2), qualifier: line('2 tbsp butter') };
  expect(changes(intent)).toEqual([{ op: 'insert', parent: id(2), position: 'last', role: 'ingredient', qualifier: line('2 tbsp butter') }]);
  expect(order(apply(intent, [id(22)]), id(2))).toEqual([id(21), id(22)]);
  expect(plan(state, { kind: 'addLine', section: id(99), qualifier: line('x') })).toEqual({ kind: 'invalid', reason: 'gone' });
});

test('editing an ingredient replaces its qualifier in place; the same text is already done', () => {
  const edited = line('250 g butter, softened');
  expect(changes({ kind: 'editLine', occurrence: id(11), qualifier: edited })).toEqual([{ op: 'update', occurrence: id(11), qualifier: edited }]);
  expect(plan(state, { kind: 'editLine', occurrence: id(11), qualifier: line('200 g butter') })).toEqual({ kind: 'moot' });
  const after = apply({ kind: 'editLine', occurrence: id(11), qualifier: edited });
  expect(after.nodes.find(node => node.occurrence === id(11))).toMatchObject({ role: 'ingredient', qualifier: edited });
  expect(order(after, id(1))).toEqual([id(11), id(12)]);
  expect(plan(state, { kind: 'editLine', occurrence: id(77), qualifier: edited })).toEqual({ kind: 'invalid', reason: 'gone' });
});

test('removing an ingredient first edits it out of the steps that use it, in one change', () => {
  expect(changes({ kind: 'removeLine', occurrence: id(11) })).toEqual([
    { op: 'update', occurrence: id(3), qualifier: step('Cream the butter.', []) },
    { op: 'remove', occurrence: id(11) }]);
  const after = apply({ kind: 'removeLine', occurrence: id(11) });
  expect(after.nodes.some(node => node.occurrence === id(11))).toBe(false);
  expect(after.nodes.find(node => node.occurrence === id(3))).toMatchObject({ qualifier: { usesIngredient: [] } });
  expect(plan(after, { kind: 'removeLine', occurrence: id(11) })).toEqual({ kind: 'moot' });
});

test('removing a section removes its lines and the references to them, never past the batch bound', () => {
  const operations = changes({ kind: 'removeSection', occurrence: id(1) });
  expect(operations.map(operation => operation.op)).toEqual(['update', 'remove', 'remove', 'remove']);
  const crowded: RecipeState = { ...state, nodes: [...state.nodes, ...Array.from({ length: 16 }, (_, n) => ({
    occurrence: id(100 + n), parent: id(1), role: 'ingredient' as const, qualifier: line(`${n + 1} g salt`) }))] };
  expect(plan(crowded, { kind: 'removeSection', occurrence: id(1) })).toEqual({ kind: 'invalid', reason: 'too-many' });
});

test('reordering moves past the nearest sibling of the same kind and re-plans on newer state', () => {
  expect(changes({ kind: 'moveLine', occurrence: id(12), direction: 'up' })).toEqual([
    { op: 'move', occurrence: id(12), parent: id(1), position: 'first' }]);
  expect(changes({ kind: 'moveLine', occurrence: id(11), direction: 'down' })).toEqual([
    { op: 'move', occurrence: id(11), parent: id(1), position: { after: id(12) } }]);
  expect(plan(state, { kind: 'moveLine', occurrence: id(11), direction: 'up' })).toEqual({ kind: 'moot' });
  expect(order(apply({ kind: 'moveLine', occurrence: id(12), direction: 'up' }), id(1))).toEqual([id(12), id(11)]);
  // Steps skip the sections that share their parent.
  expect(changes({ kind: 'moveStep', occurrence: id(4), direction: 'up' })).toEqual([
    { op: 'move', occurrence: id(4), parent: S, position: { after: id(2) } }]);
  expect(order(apply({ kind: 'moveStep', occurrence: id(4), direction: 'up' }), S)).toEqual([id(1), id(2), id(4), id(3)]);
  expect(changes({ kind: 'moveSection', occurrence: id(2), direction: 'up' })).toEqual([
    { op: 'move', occurrence: id(2), parent: S, position: 'first' }]);
});

test('a line moves to another section and a step keeps only ingredients that still exist', () => {
  expect(changes({ kind: 'moveLineTo', occurrence: id(12), section: id(2) })).toEqual([{ op: 'move', occurrence: id(12), parent: id(2), position: 'last' }]);
  expect(plan(state, { kind: 'moveLineTo', occurrence: id(12), section: id(1) })).toEqual({ kind: 'moot' });
  const operations = changes({ kind: 'addStep', text: ' Fold. ', language: 'en', uses: [id(12), id(555)] });
  expect(operations[0]).toMatchObject({ role: 'step', qualifier: { instructionText: { value: 'Fold.' }, usesIngredient: [id(12)] } });
  expect(changes({ kind: 'editStep', occurrence: id(3), text: 'Cream butter and sugar.', uses: [id(11), id(21)] })).toEqual([
    { op: 'update', occurrence: id(3), qualifier: step('Cream butter and sugar.', [id(11), id(21)]) }]);
});

test('yield keeps the stored one required, and only changed timings are written', () => {
  const yielded = plan(state, { kind: 'yield', yield: { value: { numerator: 12, denominator: 1 }, unitText: 'muffins' },
    servings: { numerator: 6, denominator: 1 }, servingsWord: 'servings' });
  expect(yielded).toEqual({ kind: 'yield', body: { yield: { value: { numerator: 12, denominator: 1 }, unitText: 'muffins', coverage: 'complete', provenance: 'declared' },
    servings: { value: { numerator: 6, denominator: 1 }, coverage: 'complete', provenance: 'declared' } } });
  const stored = applyPlan(state, yielded, id(902), []);
  expect(plan(stored, { kind: 'yield', yield: { value: { numerator: 12, denominator: 1 }, unitText: 'muffins' },
    servings: { numerator: 6, denominator: 1 }, servingsWord: 'servings' })).toEqual({ kind: 'moot' });
  expect(plan(stored, { kind: 'yield', yield: null, servings: null, servingsWord: 'servings' })).toEqual({ kind: 'invalid', reason: 'yield-required' });
  // Servings alone is the yield, in the editor's word for servings.
  expect(plan(state, { kind: 'yield', yield: null, servings: { numerator: 4, denominator: 1 }, servingsWord: 'servings' }))
    .toMatchObject({ kind: 'yield', body: { yield: { unitText: 'servings', value: { numerator: 4, denominator: 1 } } } });
  const timed = plan(stored, { kind: 'timings', times: { preparation: 20, cooking: 45, total: undefined } });
  expect(timed).toMatchObject({ kind: 'timings', body: { preparation: { value: { numerator: 20, denominator: 1 }, unitText: 'min' }, cooking: { unitText: 'min' } } });
  const withTimes = applyPlan(stored, timed, id(903), []);
  expect(withTimes.measures.map(item => item.kind).sort()).toEqual(['cooking-duration', 'preparation-duration', 'servings', 'yield']);
  expect(plan(withTimes, { kind: 'timings', times: { preparation: 20, cooking: 50 } })).toMatchObject({ kind: 'timings', body: { cooking: { value: { numerator: 50 } } } });
  expect(plan(withTimes, { kind: 'timings', times: { preparation: 20 } })).toEqual({ kind: 'moot' });
  expect(plan(withTimes, { kind: 'timings', times: { cooking: null } })).toEqual({ kind: 'timings', body: { cooking: null } });
  expect(plan(withTimes, { kind: 'timings', times: { total: null } })).toEqual({ kind: 'moot' });
});
