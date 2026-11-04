import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  arcExample,
  arcAddress,
  arcId,
  workId,
  characterId,
} from '../src/features/catalogue/story-arc-reader/examples';
import type { ArcAddress, ArcRead, ArcTransport } from '../src/features/catalogue/story-arc-reader/model';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { StoryArcReader } = await import('../src/features/catalogue/story-arc-reader/view');
const { m } = await import('../src/paraglide/messages.js');

export async function ui() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.example/en/subjects/${arcId}/harbour-arc` });
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
  const render = async (props: Parameters<typeof StoryArcReader>[0]) => {
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(StoryArcReader, props))),
    );
  };
  const click = async (label: string, scope: ParentNode = host, detail = 0) => {
    const button = Array.from(scope.querySelectorAll('button')).find((node) =>
      node.textContent?.trim().startsWith(label),
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    button.focus();
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail })));
    return button;
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

test('arc journey gates whole narrative/appearance rows, opens current targets, retains exact retry and keyboard return', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample('continuation-unavailable');
    const initial = await fixture.read();
    const addresses: ArcAddress[] = [];
    const transport: ArcTransport = (address) => {
      addresses.push(address);
      return fixture.read(address);
    };
    const props = { ...arcAddress, locale: 'en', source: {}, reader: null, transport, initial };
    await mounted.render(props);
    expect(mounted.host.textContent).toContain('Later title');
    expect(mounted.host.textContent).not.toContain('Earlier title');
    const origin = await mounted.click(m.arc_reader_characters());
    expect(mounted.host.textContent).not.toContain('Secret character');
    expect(mounted.host.querySelector(`a[href*="${characterId}"]`)).toBeNull();
    // The first gate belongs to this work's appearance; the later member also has its own gate.
    await mounted.click(m.subject_spoiler_show());
    expect(mounted.host.textContent).toContain('Secret character');
    await mounted.click(m.arc_reader_inspect(), mounted.host.querySelector('[data-slot=arc-appearance-window]')!);
    expect(mounted.host.textContent).toContain('原典の範囲');
    const target = mounted.host.querySelector<HTMLAnchorElement>(`a[href*="${characterId}"]`)!;
    expect(target.target).toBe('_blank');
    expect(target.rel).toBe('noopener');
    target.focus();
    await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    document.body.focus();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(document.activeElement).toBe(target);
    await mounted.click(m.arc_reader_back());
    expect(document.activeElement).toBe(origin);
    expect(mounted.host.textContent).not.toContain('Secret character');
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.arc_reader_next_unavailable());
    expect(mounted.host.textContent).toContain('Later title');
    expect(mounted.host.textContent).not.toContain(m.arc_reader_complete());
    const pending = addresses.at(-1);
    fixture.recover();
    await mounted.click(m.subject_section_retry());
    expect(addresses.at(-1)).toEqual(pending);
    expect(mounted.host.textContent).toContain(m.arc_reader_complete());
    if (!initial.ok) throw new Error('Expected admitted arc');
    const sequence = initial.streams.find((stream) => stream.key === 'forward:rezics:sideStoryOf')!;
    await mounted.click(sequence.label.text);
    expect(mounted.host.textContent).toContain(m.arc_reader_sequence());
    expect(mounted.host.textContent).not.toContain('Hidden narrative place');
    await mounted.click(m.subject_spoiler_show());
    expect(mounted.host.textContent).toContain('Hidden narrative place');
    const work = await fixture.read({ ...arcAddress, id: workId });
    await mounted.render({ ...props, id: workId, source: {}, initial: work });
    expect(mounted.host.querySelector(`a[href*="${arcId}"]`)?.getAttribute('target')).toBe('_blank');
  } finally {
    await mounted.close();
  }
});

test('replacement exposure retires accepted controls and an in-flight continuation permanently', async () => {
  const mounted = await ui();
  try {
    const fixture = arcExample();
    const initial = await fixture.read();
    let resolve!: (read: ArcRead) => void;
    const props = {
      ...arcAddress,
      locale: 'en',
      source: {},
      reader: null,
      initial,
      transport: () =>
        new Promise<ArcRead>((done) => {
          resolve = done;
        }),
    };
    await mounted.render(props);
    await mounted.click(m.work_parts_more());
    await act(async () => {
      mounted.client.setQueryData(['exposure', 'viewer'], { replacement: true });
    });
    expect(mounted.host.querySelectorAll('a')).toHaveLength(1);
    expect(mounted.host.querySelector('a')?.textContent).toContain(m.arc_reader_fresh_subject());
    expect(mounted.host.textContent).not.toContain('Later title');
    expect(document.activeElement?.tagName).toBe('H2');
    await act(async () => {
      resolve(initial);
    });
    expect(mounted.host.querySelectorAll('a')).toHaveLength(1);
    expect(mounted.host.querySelector('a')?.textContent).toContain(m.arc_reader_fresh_subject());
    await mounted.render(props);
    expect(mounted.host.textContent).toContain(m.arc_reader_unavailable());
    const recovered = { ...props, source: {}, transport: fixture.read };
    await mounted.render(recovered);
    expect(mounted.host.textContent).toContain('Later title');
    await mounted.render({ ...recovered, locale: 'ja' });
    expect(mounted.host.querySelectorAll('a')).toHaveLength(1);
    expect(mounted.host.querySelector('a')?.textContent).toContain(m.arc_reader_fresh_subject());
  } finally {
    await mounted.close();
  }
});
