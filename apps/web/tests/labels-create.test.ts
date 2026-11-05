import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LabelShelfPageData } from '../src/library/label-shelf-read';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { LabelShelfPage } = await import('../src/library/entries-page');

test('the phone label picker keeps required controls in its active form and retains the no-script form', async () => {
  const source = await readFile(new URL('../src/library/subject-slot-view.tsx', import.meta.url), 'utf8');
  const picker = source.slice(
    source.indexOf('data-subject-label-picker-details'),
    source.indexOf('</details>', source.indexOf('data-subject-label-picker-details')),
  );
  expect(picker).toMatch(/<summary\s[^>]*role="button"/);
  expect(picker).toContain('aria-expanded={hydrated ? labelPickerOpen : undefined}');
  expect(picker).toMatch(/\{!hydrated \|\| labelPickerOpen \? \(\s*<form/);
  expect(picker).toMatch(/<input\s+name="name"[^>]*\brequired\b/);
  expect(picker).toContain('w-full min-w-0');
  expect(picker).not.toContain('noValidate');
  expect(picker).not.toContain('formNoValidate');
});

test('a genuinely empty label shelf has one empty message and keeps its name and display controls', () => {
  const page: LabelShelfPageData = {
    state: 'loaded',
    label: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000832', name: 'Empty label', revision: 1 },
    entries: [],
    next: null,
    csrfToken: null,
  };
  for (const layout of ['grid', 'list', 'table'] as const) {
    const html = renderToStaticMarkup(
      createElement(LabelShelfPage, { page, locale: 'en', display: { layout, size: 'm' } }),
    );
    expect(html.split(m.library_label_shelf_empty())).toHaveLength(2);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('Empty label');
    expect(html).toContain('aria-label="Layout"');
    expect(html).not.toContain('data-slot="cover-card"');
    expect(html).not.toContain('data-slot="tombstone"');
  }
});

test('preparation, denied, unavailable, closed and signed-out shelves never render a source-empty state', () => {
  for (const state of ['preparing', 'denied', 'unavailable', 'closed', 'signed-out'] as const) {
    const html = renderToStaticMarkup(
      createElement(LabelShelfPage, { page: { state }, locale: 'en', display: { layout: 'grid', size: 'm' } }),
    );
    expect(html).not.toContain(m.library_label_shelf_empty());
    expect(html).not.toContain('data-slot="empty"');
  }
});
