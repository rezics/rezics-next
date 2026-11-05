import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readingFixture } from '../src/kernel/fake/settings-preferences-reading';
import recording from '../src/kernel/recorded/settings-preferences.json';
import { readingMutation, readReading, sendReading, type ReadingValues } from '../src/settings/reading-preferences';
import { managedReadTimeout } from '../src/settings/managed-read-deadline';
import type { ReadingIO } from '../src/settings/reading-preferences';
import { DisplayPreferences } from '../src/settings/display-preferences';
import { AppearanceControls } from '../src/shell/appearance-controls';
import { locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ReadingDraftRecovery } = await import('../src/settings/reading-card');

const latest = () => 0;
const concurrentNotifications = { ...recording.notifications, reply: false, mention: true };
const owner = () => ({
  canRead: () => true,
  canWrite: () => true,
  version: () => 0,
  onVersionChange: () => {},
});
const flushPromiseJobs = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

const withControlledTimeout = async (run: (expire: () => void, delay: () => number | undefined) => Promise<void>) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let callback: (() => void) | undefined;
  let timeout: number | undefined;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number) => {
    timeout = delay;
    callback = handler as unknown as () => void;
    return 1 as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    await run(
      () => {
        const current = callback;
        callback = undefined;
        current?.();
      },
      () => timeout,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
};

test('a stalled Reading save keeps its original for deliberate retry and ignores a late receipt', async () => {
  await withControlledTimeout(async (expire, delay) => {
    const fixture = readingFixture();
    let releaseSave!: (result: Awaited<ReturnType<typeof fixture.io.save>>) => void;
    let startSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => (startSave = resolve));
    let saves = 0;
    let reads = 0;
    const io: ReadingIO = {
      save: (input) => {
        if (++saves > 1) return fixture.io.save(input);
        startSave();
        return new Promise((resolve) => (releaseSave = resolve));
      },
      read: async () => {
        reads++;
        return fixture.io.read();
      },
    };
    const editor = new ReadingDraftRecovery(fixture.initial, io, owner());
    const saving = editor.edit({ spoilerLevel: 1 });
    await saveStarted;
    expect(delay()).toBe(managedReadTimeout);
    expire();
    await flushPromiseJobs();

    expect(editor.snapshot().phase).toBe('uncertain');
    const original = editor.snapshot().pending!;
    expect(original).toMatchObject({ expectedVersion: 0, spoilerLevel: 1 });
    await editor.edit({ suitability: 'show' });
    expect(editor.snapshot().pending).toBe(original);
    expect(editor.snapshot().draft).toMatchObject({ spoilerLevel: 1, suitability: 'show' });

    const lateReceipt = await fixture.io.save(original);
    releaseSave(lateReceipt);
    await flushPromiseJobs();
    expect(reads).toBe(0);
    expect(editor.snapshot().pending).toBe(original);

    await editor.retry();
    expect(fixture.calls).toEqual([original, original]);
    expect(fixture.calls[1]).toBe(original);
    expect(reads).toBe(1);
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      pending: null,
      draft: { spoilerLevel: 1, suitability: 'show' },
    });
    await saving;
  });
});

test('Reading changes preserve the exact in-flight key and payload across response loss and reload actual current preference version', async () => {
  const fixture = readingFixture('lost');
  const draft: ReadingValues = { spoilerLevel: 1, suitability: 'blur' };
  const original = readingMutation(fixture.initial, draft)!;
  const originalJson = JSON.stringify(original);
  expect(Object.isFrozen(original)).toBe(true);
  expect(await sendReading(fixture.io, original, false, latest)).toMatchObject({ kind: 'uncertain' });
  draft.suitability = 'show';
  // An independent device changes reading and notices after the first save committed.
  fixture.concurrent({ spoilerLevel: 2 });
  const result = await sendReading(fixture.io, original, true, latest);
  expect(result).toMatchObject({
    kind: 'confirmed',
    receipt: { spoilerLevel: 1, suitability: 'blur', version: 1 },
    preferences: { spoilerLevel: 2, suitability: 'blur', version: 2 },
  });
  expect(fixture.calls).toEqual([original, original]);
  expect(fixture.calls[1]).toBe(original);
  expect(JSON.stringify(original)).toBe(originalJson);
  expect(fixture.reads()).toBe(1);
  expect(draft).toEqual({ spoilerLevel: 1, suitability: 'show' });
  if (result.kind !== 'confirmed') throw new Error('Expected a confirmed readback');
  const live = readingFixture('lost');
  const recovery = new ReadingDraftRecovery(live.initial, live.io, owner());
  await recovery.edit({ spoilerLevel: 1 });
  expect(recovery.snapshot().pending).toMatchObject({ spoilerLevel: 1 });
  await recovery.edit({ suitability: 'show' });
  live.concurrent({ spoilerLevel: 2 });
  await recovery.retry();
  expect(recovery.snapshot()).toMatchObject({
    phase: 'review',
    pending: null,
    known: { spoilerLevel: 2, suitability: 'blur', version: 2 },
    draft: { spoilerLevel: 2, suitability: 'show' },
  });
  await recovery.submit();
  expect(live.calls[2]).toMatchObject({ expectedVersion: 2, suitability: 'show' });
  expect(live.calls[2]).not.toHaveProperty('spoilerLevel');
  expect(live.current()).toMatchObject({
    spoilerLevel: 2,
    suitability: 'show',
    version: 3,
    notifications: concurrentNotifications,
  });
});

test('A concurrent preference update produces reviewable conflict rather than overwriting newer notification or reading values', async () => {
  const fixture = readingFixture('conflict');
  const draft: ReadingValues = { spoilerLevel: 1, suitability: 'blur' };
  const pending = readingMutation(fixture.initial, draft)!;
  expect(await sendReading(fixture.io, pending, false, latest)).toMatchObject({ kind: 'rejected', reason: 'conflict' });
  expect(fixture.current()).toMatchObject({
    spoilerLevel: 2,
    suitability: 'show',
    version: 1,
    notifications: concurrentNotifications,
  });
  expect(fixture.calls).toHaveLength(1);
  const current = await readReading(fixture.io, 0);
  expect(current.ok).toBe(true);
  expect(fixture.calls).toHaveLength(1); // Reading current values never resubmits a draft.
  expect(draft).toEqual({ spoilerLevel: 1, suitability: 'blur' });
  if (!current.ok) throw new Error('Expected current preferences');
  const live = readingFixture('conflict');
  const recovery = new ReadingDraftRecovery(live.initial, live.io, owner());
  await recovery.edit({ spoilerLevel: 1 });
  await recovery.reload();
  expect(recovery.snapshot()).toMatchObject({
    phase: 'review',
    pending: null,
    known: { spoilerLevel: 2, suitability: 'show', version: 1 },
    draft: { spoilerLevel: 1, suitability: 'show' },
  });
  await recovery.submit();
  expect(live.calls[1]).toMatchObject({ expectedVersion: 1, spoilerLevel: 1 });
  expect(live.calls[1]).not.toHaveProperty('suitability');
  expect(live.calls[1]!.idempotencyKey).not.toBe(pending.idempotencyKey);
  expect(live.current().notifications).toEqual(concurrentNotifications);
});

test('an unavailable or closed readback never turns an original retry into success or supplies defaults', async () => {
  const fixture = readingFixture('unavailable');
  const input = readingMutation(fixture.initial, { spoilerLevel: 1, suitability: 'blur' })!;
  expect(await sendReading(fixture.io, input, false, latest)).toMatchObject({ kind: 'uncertain' });
  expect(await sendReading(fixture.io, input, true, latest)).toMatchObject({
    kind: 'confirmed-read-failed',
    reason: 'unavailable',
    receipt: { spoilerLevel: 1, version: 1 },
  });
  expect(fixture.calls[1]).toBe(input);
  expect(await readReading(fixture.io, 0)).toMatchObject({ ok: false, reason: 'unavailable' });
  const closed = readingFixture('closed');
  expect(await readReading(closed.io, 0)).toMatchObject({ ok: false, reason: 'closed' });
});

test('a shared notification version arriving during a save requires current readback before confirmation', async () => {
  const fixture = readingFixture('delayed');
  const input = readingMutation(fixture.initial, { spoilerLevel: 1, suitability: 'blur' })!;
  let version = 0;
  const result = sendReading(fixture.io, input, false, () => version);
  fixture.release();
  await Promise.resolve();
  fixture.concurrent();
  version = fixture.current().version;
  expect(await result).toMatchObject({ kind: 'confirmed', preferences: { version } });
  expect(fixture.reads()).toBe(1);
});

test('Settings display choices consume the actual shared AppearanceControls instead of maintaining a second locale/theme cookie implementation', () => {
  const content = DisplayPreferences().props.children[1];
  expect(content.props.children.type).toBe(AppearanceControls);
});

test('Current locale and theme settings reuse the shell preferences without inventing server storage', () => {
  setLocale('en', { reload: false });
  const html = renderToStaticMarkup(createElement(DisplayPreferences));
  const languages = [...html.matchAll(/<a[^>]*lang="([^"]+)"[^>]*href="([^"]+)"/g)].map((match) => [
    match[1],
    match[2],
  ]);
  expect(languages).toEqual(locales.map((locale) => [locale, `/${locale}`]));
  expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  expect(html).toContain(`aria-label="${m.shell_theme()}"`);
  expect(html).toContain(`aria-label="${m.shell_appearance()}"`);
  expect(html).toContain('id="settings-display-heading"');
  for (const language of ['English', '繁體中文', '简体中文', '日本語', '한국어', 'Deutsch', 'Français', 'Español'])
    expect(html).toContain(language);
  expect(html).toContain('apply in this browser');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('Accounts');
});

test('a notification update arriving during recovery GET cannot confirm an older reading snapshot', async () => {
  const fixture = readingFixture('lost');
  const original = readingMutation(fixture.initial, { spoilerLevel: 1, suitability: 'blur' })!;
  expect(await sendReading(fixture.io, original, false, latest)).toMatchObject({ kind: 'uncertain' });
  let beginRead = () => {};
  let releaseRead = () => {};
  const reading = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  const delay = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let version = 1;
  const result = sendReading(
    {
      ...fixture.io,
      async read() {
        const snapshot = await fixture.io.read();
        beginRead();
        await delay;
        return snapshot;
      },
    },
    original,
    true,
    () => version,
  );
  await reading;
  fixture.concurrent();
  version = fixture.current().version;
  releaseRead();
  expect(await result).toMatchObject({ kind: 'confirmed-read-failed', reason: 'unavailable' });
  expect(await sendReading(fixture.io, original, true, () => version)).toMatchObject({
    kind: 'confirmed',
    preferences: { version: 2 },
    receipt: { version: 1 },
  });
  expect(fixture.calls).toEqual([original, original, original]);
  expect(fixture.current().notifications).toEqual(concurrentNotifications);
});

test('a definite conflict resolves an original attempt whose request was lost before applying', async () => {
  const fixture = readingFixture();
  const original = readingMutation(fixture.initial, { spoilerLevel: 1, suitability: 'blur' })!;
  let attempts = 0;
  const io = {
    ...fixture.io,
    async save(input: typeof original) {
      expect(input).toBe(original);
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      return fixture.io.save(input);
    },
  };
  expect(await sendReading(io, original, false, latest)).toMatchObject({ kind: 'uncertain' });
  fixture.concurrent({ spoilerLevel: 2 });
  expect(await sendReading(io, original, true, latest)).toMatchObject({ kind: 'rejected', reason: 'conflict' });
  expect(fixture.current()).toMatchObject({
    spoilerLevel: 2,
    suitability: 'blur',
    version: 1,
    notifications: concurrentNotifications,
  });
  expect(fixture.reads()).toBe(0);
});
