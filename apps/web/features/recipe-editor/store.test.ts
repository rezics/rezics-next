import { expect, test } from 'bun:test';
import { actingSubject, fakeMain, id, mainVersion, startRecipe, work } from './fixtures.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { createRecipeStore } from './store.ts';

const line = (text: string) => qualifierOf(parseLine(text), 'en');
const open = () => {
  const fake = fakeMain({ recipe: startRecipe });
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: startRecipe, main: fake.main });
  return { fake, store };
};
const gate = () => { let release: () => void = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); return { held, release }; };
const texts = (calls: { name: string; body?: unknown }[]) => calls.filter(call => call.name === 'changes').map(call =>
  ((call.body as { operations: { qualifier?: { originalText: { value: string } } }[] }).operations[0]!.qualifier!.originalText.value));

test('a write goes out at the head held and the answer updates the editor without another read', async () => {
  const { fake, store } = open();
  expect(await store.submit({ kind: 'addLine', section: id(11), qualifier: line('1½ cups milk') })).toEqual({ kind: 'saved' });
  expect(fake.calls.map(call => call.name)).toEqual(['changes']);
  expect((fake.calls[0]!.body as { expectedHead: string }).expectedHead).toBe(id(900));
  expect(store.snapshot().state.nodes.filter(node => node.role === 'ingredient')).toHaveLength(4);
  expect(store.snapshot().state.head).not.toBe(id(900));
  expect(store.snapshot().busy).toBe(false);
});

test('a refused head reads Main again and writes the intent over what is there now', async () => {
  const { fake, store } = open();
  let once = true;
  fake.interference.before = call => {
    if (call.name === 'changes' && once) { once = false; fake.elsewhere(state => ({ ...state, nodes: [...state.nodes,
      { occurrence: id(50), parent: id(11), role: 'ingredient', qualifier: line('2 eggs') }] })); }
  };
  expect(await store.submit({ kind: 'addLine', section: id(11), qualifier: line('1 cup milk') })).toEqual({ kind: 'saved' });
  expect(fake.calls.filter(call => call.name === 'changes')).toHaveLength(2);
  expect(new Set(fake.calls.map(call => call.key)).size).toBe(2);
  const lines = store.snapshot().state.nodes.filter(node => node.role === 'ingredient').map(node => node.occurrence);
  expect(lines).toContain(id(50));
  expect(lines).toHaveLength(5);
});

test('an intent about something another tab removed is refused as gone, not written', async () => {
  const { fake, store } = open();
  fake.interference.before = call => {
    if (call.name === 'changes') fake.elsewhere(state => ({ ...state, nodes: state.nodes.filter(node => node.occurrence !== id(23)) }));
  };
  expect(await store.submit({ kind: 'editLine', occurrence: id(23), qualifier: line('120 g butter') })).toEqual({ kind: 'refused', refusal: { kind: 'gone' } });
  expect(fake.calls.filter(call => call.name === 'changes')).toHaveLength(1);
  expect(store.snapshot().failure?.refusal).toEqual({ kind: 'gone' });
});

test('a refused write is worked out again for the record\'s newest intent only, never the stale one', async () => {
  const { fake, store } = open();
  const hold = gate();
  fake.interference.gates = { changes: hold.held };
  const first = store.submit({ kind: 'editLine', occurrence: id(21), qualifier: line('2 cups butter') });
  const second = store.submit({ kind: 'editLine', occurrence: id(21), qualifier: line('3 cups butter') });
  const third = store.submit({ kind: 'editLine', occurrence: id(21), qualifier: line('4 cups butter') });
  // The head moves under the write in flight, so it is refused when it is let go.
  fake.elsewhere(state => state);
  hold.release();
  expect(await Promise.all([first, second, third])).toEqual([{ kind: 'saved' }, { kind: 'saved' }, { kind: 'saved' }]);
  // The first attempt was the conflicted "2 cups"; what was written over Main's new head is "4 cups" alone.
  expect(texts(fake.calls)).toEqual(['2 cups butter', '4 cups butter']);
  const written = store.snapshot().state.nodes.find(node => node.occurrence === id(21));
  expect(written).toMatchObject({ qualifier: { originalText: { value: '4 cups butter' } } });
});

test('a record\'s second edit while one is in flight takes the newest slot and the one in flight is written first', async () => {
  const { fake, store } = open();
  const hold = gate();
  fake.interference.gates = { changes: hold.held };
  const first = store.submit({ kind: 'editLine', occurrence: id(21), qualifier: line('2 cups butter') });
  const second = store.submit({ kind: 'editLine', occurrence: id(21), qualifier: line('3 cups butter') });
  const third = store.submit({ kind: 'editLine', occurrence: id(21), qualifier: line('4 cups butter') });
  hold.release();
  await Promise.all([first, second, third]);
  expect(texts(fake.calls)).toEqual(['2 cups butter', '4 cups butter']);
});

test('different records write independently: none waits for another and nothing drains a backlog', async () => {
  const { fake, store } = open();
  const hold = gate();
  // The section rename is held in flight; the timings are not.
  fake.interference.gates = { changes: hold.held };
  const rename = store.submit({ kind: 'renameSection', occurrence: id(11), label: 'Batter', language: 'en' });
  const prep = store.submit({ kind: 'timings', times: { preparation: 15 } });
  const cook = store.submit({ kind: 'timings', times: { cooking: 25 } });
  expect(await Promise.all([prep, cook])).toEqual([{ kind: 'saved' }, { kind: 'saved' }]);
  // Both timings were written while the rename was still in flight, each by its own lane. They race for one
  // head, so the loser of the race is written again (a third call), but never anything else.
  expect(fake.calls.filter(call => call.name === 'changes')).toHaveLength(1);
  expect(fake.calls.filter(call => call.name === 'timings').length).toBeGreaterThanOrEqual(2);
  expect(fake.calls.filter(call => call.name === 'timings').length).toBeLessThanOrEqual(3);
  expect(store.snapshot().busy).toBe(true);
  hold.release();
  expect(await rename).toEqual({ kind: 'saved' });
  expect(store.snapshot().busy).toBe(false);
  const state = store.snapshot().state;
  expect(state.measures.map(item => item.kind)).toEqual(expect.arrayContaining(['preparation-duration', 'cooking-duration']));
  expect(state.nodes.find(node => node.occurrence === id(11))).toMatchObject({ label: { value: 'Batter' } });
});

test('adds are records of their own: concurrent adds are all written, none refused as busy', async () => {
  const { fake, store } = open();
  const hold = gate();
  fake.interference.gates = { changes: hold.held };
  const results = [store.submit({ kind: 'addSection', label: 'Glaze', language: 'en' }),
    store.submit({ kind: 'addSection', label: 'Crumb', language: 'en' }),
    store.submit({ kind: 'addStep', text: 'Serve.', language: 'en', uses: [] })];
  hold.release();
  expect(await Promise.all(results)).toEqual([{ kind: 'saved' }, { kind: 'saved' }, { kind: 'saved' }]);
  const nodes = store.snapshot().state.nodes;
  expect(nodes.filter(node => node.role === 'group')).toHaveLength(4);
  expect(nodes.filter(node => node.role === 'step')).toHaveLength(2);
});

test('a form that adds something waits for the writes in flight instead of dropping its turn', async () => {
  const { fake, store } = open();
  const hold = gate();
  fake.interference.gates = { changes: hold.held };
  const first = store.submit({ kind: 'addSection', label: 'Glaze', language: 'en' });
  let idle = false;
  const waited = store.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  expect(idle).toBe(false);
  hold.release();
  await first; await waited;
  expect(idle).toBe(true);
  expect(await store.submit({ kind: 'addSection', label: 'Crumb', language: 'en' })).toEqual({ kind: 'saved' });
});
