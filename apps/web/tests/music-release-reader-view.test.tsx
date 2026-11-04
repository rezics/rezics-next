import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  musicReleaseExample,
  musicAddress,
  releaseId,
  albumId,
  mediumId,
  recordingId,
} from '../src/features/catalogue/music-release-reader/examples';
import type { MusicReleaseRead, MusicReleaseTransport } from '../src/features/catalogue/music-release-reader/model';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { MusicReleaseReader } = await import('../src/features/catalogue/music-release-reader/view');
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
  const render = async (props: Parameters<typeof MusicReleaseReader>[0]) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(MusicReleaseReader, props)));
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

test('keyboard continuation retries the exact window and keeps target/correction return context', async () => {
  const mounted = await ui();
  try {
    const fixture = musicReleaseExample('continuation-unavailable');
    const initial = await fixture.read();
    const addresses: unknown[] = [];
    const transport: MusicReleaseTransport = (address) => {
      addresses.push(address);
      return fixture.read(address);
    };
    await mounted.render({ ...musicAddress, locale: 'en', source: {}, reader: null, transport, initial });
    const targets = Array.from(mounted.host.querySelectorAll<HTMLAnchorElement>('a')).filter(
      (node) => node.textContent === m.album_tracks_open(),
    );
    expect(targets.length).toBe(3);
    expect(targets.map((node) => node.href)).toEqual(
      [mediumId, recordingId, recordingId].map(
        (id) => `https://site.example/en/subjects/${id}/${id === mediumId ? 'disc-two' : 'harbour'}`,
      ),
    );
    expect(targets.every((node) => node.target === '_blank' && node.rel === 'noopener')).toBe(true);
    expect(mounted.host.textContent).toContain('Harbour sessions');
    expect(mounted.host.textContent).toContain('Japan');
    expect(mounted.host.textContent).toContain('May 2024');
    expect(mounted.host.textContent).toContain('CD');
    expect(mounted.host.querySelector(`a[href*="${albumId}"]`)).not.toBeNull();
    expect(mounted.host.textContent).toContain('source:unknown');
    expect(mounted.host.textContent).toContain('provider-side-02?');
    expect(mounted.host.querySelector(`a[href*="${releaseId}"][href$="relation-edit"]`)).not.toBeNull();
    targets[0]!.focus();
    targets[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(targets[0]);
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.music_release_next_unavailable());
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(3);
    fixture.recover();
    await mounted.click(m.album_tracks_retry());
    expect(addresses[1]).toEqual(addresses[0]);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    expect(mounted.host.textContent).toContain(m.album_tracks_complete());
    expect(document.activeElement?.textContent).toBe(m.music_release_title());
    const retained = mounted.host.textContent;
    const correction = Array.from(mounted.host.querySelectorAll<HTMLAnchorElement>('a')).find(
      (node) => node.textContent === m.music_release_correct(),
    )!;
    correction.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mounted.host.textContent).toBe(retained);
    expect(addresses.length).toBe(2);
  } finally {
    await mounted.close();
  }
});

test('replacement observations retire delayed continuations and removed keyboard targets without reviving on away/back', async () => {
  const mounted = await ui();
  try {
    const fixture = musicReleaseExample();
    const initial = await fixture.read();
    let finish!: (value: MusicReleaseRead) => void;
    const delayed = new Promise<MusicReleaseRead>((resolve) => {
      finish = resolve;
    });
    const source = {};
    const props = { ...musicAddress, locale: 'en', source, reader: null, initial, transport: () => delayed };
    await mounted.render(props);
    await mounted.click(m.work_parts_more());
    await act(async () => {
      mounted.client.setQueryData(['session'], { state: 'signed-in', subject: mediumId, csrfToken: 'changed' });
      mounted.client.setQueryData(['session'], { state: 'signed-out' });
    });
    expect(mounted.host.querySelectorAll('a').length).toBe(0);
    expect(mounted.host.textContent).toContain(m.music_release_unavailable());
    expect(document.activeElement?.textContent).toBe(m.music_release_title());
    await act(async () => {
      finish(await fixture.read());
    });
    expect(mounted.host.querySelectorAll('a').length).toBe(0);
    const fresh = { ...props, source: {} };
    await mounted.render(fresh);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(3);
    await mounted.render({ ...fresh, locale: 'ja' });
    expect(mounted.host.querySelectorAll('a').length).toBe(0);
    await mounted.render(fresh);
    expect(mounted.host.querySelectorAll('a').length).toBe(0);
  } finally {
    await mounted.close();
  }
});
