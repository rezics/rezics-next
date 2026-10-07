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
  expect(await Promise.all([a, b, c])).toEqual(['c', 'c', 'c']);
  expect(seen).toEqual(['a', 'c']);
});
