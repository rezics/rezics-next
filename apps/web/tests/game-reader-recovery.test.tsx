import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { gameExample, editionId } from '../src/features/catalogue/game-reader/examples';
import type {
  GameReaderAddress,
  GameReaderRead,
  GameReaderTransport,
} from '../src/features/catalogue/game-reader/model';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { GameReader } = await import('../src/features/catalogue/game-reader/view');
const { m } = await import('../src/paraglide/messages.js');

async function ui() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example/en/subjects/game/harbour-game' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  const render = async (props: Parameters<typeof GameReader>[0]) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(GameReader, props)));
    });
  };
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    button.focus();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
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
  return { host, client, render, click, close };
}

test('Previous revisits accepted native addresses, Retry keeps the failed address and intent, and pending clicks cannot fabricate history', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    const first = await fixture.read();
    if (!first.ok) throw new Error('Example admission failed');
    const calls: GameReaderAddress[] = [];
    let fail = false;
    let deliver: ((page: GameReaderRead) => void) | undefined;
    let defer = false;
    const transport: GameReaderTransport = async (address) => {
      calls.push(address);
      if (defer)
        return new Promise((resolve) => {
          deliver = resolve;
        });
      if (fail) return { ok: false, reason: 'unavailable' };
      return { ...first, next: `page:${Number(address.cursor?.split(':')[1] ?? 0) + 1}` };
    };
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport });
    await mounted.click(m.work_parts_more());
    fail = true;
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain('Harbour Studio');
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.textContent).toContain(m.game_reader_failed_address());
    expect(mounted.host.textContent).not.toContain(m.game_reader_current_address());
    fail = false;
    await mounted.click(m.album_tracks_retry());
    expect(calls.slice(-2).map((address) => address.cursor)).toEqual(['page:2', 'page:2']);
    await mounted.click(m.game_reader_previous());
    expect(calls.at(-1)?.cursor).toBe('page:1');
    fail = true;
    await mounted.click(m.game_reader_previous());
    fail = false;
    await mounted.click(m.album_tracks_retry());
    expect(calls.slice(-2)).toEqual([fixture.address, fixture.address]);
    const previous = Array.from(mounted.host.querySelectorAll('button')).find(
      (node) => node.textContent === m.game_reader_previous(),
    )!;
    expect(previous.disabled).toBe(true);
    await mounted.click(m.game_reader_start());
    defer = true;
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.game_reader_requested());
    expect(mounted.host.textContent).toContain('page:1');
    const before = calls.length;
    await mounted.click(m.game_reader_start());
    await mounted.click(m.game_reader_previous());
    expect(calls.length).toBe(before);
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    await act(async () => {
      deliver!({ ...first, next: 'page:2' });
    });
    await mounted.click(m.game_reader_start());
    expect(calls.at(-1)).toEqual(fixture.address);
    await act(async () => {
      deliver!(first);
    });
    expect(previous.isConnected).toBe(true);
  } finally {
    await mounted.close();
  }
});

test('eight previous addresses evict oldest first and explicit revisits still consume the 64-window fence', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    const first = await fixture.read();
    if (!first.ok) throw new Error('Example admission failed');
    const calls: GameReaderAddress[] = [];
    const transport: GameReaderTransport = async (address) => {
      calls.push(address);
      return { ...first, next: `page:${Number(address.cursor?.split(':')[1] ?? 0) + 1}` };
    };
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport });
    for (let n = 0; n < 10; n++) await mounted.click(m.work_parts_more());
    for (let n = 0; n < 8; n++) await mounted.click(m.game_reader_previous());
    expect(calls.at(-1)?.cursor).toBe('page:2');
    const before = calls.length;
    await mounted.click(m.game_reader_previous());
    expect(calls.length).toBe(before);
    await mounted.click(m.game_reader_start());
    for (let n = 0; n < 62; n++) await mounted.click(m.work_parts_more());
    await mounted.click(m.game_reader_previous());
    const fence = calls.length;
    await mounted.click(m.game_reader_previous());
    expect(calls.length).toBe(fence);
    expect(mounted.host.textContent).toContain(m.game_reader_window_restart());
    await mounted.click(m.game_reader_start());
    expect(calls.at(-1)).toEqual(fixture.address);
  } finally {
    await mounted.close();
  }
});

test('equal-success replacement drops selection and reveal consent; tab return and completion respect later focus', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    const first = await fixture.read();
    if (!first.ok) throw new Error('Example admission failed');
    const props = {
      ...fixture.address,
      locale: 'en',
      realm: 'games',
      source: fixture,
      reader: null,
      transport: async () => first,
    };
    await mounted.render(props);
    await mounted.click(m.game_reader_inspect());
    expect(mounted.host.querySelector('[data-slot="game-edition-inspection"] h4') === document.activeElement).toBe(
      true,
    );
    const link = mounted.host.querySelector<HTMLAnchorElement>('[data-slot="game-edition-inspection"] a')!;
    expect(link.target).toBe('_blank');
    expect(link.href).toContain('realm=games');
    await act(async () => {
      link.focus();
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    const other = Array.from(mounted.host.querySelectorAll('button')).find(
      (node) => node.textContent === m.game_reader_start(),
    )!;
    await act(async () => {
      other.focus();
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.activeElement === other).toBe(true);
    await mounted.click(m.game_reader_close_inspection());
    expect(document.activeElement?.textContent).toBe(m.game_reader_inspect());
    await mounted.click(m.game_reader_inspect());
    await mounted.click(m.game_reader_start());
    expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBeNull();
    expect(mounted.host.textContent).toContain('Harbour trial');
    fixture.first.links[0]!.assertion!.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '2', unit: '1' } },
    });
    const hidden = await fixture.read();
    await mounted.render({ ...props, source: {}, transport: async () => hidden });
    await mounted.click(m.thread_reveal_spoiler());
    await mounted.click(m.game_reader_inspect());
    await mounted.click(m.game_reader_start());
    expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBeNull();
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
  } finally {
    await mounted.close();
  }
});

test('retired observation needs explicit fresh current-Subject recovery; old pending data cannot join it', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    let deliver!: (read: GameReaderRead) => void;
    let refreshes = 0;
    const props = {
      ...fixture.address,
      locale: 'en',
      realm: 'games',
      source: {},
      reader: null,
      transport: (() =>
        new Promise((resolve) => {
          deliver = resolve;
        })) as GameReaderTransport,
      refresh: async () => {
        refreshes++;
      },
    };
    await mounted.render(props);
    await act(async () => {
      mounted.client.setQueryData(['exposure', 'viewer'], { spoilerLevel: 2 });
    });
    expect(mounted.host.textContent).toContain(m.game_reader_retired());
    expect(mounted.host.textContent).not.toContain('Harbour');
    expect(mounted.host.querySelector('a[href*="/edit"]')).toBeNull();
    expect(mounted.host.querySelector('a[href*="/details"]')?.getAttribute('href')).toContain('realm=games');
    await mounted.click(m.game_reader_recover());
    expect(refreshes).toBe(1);
    expect(mounted.host.textContent).toContain(m.game_reader_retired());
    await mounted.render({ ...props, source: fixture, transport: fixture.read });
    await mounted.click(m.game_reader_inspect());
    await act(async () => {
      deliver({ ok: false, reason: 'withheld' });
    });
    expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).not.toBeNull();
    expect(mounted.host.textContent).toContain('Harbour trial');
  } finally {
    await mounted.close();
  }
});

test('invalid admission offers distinct deliberate Start and safe Details without an implicit read', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    await mounted.render({
      ...fixture.address,
      locale: 'en',
      source: fixture,
      reader: null,
      transport: fixture.read,
      initial: { ok: false, reason: 'invalid' },
    });
    expect(fixture.calls.length).toBe(0);
    expect(mounted.host.textContent).toContain(m.game_reader_invalid());
    expect(mounted.host.textContent).not.toContain(m.game_reader_unavailable());
    expect(mounted.host.querySelector('a[href*="/details"]')).not.toBeNull();
    expect(mounted.host.querySelector('a[href*="/edit"]')).toBeNull();
    await mounted.click(m.game_reader_start());
    expect(fixture.calls.length).toBe(2);
    expect(mounted.host.textContent).toContain('Harbour trial');
  } finally {
    await mounted.close();
  }
});
