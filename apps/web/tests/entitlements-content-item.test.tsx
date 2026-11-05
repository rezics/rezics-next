import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToString } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { BuyerEntitlement, BuyerEntitlementsPage } from '../src/checkout/entitlements';
import { mappedEntitlement, revokedEntitlement } from '../src/kernel/fake/entitlements';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());

// UNRUN: composed assertions over the actual shared UI; native, browser and acceptance proof remain deferred.
test('Entitlement shared summaries preserve supplied identity and honest historical status', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/entitlements' });
  const { EntitlementsPage } = await import('../src/checkout/entitlements-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const supplied: BuyerEntitlement = {
    ...mappedEntitlement,
    summary: {
      ...mappedEntitlement.summary!,
      label: { value: 'こころ — A reader’s edition', language: 'ja' },
      cover: {
        media: 'supplied-entitlement-cover',
        width: 500,
        height: 700,
        placeholder: { thumbhash: '', color: '#654321' },
        variants: [{ format: 'webp', width: 96 }],
        focalPoint: null,
        credit: null,
      },
    },
  };
  const revoked: BuyerEntitlement = {
    ...revokedEntitlement,
    id: '01a17a7a-4856-7052-a40c-074c3803e6cf',
    contentEdition: mappedEntitlement.contentEdition,
    summary: { ...supplied.summary!, label: { value: '往日的閱讀', language: 'zh-Hant' }, cover: null },
  };
  const unknown: BuyerEntitlement = {
    ...mappedEntitlement,
    id: '01a17a7a-4856-7052-a40c-074c3803e6d0',
    summary: null,
    contentEdition: null,
  };
  const cursor = 'signed+/cursor=%2F';
  const show = (page: BuyerEntitlementsPage, continuation = false) => {
    host.innerHTML = renderToString(<EntitlementsPage page={page} locale="en" continuation={continuation} />);
  };
  try {
    show({ kind: 'ready', data: { entitlements: [supplied, revoked, unknown], next: cursor } });
    expect(host.querySelector('h1')?.textContent).toBe(m.entitlements_heading());
    expect(host.querySelector('header a')?.getAttribute('href')).toBe('/en/orders');
    const rows = [...host.querySelectorAll('ul > li')];
    expect(rows).toHaveLength(3);
    for (const [index, record] of [supplied, revoked, unknown].entries()) {
      const row = rows[index]!;
      const heading = row.querySelector('h2')!;
      const primary = row.querySelector('a')!;
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(row.getAttribute('data-entitlement-id')).toBe(record.id);
      expect(row.querySelectorAll('[data-content-item-slot="title"]')).toHaveLength(1);
      expect(heading.textContent).toBe(record.summary?.label?.value ?? m.entitlements_hidden_subject());
      expect(heading.getAttribute('lang')).toBe(record.summary?.label?.language ?? null);
      expect(heading.closest('[aria-hidden="true"]')).toBeNull();
      expect(primary.getAttribute('href')).toBe(`/en/entitlements/${record.id}`);
      expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(heading.id).not.toBe('');
      expect(primary.getAttribute('aria-label')).toBeNull();
      expect(primary.getAttribute('lang')).toBe(record.summary?.label?.language ?? null);
      expect(primary.tabIndex).toBe(0);
      expect(primary.getAttribute('aria-disabled')).toBeNull();
      expect(row.querySelectorAll('a')).toHaveLength(1);
      expect(primary.querySelector('a, button')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        record.active ? m.entitlements_active() : m.entitlements_revoked(),
      );
      const metadata = row.querySelector('[data-content-item-slot="metadata"]')!;
      expect(metadata.textContent).toContain(m.entitlements_granted());
      expect(metadata.querySelector('time')?.getAttribute('datetime')).toBe(record.grantedAt);
      expect(metadata.querySelector('time')?.textContent).toBe(
        new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(record.grantedAt)),
      );
      expect(row.querySelector('button, [data-content-item-slot="actions"]')).toBeNull();
    }
    const image = rows[0]!.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/media/supplied-entitlement-cover/webp-96');
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(rows[0]!.querySelector('[data-content-item-slot="metadata"]')?.textContent).toContain(m.benefit_heading());
    expect(rows[1]!.querySelector('[data-content-item-slot="metadata"]')?.textContent).toContain(m.benefit_heading());
    expect(rows[1]!.querySelector('[data-slot="cover"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(rows[2]!.querySelector('[data-content-item-slot="metadata"]')?.textContent).not.toContain(
      m.benefit_heading(),
    );
    expect(rows[2]!.querySelector('[data-slot="cover"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(rows[2]!.textContent).not.toContain(unknown.targetSubjectId);
    expect(host.querySelector('a[href*="/subjects/"], a[href*="/editions/"], a[download]')).toBeNull();

    // A revoked record still opens its historical record; the mapped label adds no use action.
    const destinations: string[] = [];
    const historicalLink = rows[1]!.querySelector('a')!;
    historicalLink.addEventListener('click', (event: Event) => {
      event.preventDefault();
      destinations.push(historicalLink.getAttribute('href')!);
    });
    historicalLink.click();
    expect(destinations).toEqual([`/en/entitlements/${revoked.id}`]);
    expect(host.querySelector('nav a')?.getAttribute('href')).toBe(
      '/en/entitlements?cursor=signed%2B%2Fcursor%3D%252F',
    );
    expect(host.querySelector('[role="alert"], [data-slot="empty"]')).toBeNull();

    show({ kind: 'ready', data: { entitlements: [], next: null } });
    expect(host.textContent).toContain(m.entitlements_empty());
    expect(host.textContent).not.toContain(m.entitlements_page_empty());
    expect(host.querySelector('nav')).toBeNull();
    show({ kind: 'ready', data: { entitlements: [], next: null } }, true);
    expect(host.textContent).toContain(m.entitlements_page_empty());
    expect(host.textContent).not.toContain(m.entitlements_empty());
    show({ kind: 'ready', data: { entitlements: [], next: cursor } });
    expect(host.textContent).toContain(m.entitlements_page_empty());
    expect(host.querySelector('nav a')?.getAttribute('href')).toBe(
      '/en/entitlements?cursor=signed%2B%2Fcursor%3D%252F',
    );

    show({ kind: 'unavailable' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.entitlements_unavailable());
    expect(host.querySelector('button')?.textContent).toBe(m.entitlements_retry());
    expect(host.querySelector('[data-slot="empty"], li[data-entitlement-id], nav')).toBeNull();
    show({ kind: 'preparing' });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.entitlements_preparing());
    expect(host.querySelector('[data-slot="empty"]')).toBeNull();
    show({ kind: 'denied' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.entitlements_denied());
    expect(host.querySelector('button, [data-slot="empty"]')).toBeNull();
    show({ kind: 'cursor-error' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.entitlements_cursor_error());
    const restart = host.querySelector('[role="alert"] a')!;
    expect(restart.getAttribute('href')).toBe('/en/entitlements');
    expect(restart.textContent).toBe(m.entitlements_restart());
    expect(host.querySelector('button, [data-slot="empty"]')).toBeNull();
  } finally {
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
  }
});
