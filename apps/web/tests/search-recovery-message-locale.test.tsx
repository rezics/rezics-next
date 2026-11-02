import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { SearchRecovery } from '../src/search/search-recovery-view';
import type { SearchRecoveryState } from '../src/search/search-recovery';

const retryHref = '/en/search?q=kept';
const restartHref = '/en/search?q=kept';
const options = { en: { locale: 'en' as const }, 'zh-Hans': { locale: 'zh-Hans' as const } };

function recoveryMarkup(locale: 'en' | 'zh-Hans', state: SearchRecoveryState) {
  return renderToStaticMarkup(createElement(SearchRecovery, { state, retryHref, restartHref, locale, onRetry() {} }));
}

test('search recovery messages and actions follow the owning locale against the opposite ambient language', () => {
  const previous = getLocale();
  setLocale('ja', { reload: false });
  try {
    const waiting = { status: 'index-not-ready' as const, retryAt: Date.now() + 60_000 };
    const english = recoveryMarkup('en', waiting);
    const chinese = recoveryMarkup('zh-Hans', waiting);
    expect(english).toContain(m.search_reader_results_unavailable({}, options.en));
    expect(english).toContain(m.search_facet_retry({}, options.en));
    expect(english).toContain(m.search_recovery_wait({}, options.en));
    expect(english).not.toContain(m.search_reader_results_unavailable());
    expect(chinese).toContain(m.search_reader_results_unavailable({}, options['zh-Hans']));
    expect(chinese).toContain(m.search_facet_retry({}, options['zh-Hans']));
    expect(chinese).toContain(m.search_recovery_wait({}, options['zh-Hans']));
    expect(chinese).not.toContain(m.search_reader_results_unavailable());

    const both = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(SearchRecovery, {
          state: { status: 'session' },
          retryHref,
          restartHref,
          locale: 'en',
        }),
        createElement(SearchRecovery, {
          state: { status: 'restart' },
          retryHref,
          restartHref,
          locale: 'zh-Hans',
        }),
        createElement(SearchRecovery, {
          state: { status: 'invalid', problem: { code: 'unsupported_query' } },
          retryHref,
          restartHref,
          locale: 'en',
        }),
        createElement(SearchRecovery, {
          state: { status: 'invalid' },
          retryHref,
          restartHref,
          locale: 'zh-Hans',
        }),
      ),
    );
    expect(both).toContain(m.search_recovery_session({}, options.en));
    expect(both).toContain(m.account_sign_in({}, options.en));
    expect(both).toContain(`/auth/sign-in?return_to=${encodeURIComponent(retryHref)}`);
    expect(both).toContain(m.discovery_restart({}, options['zh-Hans']));
    expect(both).toContain(m.discovery_restart_action({}, options['zh-Hans']));
    expect(both).toContain(m.discovery_unsupported({}, options.en));
    expect(both).toContain(m.search_recovery_edit({}, options.en));
    expect(both).toContain(m.discovery_invalid({}, options['zh-Hans']));
    expect(both).toContain(m.search_recovery_edit({}, options['zh-Hans']));
    expect(both).not.toContain(m.search_recovery_session());
    expect(both).not.toContain(m.discovery_restart());
    expect(getLocale()).toBe('ja');
  } finally {
    setLocale(previous, { reload: false });
  }
});

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/ja/search' });
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { DiscoveryKinds } = await import('../src/search/discovery-kinds');
type Props = ComponentProps<typeof DiscoveryKinds>;
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;

function kinds(): Props['initial'] {
  return {
    values: [{ id: 'schema:Book', labels: { en: 'Book', 'zh-Hans': '书' }, icon: 'book' }],
    next: 'cursor-1',
  };
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined!;
  host.replaceChildren();
});

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('kind continuation recovery text follows each instance locale through the shared helper', async () => {
  const previous = getLocale();
  setLocale('ja', { reload: false });
  try {
    root = createRoot(host);
    await act(async () =>
      root.render(
        <form onSubmit={(event) => event.preventDefault()}>
          <DiscoveryKinds
            initial={kinds()}
            selected={[]}
            locale="en"
            hydrated
            load={async () => ({
              status: 'unavailable',
              recovery: { status: 'unavailable', retryAt: Date.now() + 60_000 },
            })}
          />
          <DiscoveryKinds
            initial={kinds()}
            selected={[]}
            locale="zh-Hans"
            hydrated
            load={async () => ({ status: 'unavailable', recovery: { status: 'session' } })}
          />
        </form>,
      ),
    );
    const more = [m.discovery_more_kinds({}, options.en), m.discovery_more_kinds({}, options['zh-Hans'])];
    await act(async () => {
      for (const button of [...host.querySelectorAll('button')].filter((value) => more.includes(value.textContent!)))
        button.click();
    });
    expect(host.textContent).toContain(m.search_reader_results_unavailable({}, options.en));
    expect(host.textContent).toContain(m.search_recovery_wait({}, options.en));
    expect(host.textContent).toContain(m.search_recovery_session({}, options['zh-Hans']));
    expect(host.textContent).not.toContain(m.search_reader_results_unavailable());
    expect(host.textContent).not.toContain(m.search_recovery_session());
    expect(getLocale()).toBe('ja');
  } finally {
    setLocale(previous, { reload: false });
  }
});
