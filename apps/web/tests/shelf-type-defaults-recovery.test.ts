import { expect, mock, test } from 'bun:test';
import type { PreferenceChange, ReadingPreferences } from '../src/settings/preferences';

const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('a type command keeps its payload and key through unknown readback; clean sibling changes survive recovery', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const book = 'schema:Book',
    movie = 'schema:Movie';
  let version = 1;
  let current = true;
  let saves = 0;
  const commands: Readonly<PreferenceChange>[] = [];
  const initial: ReadingPreferences = {
    spoilerLevel: 1,
    suitability: 'show',
    version,
    shelf: { layouts: { all: 'list', [book]: 'grid', [movie]: 'table' }, gridSize: 'large' },
  };
  const receipt: ReadingPreferences = {
    ...initial,
    version: 2,
    shelf: { ...initial.shelf, layouts: { all: 'list', [movie]: 'table' } },
  };
  let readback = initial;
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      save: async (input) => {
        commands.push(input);
        return ++saves === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt };
      },
      read: async () => ({ signedIn: true, preferences: readback, securityHref: null }),
    },
    {
      canRead: () => current,
      canWrite: () => current,
      version: () => version,
      onVersionChange: (next) => {
        version = next;
      },
    },
  );
  draft.editTypeLayout(book, undefined);
  await draft.submit();
  expect(draft.snapshot().phase).toBe('uncertain');
  draft.editTypeLayout(movie, 'list');
  await draft.retry();
  expect(draft.snapshot().phase).toBe('uncertain'); // Stale readback is never a confirmed save.
  expect(commands[1]).toBe(commands[0]);
  expect(commands[0]?.shelf).toEqual({ layouts: { [book]: null } });
  readback = { ...receipt, version: 3, shelf: { ...receipt.shelf, gridSize: 'small' } };
  await draft.retry();
  expect(commands[2]).toBe(commands[0]);
  expect(draft.snapshot().phase).toBe('review');
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(draft.snapshot().draft.layouts[movie]).toBe('list');
  expect(draft.snapshot().draft.layouts[book]).toBeUndefined();
  expect(version).toBe(3);
  current = false;
  await draft.submit();
  expect(commands).toHaveLength(3);
});

test('the native merged map bound includes preserved scopes, while removing one scope releases capacity', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const layouts = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`schema:Type${index}`, 'grid' as const]),
  );
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    { spoilerLevel: 0, suitability: 'blur', version: 0, shelf: { layouts } },
    {
      read: async () => ({ signedIn: false }),
      save: async (input) => {
        commands.push(input);
        return { ok: false, reason: 'unavailable' };
      },
    },
    { canRead: () => true, canWrite: () => true, version: () => 0, onVersionChange() {} },
  );
  draft.editTypeLayout('schema:Extra', 'table');
  await draft.submit();
  expect(commands).toHaveLength(0);
  draft.editTypeLayout('schema:Type0', undefined);
  await draft.submit();
  expect(commands[0]?.shelf).toEqual({ layouts: { 'schema:Extra': 'table', 'schema:Type0': null } });
});
