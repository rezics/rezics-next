import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { InboxRows } = await import('../src/inbox/inbox-page');
type Item = import('../src/inbox/inbox-read').ResolvedInboxPage['items'][number];

const timestamp = '2026-10-29T10:00:00.000Z';
const linked: Item = {
  id: 'linked',
  text: 'A reply from Momo',
  href: '/threads/one',
  unavailable: false,
  createdAt: timestamp,
};
const plain: Item = {
  id: 'plain',
  text: 'A notice without a destination',
  unavailable: false,
  createdAt: timestamp,
};
const unavailable: Item = {
  id: 'unavailable',
  text: 'A private item is unavailable',
  unavailable: true,
  createdAt: timestamp,
};

function markup(items: Item[]) {
  return renderToStaticMarkup(createElement(InboxRows, { page: { items, next: null } }));
}

test('the inbox renders every notification as a bare ListRow with its overlay as the only row state', () => {
  const html = markup([linked, plain]);
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(2);
  expect(html).toContain('data-slot="list-row-link"');
  expect(html).not.toMatch(/divide-y|border(?:-[^\s"]*)?|rounded-2xl/);
  expect(html).toContain('before:opacity-0');
  expect(html).toContain('hover:before:opacity-100');
  expect(html).toContain('has-[:focus-visible]:before:opacity-100');
  expect(html).toContain('active:before:opacity-100');
});

test('a linked notification stretches its link across the row and a plain notification has no link or pointer cursor', () => {
  const html = markup([linked, plain]);
  const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]!);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('href="/threads/one"');
  expect(rows[0]).toContain('absolute inset-1');
  expect(rows[0]).toContain('sr-only');
  expect(rows[1]).not.toContain('<a');
  expect(rows[1]).not.toMatch(/cursor-pointer/);
});

test('unavailable notices stay plain and every row retains its time', () => {
  const html = markup([linked, unavailable]);
  expect(html).toContain(m.inbox_unavailable_item());
  const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]!);
  expect(rows).toHaveLength(2);
  expect(rows[1]).not.toContain('<a');
  for (const row of rows) expect(row).toMatch(/<time[^>]*dateTime="2026-10-29T10:00:00.000Z"/);
});

let browser: Browser | undefined;
afterAll(async () => browser?.close());

test('the inbox list has no accessibility violations', async () => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(
    `<html lang="en"><head><title>Inbox</title></head><body><main><h1>Inbox</h1>${markup([linked, plain, unavailable])}</main></body></html>`,
  );
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
