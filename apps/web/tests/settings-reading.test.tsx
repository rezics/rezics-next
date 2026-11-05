import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readingAdviceFor, type ReadingIO } from '../src/settings/reading-preferences';
import type { SettingsPage } from '../src/settings/preferences';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ReadingCard, ReadingDraftRecovery } = await import('../src/settings/reading-card');

const advice = readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' });
advice.reading.defaults = { spoilerLevel: 2, suitability: 'show' };
const denied = readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' }, false);
const initial = { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 3, advice };
const createEditor = (io: ReadingIO, current: () => boolean = () => true, version: () => number = () => 3) =>
  new ReadingDraftRecovery(initial, io, {
    canRead: current,
    canWrite: current,
    version,
    onVersionChange: () => {},
  });

test('the reading card explains confirmed values, native defaults and an inert sample', () => {
  const html = renderToStaticMarkup(
    createElement(ReadingCard, {
      initial,
      version: 3,
      csrfToken: 'csrf',
      onVersionChange: () => {},
    }),
  );
  expect(html).toContain(m.settings_reading_preview_legend());
  expect(html).toContain(m.settings_reading_preview_confirmed());
  expect(html).toContain(
    m.settings_reading_effective({
      spoilers: m.settings_spoiler_1_title(),
      images: m.settings_reading_blur(),
      defaultSpoilers: m.settings_spoiler_2_title(),
      defaultImages: m.settings_reading_show(),
    }),
  );
  expect(html).toContain(m.settings_reading_reset());
  expect(html).toContain(m.settings_spoiler_1_title());
});

test('unknown choice data is unavailable and a readable owner without update stays inspectable', () => {
  const missing = renderToStaticMarkup(
    createElement(ReadingCard, {
      initial: { spoilerLevel: 1, suitability: 'blur', version: 3 },
      version: 3,
      csrfToken: 'csrf',
      onVersionChange: () => {},
    }),
  );
  expect(missing).toContain(m.settings_reading_choices_unavailable_title());
  expect(missing).not.toContain(m.settings_spoiler_1_title());
  const readOnly = renderToStaticMarkup(
    createElement(ReadingCard, {
      initial: { ...initial, advice: denied },
      version: 3,
      csrfToken: 'csrf',
      onVersionChange: () => {},
    }),
  );
  expect(readOnly).toContain(m.settings_spoiler_1_title());
  expect(readOnly).toContain(m.settings_reading_read_only_title());
  expect(readOnly).not.toContain(m.settings_reading_reset());
});

test('a readable-but-not-editable reload keeps an unresolved original', async () => {
  const fixture = {
    save: async () => ({ ok: false as const, reason: 'unavailable' as const, failure: { status: null } }),
    read: async () => ({
      signedIn: true as const,
      preferences: {
        spoilerLevel: 2 as const,
        suitability: 'show' as const,
        version: 4,
        advice: readingAdviceFor({ spoilerLevel: 2, suitability: 'show' }, false),
      },
      securityHref: null,
    }),
  };
  let writable = true;
  const editor = new ReadingDraftRecovery(initial, fixture, {
    canRead: () => true,
    canWrite: () => writable,
    version: () => 3,
    onVersionChange: () => {},
  });
  await editor.edit({ spoilerLevel: 0 });
  expect(editor.snapshot().pending).not.toBeNull();
  const original = editor.snapshot().pending;
  writable = false;
  await editor.reload();
  expect(editor.snapshot().pending).toBe(original);
  expect(editor.snapshot().known).toMatchObject({ spoilerLevel: 2, suitability: 'show', version: 4 });
  expect(editor.snapshot().advice?.allowedActions.update.allowed).toBe(false);
  await editor.retry();
  expect(editor.snapshot().pending).toBe(original);
});

test('read denial and platform closure retire update advice and retained callbacks', async () => {
  const failures: SettingsPage[] = [
    { signedIn: false },
    { signedIn: true, state: 'closed', failure: { status: null, code: 'platform_closed' }, securityHref: null },
  ];
  for (const page of failures) {
    let saves = 0;
    const editor = createEditor({
      save: async () => (saves++, { ok: false as const, reason: 'unavailable' as const }),
      read: async () => page,
    });
    const callbacks = [
      () => editor.edit({ spoilerLevel: 0 }),
      () => editor.submit(),
      () => editor.resetToNativeDefaults(),
    ];
    await editor.reload();
    expect(editor.snapshot().advice).toBeUndefined();
    expect(editor.snapshot().known.advice).toBeUndefined();
    for (const callback of callbacks) await callback();
    await editor.retry();
    expect(saves).toBe(0);
  }
});

test('late read completion after viewer retirement cannot install its values or advice', async () => {
  let active = true;
  let finish!: (page: SettingsPage) => void;
  const late: SettingsPage = {
    signedIn: true,
    preferences: {
      spoilerLevel: 2,
      suitability: 'show',
      version: 4,
      advice: readingAdviceFor({ spoilerLevel: 2, suitability: 'show' }),
    },
    securityHref: null,
  };
  const editor = createEditor(
    {
      save: async () => ({ ok: false, reason: 'unavailable' }),
      read: () => new Promise((resolve) => (finish = resolve)),
    },
    () => active,
  );
  const pending = editor.reload();
  active = false;
  finish(late);
  await pending;
  expect(editor.snapshot().known).toMatchObject({ spoilerLevel: 1, suitability: 'blur', version: 3 });
  expect(editor.snapshot().advice).toBe(advice);
  expect(editor.snapshot().knownCurrent).toBe(false);
});

test('temporary read failure keeps the original until fresh advice is reviewed and retried', async () => {
  const current: SettingsPage = {
    signedIn: true,
    preferences: {
      spoilerLevel: 0,
      suitability: 'blur',
      version: 4,
      advice: readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }),
    },
    securityHref: null,
  };
  const pages: SettingsPage[] = [
    { signedIn: true, state: 'unavailable', failure: { status: 503 }, securityHref: null },
    { signedIn: false },
    current,
  ];
  const calls: unknown[] = [];
  const editor = createEditor({
    save: async (input) => (calls.push(input), { ok: false as const, reason: 'unavailable' as const }),
    read: async () => pages.shift()!,
  });
  await editor.edit({ spoilerLevel: 2, suitability: 'show' });
  const original = editor.snapshot().pending;
  expect(original).not.toBeNull();
  await editor.reload();
  expect(editor.snapshot().pending).toBe(original);
  await editor.edit({ suitability: 'blur' });
  await editor.submit();
  expect(calls).toHaveLength(1);
  await editor.reload();
  await editor.retry();
  expect(calls).toHaveLength(1);
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({
    pending: original,
    known: { version: 4, spoilerLevel: 0, suitability: 'blur' },
    draft: { spoilerLevel: 2, suitability: 'blur' },
  });
  await editor.retry();
  expect(calls[1]).toBe(original);
});

test('confirmed replay read recovery keeps its receipt, newer baseline and later draft without another write', async () => {
  let version = 3;
  const preferences = (spoilerLevel: 0 | 1 | 2, suitability: 'blur' | 'show', version: number) => ({
    spoilerLevel,
    suitability,
    version,
    advice: readingAdviceFor({ spoilerLevel, suitability }),
  });
  const receipt = preferences(0, 'blur', 4),
    current = preferences(2, 'show', 5);
  const pages: SettingsPage[] = [
    { signedIn: true, state: 'unavailable', failure: { status: 503 }, securityHref: null },
    { signedIn: true, preferences: current, securityHref: null },
  ];
  const calls: unknown[] = [];
  const editor = createEditor(
    {
      save: async (input) => (
        calls.push(input),
        calls.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt }
      ),
      read: async () => pages.shift()!,
    },
    () => true,
    () => version,
  );
  await editor.edit({ spoilerLevel: 0 });
  const original = editor.snapshot().pending;
  version = 5;
  await editor.retry();
  expect(editor.snapshot()).toMatchObject({
    phase: 'failed',
    pending: null,
    knownCurrent: false,
    failureOrigin: 'read',
  });
  expect(editor.snapshot().confirmedReceipt).toEqual({ spoilerLevel: 0, suitability: 'blur', version: 4 });
  await editor.edit({ suitability: 'show' });
  await editor.submit();
  await editor.resetToNativeDefaults();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe(original);
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({
    phase: 'saved',
    knownCurrent: true,
    known: current,
    draft: { spoilerLevel: 2, suitability: 'show' },
  });
  expect(editor.snapshot().confirmedReceipt?.version).toBe(4);
  expect(calls).toHaveLength(2);
});

const withNow = async (start: number, run: (advance: (ms: number) => void) => Promise<void>) => {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    await run((ms) => (now += ms));
  } finally {
    Date.now = realNow;
  }
};

test('Reading Retry-After waits survive edits and reads, then allow deliberate retry only', async () =>
  withNow(Date.UTC(2026, 10, 5), async (advance) => {
    const receipt = {
      spoilerLevel: 0 as const,
      suitability: 'blur' as const,
      version: 4,
      advice: readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }),
    };
    const calls: unknown[] = [];
    let reads = 0;
    const editor = createEditor({
      save: async (input) => (
        calls.push(input),
        calls.length === 1
          ? { ok: false as const, reason: 'unavailable' as const, failure: { status: 429, retryAfter: '2' } }
          : { ok: true as const, preferences: receipt }
      ),
      read: async () => ({
        signedIn: true as const,
        preferences: reads++ === 0 ? initial : receipt,
        securityHref: null,
      }),
    });
    const retry = () => editor.retry(false);
    await editor.edit({ spoilerLevel: 0 });
    const original = editor.snapshot().pending;
    await editor.reload(false);
    await editor.edit({ suitability: 'show' });
    expect(editor.snapshot().pending).toBe(original);
    expect(editor.snapshot().commandRetryAt).toBe(Date.now() + 2_000);
    await retry();
    expect(calls).toHaveLength(1);
    advance(2_000);
    expect(calls).toHaveLength(1);
    await retry();
    expect(calls[1]).toBe(original);
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      pending: null,
      draft: { spoilerLevel: 0, suitability: 'show' },
      known: { spoilerLevel: 0, suitability: 'blur', version: 4 },
    });

    const deadline = Date.now() + 5_000;
    reads = 0;
    const current = createEditor({
      save: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      read: async () =>
        reads++ === 0
          ? {
              signedIn: true as const,
              state: 'unavailable' as const,
              failure: { status: 503, retryAfter: new Date(deadline).toUTCString() },
              securityHref: null,
            }
          : { signedIn: true as const, preferences: initial, securityHref: null },
    });
    const reload = () => current.reload(false);
    await reload();
    await current.edit({ spoilerLevel: 0 });
    advance(4_999);
    await reload();
    expect([reads, current.snapshot().readRetryAt]).toEqual([1, deadline]);
    advance(1);
    expect(reads).toBe(1);
    await reload();
    expect([reads, current.snapshot().readRetryAt, current.snapshot().draft.spoilerLevel]).toEqual([2, 0, 0]);

    let active = true,
      finish!: (page: SettingsPage) => void;
    const retired = createEditor(
      {
        save: async () => ({ ok: false, reason: 'unavailable' }),
        read: () => new Promise((resolve) => (finish = resolve)),
      },
      () => active,
    );
    const pending = retired.reload();
    active = false;
    finish({ signedIn: true, state: 'unavailable', failure: { status: 503, retryAfter: '60' }, securityHref: null });
    await pending;
    expect(retired.snapshot().readRetryAt).toBe(0);
  }));
