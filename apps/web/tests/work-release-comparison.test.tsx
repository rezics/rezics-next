import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { workReleaseComparisonExample } from '../src/features/catalogue/game-reader/comparison-example';
import type { GameReaderTransport } from '../src/features/catalogue/game-reader/model';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { GameReader } = await import('../src/features/catalogue/game-reader/view');
const { m } = await import('../src/paraglide/messages.js');

async function mounted() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example/en/subjects/game/harbour-game' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
  ];
  const values = [
    window,
    window.document,
    window.navigator,
    window.HTMLElement,
    window.Element,
    window.Node,
    window.Event,
    window.MouseEvent,
    window.MutationObserver,
  ];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  keys.forEach((key, index) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[index] }),
  );
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  const render = async (
    fixture: ReturnType<typeof workReleaseComparisonExample>,
    transport: GameReaderTransport = fixture.read,
  ) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(GameReader, {
            ...fixture.address,
            locale: 'en',
            realm: 'games',
            source: fixture,
            reader: null,
            transport,
          }),
        ),
      ),
    );
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
  };
  const close = async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  };
  return { host, render, click, close, window };
}

test('mounted comparison keeps advice failure separate, shows release roles and restores release-detail focus', async () => {
  const ui = await mounted();
  try {
    const fixture = workReleaseComparisonExample('advice-unavailable');
    let retire = false;
    const transport: GameReaderTransport = async (address) => {
      if (address.cursor && retire)
        fixture.respond({ ...fixture.last, workReleaseCards: { state: 'available', cards: [] } });
      return fixture.read(address);
    };
    await ui.render(fixture, transport);
    expect(ui.host.textContent).toContain(m.game_reader_advice_unavailable());
    expect(ui.host.textContent).toContain(m.game_reader_compare_title());
    expect(ui.host.textContent).toContain('Windows');
    expect(ui.host.textContent).toContain('ja');
    expect(ui.host.textContent).toContain('+2024-05');
    expect(ui.host.textContent).toContain('17');
    expect(ui.host.textContent).toContain('Harbour Digital');
    expect(ui.host.textContent).toContain('Original VN creator');
    expect(ui.host.textContent).toContain('Harbour Release Producer');
    expect(ui.host.textContent).toContain('Harbour Development');

    const destination = ui.host.querySelector<HTMLAnchorElement>('a[href*="/release?"]');
    expect(destination?.target).toBe('_blank');
    destination!.focus();
    await act(async () =>
      destination!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })),
    );
    destination!.blur();
    await act(async () => ui.window.dispatchEvent(new Event('focus')));
    expect(document.activeElement).toBe(destination);
    expect(ui.host.querySelector('[data-slot="work-release-comparison"]')).not.toBeNull();

    retire = true;
    await ui.click(m.work_parts_more());
    expect(ui.host.querySelector('[data-slot="work-release-comparison"]')).toBeNull();
    expect(ui.host.textContent).toContain(fixture.publicRead.subject.labels.en);
  } finally {
    await ui.close();
  }
});

test('mounted TBA and withheld age stay visible as distinct states', async () => {
  const ui = await mounted();
  try {
    const tba = workReleaseComparisonExample('tba');
    await ui.render(tba);
    expect(ui.host.textContent).toContain(m.release_fidelity_date_tba());
    await ui.render(workReleaseComparisonExample('withheld'));
    expect(ui.host.textContent).toContain(m.game_reader_compare_withheld());
    expect(ui.host.textContent).toContain('Harbour Digital');
  } finally {
    await ui.close();
  }
});
