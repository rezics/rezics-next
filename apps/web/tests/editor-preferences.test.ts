import { expect, test } from 'bun:test';
import type { EditorPreferences } from '@rezics/editor/preferences';
import { EditorAccountPreferences } from '../src/editor/preference-state';
import { composeEditorPreferenceOverrides, LocalEditorPreferences } from '../src/editor/local-preferences';
import { withShelfAdvice, type PreferenceChange, type ReadingPreferences } from '../src/settings/preferences';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient';

function shown(version: number, editor: EditorPreferences = {}): ReadingPreferences {
  return {
    ...withShelfAdvice({ spoilerLevel: 0, suitability: 'blur', version, shelf: { gridSize: 'large' } }),
    editor,
  };
}

test('a JSONB receipt with reordered editor fields and nested bindings confirms the original save', async () => {
  const controller = new EditorAccountPreferences(
    {
      read: async () => {
        throw new Error('unexpected read');
      },
      save: async () => ({
        ok: true,
        preferences: shown(1, {
          keyboardBindings: { italic: '', bold: 'Mod-Shift-j' },
          textSize: 20,
          lineSpacing: 1.8,
        }),
      }),
    },
    {
      current: () => true,
      version: () => 0,
      confirmed: () => {},
      id: () => 'id',
      timer: createBrowserSettingsAmbient().timer,
    },
    shown(0),
  );
  try {
    controller.edit({ lineSpacing: 1.8, textSize: 20, keyboardBindings: { bold: 'Mod-Shift-j', italic: '' } });
    await controller.save();
    expect(controller.snapshot()).toMatchObject({ state: 'saved', pending: null, known: { version: 1 } });
  } finally {
    controller.dispose();
  }
});

test('an uncertain editor preference retry uses the same command and reads the current shared version', async () => {
  let version = 0;
  const sent: Readonly<PreferenceChange>[] = [];
  let remote = shown(0);
  const controller = new EditorAccountPreferences(
    {
      read: async () => ({ signedIn: true, preferences: remote, accountId: 'owner', securityHref: null }),
      save: async (input) => {
        sent.push(input);
        if (sent.length === 1) {
          remote = shown(1, { textSize: 20 });
          return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, preferences: shown(1, { textSize: 20 }) };
      },
    },
    {
      current: () => true,
      version: () => version,
      confirmed: (value) => {
        version = Math.max(version, value.version);
      },
      id: () => '00000000-0000-4000-8000-000000000001',
      timer: createBrowserSettingsAmbient().timer,
    },
    shown(0),
  );
  try {
    controller.edit({ textSize: 20 });
    await controller.save();
    expect(controller.snapshot().state).toBe('error');
    expect(controller.snapshot().pending).toBe(sent[0]);
    remote = { ...remote, version: 2, suitability: 'show' };
    await controller.save();
    expect(sent[1]).toBe(sent[0]);
    expect(controller.snapshot()).toMatchObject({
      state: 'saved',
      pending: null,
      known: { version: 2, suitability: 'show' },
    });
  } finally {
    controller.dispose();
  }
});

test('another preference domain advances the compare version without replacing the editor draft', async () => {
  let version = 0;
  const sent: Readonly<PreferenceChange>[] = [];
  const controller = new EditorAccountPreferences(
    {
      read: async () => ({ signedIn: true, preferences: shown(4), securityHref: null }),
      save: async (input) => {
        sent.push(input);
        return { ok: true, preferences: shown(5, { typeface: 'serif' }) };
      },
    },
    {
      current: () => true,
      version: () => version,
      confirmed: (value) => {
        version = Math.max(version, value.version);
      },
      id: () => '00000000-0000-4000-8000-000000000002',
      timer: createBrowserSettingsAmbient().timer,
    },
    shown(0),
  );
  try {
    controller.edit({ typeface: 'serif' });
    version = 4;
    await controller.save();
    expect(sent[0]).toMatchObject({ expectedVersion: 4, editor: { typeface: 'serif' } });
    expect(controller.snapshot().draft).toEqual({ typeface: 'serif' });
  } finally {
    controller.dispose();
  }
});

test('a later preference edit survives an uncertain original command and saves after its exact retry', async () => {
  const sent: Readonly<PreferenceChange>[] = [];
  let remote = shown(0);
  const controller = new EditorAccountPreferences(
    {
      read: async () => ({ signedIn: true, preferences: remote, securityHref: null }),
      save: async (input) => {
        sent.push(input);
        if (sent.length === 1) {
          remote = shown(1, { textSize: 20 });
          return { ok: false, reason: 'unavailable' };
        }
        if (sent.length === 2) return { ok: true, preferences: remote };
        remote = shown(2, { textSize: 22 });
        return { ok: true, preferences: remote };
      },
    },
    {
      current: () => true,
      version: () => 0,
      confirmed: () => {},
      id: () => `id-${sent.length}`,
      timer: createBrowserSettingsAmbient().timer,
    },
    shown(0),
  );
  try {
    controller.edit({ textSize: 20 });
    await controller.save();
    controller.edit({ textSize: 22 });
    await controller.save();
    expect(sent).toHaveLength(3);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).toMatchObject({ expectedVersion: 1, editor: { textSize: 22 } });
    expect(controller.snapshot()).toMatchObject({ draft: { textSize: 22 }, known: { version: 2 }, state: 'saved' });
  } finally {
    controller.dispose();
  }
});

test('replacement retires a late account preference receipt and clears private state', async () => {
  let current = true;
  let resolve!: (value: Awaited<ReturnType<import('../src/settings/reading-preferences').ReadingIO['save']>>) => void;
  let confirmed = 0;
  const controller = new EditorAccountPreferences(
    {
      read: async () => {
        throw new Error('unexpected read');
      },
      save: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    {
      current: () => current,
      version: () => 0,
      confirmed: () => confirmed++,
      id: () => 'id',
      timer: createBrowserSettingsAmbient().timer,
    },
    shown(0),
  );
  controller.edit({ customFont: 'Private font' });
  const pending = controller.save();
  current = false;
  controller.dispose();
  resolve({ ok: true, preferences: shown(1, { customFont: 'Private font' }) });
  await pending;
  expect(confirmed).toBe(0);
  expect(controller.snapshot()).toEqual({ known: null, draft: {}, state: 'idle', pending: null });
});

test('device and session storage use separate bounded versioned overrides and honest persistence errors', () => {
  expect(composeEditorPreferenceOverrides({}, {})).toEqual({});
  expect(
    composeEditorPreferenceOverrides(
      { textSize: 18, keyboardBindings: { bold: 'Mod-Shift-j' } },
      { textSize: 20 },
      { keyboardBindings: { italic: '' } },
    ),
  ).toEqual({
    textSize: 20,
    keyboardBindings: { bold: 'Mod-Shift-j', italic: '' },
  });
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const device = new LocalEditorPreferences('device:owner', () => storage);
  const session = new LocalEditorPreferences('session:owner', () => storage);
  expect(device.write({ textSize: 20 })).toBe(true);
  expect(session.snapshot()).toEqual({});
  expect(JSON.parse(values.get('device:owner')!)).toEqual({ version: 1, preferences: { textSize: 20 } });
  expect(device.write({})).toBe(true);
  expect(values.has('device:owner')).toBe(false);
  values.set('session:owner', JSON.stringify({ version: 1, preferences: { writingWidth: 500 } }));
  session.refresh();
  expect(session.snapshot()).toEqual({});
  const blocked = new LocalEditorPreferences('blocked', () => {
    throw new Error('blocked');
  });
  expect(blocked.write({ spellcheck: false })).toBe(false);
  expect(blocked.snapshot()).toEqual({ spellcheck: false });
});
