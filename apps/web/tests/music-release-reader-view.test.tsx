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
  recordingId,
} from '../src/features/catalogue/music-release-reader/examples';
import type {
  MusicReleaseAddress,
  MusicReleaseRead,
  MusicReleaseTransport,
} from '../src/features/catalogue/music-release-reader/model';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
let productionTransport: MusicReleaseTransport = async () => ({ ok: false, reason: 'unavailable' });
mock.module('../src/features/catalogue/music-release-reader/actions', () => ({
  loadMusicRelease: ({ data }: { data: MusicReleaseAddress }) => productionTransport(data),
}));
const { MusicReleaseOverview } = await import('../src/features/catalogue/music-release-reader/entry');
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
  const render = async (props: Parameters<typeof MusicReleaseReader>[0], provider = client) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: provider }, createElement(MusicReleaseReader, props)));
    });
  };
  const renderOverview = async (props: Parameters<typeof MusicReleaseOverview>[0]) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(MusicReleaseOverview, props)));
    });
  };
  const select = async (index: number, detail = 0) => {
    const row = host.querySelectorAll<HTMLElement>('[data-slot="music-release-row"]')[index];
    const details = row?.querySelector('details');
    if (details && !details.open) {
      await act(async () => {
        details.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      });
    }
    const button = row?.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error(`Missing occurrence: ${index}`);
    button.focus();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
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
  return { host, client, render, renderOverview, select, click, close };
}

test('select one repeated occurrence, inspect its evidence and return, retry Next and Previous at exact addresses', async () => {
  const mounted = await ui();
  try {
    const fixture = musicReleaseExample('continuation-unavailable');
    const original = fixture.first.relations[1]!.statement;
    original.rezics.release = `sha256:${'1'.repeat(64)}`;
    original.references.push({
      hash: 'second',
      parts: [
        {
          property: { id: 'source:other', data_type: 'string' },
          value: { type: 'value', content: 'independent group' },
        },
      ],
    });
    const initial = await fixture.read();
    const addresses: MusicReleaseAddress[] = [];
    const props = {
      ...musicAddress,
      locale: 'en',
      source: {
        actions: { status: 'ready', viewerActions: [{ action: 'subject:read', operations: ['subject.read'] }] },
        viewer: { context: musicAddress.context, actions: { statementPropose: 'allowed' } },
      },
      reader: null,
      initial,
      transport: async (address: MusicReleaseAddress) => {
        addresses.push(address);
        return fixture.read(address);
      },
    };
    await mounted.render(props);
    for (const text of ['Harbour sessions', 'Japan', 'May 2024', 'CD'])
      expect(mounted.host.textContent).toContain(text);
    expect(mounted.host.querySelector(`a[href*="${albumId}"]`)).not.toBeNull();
    expect(mounted.host.querySelector('[data-slot="music-release-inspection"]')).toBeNull();
    await mounted.select(1);
    const inspection = () => mounted.host.querySelector<HTMLElement>('[data-slot="music-release-inspection"]')!;
    expect(inspection().querySelector('[data-occurrence]')?.getAttribute('data-occurrence')).toBe(
      `${releaseId}:${original.id}`,
    );
    expect(mounted.host.querySelectorAll('[data-selected="true"]').length).toBe(1);
    expect(document.activeElement).toBe(inspection().querySelector('h3'));
    expect(inspection().textContent).not.toContain('source:unknown');
    expect(inspection().textContent).toContain('provider-side-02?');
    expect(inspection().textContent).toContain(m.release_fidelity_historical());
    expect(inspection().textContent).toContain(original.rezics.release);
    expect(inspection().querySelectorAll('[data-slot="music-release-reference"]').length).toBe(2);
    const target = Array.from(inspection().querySelectorAll('a')).find(
      (node) => node.textContent === m.album_tracks_open(),
    )!;
    const correction = Array.from(inspection().querySelectorAll('a')).find(
      (node) => node.textContent === m.album_tracks_correction(),
    )!;
    const targetUrl = new URL(target.href);
    expect(targetUrl.pathname).toBe(`/en/subjects/${recordingId}/harbour`);
    expect(targetUrl.searchParams.get('context')).toBe(musicAddress.context);
    const targetReturn = new URL(targetUrl.searchParams.get('via')!, 'https://site.example');
    expect(targetReturn.searchParams.get('musicReturnStream')).toBe('forward:schema:track');
    expect(targetReturn.searchParams.get('musicReturnHolder')).toBe(releaseId);
    expect(targetReturn.searchParams.get('musicReturnStatement')).toBe(original.id);
    expect(correction.href).toContain(`/en/subjects/${releaseId}/`);
    expect(new URL(correction.href).pathname).toEndWith('/relation-edit');
    for (const anchor of [target, correction]) {
      expect([anchor.target, anchor.rel]).toEqual(['_blank', 'noopener']);
      anchor.focus();
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      (document.activeElement as HTMLElement).blur();
      window.dispatchEvent(new Event('focus'));
      expect(document.activeElement).toBe(anchor);
    }
    // Returning must not displace focus that the listener moved elsewhere.
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    correction.focus();
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(correction);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    correction.focus();
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(correction);
    await mounted.select(0);
    expect(inspection().textContent).not.toContain('independent group');
    expect(inspection().querySelector('[data-occurrence]')?.getAttribute('data-occurrence')).not.toContain(original.id);
    await mounted.click(m.candidate_close());
    expect(document.activeElement).toBe(mounted.host.querySelectorAll('[data-slot="music-release-row"] button')[0]);
    await mounted.select(1);
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.music_release_window_unavailable());
    expect(inspection()).not.toBeNull();
    fixture.recover();
    await mounted.click(m.album_tracks_retry());
    expect(addresses[1]).toEqual(addresses[0]);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    expect(mounted.host.textContent).toContain(m.album_tracks_complete());
    expect(document.activeElement?.textContent).toBe(m.music_release_title());
    fixture.fail(503);
    await mounted.click(m.album_tracks_previous());
    expect(mounted.host.textContent).toContain(m.music_release_window_unavailable());
    expect(mounted.host.textContent).toContain(m.music_release_retry_previous());
    fixture.fail(0);
    await mounted.click(m.album_tracks_retry());
    expect(addresses.at(-1)).toEqual(addresses.at(-2));
    expect(addresses.at(-1)).toEqual({ ...musicAddress, stream: initial.ok ? initial.stream!.key : '' });
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);
    expect(mounted.host.querySelector('[data-slot="music-release-inspection"]')).toBeNull();
    expect(mounted.host.querySelectorAll('button')[0]?.disabled).toBe(false);
    await mounted.select(1);
    const removedOrigin = Array.from(inspection().querySelectorAll('a')).find(
      (node) => node.textContent === m.album_tracks_open(),
    )!;
    removedOrigin.focus();
    removedOrigin.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    const restart = Array.from(mounted.host.querySelectorAll('button')).find(
      (node) => node.textContent === m.work_parts_restart(),
    )!;
    await act(async () => {
      restart.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(removedOrigin.isConnected).toBe(false);
    (document.activeElement as HTMLElement).blur();
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement?.textContent).toBe(m.music_release_title());
    expect(addresses.at(-1)?.cursor).toBeUndefined();
    const previousButton = Array.from(mounted.host.querySelectorAll('button')).find(
      (node) => node.textContent === m.album_tracks_previous(),
    );
    expect(previousButton?.disabled).toBe(true);
    expect(addresses.length).toBe(5);
  } finally {
    await mounted.close();
  }
});

test('inverse stream starts without another frontier, and withheld targets expose no association details', async () => {
  const mounted = await ui();
  try {
    const fixture = musicReleaseExample();
    fixture.inverse.links[0]!.summary = null;
    const addresses: MusicReleaseAddress[] = [];
    await mounted.render({
      ...musicAddress,
      locale: 'en',
      source: {},
      reader: null,
      initial: await fixture.read(),
      transport: async (address) => {
        addresses.push(address);
        return fixture.read(address);
      },
    });
    await mounted.select(1);
    await mounted.click(m.work_parts_more());
    const inverseButton = mounted.host.querySelector<HTMLButtonElement>('button[data-stream-key="inverse:wdt:P361"]')!;
    inverseButton.focus();
    await act(async () => {
      inverseButton.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(addresses.at(-1)).toEqual({ ...musicAddress, stream: 'inverse:wdt:P361' });
    const withheld = mounted.host.querySelector('[data-slot="music-release-row"]')!;
    expect(withheld.textContent).toContain(m.music_release_withheld());
    expect(withheld.querySelector('details, a, button')).toBeNull();
    expect(withheld.hasAttribute('data-holder')).toBe(false);
    expect(withheld.hasAttribute('data-statement-id')).toBe(false);
    await mounted.click(m.work_parts_restart());
    expect(addresses.at(-1)).toEqual({ ...musicAddress, stream: 'inverse:wdt:P361' });
    expect(mounted.host.querySelector('[data-slot="music-release-inspection"]')).toBeNull();
  } finally {
    await mounted.close();
  }
});

test('retirement discards delayed controls across session/provider/source A/B/A and equal successful replacement', async () => {
  const mounted = await ui();
  try {
    const fixture = musicReleaseExample();
    const initial = await fixture.read();
    let finish!: (value: MusicReleaseRead) => void;
    const delayed = new Promise<MusicReleaseRead>((resolve) => {
      finish = resolve;
    });
    const props = {
      ...musicAddress,
      locale: 'en',
      source: {},
      reader: null,
      initial,
      transport: () => delayed,
      recoverCurrentPage: async () => {},
    };
    await mounted.render(props);
    await mounted.select(1);
    await mounted.click(m.work_parts_more());
    await act(async () => {
      mounted.client.setQueryData(['session'], { state: 'signed-in', subject: recordingId, csrfToken: 'changed' });
      mounted.client.setQueryData(['session'], { state: 'signed-out' });
    });
    expect(mounted.host.querySelectorAll('a').length).toBe(0);
    expect(mounted.host.textContent).toContain(m.music_release_retired());
    expect(document.activeElement?.textContent).toBe(m.music_release_title());
    await act(async () => {
      finish(await fixture.read());
    });
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    await mounted.render({ ...props, source: {} });
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    await mounted.render(props);
    await mounted.render({ ...props, locale: 'ja' });
    await mounted.render(props);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    await mounted.click(m.music_release_recover());
    expect(mounted.host.textContent).toContain(m.music_release_recovery_failed());
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
  } finally {
    await mounted.close();
  }
});

test('production entry explicitly reloads the current Subject before reading a fresh first window', async () => {
  const mounted = await ui();
  try {
    const fixture = musicReleaseExample();
    const addresses: MusicReleaseAddress[] = [];
    let response: MusicReleaseRead = { ok: false, reason: 'withheld' };
    productionTransport = async (address) => {
      addresses.push(address);
      return response;
    };
    let props: Parameters<typeof MusicReleaseOverview>[0] = {
      ...musicAddress,
      locale: 'en',
      source: {},
      reader: null,
      recoverCurrentPage: async () => {
        props = { ...props, source: {} };
        await mounted.renderOverview(props);
      },
    };
    await mounted.renderOverview(props);
    expect(mounted.host.textContent).toContain(m.music_release_withheld());
    expect(mounted.host.querySelectorAll('a').length).toBe(0);
    response = await fixture.read();
    await mounted.click(m.music_release_recover());
    expect(addresses).toEqual([musicAddress, musicAddress]);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);
    await mounted.select(1);
    await mounted.renderOverview({ ...props, source: {} });
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    expect(addresses.length).toBe(2);
    // Equal successful exposure replacement retires the source even for an anonymous reader.
    await mounted.click(m.music_release_recover());
    await act(async () => {
      mounted.client.setQueryData(['exposure', 'viewer'], { allowed: [] });
      mounted.client.setQueryData(['exposure', 'viewer'], { allowed: [] });
    });
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    const before = addresses.length;
    response = { ok: false, reason: 'invalid' };
    await mounted.click(m.music_release_recover());
    expect(addresses.length).toBe(before + 1);
    expect(mounted.host.textContent).toContain(m.music_release_invalid());
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
  } finally {
    await mounted.close();
  }
});

test('a replacement during failed or retired recovery cannot silently admit the old body or its pending request', async () => {
  const mounted = await ui();
  const replacement = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacement.setQueryData(['session'], { state: 'signed-out' });
  try {
    const fixture = musicReleaseExample();
    let finish!: () => void;
    let attempts = 0;
    const addresses: MusicReleaseAddress[] = [];
    let props: Parameters<typeof MusicReleaseReader>[0] = {
      ...musicAddress,
      locale: 'en',
      source: {},
      reader: null,
      initial: await fixture.read(),
      transport: async (address) => {
        addresses.push(address);
        return fixture.read(address);
      },
      recoverCurrentPage: async () => {
        attempts++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    };
    await mounted.render(props);
    await mounted.select(1);
    await mounted.render(props, replacement);
    await mounted.render(props);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    await mounted.click(m.music_release_recover());
    expect(attempts).toBe(1);
    const busy = Array.from(mounted.host.querySelectorAll('button')).find((node) => node.disabled)!;
    expect(busy).toBeDefined();
    await act(async () => {
      busy.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(attempts).toBe(1);
    await act(async () => {
      mounted.client.setQueryData(['exposure', 'viewer'], { allowed: [] });
      mounted.client.setQueryData(['exposure', 'viewer'], { allowed: [] });
    });
    props = { ...props, source: {} };
    await mounted.render(props);
    await act(async () => {
      finish();
    });
    expect(addresses).toEqual([]);
    expect(mounted.host.textContent).toContain(m.music_release_recovery_failed());
    expect(mounted.host.querySelector('[data-slot="music-release-inspection"]')).toBeNull();
    await mounted.click(m.music_release_recover());
    expect(attempts).toBe(2);
    await mounted.render({ ...props, realm: 'changed-during-recovery' });
    await mounted.render(props);
    const recoveryButton = Array.from(mounted.host.querySelectorAll('button')).find(
      (node) => node.textContent === m.music_release_recover(),
    )!;
    expect(recoveryButton.disabled).toBe(false);
    await act(async () => {
      finish();
    });
    expect(addresses).toEqual([]);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    props = {
      ...props,
      recoverCurrentPage: async () => {
        props = { ...props, source: {} };
        await mounted.render(props);
      },
    };
    await mounted.render(props);
    // Recovery must load fresh transport data, even though the old initial example is still passed.
    await mounted.click(m.music_release_recover());
    expect(addresses).toEqual([musicAddress]);
    expect(mounted.host.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);
  } finally {
    replacement.clear();
    await mounted.close();
  }
});
