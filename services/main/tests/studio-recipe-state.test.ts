import { expect, test } from 'bun:test';
import { studioWorkState } from '../src/modules/studio/works.ts';

test('an original recipe starts, imports and publishes independently of optional notes', () => {
  expect(studioWorkState([], { started: false, published: false })).toBe('empty');
  expect(studioWorkState([], { started: true, published: false })).toBe('draft');
  expect(studioWorkState([], { started: true, published: true })).toBe('published');
  expect(studioWorkState([], { started: true, published: false })).toBe('draft');
});

test('notes publication cannot label an unpinned recipe as published', () => {
  expect(studioWorkState([{ publicationHead: 'notes-publication' }], { started: true, published: false })).toBe('draft');
  // A later private draft does not unpublish the older, still pinned public revision.
  expect(studioWorkState([{ publicationHead: null }], { started: true, published: true })).toBe('published');
});

test('other Work kinds retain their text-authoring states', () => {
  expect(studioWorkState([])).toBe('empty');
  expect(studioWorkState([{ publicationHead: null }])).toBe('draft');
  expect(studioWorkState([{ publicationHead: 'public-text' }])).toBe('published');
});
