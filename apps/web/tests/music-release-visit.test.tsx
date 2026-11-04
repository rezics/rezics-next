import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { musicReleaseExample, musicAddress, recordingId, releaseId } from '../src/features/catalogue/music-release-reader/examples';
import type { MusicReleaseAddress } from '../src/features/catalogue/music-release-reader/model';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { MusicReleaseReader } = await import('../src/features/catalogue/music-release-reader/view');
const { m } = await import('../src/paraglide/messages.js');

async function mount() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example/en/subjects/release/harbour' });
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
  const render = async (props: Parameters<typeof MusicReleaseReader>[0] | null) => {
    await act(async () =>
      root.render(
        props ? createElement(QueryClientProvider, { client }, createElement(MusicReleaseReader, props)) : null,
      ),
    );
  };
  const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    await settle();
  };
  const close = async () => {
    await render(null);
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  };
  return { window, host, client, render, settle, click, close };
}

test('recording visit returns to its exact current stream, Context and row; Previous rereads and stale return retires', async () => {
  const ui = await mount();
  try {
    const fixture = musicReleaseExample();
    const initial = await fixture.read();
    if (!initial.ok) throw new Error('Expected current release page');
    const addresses: MusicReleaseAddress[] = [];
    const transport = (address: MusicReleaseAddress) => {
      addresses.push(address);
      return fixture.read(address);
    };
    const props = { ...musicAddress, locale: 'en', source: {}, reader: null, initial, transport };
    await ui.render(props);
    const target = Array.from(ui.host.querySelectorAll<HTMLAnchorElement>('a')).find(
      (node) => node.textContent === m.album_tracks_open(),
    )!;
    const targetUrl = new URL(target.href);
    const returned = new URL(targetUrl.searchParams.get('via')!, 'https://site.example');
    expect(targetUrl.pathname).toBe(`/en/subjects/${recordingId}/harbour`);
    expect(targetUrl.searchParams.get('context')).toBe(musicAddress.context);
    expect(returned.searchParams.get('context')).toBe(musicAddress.context);
    expect(returned.searchParams.get('musicReturnStream')).toBe('forward:schema:track');
    expect(returned.searchParams.get('musicReturnHolder')).toBe(releaseId);
    expect(returned.searchParams.get('musicReturnStatement')).toBeTruthy();
    await ui.click(m.work_parts_more());
    await ui.click(m.album_tracks_previous());
    expect(addresses.at(-1)).toMatchObject({ expectedRevision: 1, stream: 'forward:schema:track' });
    expect(ui.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);

    await ui.render(null);
    ui.window.history.replaceState({}, '', returned.pathname + returned.search + returned.hash);
    await ui.render({ ...props, initial: undefined });
    await ui.settle();
    expect(addresses.at(-1)).toMatchObject({ expectedRevision: 1, expectedDigest: fixture.release.digest });
    expect((document.activeElement as HTMLElement).dataset.statementId).toBe(
      returned.searchParams.get('musicReturnStatement'),
    );

    await ui.render(null);
    fixture.publicRead.subject.revision = 2;
    await ui.render({ ...props, initial: undefined });
    await ui.settle();
    expect(ui.host.textContent).toContain(m.music_release_changed());
    expect(ui.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    await ui.click(m.work_parts_restart());
    expect(addresses.at(-1)).toEqual({ id: releaseId, context: musicAddress.context });
    expect(ui.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);
  } finally {
    await ui.close();
  }
});
