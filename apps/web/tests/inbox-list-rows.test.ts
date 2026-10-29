import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { InboxRows } = await import('../src/inbox/inbox-page');
type Item = import('../src/inbox/inbox-read').ResolvedInboxPage['items'][number];

const timestamp = '2026-10-29T10:00:00.000Z';
const linked: Item = {
  id: 'linked',
  kind: 'reply',
  actorId: 'momo',
  unread: true,
  text: 'A reply from Momo',
  href: '/threads/one',
  unavailable: false,
  createdAt: timestamp,
};
const plain: Item = {
  id: 'plain',
  kind: 'moderation_decision',
  actorId: null,
  reportId: 'report-1',
  unread: false,
  text: 'A notice without a destination',
  unavailable: false,
  createdAt: timestamp,
};
const unavailable: Item = {
  id: 'unavailable',
  kind: 'moderation_decision',
  actorId: null,
  unread: false,
  text: 'A private item is unavailable',
  unavailable: true,
  createdAt: timestamp,
};

function markup(items: Item[]) {
  return renderToStaticMarkup(createElement(InboxRows, { page: { items, next: null } }));
}

test('Inbox stories enter the inbox route through the shared page story shell', async () => {
  const source = await readFile(new URL('../src/stories/inbox.stories.tsx', import.meta.url), 'utf8');
  expect(source).toContain("import { PageStory } from './page'");
  expect(source).toContain('<PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />');
  expect(source).toContain("title: 'Pages/Inbox'");
});

test('the inbox renders notifications as ListRows, with an actor avatar or kind icon, and distinguishes unread rows', () => {
  const html = markup([linked, plain]);
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(2);
  expect(html).toContain('data-slot="list-row-link"');
  expect(html).toContain('data-slot="avatar"');
  expect(html).toContain('data-icon-kind="report_outcome"');
  expect(html).toContain('data-unread="true"');
  expect(html).toContain('data-unread="false"');
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

test('unavailable notices stay plain and every row retains an accessible full date alongside relative time', () => {
  const html = markup([linked, unavailable]);
  expect(html).toContain(m.inbox_unavailable_item());
  const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]!);
  expect(rows).toHaveLength(2);
  expect(rows[1]).not.toContain('<a');
  for (const row of rows) {
    expect(row).toMatch(/<time[^>]*dateTime="2026-10-29T10:00:00.000Z"/);
    expect(row).toMatch(/<time[^>]*title="[^"]+"/);
    expect(row).toContain('sr-only');
    expect(row).not.toContain('Oct 29, 2026, 10:00 AM');
  }
});

test('notification links wrap their content and mixed timestamps render different relative times', () => {
  const second: Item = { ...linked, id: 'second', createdAt: '2026-10-26T08:00:00.000Z' };
  const html = markup([linked, second]);
  const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]!);
  expect(rows[0]).toContain('href="/threads/one"');
  expect(rows[0]).toContain('Momo');
  const times = [...html.matchAll(/<time[^>]*>(.*?)<\/time>/g)].map((match) => match[1]);
  expect(times[0]).not.toBe(times[1]);
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
