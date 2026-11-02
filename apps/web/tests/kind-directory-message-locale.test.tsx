import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

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
const regions = [
  ['en', 'zh-Hans'],
  ['zh-Hans', 'en'],
] as const;
const options = { en: { locale: 'en' as const }, 'zh-Hans': { locale: 'zh-Hans' as const } };

function directory(next: string | null): Props['initial'] {
  return {
    values: [
      { id: 'schema:Book', labels: { ja: '本' }, icon: 'book', count: { kind: 'schema:Book', unavailable: true } },
    ],
    next,
  };
}

function props(locale: 'en' | 'zh-Hans', next: string | null, load: Props['load']): Props {
  return { initial: directory(next), selected: [], locale, hydrated: true, load };
}

function markup(locale: 'en' | 'zh-Hans', next: string | null) {
  return renderToStaticMarkup(
    createElement(
      DiscoveryKinds,
      props(locale, next, async () => ({ status: 'ready', kinds: directory(null) })),
    ),
  );
}

function copy(locale: 'en' | 'zh-Hans') {
  return [
    m.search_result_kinds({}, options[locale]),
    m.search_result_kinds_help({}, options[locale]),
    m.search_all_kinds({}, options[locale]),
    m.search_choose_kinds({}, options[locale]),
    m.discovery_count_unavailable({}, options[locale]),
    m.search_kind_choice({ value: '本' }, options[locale]),
  ];
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

test('type directory chrome follows each reader locale and keeps authored type labels', () => {
  const previous = getLocale();
  try {
    for (const [locale, ambient] of regions) {
      setLocale(ambient, { reload: false });
      const html = markup(locale, null);
      for (const text of copy(locale)) expect(html).toContain(text);
      for (const text of copy(ambient)) expect(html).not.toContain(text);
      expect(html).toContain(m.result_kind_window_end({}, options[locale]));
      expect(html).toContain(m.result_kind_window_restart({}, options[locale]));
      expect(html).not.toContain(m.result_kind_window_end({}, options[ambient]));
      expect(html).toContain('lang="ja">本<');
      expect(html).not.toContain(m.discovery_more_kinds({}, options[locale]));
      expect(markup(locale, 'cursor-1')).toContain(m.discovery_more_kinds({}, options[locale]));
      expect(getLocale()).toBe(ambient);
    }
    setLocale('ja', { reload: false });
    const both = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(
          DiscoveryKinds,
          props('en', null, async () => ({ status: 'ready', kinds: directory(null) })),
        ),
        createElement(
          DiscoveryKinds,
          props('zh-Hans', null, async () => ({ status: 'ready', kinds: directory(null) })),
        ),
      ),
    );
    expect(both).toContain(m.search_result_kinds({}, options.en));
    expect(both).toContain(m.search_result_kinds({}, options['zh-Hans']));
    expect(both).toContain(m.search_kind_choice({ value: '本' }, options.en));
    expect(both).toContain(m.search_kind_choice({ value: '本' }, options['zh-Hans']));
    expect(both).toContain(m.discovery_count_unavailable({}, options.en));
    expect(both).toContain(m.discovery_count_unavailable({}, options['zh-Hans']));
    expect(both).toContain(m.result_kind_window_end({}, options.en));
    expect(both).toContain(m.result_kind_window_end({}, options['zh-Hans']));
    expect(both).not.toContain(m.search_result_kinds());
    expect(getLocale()).toBe('ja');
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('type directory failure and continuation progress follow each instance locale', async () => {
  const previous = getLocale();
  setLocale('ja', { reload: false });
  try {
    root = createRoot(host);
    await act(async () =>
      root.render(
        <form onSubmit={(event) => event.preventDefault()}>
          <DiscoveryKinds key="legacy-en" {...props('en', 'cursor-1', async () => ({ status: 'unavailable' }))} />
          <DiscoveryKinds
            key="legacy-zh"
            {...props('zh-Hans', 'cursor-1', async () => ({
              status: 'unavailable',
              recovery: { status: 'session' },
            }))}
          />
        </form>,
      ),
    );
    await act(async () => {
      for (const locale of ['en', 'zh-Hans'] as const)
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === m.discovery_more_kinds({}, options[locale]))!
          .click();
    });
    expect(host.textContent).toContain(m.search_failed({}, options.en));
    expect(host.textContent).toContain(m.search_recovery_session({}, options['zh-Hans']));
    expect(host.textContent).not.toContain(m.search_failed());
    expect(host.textContent).not.toContain(m.search_recovery_session());

    const stalled = async () => ({ status: 'ready' as const, kinds: { values: [], next: 'x' } });
    await act(async () =>
      root.render(
        <form onSubmit={(event) => event.preventDefault()}>
          <DiscoveryKinds key="progress-en" {...props('en', 'cursor-1', stalled)} />
          <DiscoveryKinds key="progress-zh" {...props('zh-Hans', 'cursor-1', stalled)} />
        </form>,
      ),
    );
    await act(async () => {
      for (const locale of ['en', 'zh-Hans'] as const)
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === m.discovery_more_kinds({}, options[locale]))!
          .click();
    });
    expect(host.textContent).toContain(m.result_kind_window_progress({}, options.en));
    expect(host.textContent).toContain(m.result_kind_window_progress({}, options['zh-Hans']));
    expect(host.textContent).toContain(m.result_kind_window_restart({}, options.en));
    expect(host.textContent).toContain(m.result_kind_window_restart({}, options['zh-Hans']));
    expect(host.textContent).not.toContain(m.result_kind_window_progress());
    expect(getLocale()).toBe('ja');
  } finally {
    setLocale(previous, { reload: false });
  }
});
