import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readingAdviceFor } from '../src/settings/reading-preferences';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ReadingCard, ReadingDraftRecovery } = await import('../src/settings/reading-card');

const advice = readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' });
const denied = readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' }, false);
const initial = { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 3, advice };

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
      defaultSpoilers: m.settings_spoiler_0_title(),
      defaultImages: m.settings_reading_blur(),
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
      preferences: { spoilerLevel: 2 as const, suitability: 'show' as const, version: 4, advice: denied },
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
