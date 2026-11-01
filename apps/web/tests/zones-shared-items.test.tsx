import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UI_LOCALES } from '@rezics/composition';
import type { ListOutcome } from '../src/features/zones/manage/model';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/my/zones' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { ZonesOwnerWorkspace } = await import('../src/features/zones/manage/workspace');
const { fixtureZone, fixtureZoneId, zonesFixture } = await import('../src/features/zones/manage/fixtures');
const { m } = await import('../src/paraglide/messages.js');

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('active and trash supplied summaries share item semantics while keeping native destinations independent', () => {
  for (const locale of UI_LOCALES) {
    const options = { locale };
    const zone = { ...fixtureZone(), labels: { ja: '読書の記録' }, primaryLanguage: 'ja' as const };
    const host = document.createElement('div');
    const render = (deleted: boolean, restoreUntil: string | null = null) => {
      host.innerHTML = renderToStaticMarkup(
        <ZonesOwnerWorkspace
          locale={locale}
          input={{ deleted }}
          outcome={{
            kind: 'ready',
            page: {
              zones: [{ ...zone, deletedAt: deleted ? '2026-01-01T12:00:00.000Z' : null, restoreUntil }],
              next: 'opaque+/cursor==',
            },
          }}
          onChange={async () => ({ kind: 'unavailable' })}
          onReload={() => {}}
        />,
      );
      return host.querySelector('li')!;
    };
    const active = render(false);
    const title = active.querySelector('h2[data-content-item-slot="title"]');
    expect(title?.textContent).toBe('読書の記録');
    expect(title?.getAttribute('lang')).toBe('ja');
    const primary = active.querySelector('a[data-slot="list-row-link"]');
    expect(primary?.getAttribute('href')).toBe(`/${locale}/my/zones/${fixtureZoneId}/edit`);
    expect(primary?.getAttribute('aria-label')).toBe(m.zones_owner_configure_named({ title: '読書の記録' }, options));
    expect(primary?.querySelector('a, button')).toBeNull();
    const actions = active.querySelector('[data-content-item-slot="actions"]');
    expect(actions?.closest('a')).toBeNull();
    expect(actions?.querySelector(`a[href="/${locale}/zones/${fixtureZoneId}"]`)?.textContent).toBe(
      m.zones_owner_open({}, options),
    );
    expect(actions?.querySelector(`a[href="/${locale}/my/zones/${fixtureZoneId}/edit"]`)?.textContent).toBe(
      m.zones_owner_configure({}, options),
    );
    expect(actions?.querySelector('button')?.disabled).toBe(false);
    expect(active.querySelector('[data-content-item-slot="metadata"]')?.textContent).toContain(
      m.zones_owner_private({}, options),
    );

    const deadline = '2099-03-04T12:30:00.000Z';
    const trash = render(true, deadline);
    expect(trash.querySelector('h2[data-content-item-slot="title"]')?.textContent).toBe('読書の記録');
    expect(trash.querySelector('a')).toBeNull();
    expect(trash.querySelector('time')?.getAttribute('datetime')).toBe(deadline);
    expect(trash.querySelector('time')?.textContent).toBe(
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(
        new Date(deadline),
      ),
    );
    expect(trash.querySelector('[data-content-item-slot="actions"] button')?.disabled).toBe(false);
    const next = [...host.querySelectorAll('a')].find((link) => link.textContent === m.zones_owner_next({}, options));
    expect(new URL(next!.href).searchParams.get('cursor')).toBe('opaque+/cursor==');
    for (const expiredDeadline of ['2020-01-01T12:00:00.000Z', null]) {
      const expired = render(true, expiredDeadline);
      expect(expired.querySelector('a')).toBeNull();
      expect(expired.querySelector('[data-content-item-slot="actions"] button')?.disabled).toBe(true);
      expect(expired.querySelector('[role="status"]')?.textContent).toBe(m.zones_owner_expired({}, options));
    }

    zone.labels = {} as typeof zone.labels;
    const unnamed = render(false);
    expect(unnamed.querySelector('h2[data-content-item-slot="title"]')?.textContent).toBe(
      m.zones_owner_unnamed({}, options),
    );
  }
});

test('shared owner items confirm deletion, retry the identical uncertain request, and restore after a fresh read', async () => {
  const api = zonesFixture('uncertain');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const options = { locale: 'en' as const };
  let deleted = false;
  let outcome: ListOutcome = await api.list({ deleted });
  let reloads = 0;
  const render = () =>
    root.render(
      <ZonesOwnerWorkspace
        key={String(deleted)}
        locale="en"
        input={{ deleted }}
        outcome={outcome}
        onChange={api.change}
        onReload={async () => {
          reloads += 1;
          outcome = await api.list({ deleted });
          render();
        }}
      />,
    );
  async function settle(action: () => void) {
    await act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  function button(container: ParentNode, label: string) {
    const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found as HTMLButtonElement;
  }
  try {
    await settle(render);
    const trigger = button(
      host.querySelector('[data-content-item-slot="actions"]')!,
      m.zones_owner_trash_action({}, options),
    );
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await settle(() => trigger.click());
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    await settle(() => button(dialog, m.zones_owner_trash_action({}, options)).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.zones_owner_unavailable({}, options));
    const original = api.calls.find((call) => call.method === 'DELETE');
    expect(original).toMatchObject({ path: `/v1/zones/${fixtureZoneId}`, match: '"3"' });
    await settle(() => button(host, m.zones_owner_retry({}, options)).click());
    expect(api.calls.filter((call) => call.method === 'DELETE')).toEqual([original, original]);
    expect(reloads).toBe(1);
    expect(host.textContent).toContain(m.zones_owner_trashed({}, options));

    deleted = true;
    outcome = await api.list({ deleted });
    await settle(render);
    expect(host.querySelector('li a')).toBeNull();
    await settle(() => button(host, m.zones_owner_restore({}, options)).click());
    expect(api.calls.find((call) => call.path.endsWith(':restore'))).toMatchObject({ method: 'POST', match: '"4"' });
    expect(reloads).toBe(2);
    expect(host.textContent).toContain(m.zones_owner_restored({}, options));
  } finally {
    await settle(() => root.unmount());
    host.remove();
  }
});
