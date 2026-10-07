import { expect, test } from 'bun:test';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import type { RecipeState } from './model.ts';
import { createRecipeStore } from './store.ts';
import { actingSubject, fakeMain as createFixture, id as id2, mainVersion, startRecipe as fixtureStart, work } from './fixtures.ts';
import type { MainClient } from '../studio/types.ts';

const S = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (text: string) => qualifierOf(parseLine(text), 'en');

/** A stand-in Main that holds one recipe and answers like Main: CAS on the head, 409 when it moved. */
function fakeMain(start: RecipeState & { structure: string; head: string }, hooks: { beforeWrite?: (calls: number) => void } = {}) {
  let head = start.head;
  let nodes = [...start.nodes];
  const calls: { key: string; expectedHead: string; operations: unknown[] }[] = [];
  let revisions = 1000;
  const page = () => ({ structure: S, revision: head, measures: [], occurrences: nodes.map(node => ({ ...node, state: 'active',
    labels: node.role === 'group' && node.label ? [node.label] : [] })) });
  const main = { v1: {
    recipes: { works: () => ({ get: async () => ({ data: page(), error: null }) }) },
    compositions: Object.assign(() => ({ changes: { post: async (body: { expectedHead: string; operations: { op: string; parent?: string; qualifier?: unknown; role?: string; occurrence?: string }[] },
      options: { headers: { 'idempotency-key': string } }) => {
      calls.push({ key: options.headers['idempotency-key'], expectedHead: body.expectedHead, operations: body.operations });
      hooks.beforeWrite?.(calls.length);
      if (body.expectedHead !== head) return { data: null, error: { status: 409, value: { code: 'stale_composition_head' } } };
      const created: string[] = [];
      for (const operation of body.operations) {
        if (operation.op === 'insert') {
          const occurrence = id(revisions++);
          created.push(occurrence);
          nodes.push({ occurrence, parent: operation.parent!, role: operation.role, qualifier: operation.qualifier } as never);
        }
      }
      head = id(revisions++);
      return { data: { structure: S, revision: head, occurrences: created, receipt: 'r', replayed: false }, error: null };
    } } }), { post: async () => ({ data: { structure: S, revision: head }, error: null }) }),
  } } as unknown as MainClient;
  return { main, calls, move: () => { head = id(revisions++); }, insertElsewhere: (node: never) => { nodes.push(node); head = id(revisions++); } };
}

const start: RecipeState & { structure: string; head: string } = { structure: S, head: id(900), measures: [], nodes: [
  { occurrence: id(1), parent: S, role: 'group', label: { value: 'Cake', language: 'en' } }] };

test('a write goes out at the head held and the answer updates the editor without another read', async () => {
  const fake = fakeMain(start);
  const store = createRecipeStore({ work: id(5), mainVersion: id(6), actingSubject: id(7), initial: start, main: () => fake.main });
  const outcome = await store.submit({ kind: 'addLine', section: id(1), qualifier: line('1½ cups flour') });
  expect(outcome).toEqual({ kind: 'saved' });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.expectedHead).toBe(id(900));
  expect(store.snapshot().state.nodes.filter(node => node.role === 'ingredient')).toHaveLength(1);
  expect(store.snapshot().state.head).not.toBe(id(900));
  expect(store.snapshot().busy).toBe(false);
});

test('a refused head reads Main again and writes only the newest intent over what is there now', async () => {
  const fake = fakeMain(start, { beforeWrite: calls => { if (calls === 1) fake.insertElsewhere({ occurrence: id(50), parent: id(1), role: 'ingredient', qualifier: line('2 eggs') } as never); } });
  const store = createRecipeStore({ work: id(5), mainVersion: id(6), actingSubject: id(7), initial: start, main: () => fake.main });
  expect(await store.submit({ kind: 'addLine', section: id(1), qualifier: line('1 cup milk') })).toEqual({ kind: 'saved' });
  // The first attempt was refused, the second used the head Main now holds.
  expect(fake.calls.map(call => call.expectedHead === id(900))).toEqual([true, false]);
  expect(new Set(fake.calls.map(call => call.key)).size).toBe(2);
  expect(store.snapshot().state.nodes.filter(node => node.role === 'ingredient').map(node => node.occurrence).includes(id(50))).toBe(true);
  expect(store.snapshot().state.nodes.filter(node => node.role === 'ingredient')).toHaveLength(2);
});

test('an intent about something another tab removed is refused as gone, not written', async () => {
  const fake = fakeMain(start, { beforeWrite: () => fake.move() });
  const initial: RecipeState = { ...start, nodes: [...start.nodes, { occurrence: id(60), parent: id(1), role: 'ingredient', qualifier: line('1 cup milk') }] };
  const store = createRecipeStore({ work: id(5), mainVersion: id(6), actingSubject: id(7), initial, main: () => fake.main });
  const outcome = await store.submit({ kind: 'editLine', occurrence: id(60), qualifier: line('2 cups milk') });
  expect(outcome).toEqual({ kind: 'refused', refusal: { kind: 'gone' } });
  expect(fake.calls).toHaveLength(1);
  expect(store.snapshot().failure?.refusal).toEqual({ kind: 'gone' });
});

test('one write at a time: an add waits for the person, an edit of the record being written replaces the waiting one', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = fakeMain(start);
  const slow = { v1: { ...fake.main.v1, compositions: Object.assign(() => ({ changes: { post: async (...args: unknown[]) => {
    await gate;
    return (fake.main.v1.compositions(undefined as never) as never as { changes: { post: (...a: unknown[]) => Promise<unknown> } }).changes.post(...args);
  } } }), { post: fake.main.v1.compositions.post }) } } as unknown as MainClient;
  const initial: RecipeState = { ...start, nodes: [...start.nodes, { occurrence: id(60), parent: id(1), role: 'ingredient', qualifier: line('1 cup milk') }] };
  const store = createRecipeStore({ work: id(5), mainVersion: id(6), actingSubject: id(7), initial, main: () => slow });
  const first = store.submit({ kind: 'editLine', occurrence: id(60), qualifier: line('2 cups milk') });
  expect(store.snapshot().busy).toBe(true);
  expect(await store.submit({ kind: 'addStep', text: 'Stir', language: 'en', uses: [] })).toEqual({ kind: 'busy' });
  const second = store.submit({ kind: 'editLine', occurrence: id(60), qualifier: line('3 cups milk') });
  const third = store.submit({ kind: 'editLine', occurrence: id(60), qualifier: line('4 cups milk') });
  release();
  expect(await Promise.all([first, second, third])).toEqual([{ kind: 'saved' }, { kind: 'saved' }, { kind: 'saved' }]);
  // The edit in flight was written, then only the newest of the two that waited.
  expect(fake.calls.map(call => (call.operations[0] as { qualifier: { originalText: { value: string } } }).qualifier.originalText.value))
    .toEqual(['2 cups milk', '4 cups milk']);
});

test('edits of different records made while one is written are each written, the newest per record', async () => {
  let release: () => void = () => {};
  const fake = createFixture({ recipe: { ...fixtureStart, nodes: [...fixtureStart.nodes] } });
  fake.interference.gate = new Promise<void>(resolve => { release = resolve; });
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: fixtureStart, main: fake.main });
  const rename = store.submit({ kind: 'renameSection', occurrence: id2(11), label: 'Batter', language: 'en' });
  const prep = store.submit({ kind: 'timings', times: { preparation: 15 } });
  const cook = store.submit({ kind: 'timings', times: { cooking: 25 } });
  const lost = store.submit({ kind: 'timings', times: { cooking: 30 } });
  release();
  expect(await Promise.all([rename, prep, cook, lost])).toEqual([{ kind: 'saved' }, { kind: 'saved' }, { kind: 'saved' }, { kind: 'saved' }]);
  expect(fake.calls.map(call => call.name)).toEqual(['changes', 'timings', 'timings']);
  const cooked = store.snapshot().state.measures.find(item => item.kind === 'cooking-duration');
  expect(cooked?.value.numerator).toBe(30);
  expect(store.snapshot().state.nodes.find(node => node.occurrence === id2(11))).toMatchObject({ label: { value: 'Batter' } });
});
