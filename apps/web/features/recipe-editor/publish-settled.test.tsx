import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resourceHref } from '../address/path.ts';
import { actingSubject, detailsValues, fakeMain, id, mainVersion, noNotes, startRecipe, work } from './fixtures.ts';
import { copyOf } from './messages.ts';
import { PublishBar } from './publish.tsx';
import { publishWhenSettled } from './publish-settled.ts';
import { createDetailsSaver, createNotesWriter } from './saves.ts';
import { createRecipeStore } from './store.ts';

const gate = () => {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
};
const publishedNotes = { ...noNotes, text: id(300), head: id(301), body: 'Best the day after baking.', publicationHead: id(302) };

test('publish does not succeed while a cooking time is waiting behind preparation', async () => {
  const fake = fakeMain({ recipe: startRecipe, notes: { ...noNotes, body: 'Best the day after baking.' } });
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: startRecipe, main: fake.main });
  const details = createDetailsSaver({ main: fake.main, actingSubject, work, language: 'en',
    initial: { head: id(700), values: detailsValues } });
  const notes = createNotesWriter({ main: fake.main, actingSubject, work, mainVersion, language: 'en', initial: noNotes });
  const prep = gate();
  fake.interference.holds = { timings: [prep.held] };
  const preparation = store.submit({ kind: 'timings', times: { preparation: 18 } });
  const cooking = store.submit({ kind: 'timings', times: { cooking: 30 } });
  expect(fake.calls.filter(call => call.name === 'timings')).toHaveLength(1);
  let done = false;
  const publishing = publishWhenSettled({ recipe: store, details, notes, body: 'Best the day after baking.' })
    .then(outcome => { done = true; return outcome; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(done).toBe(false);
  expect(fake.calls.filter(call => call.name === 'publish')).toHaveLength(0);
  expect(store.snapshot().busy).toBe(true);
  prep.release();
  expect(await publishing).toEqual({ kind: 'published' });
  expect(fake.calls.filter(call => call.name === 'timings').map(call => call.body)).toMatchObject([
    { preparation: { value: { numerator: 18, denominator: 1 } } },
    { cooking: { value: { numerator: 30, denominator: 1 } } },
  ]);
  expect(store.snapshot().busy).toBe(false);
  expect(await preparation).toEqual({ kind: 'saved' });
  expect(await cooking).toEqual({ kind: 'saved' });
});

test('publish waits for a title save that is still in flight', async () => {
  const fake = fakeMain({ recipe: startRecipe });
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: startRecipe, main: fake.main });
  const details = createDetailsSaver({ main: fake.main, actingSubject, work, language: 'en',
    initial: { head: id(700), values: detailsValues } });
  const notes = createNotesWriter({ main: fake.main, actingSubject, work, mainVersion, language: 'en', initial: noNotes });
  const hold = gate();
  fake.interference.gates = { details: hold.held };
  const saving = details.submit({ title: 'Lemon poppy muffins', description: 'Bright and tender.' });
  let done = false;
  const publishing = publishWhenSettled({ recipe: store, details, notes, body: 'Best the day after baking.' })
    .then(outcome => { done = true; return outcome; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(done).toBe(false);
  expect(fake.calls.filter(call => call.name === 'publish')).toHaveLength(0);
  hold.release();
  expect(await publishing).toEqual({ kind: 'published' });
  expect(await saving).toEqual({ kind: 'saved' });
  const names = fake.calls.map(call => call.name);
  expect(names.indexOf('details')).toBeGreaterThanOrEqual(0);
  expect(names.indexOf('details')).toBeLessThan(names.indexOf('publish'));
});

test('leaving the editor waits while a write is still outstanding', () => {
  const source = readFileSync(new URL('./editor.tsx', import.meta.url), 'utf8');
  expect(source).toContain('publishWhenSettled');
  // Saving withholds the published link. An unread remainder does too: publishing waits for the whole recipe.
  expect(source).toContain('pending={saving || held}');
  expect(source).toContain('held={held}');
  expect(source).toContain('if (saving) event.preventDefault()');
  expect(source).toContain('written.published && !saving');
  expect(source).not.toMatch(/await notes\.publish\(/);
});

test('View recipe is withheld while a write is still outstanding', () => {
  const snapshot = { notes: publishedNotes, busy: false, publishing: false, failure: null, published: true };
  const missing = { title: false, ingredients: false, steps: false, notes: false };
  const workHref = resourceHref('/w/', work.slice(-36));
  const waiting = renderToStaticMarkup(createElement(PublishBar, {
    snapshot, missing, pending: true, onPublish() {}, workHref, t: copyOf('en'),
  }));
  expect(waiting).not.toContain('View recipe');
  expect(waiting).not.toContain('Published');
  const ready = renderToStaticMarkup(createElement(PublishBar, {
    snapshot, missing, pending: false, onPublish() {}, workHref, t: copyOf('en'),
  }));
  expect(ready).toContain('View recipe');
  expect(ready).toContain('Published');
});
