import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  albumTrackExample,
  exampleAddress,
  exampleAlbum,
} from '../src/features/catalogue/album-track-reader/examples';
import type { AlbumTrackRead, AlbumTrackTransport } from '../src/features/catalogue/album-track-reader/model';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { AlbumTrackReader } = await import('../src/features/catalogue/album-track-reader/view');
const { m } = await import('../src/paraglide/messages.js');

async function ui() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example/en/subjects/album/title' });
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
  const render = async (props: Parameters<typeof AlbumTrackReader>[0]) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(AlbumTrackReader, props)));
    });
  };
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    button.focus();
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
  return { host, client, render, click, close };
}

test('Previous retains only eight exact prior addresses; Start and Retry perform deliberate reads', async () => {
  const mounted = await ui();
  try {
    const fixture = albumTrackExample();
    const admitted = await fixture.read();
    if (!admitted.ok || !admitted.stream) throw new Error('Expected admitted album contents');
    const initial = { ...admitted, next: 'cursor-1' };
    const addresses: { id: string; context: string; stream?: string; cursor?: string }[] = [];
    const transport: AlbumTrackTransport = (address) => {
      addresses.push({ ...address });
      const pageNumber = address.cursor ? Number(address.cursor.slice('cursor-'.length)) : 0;
      return Promise.resolve({ ...initial, next: pageNumber < 12 ? `cursor-${pageNumber + 1}` : null });
    };
    await mounted.render({ ...exampleAddress, locale: 'en', source: {}, reader: null, transport, initial });
    await mounted.click(m.work_parts_more());
    for (let page = 2; page <= 9; page++) await mounted.click(m.work_parts_more());
    expect(addresses.map((address) => address.cursor)).toEqual(Array.from({ length: 9 }, (_, index) => `cursor-${index + 1}`));
    const previous = () => Array.from(mounted.host.querySelectorAll('button')).find(
      (button) => button.textContent === m.album_tracks_previous(),
    )!;
    expect(previous().disabled).toBe(false);
    for (let count = 0; count < 8; count++) await mounted.click(m.album_tracks_previous());
    expect(addresses.slice(9).map((address) => address.cursor)).toEqual(
      Array.from({ length: 8 }, (_, index) => `cursor-${8 - index}`),
    );
    expect(previous().disabled).toBe(true);
    await mounted.click(m.work_parts_restart());
    expect(addresses.at(-1)).toEqual({ ...exampleAddress, stream: initial.stream.key });
    expect(previous().disabled).toBe(false);
  } finally {
    await mounted.close();
  }
});

test('failed continuation retries its exact address and retired viewer work cannot restore old contents', async () => {
  const mounted = await ui();
  try {
    const fixture = albumTrackExample();
    const admitted = await fixture.read();
    if (!admitted.ok || !admitted.stream) throw new Error('Expected admitted album contents');
    const initial = { ...admitted, next: 'retry-cursor' };
    const addresses: { id: string; context: string; stream?: string; cursor?: string }[] = [];
    let recover = false;
    let finish!: (result: AlbumTrackRead) => void;
    const delayed = new Promise<AlbumTrackRead>((resolve) => {
      finish = resolve;
    });
    const transport: AlbumTrackTransport = (address) => {
      addresses.push({ ...address });
      if (address.cursor === 'retry-cursor' && !recover) return Promise.resolve({ ok: false, reason: 'unavailable' });
      if (address.cursor === 'delayed-cursor') return delayed;
      return Promise.resolve({ ...initial, next: 'retry-cursor' });
    };
    const source = {};
    const props = { ...exampleAddress, locale: 'en', source, reader: null, initial, transport };
    await mounted.render(props);
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.album_tracks_next_unavailable());
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(initial.rows.length);
    recover = true;
    await mounted.click(m.album_tracks_retry());
    expect(addresses[1]).toEqual(addresses[0]);
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(initial.rows.length);

    const delayedProps = { ...props, source: {}, transport: () => delayed };
    await mounted.render(delayedProps);
    await mounted.click(m.work_parts_more());
    await act(async () => {
      mounted.client.setQueryData(['session'], { state: 'signed-in', subject: exampleAlbum, csrfToken: 'changed' });
      mounted.client.setQueryData(['session'], { state: 'signed-out' });
    });
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(0);
    expect(mounted.host.textContent).toContain(m.album_tracks_unavailable());
    expect(mounted.host.querySelector('a')?.href).toContain(`/en/subjects/${exampleAlbum}`);
    await act(async () => finish(initial));
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(0);

    const fresh = { ...props, source: {} };
    await mounted.render(fresh);
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(initial.rows.length);
    await mounted.render({ ...fresh, locale: 'ja' });
    await mounted.render(fresh);
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(0);
    expect(mounted.host.querySelector('a')?.textContent).toBe(m.album_tracks_subject_recovery());
  } finally {
    await mounted.close();
  }
});
