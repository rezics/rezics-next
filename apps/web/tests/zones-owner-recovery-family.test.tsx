// UNRUN: mounted presentation/connected regressions; DOM/classes are not browser geometry evidence.
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { UI_LOCALES } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { ZoneFeedback } from '../src/features/zones/manage/feedback';
import { ZonesOwnerWorkspace } from '../src/features/zones/manage/workspace';
import { CreateZone } from '../src/features/zones/manage/create';
import { zonesFixture } from '../src/features/zones/manage/fixtures';
import type { Failure } from '../src/features/zones/manage/model';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

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
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
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
setLocale('en', { reload: false });
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function mounted(content: ReactNode, run: (host: HTMLDivElement) => Promise<void> | void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(content));
    await run(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
const messages = {
  'signed-out': m.zones_owner_signed_out,
  denied: m.zones_owner_denied,
  closed: m.zones_owner_closed,
  actor: m.zones_owner_actor,
  missing: m.zones_owner_missing,
  invalid: m.zones_owner_invalid,
  conflict: m.zones_owner_conflict,
  stale: m.zones_owner_stale,
  unavailable: m.zones_owner_unavailable,
};
const kinds = Object.keys(messages) as Failure['kind'][];
const longReturnTo = `/ja/my/zones/new?name=${'読書と旅の記録 مكتبة الرحلات & "<書棚>" +/#?'.repeat(8)}&cursor=opaque+/cursor==#names`;
function presentation(action: HTMLElement) {
  for (const token of [
    'inline-flex',
    'border',
    'h-auto',
    'max-w-full',
    'whitespace-normal',
    '[overflow-wrap:anywhere]',
    'focus-visible:outline-2',
    'focus-visible:outline-offset-2',
    'focus-visible:outline-ring',
    'max-md:min-h-11',
    'max-md:min-w-11',
    'pointer-coarse:min-h-11',
    'pointer-coarse:min-w-11',
  ])
    expect(action.classList.contains(token)).toBe(true);
  expect(action.classList.contains('truncate')).toBe(false);
  action.focus();
  expect(document.activeElement).toBe(action);
}

for (const locale of UI_LOCALES) {
  test(`${locale}: all nine failures retain exact full text and recovery precedence`, async () => {
    for (const kind of kinds) {
      for (const supplied of [false, true]) {
        for (const returnTo of [undefined, longReturnTo]) {
          const retry = mock(() => {});
          await mounted(
            <div lang={locale} dir="rtl">
              <ZoneFeedback
                failure={{ kind }}
                locale={locale}
                {...(supplied ? { onRetry: retry } : {})}
                {...(returnTo === undefined ? {} : { returnTo })}
              />
            </div>,
            async (host) => {
              const alert = host.querySelector('[role="alert"]')!;
              expect(alert.tagName).toBe('DIV');
              expect(alert.parentElement?.lang).toBe(locale);
              expect(alert.closest('[dir]')?.getAttribute('dir')).toBe('rtl');
              expect(alert.querySelector('p')?.textContent).toBe(messages[kind]({}, { locale }));
              expect(alert.querySelector('p')?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
              expect(alert.querySelector('p')?.classList.contains('whitespace-normal')).toBe(true);
              expect(alert.querySelector('p')?.className).not.toContain('line-clamp');
              expect(alert.querySelector('details, [role="status"], [role="button"]')).toBeNull();
              expect(retry).not.toHaveBeenCalled();
              const anchors = alert.querySelectorAll('a');
              const buttons = alert.querySelectorAll('button');
              const destination = returnTo ?? `/${locale}/my/zones`;
              if (kind === 'signed-out' || (!supplied && kind === 'unavailable')) {
                expect(anchors).toHaveLength(1);
                expect(buttons).toHaveLength(0);
                const anchor = anchors[0]!;
                expect(anchor.getAttribute('href')).toBe(
                  kind === 'signed-out' ? `/auth/sign-in?return_to=${encodeURIComponent(destination)}` : destination,
                );
                expect(anchor.textContent).toBe(
                  kind === 'signed-out' ? m.zones_owner_sign_in({}, { locale }) : m.zones_owner_retry({}, { locale }),
                );
                expect(anchor.hasAttribute('role')).toBe(false);
                expect(anchor.hasAttribute('type')).toBe(false);
                if (kind === 'signed-out') expect(new URL(anchor.href).searchParams.get('return_to')).toBe(destination);
                presentation(anchor);
                // Focus never invokes the lower-precedence callback or navigates.
                expect(retry).not.toHaveBeenCalled();
              } else if (supplied) {
                expect(anchors).toHaveLength(0);
                expect(buttons).toHaveLength(1);
                presentation(buttons[0]!);
                expect(buttons[0]!.textContent).toBe(m.zones_owner_retry({}, { locale }));
                await act(async () => buttons[0]!.click());
                expect(retry).toHaveBeenCalledTimes(1);
                expect(host.querySelector('[role="alert"]')).toBe(alert);
                expect(alert.querySelector('p')?.textContent).toBe(messages[kind]({}, { locale }));
              } else {
                expect(anchors).toHaveLength(0);
                expect(buttons).toHaveLength(0);
              }
            },
          );
        }
      }
    }
  });
}

test('recovery preserves the shared Button implicit native type and form behavior', async () => {
  const retry = mock(() => {});
  const submit = mock(() => {});
  await mounted(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Button variant="outline">baseline</Button>
      <ZoneFeedback failure={{ kind: 'unavailable' }} locale="en" onRetry={retry} />
    </form>,
    async (host) => {
      const [baseline, recovery] = [...host.querySelectorAll('button')];
      expect(recovery!.getAttribute('type')).toBe(baseline!.getAttribute('type'));
      expect(recovery!.type).toBe(baseline!.type);
      await act(async () => recovery!.click());
      expect(retry).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    },
  );
});

test('independent supplied mounts grow at 1/8/32 with no IO and one explicit local invocation', async () => {
  const originalFetch = globalThis.fetch;
  const fetch = mock(() => Promise.reject(new Error('Presentation must not request data')));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  try {
    for (const count of [1, 8, 32]) {
      const retries = Array.from({ length: count }, () => mock(() => {}));
      await mounted(
        <div dir="rtl" lang="ja">
          {retries.map((retry, index) => (
            <ZoneFeedback
              key={index}
              failure={{ kind: 'unavailable' }}
              locale="ja"
              onRetry={retry}
              returnTo={longReturnTo}
            />
          ))}
        </div>,
        async (host) => {
          expect(host.querySelectorAll('[role="alert"]')).toHaveLength(count);
          expect(host.querySelectorAll('button')).toHaveLength(count);
          expect(retries.every((retry) => retry.mock.calls.length === 0)).toBe(true);
          const action = host.querySelectorAll('button')[count - 1]!;
          presentation(action);
          await act(async () => action.click());
          expect(retries.map((retry) => retry.mock.calls.length)).toEqual(
            Array.from({ length: count }, (_, index) => (index === count - 1 ? 1 : 0)),
          );
          expect(fetch).not.toHaveBeenCalled();
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('connected owner recovery refreshes one native fixture page; ready and empty are separate', async () => {
  for (const scenario of ['denied', 'stale', 'unavailable', 'empty', 'list'] as const) {
    const api = zonesFixture(scenario);
    const reload = mock(async () => {
      await api.list({ deleted: false });
    });
    await mounted(
      <ZonesOwnerWorkspace
        locale="en"
        input={{ deleted: false }}
        outcome={scenario === 'list' || scenario === 'empty' ? api.initial() : { kind: scenario }}
        onChange={api.change}
        onReload={reload}
      />,
      async (host) => {
        expect(api.calls).toHaveLength(0);
        const alert = host.querySelector('[role="alert"]');
        if (scenario === 'list' || scenario === 'empty') {
          expect(alert).toBeNull();
          expect(host.textContent).toContain(scenario === 'empty' ? m.zones_owner_empty() : m.zones_owner_private());
        } else {
          expect(alert?.querySelector('p')?.textContent).toBe(messages[scenario]());
          const action = alert!.querySelector('button')!;
          presentation(action);
          await act(async () => action.click());
          expect(reload).toHaveBeenCalledTimes(1);
          expect(api.calls).toHaveLength(1);
          expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/v1/zones', body: null });
          expect(new URLSearchParams(api.calls[0]!.query).get('limit')).toBe('20');
        }
      },
    );
  }
});

test('connected starter sign-in and unavailable sessions preserve the actual create return destination', async () => {
  for (const session of ['signed-out', 'unavailable'] as const) {
    const api = zonesFixture();
    const navigate = mock(() => {});
    await mounted(<CreateZone locale="ja" session={session} onCreate={api.create} onNavigate={navigate} />, (host) => {
      const alert = host.querySelector('[role="alert"]')!;
      expect(alert.querySelector('button')).toBeNull();
      expect(alert.querySelector('a')?.getAttribute('href')).toBe(
        session === 'signed-out' ? '/auth/sign-in?return_to=%2Fja%2Fmy%2Fzones%2Fnew' : '/ja/my/zones/new',
      );
      presentation(alert.querySelector('a')!);
      expect(api.calls).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
    });
  }
});

test('separately mounted alerts keep callbacks and keyboard focus independent', async () => {
  const first = mock(() => {});
  const second = mock(() => {});
  await mounted(<ZoneFeedback failure={{ kind: 'conflict' }} locale="de" onRetry={first} />, async (one) => {
    await mounted(<ZoneFeedback failure={{ kind: 'missing' }} locale="ja" onRetry={second} />, async (two) => {
      presentation(one.querySelector('button')!);
      await act(async () => one.querySelector('button')!.click());
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
      presentation(two.querySelector('button')!);
      expect(one.querySelector('p')?.textContent).toBe(m.zones_owner_conflict({}, { locale: 'de' }));
      await act(async () => two.querySelector('button')!.click());
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledTimes(1);
    });
  });
});

test('actual route failure retries only explicit invalidation and keeps private thrown text out of the alert', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } =
    await import('@tanstack/react-router');
  const { ZonesRouteError } = await import('../src/features/zones/manage/route-feedback');
  const { sessionQuery } = await import('../src/session/query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'fixture-owner',
    csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
  });
  let reads = 0;
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: '/my/zones',
    loader: () => {
      reads++;
      throw new Error('Private diagnostic must never appear');
    },
    errorComponent: ZonesRouteError,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/my/zones'] }),
  });
  try {
    await router.load();
    await mounted(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
      async (host) => {
        const alert = host.querySelector('[role="alert"]')!;
        expect(alert.querySelector('p')?.textContent).toBe(m.zones_owner_unavailable());
        expect(alert.querySelector('a,details')).toBeNull();
        expect(host.textContent).not.toContain('Private diagnostic');
        expect(reads).toBe(1);
        presentation(alert.querySelector('button')!);
        expect(reads).toBe(1);
        await act(async () => alert.querySelector('button')!.click());
        expect(reads).toBe(2);
      },
    );
  } finally {
    client.clear();
  }
});
