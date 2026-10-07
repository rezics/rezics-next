import { expect, test } from 'bun:test';
import { actingSubject, detailsValues, fakeMain, id, mainVersion, noNotes, startRecipe, work } from './fixtures.ts';
import { createDetailsSaver, createNotesWriter, entryOf, latestLane } from './saves.ts';

test('a title saved over a head that moved is read again and written over what Main holds', async () => {
  const fake = fakeMain({ recipe: startRecipe, metadataHead: id(701) });
  // This editor opened on the head before the latest one.
  const saver = createDetailsSaver({ main: fake.main, actingSubject, work, language: 'en',
    initial: { head: id(700), values: detailsValues } });
  const outcome = await saver.submit({ title: 'Lemon poppy muffins', description: 'Bright and tender.' });
  expect(outcome).toEqual({ kind: 'saved' });
  expect(fake.calls.filter(call => call.name === 'details')).toHaveLength(2);
  expect(saver.snapshot().head).not.toBe(id(700));
  expect(entryOf(saver.snapshot().values, 'en').title).toBe('Lemon poppy muffins');
  expect(fake.world().metadata.values.entries[0]!.title).toBe('Lemon poppy muffins');
  // The same text again changes nothing and writes nothing.
  expect(await saver.submit({ title: 'Lemon poppy muffins', description: 'Bright and tender.' })).toEqual({ kind: 'unchanged' });
  expect(fake.calls.filter(call => call.name === 'details')).toHaveLength(2);
});

test('notes are created on the first save, edited after, and published in order with the newest text', async () => {
  const fake = fakeMain({ recipe: startRecipe });
  const writer = createNotesWriter({ main: fake.main, actingSubject, work, mainVersion, language: 'en', initial: noNotes });
  expect(await writer.save('   ')).toEqual({ kind: 'unchanged' });
  expect(await writer.save('Best the day after.')).toEqual({ kind: 'saved' });
  const first = writer.publish('Best the day after baking.');
  expect(await first).toEqual({ kind: 'published' });
  expect(fake.calls.map(call => call.name)).toEqual(['notes-create', 'notes-edit', 'publish', 'select']);
  expect(writer.snapshot().published).toBe(true);
  expect(writer.snapshot().notes.body).toBe('Best the day after baking.');
  // Blanking a saved note is refused rather than sent.
  expect(await writer.save('')).toEqual({ kind: 'refused', refusal: 'empty' });
});

test('a value submitted while one is written replaces the one waiting and shares its outcome', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const lane = latestLane(async (value: string) => { seen.push(value); await gate; return value; }, 'failed', () => {});
  const a = lane.submit('a');
  const b = lane.submit('b');
  const c = lane.submit('c');
  release();
  expect(await Promise.all([a, b, c])).toEqual(['a', 'c', 'c']);
  expect(seen).toEqual(['a', 'c']);
});

const gate = () => { let release: () => void = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); return { held, release }; };
const names = (calls: { name: string }[]) => calls.map(call => call.name);

test('a refused title is worked out again for the newest title and description, never the stale one', async () => {
  const fake = fakeMain({ recipe: startRecipe, metadataHead: id(701) });
  const hold = gate();
  fake.interference.gates = { details: hold.held };
  const saver = createDetailsSaver({ main: fake.main, actingSubject, work, language: 'en', initial: { head: id(700), values: detailsValues } });
  const first = saver.submit({ title: 'Title A', description: 'x' });
  const second = saver.submit({ title: 'Title B', description: 'x' });
  const third = saver.submit({ title: 'Title C', description: 'x' });
  hold.release();
  expect(await Promise.all([first, second, third])).toEqual([{ kind: 'saved' }, { kind: 'saved' }, { kind: 'saved' }]);
  const titles = fake.calls.filter(call => call.name === 'details').map(call =>
    (call.body as { state: { localized: { title: string }[] } }).state.localized[0]!.title);
  // The first attempt conflicted on its stale head; what was written over Main's head is the newest title alone.
  expect(titles).toEqual(['Title A', 'Title C']);
  expect(fake.world().metadata.values.entries[0]!.title).toBe('Title C');
});

test('a refused notes save is worked out again for the newest body, never the stale one', async () => {
  const fake = fakeMain({ recipe: startRecipe, notes: { text: id(300), head: id(1500), body: 'old', publicationHead: null } });
  // Another tab saved first: the head this writer holds is behind.
  const hold = gate();
  fake.interference.gates = { 'notes-edit': hold.held };
  const writer = createNotesWriter({ main: fake.main, actingSubject, work, mainVersion, language: 'en',
    initial: { text: id(300), head: id(1400), body: 'old', publicationHead: null } });
  const first = writer.save('first');
  const second = writer.save('second');
  const third = writer.save('third');
  hold.release();
  await Promise.all([first, second, third]);
  const bodies = fake.calls.filter(call => call.name === 'notes-edit').map(call => (call.body as { body: string }).body);
  expect(bodies).toEqual(['first', 'third']);
  expect(fake.world().notes.body).toBe('third');
});

test('publication runs in the notes lane: it waits for saves in flight and for the newest slot, and joins it', async () => {
  const fake = fakeMain({ recipe: startRecipe });
  const hold = gate();
  fake.interference.gates = { 'notes-create': hold.held };
  const writer = createNotesWriter({ main: fake.main, actingSubject, work, mainVersion, language: 'en', initial: noNotes });
  const saving = writer.save('First draft.');
  const slot = writer.save('Second draft.');
  const publishing = writer.publish('Final text.');
  // Nothing but the save in flight has gone out: the publication waits behind it.
  expect(names(fake.calls)).toEqual(['notes-create']);
  hold.release();
  expect(await publishing).toEqual({ kind: 'published' });
  await Promise.all([saving, slot]);
  // The slot's save and the publication are one task over the newest text, in order.
  expect(names(fake.calls)).toEqual(['notes-create', 'notes-edit', 'publish', 'select']);
  expect((fake.calls[1]!.body as { body: string }).body).toBe('Final text.');
  expect(writer.snapshot().published).toBe(true);
});

test('while publishing, a field save waits in the newest slot and publication never restores an older body', async () => {
  const fake = fakeMain({ recipe: startRecipe });
  const hold = gate();
  fake.interference.gates = { publish: hold.held };
  const writer = createNotesWriter({ main: fake.main, actingSubject, work, mainVersion, language: 'en', initial: noNotes });
  const publishing = writer.publish('Published text.');
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(names(fake.calls)).toEqual(['notes-create', 'publish']);
  expect(writer.snapshot().publishing).toBe(true);
  // A blur during publication: it waits, and a newer one overwrites it.
  const early = writer.save('Edit one.');
  const late = writer.save('Edit two.');
  expect(names(fake.calls)).toEqual(['notes-create', 'publish']);
  hold.release();
  expect(await publishing).toEqual({ kind: 'published' });
  expect(await Promise.all([early, late])).toEqual([{ kind: 'saved' }, { kind: 'saved' }]);
  expect(names(fake.calls)).toEqual(['notes-create', 'publish', 'select', 'notes-edit']);
  expect((fake.calls[3]!.body as { body: string }).body).toBe('Edit two.');
  expect(fake.world().notes.body).toBe('Edit two.');
  expect(writer.snapshot().notes.publicationHead).not.toBeNull();
});
