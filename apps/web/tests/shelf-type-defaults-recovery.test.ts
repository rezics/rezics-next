import { expect, mock, test } from 'bun:test';
import { withShelfAdvice, type PreferenceChange, type ReadingPreferences } from '../src/settings/preferences';

const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('a type command keeps its payload and key through unknown readback; clean sibling changes survive recovery', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const { SettingsNavigationDrafts } = await import('../src/settings/reading-navigation');
  const book = 'schema:Book',
    movie = 'schema:Movie';
  let version = 1;
  let current = true;
  let saves = 0;
  const commands: Readonly<PreferenceChange>[] = [];
  const initial: ReadingPreferences = withShelfAdvice({
    spoilerLevel: 1,
    suitability: 'show',
    version,
    shelf: { layouts: { all: 'list', [book]: 'grid', [movie]: 'table' }, gridSize: 'large' },
  });
  const receipt: ReadingPreferences = withShelfAdvice({
    spoilerLevel: 1,
    suitability: 'show',
    version: 2,
    shelf: { ...initial.shelf, layouts: { all: 'list', [movie]: 'table' } },
  });
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
  draft.edit({ layout: 'list' }, 'layout');
  expect(draft.needsNavigationDecision()).toBe(false);
  draft.editTypeLayout(book, undefined);
  await draft.submit();
  expect(draft.snapshot().phase).toBe('uncertain');
  draft.editTypeLayout(book, 'grid');
  expect(draft.needsNavigationDecision()).toBe(true); // The exact original removal stays protected.
  const navigation = new SettingsNavigationDrafts();
  const removeShelf = navigation.register({ kind: 'shelf', needsDecision: draft.needsNavigationDecision });
  expect([...navigation.kinds()]).toEqual(['shelf']);
  const leaving = navigation.block('/settings', '/library');
  expect(navigation.block('/settings', '/settings')).toBe(false); // Section hashes keep the retained panel mounted.
  const removeReading = navigation.register({ kind: 'reading', needsDecision: () => true });
  expect([...navigation.kinds()]).toEqual(['shelf', 'reading']);
  expect(navigation.block('/settings', '/inbox')).toBe(true);
  const retained = draft.snapshot();
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(draft.snapshot()).toBe(retained);
  const abandoned = navigation.block('/settings', '/library');
  navigation.leave();
  expect(await abandoned).toBe(false);
  expect(draft.snapshot()).toBe(retained);
  removeReading();
  removeShelf();
  draft.editTypeLayout(book, undefined);
  draft.editTypeLayout(movie, 'list');
  await draft.retry();
  expect(draft.snapshot().phase).toBe('uncertain'); // Stale readback is never a confirmed save.
  expect(commands[1]).toBe(commands[0]);
  expect(commands[0]?.shelf).toEqual({ layouts: { [book]: null } });
  readback = withShelfAdvice({
    spoilerLevel: 1,
    suitability: 'show',
    version: 3,
    shelf: { ...receipt.shelf, layouts: { ...receipt.shelf?.layouts, [book]: 'table' }, gridSize: 'small' },
  });
  await draft.retry();
  expect(commands[2]).toBe(commands[0]);
  expect(draft.snapshot().phase).toBe('review');
  expect(draft.snapshot().comparison?.input).toBe(commands[0]);
  expect(Object.isFrozen(commands[0])).toBe(true);
  expect(Object.isFrozen(commands[0]?.shelf)).toBe(true);
  expect(draft.snapshot().pending).toBeNull();
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(draft.snapshot().draft.layouts[movie]).toBe('list');
  expect(draft.snapshot().draft.layouts[book]).toBe('table');
  expect(version).toBe(3);
  await draft.submit();
  expect(commands[3]?.shelf).toEqual({ layouts: { [movie]: 'list' } });
  expect(commands[3]?.idempotencyKey).not.toBe(commands[0]?.idempotencyKey);
  current = false;
  await draft.submit();
  expect(commands).toHaveLength(4);
});

test('a pending reset is retained for navigation and a retired owner cannot accept its late completion', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const { SettingsNavigationDrafts } = await import('../src/settings/reading-navigation');
  let current = true;
  let finish = () => {};
  const initial = withShelfAdvice({ spoilerLevel: 0, suitability: 'blur', version: 4, shelf: { gridSize: 'large' } });
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      read: async () => ({ signedIn: false }),
      save: async () => {
        await new Promise<void>((resolve) => (finish = resolve));
        return { ok: true as const, preferences: withShelfAdvice({ ...initial, version: 5, shelf: {} }) };
      },
    },
    { canRead: () => current, canWrite: () => current, version: () => 4, onVersionChange() {} },
  );
  const navigation = new SettingsNavigationDrafts();
  navigation.register({ kind: 'shelf', needsDecision: () => current && draft.needsNavigationDecision() });
  const saving = draft.submit(true);
  expect(draft.snapshot().pending?.input.shelf).toBeNull();
  expect(navigation.needsDecision()).toBe(true);
  const retained = draft.snapshot();
  current = false;
  navigation.refresh();
  finish();
  await saving;
  expect(draft.snapshot()).toBe(retained);
  expect(navigation.needsDecision()).toBe(false);
});

test('the native merged map bound includes preserved scopes, while removing one scope releases capacity', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const layouts = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`schema:Type${index}`, 'grid' as const]),
  );
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    withShelfAdvice({ spoilerLevel: 0, suitability: 'blur', version: 0, shelf: { layouts } }),
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
