import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  albumTrackExample,
  exampleAddress,
  exampleRecording,
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

test('native rows open one exact membership inspection and accepted navigation clears it', async () => {
  const mounted = await ui();
  try {
    const fixture = albumTrackExample('continuation-unavailable');
    const initial = await fixture.read();
    if (!initial.ok || !initial.stream) throw new Error('Expected admitted album contents');
    const addresses: unknown[] = [];
    const transport: AlbumTrackTransport = (address) => {
      addresses.push(address);
      return fixture.read(address);
    };
    await mounted.render({ ...exampleAddress, locale: 'en', source: {}, reader: null, transport, initial });
    expect(mounted.host.textContent).toContain(initial.album.label.text);
    expect(mounted.host.textContent).toContain(initial.stream.property);
    expect(mounted.host.textContent).toContain(
      initial.stream.direction === 'forward' ? m.work_parts_order_forward() : m.work_parts_order_inverse(),
    );
    expect(mounted.host.textContent).toContain(m.work_parts_slice());
    expect(mounted.host.textContent).toContain(initial.caughtUp ? m.album_tracks_current() : m.work_parts_pending());
    if (initial.count) {
      expect(mounted.host.textContent).toContain(initial.count.exact ? m.work_parts_exact() : m.work_parts_at_least());
      expect(mounted.host.textContent).toContain(String(initial.count.value));
    }
    expect(Array.from(mounted.host.querySelector('nav')!.querySelectorAll('button')).map((button) => button.textContent)).toEqual(
      initial.streams.map((stream) => stream.label.text || stream.property),
    );
    const rowButtons = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('[data-slot="album-track-inspect"]'));
    expect(rowButtons.map((button) => button.getAttribute('aria-label'))).toEqual(
      initial.rows.map(
        (row) => `${m.album_tracks_inspect()}: ${row.summary?.label?.value || m.work_parts_unresolved()}; ${row.holder}; ${row.statementId}`,
      ),
    );
    const repeated = initial.rows.filter((row) => row.summary?.id === exampleRecording);
    expect(repeated.length).toBe(2);
    const firstIndex = initial.rows.indexOf(repeated[0]!);
    const secondIndex = initial.rows.indexOf(repeated[1]!);
    const inspect = async (index: number) => {
      const button = rowButtons[index]!;
      button.focus();
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
      return button;
    };
    const firstOpener = await inspect(firstIndex);
    let inspection = mounted.host.querySelector<HTMLElement>('[data-slot="album-track-inspection"]')!;
    expect(inspection.textContent).toContain(repeated[0]!.holder);
    expect(inspection.textContent).toContain(repeated[0]!.statementId);
    expect(inspection.textContent).toContain('source:unknownPosition');
    expect(inspection.textContent).toContain('A-02?');
    const sourceGroup = Array.from(inspection.querySelectorAll('details')).find(
      (details) => details.querySelector('summary')?.textContent === m.sources_citations(),
    );
    expect(sourceGroup).not.toBeNull();
    expect(sourceGroup?.textContent).toContain('Unsupported calendar:');
    expect(sourceGroup?.textContent).not.toContain('source:unknownPosition');
    const target = inspection.querySelector<HTMLAnchorElement>(`a[href*="${exampleRecording}"]`)!;
    expect(target.href).toBe(`https://site.example/en/subjects/${exampleRecording}/harbour`);
    expect(target.target).toBe('_blank');
    expect(target.rel).toBe('noopener');
    const correction = inspection.querySelector<HTMLAnchorElement>(`a[href*="${repeated[0]!.holder}"][href$="relation-edit"]`)!;
    expect(correction.target).toBe('_blank');
    expect(correction.rel).toBe('noopener');
    const selectedText = mounted.host.textContent;
    correction.focus();
    correction.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(correction);
    expect(mounted.host.textContent).toBe(selectedText);
    await mounted.click(m.candidate_close());
    expect(mounted.host.querySelector('[data-slot="album-track-inspection"]')).toBeNull();
    expect(document.activeElement).toBe(firstOpener);
    await inspect(secondIndex);
    inspection = mounted.host.querySelector<HTMLElement>('[data-slot="album-track-inspection"]')!;
    expect(inspection.textContent).toContain(repeated[1]!.holder);
    expect(inspection.textContent).toContain(repeated[1]!.statementId);
    expect(repeated[0]!.statementId).not.toBe(repeated[1]!.statementId);
    const selectedTarget = inspection.querySelector<HTMLAnchorElement>(`a[href*="${exampleRecording}"]`)!;
    selectedTarget.focus();
    selectedTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(selectedTarget);
    await mounted.click(m.candidate_close());
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.album_tracks_next_unavailable());
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]').length).toBe(3);
    fixture.recover();
    await mounted.click(m.album_tracks_retry());
    expect(addresses[1]).toEqual(addresses[0]);
    expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]').length).toBe(1);
    expect(mounted.host.querySelector('[data-slot="album-track-inspection"]')).toBeNull();
    expect(mounted.host.textContent).toContain(m.album_tracks_complete());
    expect(document.activeElement?.textContent).toBe(m.album_tracks_title());
    expect(mounted.host.querySelectorAll('a')).toHaveLength(0);
    expect(addresses.length).toBe(2);
  } finally {
    await mounted.close();
  }
});

test('unsupported, empty and withheld album windows remain different states', async () => {
  for (const [scenario, expected] of [
    ['unconfigured', m.album_tracks_unconfigured()],
    ['empty', m.work_parts_empty()],
    ['withheld', m.album_tracks_withheld()],
  ] as const) {
    const mounted = await ui();
    try {
      const fixture = albumTrackExample(scenario);
      const initial = await fixture.read();
      await mounted.render({
        ...exampleAddress,
        locale: 'en',
        source: {},
        reader: null,
        transport: fixture.read,
        initial,
      });
      expect(mounted.host.textContent).toContain(expected);
      expect(mounted.host.querySelectorAll('[data-slot="album-track-row"]')).toHaveLength(0);
      expect(mounted.host.querySelectorAll('[data-slot="album-track-inspection"]')).toHaveLength(0);
      if (scenario === 'withheld') {
        expect(mounted.host.querySelector('a')?.textContent).toBe(m.album_tracks_subject_recovery());
        expect(Array.from(mounted.host.querySelectorAll('button')).some((button) => button.textContent === m.work_parts_restart())).toBe(true);
      }
    } finally {
      await mounted.close();
    }
  }
});

