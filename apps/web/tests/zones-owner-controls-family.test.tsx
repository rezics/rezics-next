// Authored UNRUN. Mounted DOM and supplied-data witnesses are not measured geometry,
// browser, native authorization/lifecycle, private SSR or physical growth proof.
import { afterAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { UI_LOCALES } from '@rezics/composition';
import type { ListOutcome, OwnedZone } from '../src/features/zones/manage/model';

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
  Document: window.Document,
  ShadowRoot: window.ShadowRoot,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  NodeFilter: window.NodeFilter,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  CSS: window.CSS,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const { createRoot } = await import('react-dom/client');
const { QueryClient } = await import('@tanstack/react-query');
const { ZonesOwnerWorkspace } = await import('../src/features/zones/manage/workspace');
const { OwnerLifetime } = await import('../src/features/zones/editor/owner-lifetime');
const { sessionQuery } = await import('../src/session/query');
const { fixtureZone, fixtureZoneId, zonesFixture } = await import('../src/features/zones/manage/fixtures');
const { pageLimit, listHref, zonePaths } = await import('../src/features/zones/manage/model');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const initialLocale = getLocale();
const options = { locale: 'en' as const };
const longName = '読書と旅の記録 — مكتبة الرحلات والقراءة — Carnets de lecture et de voyage';
const trashZone = fixtureZone(true);
const deadline = trashZone.restoreUntil!;
const cursor = 'opaque+/cursor==';

afterAll(async () => {
  setLocale(initialLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const settle = (action: () => void | Promise<unknown>) =>
  act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await settle(() => {});
  expect(predicate()).toBe(true);
}
function button(scope: ParentNode, text: string) {
  const control = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
  if (!control) throw new Error(`Missing button: ${text}`);
  return control;
}
function link(scope: ParentNode, text: string) {
  const control = [...scope.querySelectorAll<HTMLAnchorElement>('a')].find((node) => node.textContent === text);
  if (!control) throw new Error(`Missing link: ${text}`);
  return control;
}
function page(zones: OwnedZone[], next: string | null = cursor): ListOutcome {
  return { kind: 'ready', page: { zones, next } };
}
function wrappingControl(control: Element) {
  // Source intent only; these assertions deliberately make no pixel-size claim.
  expect(control.className).toContain('whitespace-normal');
  expect(control.className).toContain('pointer-coarse:min-h-11');
  expect(control.className).toContain('pointer-coarse:min-w-11');
  expect(control.className).toContain('max-md:min-h-11');
  expect(control.className).toContain('focus-visible:outline-2');
}
async function mounted() {
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document });
  return {
    host,
    user,
    render: (node: ReactNode) => root.render(node),
    show: (node: ReactNode) => settle(() => root.render(node)),
    async close() {
      await settle(() => root.unmount());
      host.remove();
    },
  };
}

test('complete active/trash family retains full names, exact UTC deadlines, fallback language and independent destinations', async () => {
  const view = await mounted();
  const api = zonesFixture('empty');
  try {
    let generation = 0;
    for (const locale of UI_LOCALES) {
      for (const width of [390, 1280]) {
        for (const deleted of [false, true]) {
          const zones: OwnedZone[] = [
            { ...(deleted ? trashZone : fixtureZone()), labels: { ja: longName }, primaryLanguage: 'ja' },
            {
              ...fixtureZone(deleted),
              id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e71',
              labels: {},
              ...(deleted ? { deletedAt: '2019-12-02T00:00:00.000Z' } : {}),
              restoreUntil: deleted ? '2020-01-01T00:00:00.000Z' : null,
            },
            { ...fixtureZone(deleted), id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e72', restoreUntil: null },
          ];
          await view.show(
            <div lang={locale} dir="rtl" style={{ width }}>
              <ZonesOwnerWorkspace
                key={++generation}
                locale={locale}
                input={{ deleted, cursor }}
                outcome={page(zones)}
                onChange={api.change}
                onReload={() => {
                  throw new Error('No automatic reload');
                }}
              />
            </div>,
          );
          const local = { locale };
          const article = view.host.querySelector('article')!;
          expect(article.parentElement?.getAttribute('dir')).toBe('rtl');
          expect(article.parentElement?.getAttribute('lang')).toBe(locale);
          const rows = [...article.querySelectorAll('li')];
          expect(rows).toHaveLength(3);
          expect(rows[0]!.querySelector('h2')?.textContent).toBe(longName);
          expect(rows[0]!.querySelector('h2')?.getAttribute('lang')).toBe('ja');
          expect(rows[0]!.className).toContain('[&_[data-content-item-slot=title]]:line-clamp-none');
          expect(rows[1]!.querySelector('h2')?.textContent).toBe(m.zones_owner_unnamed({}, local));
          expect(rows[1]!.querySelector('h2')?.hasAttribute('lang')).toBe(false);
          expect(article.textContent).toContain(m.zones_owner_intro({}, local));
          expect(article.querySelectorAll('a a, a button, button a')).toHaveLength(0);
          const nav = article.querySelector('nav')!;
          expect(nav.getAttribute('aria-label')).toBe(m.zones_owner_views({}, local));
          expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe(
            deleted ? m.zones_owner_trash({}, local) : m.zones_owner_active({}, local),
          );
          expect(link(nav, m.zones_owner_active({}, local)).getAttribute('href')).toBe(
            listHref(locale, { deleted: false }),
          );
          expect(link(nav, m.zones_owner_trash({}, local)).getAttribute('href')).toBe(
            listHref(locale, { deleted: true }),
          );
          expect(link(article, m.zones_owner_create({}, local)).getAttribute('href')).toBe(zonePaths(locale).create);
          const next = link(article, m.zones_owner_next({}, local));
          expect(next.getAttribute('href')).toBe(listHref(locale, { deleted, cursor }));
          expect(link(article, m.zones_owner_start({}, local)).getAttribute('href')).toBe(
            listHref(locale, { deleted }),
          );
          for (const control of article.querySelectorAll('nav a, nav button, header a')) wrappingControl(control);
          wrappingControl(next);
          wrappingControl(link(article, m.zones_owner_start({}, local)));
          if (deleted) {
            expect(article.textContent).toContain(m.zones_owner_trash_help({}, local));
            for (const row of rows) expect(row.querySelector('a')).toBeNull();
            const time = rows[0]!.querySelector('time')!;
            expect(time.getAttribute('datetime')).toBe(deadline);
            expect(time.textContent).toBe(
              new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'long',
                timeZone: 'UTC',
              }).format(new Date(deadline)),
            );
            expect(button(rows[0]!, m.zones_owner_restore({}, local)).disabled).toBe(false);
            for (const row of rows.slice(1)) {
              expect(button(row, m.zones_owner_restore({}, local)).disabled).toBe(true);
              expect(row.querySelector('[role="status"]')?.textContent).toBe(m.zones_owner_expired({}, local));
            }
          } else {
            const primary = rows[0]!.querySelector('a[data-slot="list-row-link"]')!;
            expect(primary.getAttribute('href')).toBe(zonePaths(locale, fixtureZoneId).edit);
            expect(primary.getAttribute('aria-label')).toBe(m.zones_owner_configure_named({ title: longName }, local));
            expect(link(rows[0]!, m.zones_owner_open({}, local)).getAttribute('href')).toBe(
              zonePaths(locale, fixtureZoneId).reader,
            );
            expect(link(rows[0]!, m.zones_owner_configure({}, local)).getAttribute('href')).toBe(
              zonePaths(locale, fixtureZoneId).edit,
            );
            expect(rows[0]!.querySelector('[data-content-item-slot="actions"]')?.closest('a')).toBeNull();
          }
          for (const control of article.querySelectorAll(
            '[data-content-item-slot="actions"] a, [data-content-item-slot="actions"] button',
          ))
            wrappingControl(control);
        }
      }
    }
    expect(api.calls).toEqual([]);
  } finally {
    await view.close();
  }
});

test('keyboard confirmation cancels to its own trigger then confirms only that independent workspace', async () => {
  const view = await mounted();
  const first = zonesFixture();
  const second = zonesFixture();
  const firstPage = first.initial();
  firstPage.page.zones[0] = { ...firstPage.page.zones[0]!, labels: { ja: longName }, primaryLanguage: 'ja' };
  let reloads = 0;
  const destinations: string[] = [];
  view.host.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor) {
      destinations.push(anchor.getAttribute('href')!);
      event.preventDefault();
    }
  });
  try {
    await view.show(
      <>
        <ZonesOwnerWorkspace
          locale="en"
          input={{ deleted: false }}
          outcome={firstPage}
          onChange={first.change}
          onReload={() => {
            reloads++;
          }}
        />
        <ZonesOwnerWorkspace
          locale="en"
          input={{ deleted: false }}
          outcome={second.initial()}
          onChange={second.change}
          onReload={() => {
            throw new Error('Other instance reloaded');
          }}
        />
      </>,
    );
    const [one, two] = [...view.host.querySelectorAll('article')];
    const titles = [...view.host.querySelectorAll('h2')];
    expect(new Set(titles.map((title) => title.id)).size).toBe(titles.length);
    const row = one!.querySelector('li')!;
    (row.querySelector('a[data-slot="list-row-link"]') as HTMLElement).focus();
    await settle(() => view.user.tab());
    expect(document.activeElement).toBe(link(row, m.zones_owner_open({}, options)));
    await settle(() => view.user.keyboard('{Enter}'));
    await settle(() => view.user.tab());
    expect(document.activeElement).toBe(link(row, m.zones_owner_configure({}, options)));
    await settle(() => view.user.keyboard('{Enter}'));
    await settle(() => view.user.tab());
    const trigger = button(row, m.zones_owner_trash_action({}, options));
    expect(document.activeElement).toBe(trigger);
    expect(destinations).toEqual([zonePaths('en', fixtureZoneId).reader, zonePaths('en', fixtureZoneId).edit]);
    await settle(() => view.user.keyboard('{Enter}'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(title.textContent).toBe(m.zones_owner_confirm_title({ title: longName }, options));
    expect(title.className).toContain('[overflow-wrap:anywhere]');
    expect(description.textContent).toBe(m.zones_owner_confirm_description({}, options));
    expect(first.calls).toEqual([]);
    const cancel = button(dialog, m.zones_owner_cancel({}, options));
    wrappingControl(cancel);
    wrappingControl(button(dialog, m.zones_owner_trash_action({}, options)));
    cancel.focus();
    await settle(() => view.user.keyboard('{Enter}'));
    await until(() => document.activeElement === trigger);
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([]);
    await settle(() => view.user.keyboard('{Enter}'));
    const reopened = document.querySelector('[role="alertdialog"]')!;
    button(reopened, m.zones_owner_trash_action({}, options)).focus();
    await settle(() => view.user.keyboard('{Enter}'));
    await until(() => one!.textContent?.includes(m.zones_owner_trashed({}, options)) === true);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]).toMatchObject({
      method: 'DELETE',
      path: `/v1/zones/${fixtureZoneId}`,
      match: '"3"',
      body: null,
    });
    expect(reloads).toBe(1);
    expect(second.calls).toEqual([]);
    expect(two!.querySelectorAll('li')).toHaveLength(2);
    expect(one!.querySelectorAll('li')).toHaveLength(1);
  } finally {
    await view.close();
  }
});

test('empty, denied, stale, unavailable and other supported failures stay distinct and reload only explicitly', async () => {
  const view = await mounted();
  try {
    let generation = 0;
    for (const deleted of [false, true]) {
      await view.show(
        <ZonesOwnerWorkspace
          key={++generation}
          locale="en"
          input={{ deleted }}
          outcome={page([], null)}
          onChange={async () => {
            throw new Error('Empty page changed');
          }}
          onReload={() => {}}
        />,
      );
      expect(view.host.querySelector('h2')?.textContent).toBe(
        deleted ? m.zones_owner_empty_trash({}, options) : m.zones_owner_empty({}, options),
      );
      expect(view.host.querySelector('li, time, [role="alert"]')).toBeNull();
    }
    for (const kind of ['denied', 'actor', 'closed', 'missing', 'stale', 'unavailable', 'signed-out'] as const) {
      const api = zonesFixture();
      let reloads = 0;
      let outcome: ListOutcome = { kind };
      const key = ++generation;
      const render = () => (
        <ZonesOwnerWorkspace
          key={key}
          locale="en"
          input={{ deleted: false, cursor }}
          outcome={outcome}
          onChange={api.change}
          onReload={async () => {
            reloads++;
            outcome = await api.list({ deleted: false });
            view.render(render());
          }}
        />
      );
      await view.show(render());
      const message = {
        denied: m.zones_owner_denied,
        actor: m.zones_owner_actor,
        closed: m.zones_owner_closed,
        missing: m.zones_owner_missing,
        stale: m.zones_owner_stale,
        unavailable: m.zones_owner_unavailable,
        'signed-out': m.zones_owner_signed_out,
      }[kind];
      expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(message({}, options));
      expect(view.host.querySelector('li')).toBeNull();
      expect(api.calls).toEqual([]);
      if (kind === 'signed-out') {
        expect(link(view.host, m.zones_owner_sign_in({}, options)).getAttribute('href')).toBe(
          '/auth/sign-in?return_to=%2Fen%2Fmy%2Fzones',
        );
      } else {
        await settle(() => view.user.click(button(view.host, m.zones_owner_retry({}, options))));
        expect(reloads).toBe(1);
        expect(api.calls).toHaveLength(1);
        expect(view.host.querySelector('li')).not.toBeNull();
      }
    }
  } finally {
    await view.close();
  }
});

test('known mutation failures retain their native distinction and never announce success or automatically reload', async () => {
  const view = await mounted();
  try {
    for (const scenario of ['denied', 'conflict', 'fenced', 'missing'] as const) {
      const api = zonesFixture(scenario);
      let reloads = 0;
      await view.show(
        <ZonesOwnerWorkspace
          key={scenario}
          locale="en"
          input={{ deleted: false }}
          outcome={api.initial()}
          onChange={api.change}
          onReload={() => {
            reloads++;
          }}
        />,
      );
      await settle(() => view.user.click(button(view.host, m.zones_owner_trash_action({}, options))));
      await settle(() =>
        view.user.click(
          button(document.querySelector('[role="alertdialog"]')!, m.zones_owner_trash_action({}, options)),
        ),
      );
      const message =
        scenario === 'denied'
          ? m.zones_owner_denied
          : scenario === 'missing'
            ? m.zones_owner_missing
            : m.zones_owner_conflict;
      expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(message({}, options));
      expect(view.host.textContent).not.toContain(m.zones_owner_trashed({}, options));
      expect(reloads).toBe(0);
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]).toMatchObject({
        method: 'DELETE',
        path: `/v1/zones/${fixtureZoneId}`,
        match: '"3"',
        body: null,
      });
      expect(button(view.host, m.zones_owner_trash_action({}, options)).disabled).toBe(
        scenario === 'conflict' || scenario === 'fenced',
      );
      await settle(() => view.user.click(button(view.host, m.zones_owner_retry({}, options))));
      expect(reloads).toBe(1);
      expect(api.calls).toHaveLength(1);
      expect(view.host.querySelector('[role="alert"]')).toBeNull();
    }
  } finally {
    await view.close();
  }
});

test('uncertain delete replays the exact request and a fresh trash read restores through the native adapter', async () => {
  const view = await mounted();
  const api = zonesFixture('uncertain');
  let outcome = await api.list({ deleted: false });
  let deleted = false;
  let reloads = 0;
  const render = () => (
    <ZonesOwnerWorkspace
      key={String(deleted)}
      locale="en"
      input={{ deleted }}
      outcome={outcome}
      onChange={api.change}
      onReload={async () => {
        reloads++;
        outcome = await api.list({ deleted });
        view.render(render());
      }}
    />
  );
  try {
    await view.show(render());
    await settle(() => view.user.click(button(view.host, m.zones_owner_trash_action({}, options))));
    await settle(() =>
      view.user.click(button(document.querySelector('[role="alertdialog"]')!, m.zones_owner_trash_action({}, options))),
    );
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(m.zones_owner_unavailable({}, options));
    expect(reloads).toBe(0);
    expect(button(view.host, m.zones_owner_refresh({}, options)).disabled).toBe(true);
    const original = api.calls.find((call) => call.method === 'DELETE')!;
    expect(original.key).toMatch(/^[0-9a-f-]{36}$/);
    await settle(() => view.user.click(button(view.host, m.zones_owner_retry({}, options))));
    expect(api.calls.filter((call) => call.method === 'DELETE')).toEqual([original, original]);
    expect(reloads).toBe(1);
    expect(view.host.textContent).toContain(m.zones_owner_trashed({}, options));
    deleted = true;
    outcome = await api.list({ deleted });
    await view.show(render());
    const time = view.host.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-11-30T12:00:00.000Z');
    expect(view.host.querySelector('li a')).toBeNull();
    await settle(() => view.user.click(button(view.host, m.zones_owner_restore({}, options))));
    expect(api.calls.at(-2)).toMatchObject({
      method: 'POST',
      path: `/v1/zones/${fixtureZoneId}:restore`,
      match: '"4"',
      body: {},
    });
    expect(reloads).toBe(2);
    expect(view.host.textContent).toContain(m.zones_owner_restored({}, options));
  } finally {
    await view.close();
  }
});

test('stale owner retirement removes private controls and cannot reload or replay a retained uncertain command', async () => {
  const view = await mounted();
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'owner-A',
    csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
  });
  const owner = new OwnerLifetime(client, '/en/my/zones');
  const api = zonesFixture('uncertain');
  const capture = owner.capture()!;
  let reloads = 0;
  try {
    await view.show(
      <ZonesOwnerWorkspace
        locale="en"
        input={{ deleted: false }}
        owner={owner}
        outcome={{ ...api.initial(), ownerObservation: capture.observation }}
        onChange={async (command, admitted) => ({
          ...(await api.change(command)),
          ownerObservation: admitted!.observation,
        })}
        onReload={() => {
          reloads++;
        }}
      />,
    );
    await settle(() => view.user.click(button(view.host, m.zones_owner_trash_action({}, options))));
    await settle(() =>
      view.user.click(button(document.querySelector('[role="alertdialog"]')!, m.zones_owner_trash_action({}, options))),
    );
    const retry = button(view.host, m.zones_owner_retry({}, options));
    const propsKey = Object.keys(retry).find((key) => key.startsWith('__reactProps$'))!;
    const retainedClick = Reflect.get(retry, propsKey).onClick;
    const before = structuredClone(api.calls);
    await settle(() => {
      client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      const nativeEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      retainedClick({
        nativeEvent,
        target: retry,
        currentTarget: retry,
        get defaultPrevented() {
          return nativeEvent.defaultPrevented;
        },
        preventDefault: () => nativeEvent.preventDefault(),
        stopPropagation: () => nativeEvent.stopPropagation(),
        isPropagationStopped: () => false,
        isDefaultPrevented: () => nativeEvent.defaultPrevented,
        persist() {},
      });
    });
    expect(owner.isCurrent(capture)).toBe(false);
    expect(view.host.querySelector('li, nav, button')).toBeNull();
    expect(view.host.textContent).toBe(m.zones_owner_loading({}, options));
    expect(api.calls).toEqual(before);
    expect(reloads).toBe(0);
  } finally {
    await view.close();
    client.clear();
  }
});

test('a late saved receipt after route retirement cannot announce, focus or reload the old private visit', async () => {
  const view = await mounted();
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'owner-A',
    csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
  });
  const owner = new OwnerLifetime(client, '/en/my/zones');
  const capture = owner.capture()!;
  const api = zonesFixture();
  let release: (() => void) | undefined;
  let reloads = 0;
  try {
    await view.show(
      <ZonesOwnerWorkspace
        locale="en"
        input={{ deleted: false }}
        owner={owner}
        outcome={{ ...api.initial(), ownerObservation: capture.observation }}
        onChange={async (command, admitted) => {
          const response = await api.change(command);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ...response, ownerObservation: admitted!.observation };
        }}
        onReload={() => {
          reloads++;
        }}
      />,
    );
    await settle(() => view.user.click(button(view.host, m.zones_owner_trash_action({}, options))));
    await settle(() =>
      view.user.click(button(document.querySelector('[role="alertdialog"]')!, m.zones_owner_trash_action({}, options))),
    );
    await until(() => release !== undefined);
    expect(button(view.host, m.zones_owner_refresh({}, options)).disabled).toBe(true);
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      await settle(() => owner.end());
      outside.focus();
      await settle(() => release!());
      await settle(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(owner.isCurrent(capture)).toBe(false);
      expect(view.host.textContent).toBe(m.zones_owner_loading({}, options));
      expect(document.activeElement).toBe(outside);
      expect(reloads).toBe(0);
      expect(api.calls).toHaveLength(1);
    } finally {
      outside.remove();
    }
  } finally {
    release?.();
    await view.close();
    client.clear();
  }
});

test('supplied-data growth stays at 1/8/20 rows with zero render IO and one unchanged bounded continuation request', async () => {
  const view = await mounted();
  const api = zonesFixture();
  try {
    for (const count of [1, 8, pageLimit]) {
      const zones = Array.from({ length: count }, (_, index) => ({
        ...fixtureZone(),
        id: `0192f3a0-6c1e-7b2a-9d4e-${String(index).padStart(12, '0')}`,
        labels: { ja: longName },
        primaryLanguage: 'ja' as const,
      }));
      await view.show(
        <ZonesOwnerWorkspace
          key={count}
          locale="en"
          input={{ deleted: false }}
          outcome={page(zones)}
          onChange={api.change}
          onReload={() => {
            throw new Error('Hidden reload');
          }}
        />,
      );
      expect(view.host.querySelectorAll('li')).toHaveLength(count);
      expect(view.host.querySelectorAll('h2')).toHaveLength(count);
      expect(view.host.querySelectorAll('[data-content-item-slot="actions"]')).toHaveLength(count);
      expect(api.calls).toEqual([]);
      const next = link(view.host, m.zones_owner_next({}, options));
      expect(next.getAttribute('href')).toBe(listHref('en', { deleted: false, cursor }));
    }
    const next = new URL(link(view.host, m.zones_owner_next({}, options)).href);
    await api.list({ deleted: false, cursor: next.searchParams.get('cursor')! });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/v1/zones', body: null });
    expect(new URLSearchParams(api.calls[0]!.query).get('limit')).toBe('20');
    expect(new URLSearchParams(api.calls[0]!.query).get('cursor')).toBe(cursor);
    expect(new URLSearchParams(api.calls[0]!.query).get('deleted')).toBe('false');
    // This observes supplied rows and adapter requests, not database work. Native/backend
    // physical growth remains UNRUN; production still maps only the supplied bounded page.
  } finally {
    await view.close();
  }
});
