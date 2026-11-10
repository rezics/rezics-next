import { afterAll, expect, mock, test } from 'bun:test';
import { Children, createElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { performanceAmbientTree } from './performance-ambient';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { InboxRows } = await import('../src/inbox/inbox-page');
const { inboxContent } = await import('../src/inbox/adapters/presentation');
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
  return renderToStaticMarkup(
    performanceAmbientTree(createElement(InboxRows, { content: inboxContent, page: { items, next: null } })),
  );
}

function continuationButton(tree: ReactNode) {
  if (!isValidElement<{ children: ReactNode }>(tree)) return undefined;
  const continuation = Children.toArray(tree.props.children)[1];
  if (!isValidElement<ComponentProps<typeof Button>>(continuation) || continuation.type !== Button) return undefined;
  return continuation;
}

test('Inbox stories enter the inbox route through the shared page story shell', async () => {
  const source = await readFile(new URL('../src/stories/inbox.stories.tsx', import.meta.url), 'utf8');
  expect(source).toMatch(/import\s*\{[^}]*\bPageStory\b[^}]*\}\s*from\s*['"]\.\/page['"]/);
  expect(source).toContain('<PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />');
  expect(source).toContain("title: 'Account/Inbox Page'");
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
  expect(rows[0]).toContain('<h2');
  expect(rows[0]).toContain('aria-label="A reply from Momo. Community member. Reply. Unread notification.');
  expect(rows[0]).not.toContain('aria-labelledby=');
  expect(rows[0]).toContain('data-notice-byline="true" aria-hidden="true"');
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

test('a sparse continuation preserves its callback and loading disables only the supplied next-page action', () => {
  let calls = 0;
  const onLoadMore = () => {
    calls += 1;
  };
  const page = { items: [], next: 'opaque-sparse-next' };
  const available = InboxRows({ page, content: inboxContent, onLoadMore });
  const loading = InboxRows({ page, content: inboxContent, onLoadMore, loading: true });
  const withoutCallback = InboxRows({ page, content: inboxContent });
  const exhausted = InboxRows({ page: { items: [], next: null }, content: inboxContent, onLoadMore });
  const availableButton = continuationButton(available);
  const loadingButton = continuationButton(loading);
  const availableHandler = availableButton?.props.onClick;

  expect(availableButton).toBeDefined();
  expect(availableHandler).toBe(onLoadMore);
  expect(availableButton?.props.disabled).toBe(false);
  expect(availableButton?.props.className).toContain('min-h-11');
  expect(renderToStaticMarkup(performanceAmbientTree(available))).toContain(m.inbox_load_more());
  expect(loadingButton?.props.onClick).toBe(onLoadMore);
  expect(loadingButton?.props.disabled).toBe(true);
  expect(continuationButton(withoutCallback)).toBeUndefined();
  expect(continuationButton(exhausted)).toBeUndefined();
  if (availableHandler) Reflect.apply(availableHandler, undefined, []);
  expect(calls).toBe(1);
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

test('linked notices announce their resolved content, actor, kind, current read state and exact date once in every launch locale', async () => {
  const previousLocale = getLocale();
  const items: Item[] = [
    { ...linked, actorName: '桃子' },
    { ...linked, id: 'read-mention', kind: 'mention', unread: false, actorName: 'あおい', text: 'A mention' },
  ];
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
      expect(m.inbox_notice_unread()).toBe(catalog.inbox_notice_unread);
      expect(m.inbox_notice_read()).toBe(catalog.inbox_notice_read);
      if (locale !== 'en') {
        expect(catalog.inbox_notice_unread).not.toBe('Unread notification');
        expect(catalog.inbox_notice_read).not.toBe('Read notification');
      }
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(timestamp));
      // Reverse the order too: read state belongs to the notice, never its position.
      for (const ordered of [items, items.toReversed()]) {
        const html = markup(ordered);
        const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/g)].map(
          (match) => match[0]!,
        );
        await page.setContent(`<html lang="${locale}"><body>${html}</body></html>`);
        const links = page.locator('a[data-slot="list-row-link"]');
        expect(await links.count()).toBe(2);
        for (const [index, item] of ordered.entries()) {
          const state = item.unread ? catalog.inbox_notice_unread : catalog.inbox_notice_read;
          const kind = item.kind === 'mention' ? catalog.inbox_kind_mention : catalog.inbox_kind_reply;
          const announcement = [item.text, item.actorName, kind, state, date].join('. ');
          const link = links.nth(index);
          expect(await link.getAttribute('aria-label')).toBe(announcement);
          expect(await link.getAttribute('aria-labelledby')).toBeNull();
          expect(await page.getByRole('link', { name: announcement, exact: true }).count()).toBe(1);
          expect(await page.getByRole('heading', { level: 2, name: item.text, exact: true }).count()).toBe(1);
          expect(rows[index]).toContain('data-notice-byline="true" aria-hidden="true"');
          expect(rows[index]).toMatch(/<span aria-hidden="true"><time\b/);
          expect(rows[index]!.split(date)).toHaveLength(2);
        }
      }
    }
  } finally {
    await page.close();
    setLocale(previousLocale, { reload: false });
  }
});

test('InboxRows preserves complete localized information and announces the exact date once for linked plain and unavailable notices', async () => {
  const previousLocale = getLocale();
  const linkedWithActor: Item = { ...linked, actorName: '桃子' };
  const privateUnavailable: Item = {
    ...unavailable,
    unread: true,
    actorId: 'stale-private-actor',
    actorName: 'Stale private name',
    href: '/threads/stale-private-target',
    text: 'Stale private text',
  };
  const items: Item[] = [linkedWithActor, plain, privateUnavailable];
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(timestamp));

      for (const ordered of [items, items.toReversed()]) {
        const html = markup(ordered);
        expect(html).not.toContain('stale-private');
        expect(html).not.toContain('Stale private');
        await page.setContent(`<html lang="${locale}"><body>${html}</body></html>`);

        const rows = page.getByRole('listitem');
        expect(await rows.count()).toBe(ordered.length);
        expect(await page.getByRole('link').count()).toBe(1);

        for (const [index, item] of ordered.entries()) {
          const row = rows.nth(index);
          const title = item.unavailable ? catalog.inbox_unavailable_item : item.text;
          const actor = item.unavailable
            ? catalog.inbox_actor_unknown
            : item.actorName || (item.actorId ? catalog.inbox_actor_unknown : catalog.inbox_actor_moderation);
          const kind =
            item.reportId || item.kind === 'moderation_decision'
              ? catalog.inbox_kind_moderation
              : item.kind === 'mention'
                ? catalog.inbox_kind_mention
                : catalog.inbox_kind_reply;
          const readState = item.unread ? catalog.inbox_notice_unread : catalog.inbox_notice_read;
          const relativeTime = row.locator('span[aria-hidden="true"] time');

          expect(await row.getByRole('heading', { level: 2, name: title, exact: true }).count()).toBe(1);
          expect(await relativeTime.count()).toBe(1);
          expect(await relativeTime.isVisible()).toBe(true);
          const relativeLabel = (await relativeTime.innerText()).trim();
          expect(relativeLabel).not.toBe('');
          expect(await relativeTime.evaluate((element) => element.parentElement?.getAttribute('aria-hidden'))).toBe(
            'true',
          );
          const snapshot = await row.ariaSnapshot();
          expect(snapshot).not.toContain(relativeLabel);

          if (item.href && !item.unavailable) {
            const announcement = [title, actor, kind, readState, date].join('. ');
            const link = row.getByRole('link', { name: announcement, exact: true });
            expect(await link.count()).toBe(1);
            expect(await link.getAttribute('aria-label')).toBe(announcement);
            expect(await link.getAttribute('aria-labelledby')).toBeNull();
            expect(announcement.split(date)).toHaveLength(2);
          } else {
            expect(await row.getByRole('link').count()).toBe(0);
            expect(snapshot).toContain(actor);
            expect(snapshot).toContain(kind);
            expect(snapshot).toContain(readState);
            expect(snapshot.split(date)).toHaveLength(2);
          }
        }
      }
    }
  } finally {
    await page.close();
    setLocale(previousLocale, { reload: false });
  }
});

test('plain and unavailable notices retain localized announcements without restoring stale destination, text or identity', () => {
  const previousLocale = getLocale();
  const hidden: Item = {
    ...unavailable,
    unread: true,
    actorId: 'stale-private-actor',
    actorName: 'Stale private name',
    href: '/threads/stale-private-target',
    text: 'Stale private text',
  };
  try {
    for (const locale of ['ja', 'zh-Hans'] as const) {
      setLocale(locale, { reload: false });
      const html = markup([plain, hidden]);
      const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]!);
      expect(rows).toHaveLength(2);
      expect(html).not.toContain('<a');
      expect(html).not.toContain('stale-private');
      expect(html).not.toContain('Stale private');
      expect(rows[0]).toContain(m.inbox_notice_read());
      expect(rows[0]).toContain(m.inbox_actor_moderation());
      expect(rows[1]).toContain(m.inbox_notice_unread());
      expect(rows[1]).toContain(m.inbox_actor_unknown());
      expect(rows[1]).toContain(m.inbox_unavailable_item());
      expect(rows[1]).toContain('data-unread="true"');
      expect(rows[1]).not.toContain('data-actor-id');
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(timestamp));
      for (const row of rows) {
        expect(row).toContain(m.inbox_kind_moderation());
        expect(row.split(date)).toHaveLength(2);
        expect(row).toContain('<time class="sr-only"');
        expect(row).not.toMatch(/cursor-pointer/);
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});
