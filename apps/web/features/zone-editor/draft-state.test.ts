import { expect, test } from 'bun:test';
import { createZoneEditorDraftStore, readZoneEditorDraft, zoneEditorDraftKey, type DraftStorage } from './draft-state.ts';

interface Draft {
  title: string;
  body: string;
  savedBody: string;
  expectedHead: string;
}

const opening: Draft = { title: 'Saved title', body: 'Saved body', savedBody: 'Saved body', expectedHead: 'saved-head' };
const edited: Draft = { ...opening, title: 'Unsaved title', body: 'Unsaved body' };
const key = zoneEditorDraftKey('harbor', 'author', 'home');

function accepts(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<Draft>;
  return typeof draft.title === 'string' && typeof draft.body === 'string'
    && typeof draft.savedBody === 'string' && typeof draft.expectedHead === 'string';
}

function memoryStorage(): DraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

test('the mounted route retains title and body when session storage cannot be accessed', () => {
  const drafts = createZoneEditorDraftStore();
  drafts.write(undefined, key, edited, true);
  expect(drafts.read(undefined, key, accepts)).toEqual(edited);
});

test('a quota failure restores the latest title and body instead of an older stored draft', () => {
  const storage = memoryStorage();
  storage.setItem(key, JSON.stringify(opening));
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const drafts = createZoneEditorDraftStore();
  expect(drafts.read(storage, key, accepts)).toEqual(opening);
  drafts.write(storage, key, edited, true);
  expect(drafts.read(storage, key, accepts)).toEqual(edited);
  expect(readZoneEditorDraft(storage, key, accepts)).toEqual(opening);
});

test('storage read and write failures leave an in-memory section draft available', () => {
  const fail = () => { throw new Error('SecurityError'); };
  const storage: DraftStorage = { getItem: fail, setItem: fail, removeItem: fail };
  const drafts = createZoneEditorDraftStore();
  expect(drafts.read(storage, key, accepts)).toBeNull();
  drafts.write(storage, key, edited, true);
  expect(drafts.read(storage, key, accepts)).toEqual(edited);
});

test('section drafts stay isolated by Zone, acting subject and section', () => {
  const drafts = createZoneEditorDraftStore();
  drafts.write(undefined, key, edited, true);
  for (const other of [
    zoneEditorDraftKey('another-zone', 'author', 'home'),
    zoneEditorDraftKey('harbor', 'another-author', 'home'),
    zoneEditorDraftKey('harbor', 'author', 'navigation'),
    zoneEditorDraftKey('harbor', 'author', 'theme'),
  ]) expect(drafts.read(undefined, other, accepts)).toBeNull();
  expect(drafts.read(undefined, key, accepts)).toEqual(edited);
  expect(zoneEditorDraftKey('harbor:author', 'home', 'theme'))
    .not.toBe(zoneEditorDraftKey('harbor', 'author:home', 'theme'));
});

test('an acknowledged save cannot revive a stored draft when storage removal fails', () => {
  const storage = memoryStorage();
  storage.setItem(key, JSON.stringify(edited));
  storage.removeItem = () => { throw new Error('SecurityError'); };
  const drafts = createZoneEditorDraftStore();
  expect(drafts.read(storage, key, accepts)).toEqual(edited);
  drafts.write(storage, key, { ...edited, savedBody: edited.body, expectedHead: 'acknowledged-head' }, false);
  expect(drafts.read(storage, key, accepts)).toBeNull();
  expect(readZoneEditorDraft(storage, key, accepts)).toEqual(edited);
  const later = { ...edited, body: 'A later edit', savedBody: edited.body, expectedHead: 'acknowledged-head' };
  drafts.write(storage, key, later, true);
  expect(drafts.read(storage, key, accepts)).toEqual(later);
});

test('session storage restores drafts after the route provider has been replaced', () => {
  const storage = memoryStorage();
  createZoneEditorDraftStore().write(storage, key, edited, true);
  const restored = createZoneEditorDraftStore();
  expect(restored.read(storage, key, accepts)).toEqual(edited);
  restored.write(storage, key, opening, false);
  expect(createZoneEditorDraftStore().read(storage, key, accepts)).toBeNull();
});

test('a stored draft that does not match the section state is ignored', () => {
  const storage = memoryStorage();
  storage.setItem(key, JSON.stringify({ title: 'Incomplete' }));
  expect(createZoneEditorDraftStore().read(storage, key, accepts)).toBeNull();
});

test('command resources and acknowledged state survive a section unmount without crossing identity scope', () => {
  const drafts = createZoneEditorDraftStore();
  const lane = { captured: { body: 'Submitted text', expectedHead: 'head' }, key: 'original-key' };
  expect(drafts.resource(`${key}:command`, () => lane)).toBe(lane);
  drafts.retain(key, edited);
  let notifications = 0;
  const leave = drafts.subscribe(key, () => { notifications += 1; });
  leave();
  const acknowledged = { ...edited, savedBody: 'Submitted text', expectedHead: 'acknowledged-head' };
  drafts.retain(key, acknowledged);
  expect(notifications).toBe(0);
  expect(drafts.current<Draft>(key)).toEqual(acknowledged);
  expect(drafts.resource<typeof lane>(`${key}:command`, () => { throw new Error('new lane after remount'); })).toBe(lane);
  expect(drafts.current(zoneEditorDraftKey('harbor', 'another-author', 'home'))).toBeUndefined();
});
