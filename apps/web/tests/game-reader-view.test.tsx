import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { gameExample, editionId } from '../src/features/catalogue/game-reader/examples';
import type { GameReaderRead, GameReaderTransport } from '../src/features/catalogue/game-reader/model';
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

test('ordinary facts and exact release destinations retain source meaning and keyboard return across bounded retry', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample('continuation-unavailable');
    const addresses: unknown[] = [];
    const transport: GameReaderTransport = (address) => {
      addresses.push(address);
      return fixture.read(address);
    };
    await mounted.render({
      ...fixture.address,
      locale: 'en',
      realm: 'games',
      source: fixture,
      reader: null,
      transport,
    });
    expect(mounted.host.textContent).toContain('Windows');
    expect(mounted.host.textContent).toContain('Source engine');
    expect(mounted.host.textContent).toContain('Harbour Studio');
    expect(mounted.host.textContent).toContain('+2024-05');
    expect(mounted.host.textContent).toContain('source:status-02?');
    expect(mounted.host.textContent).toContain('Trial 0.8 · ja / Windows');
    expect(mounted.host.textContent).toContain(fixture.publicRead.subject.labels.en);
    expect(mounted.host.textContent).toContain(fixture.publicRead.subject.sourceRecords[0]!.name);
    expect(fixture.calls).toHaveLength(2);
    const destination = mounted.host.querySelector<HTMLAnchorElement>(`a[href*="${editionId}"]`)!;
    expect(destination.getAttribute('href')).toBe(
      `/en/subjects/${editionId}/harbour-trial-japanese-windows?realm=games`,
    );
    expect(destination.target).toBe('_blank');
    expect(mounted.host.querySelector(`a[href*="${editionId}"][href*="/release?"]`)).not.toBeNull();
    destination.focus();
    await act(async () => {
      destination.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    destination.blur();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.activeElement).toBe(destination);
    await mounted.click(m.work_parts_more());
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.textContent).toContain(m.game_reader_unavailable());
    expect(mounted.host.textContent).toContain('Harbour Studio');
    expect(mounted.host.textContent).not.toContain(m.game_reader_editions_empty());
    fixture.recover();
    await mounted.click(m.album_tracks_retry());
    expect(addresses.slice(-2)).toEqual([
      { ...fixture.address, cursor: 'opaque:game/next' },
      { ...fixture.address, cursor: 'opaque:game/next' },
    ]);
    expect(document.activeElement).toBe(mounted.host.querySelector('h2'));
    expect(mounted.host.textContent).toContain(m.game_reader_editions_empty());
    expect(mounted.host.querySelector('a[href*="/details?"]')).not.toBeNull();
    expect(mounted.host.querySelector('a[href*="/edit?"]')).not.toBeNull();
  } finally {
    await mounted.close();
  }
});

test('sparse release windows continue, cursor refusal restarts, and withheld readings retire work facts', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample('visual-novel');
    fixture.respond({ ...fixture.first, links: [] });
    let refuse = false;
    const addresses: unknown[] = [];
    const transport: GameReaderTransport = (address) => {
      addresses.push(address);
      return refuse ? Promise.resolve({ ok: false, reason: 'restart' }) : fixture.read(address);
    };
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport });
    expect(mounted.host.textContent).toContain(m.game_reader_editions_empty());
    expect(mounted.host.textContent).toContain(m.game_reader_total_unknown());
    expect(mounted.host.textContent).not.toContain(m.game_reader_window_complete());
    refuse = true;
    await mounted.click(m.work_parts_more());
    expect(mounted.host.textContent).toContain(m.game_reader_window_restart());
    expect(mounted.host.textContent).toContain('+2024-05');
    refuse = false;
    fixture.respond(fixture.last);
    // The section restart and general refresh both request a first page; use the first matching control.
    await mounted.click(m.game_reader_refresh());
    expect(addresses.at(-1)).toEqual(fixture.address);
    expect(mounted.host.textContent).toContain(m.game_reader_window_complete());
    fixture.fail(404);
    await mounted.click(m.game_reader_refresh());
    expect(mounted.host.textContent).toContain(m.game_reader_withheld());
    expect(mounted.host.textContent).not.toContain('+2024-05');
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('a[href*="/details"]')).not.toBeNull();
  } finally {
    await mounted.close();
  }
});

test('accepted release cursor cycles require refresh without another native read', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport: fixture.read });
    fixture.respond({ ...fixture.first, next: 'opaque:second' });
    await mounted.click(m.work_parts_more());
    fixture.respond(fixture.first);
    await mounted.click(m.work_parts_more());
    const calls = fixture.calls.length;
    await mounted.click(m.work_parts_more());
    expect(fixture.calls.length).toBe(calls);
    expect(mounted.host.textContent).toContain(m.game_reader_window_restart());
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.textContent).toContain('Harbour Studio');
  } finally {
    await mounted.close();
  }
});

test('authority, source and locale replacement retire pending data, cursors, destinations and old focus intent', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    let deliver!: (read: GameReaderRead) => void;
    const transport: GameReaderTransport = () =>
      new Promise((resolve) => {
        deliver = resolve;
      });
    const source = {};
    const props = { ...fixture.address, locale: 'en', source, reader: null, transport };
    await mounted.render(props);
    const stale = deliver;
    await mounted.render({ ...props, source: fixture, transport: fixture.read });
    expect(mounted.host.textContent).toContain('Harbour trial');
    await act(async () => {
      stale(await fixture.read());
    });
    await act(async () => {
      mounted.client.setQueryData(['exposure', 'viewer'], { spoilerLevel: 2 });
    });
    expect(mounted.host.textContent).not.toContain('Harbour trial');
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('a[href*="/details"]')).not.toBeNull();
    await mounted.render({ ...props, source: fixture, transport: fixture.read });
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('a[href*="/details"]')).not.toBeNull();
    const fresh = {};
    await mounted.render({ ...props, source: fresh, transport: fixture.read });
    expect(mounted.host.textContent).toContain('Harbour trial');
    const calls = fixture.calls.length;
    await mounted.render({ ...props, source: fresh, locale: 'ja', transport: fixture.read });
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('a[href*="/details"]')).not.toBeNull();
    await mounted.render({ ...props, source: fresh, locale: 'en', transport: fixture.read });
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('a[href*="/details"]')).not.toBeNull();
    expect(fixture.calls.length).toBe(calls);
    await mounted.render({ ...props, source: {}, transport });
    const retired = deliver;
    await mounted.render({ ...props, source, transport: fixture.read });
    await act(async () => {
      retired({ ok: false, reason: 'withheld' });
    });
    expect(mounted.host.textContent).toContain('Harbour game');
  } finally {
    await mounted.close();
  }
});

test('unsupported fields keep generic reading/correction and spoiler-qualified editions hide their whole destination', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample('visual-novel');
    fixture.first.links[0]!.assertion!.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '2', unit: '1' } },
    });
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport: fixture.read });
    expect(mounted.host.textContent).toContain(m.game_reader_platform());
    expect(mounted.host.querySelector('a[href$="/details"]')).not.toBeNull();
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.textContent).not.toContain('Trial 0.8');
    await mounted.click(m.thread_reveal_spoiler());
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).not.toBeNull();
  } finally {
    await mounted.close();
  }
});

test('inspection keeps each native association and its rank, qualifier and reference separate from equal release labels', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    const first = fixture.first.links[0]!;
    first.assertion!.rank = 'preferred';
    first.assertion!.rezics.release = `sha256:${'2'.repeat(64)}`;
    first.assertion!.references.push({
      hash: 'edition-reference',
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: 'https://example.test/edition-source' },
        },
      ],
    });
    const second = structuredClone(first);
    second.statement = second.assertion!.id = '00000000-0000-4000-8000-000000000006';
    second.assertion!.rank = 'normal';
    second.assertion!.qualifiers = [];
    second.assertion!.references = [];
    fixture.first.links.push(second);
    await mounted.render({
      ...fixture.address,
      locale: 'en',
      realm: 'games',
      source: fixture,
      reader: null,
      transport: fixture.read,
    });
    await mounted.click(m.game_reader_inspect());
    const panel = mounted.host.querySelector('[data-slot="game-edition-inspection"]')!;
    for (const value of [
      first.subject,
      first.statement,
      fixture.address.id,
      first.property,
      first.summary!.type,
      'preferred',
      'Trial 0.8',
    ])
      expect(panel.textContent).toContain(value);
    expect(panel.textContent).toContain(m.release_fidelity_historical());
    expect(panel.querySelector('[data-reference="edition-reference"] a')?.getAttribute('href')).toBe(
      'https://example.test/edition-source',
    );
    await mounted.click(m.game_reader_close_inspection());
    expect(document.activeElement?.textContent).toBe(m.game_reader_inspect());
    const controls = mounted.host.querySelectorAll<HTMLButtonElement>('button');
    const other = Array.from(controls).filter((node) => node.textContent === m.game_reader_inspect())[1]!;
    await act(async () => {
      other.focus();
      other.click();
    });
    const next = mounted.host.querySelector('[data-slot="game-edition-inspection"]')!;
    expect(next.textContent).toContain(second.statement);
    expect(next.textContent).toContain(m.game_reader_no_qualifiers());
    expect(next.textContent).toContain(m.game_reader_no_references());
    expect(next.textContent).not.toContain('Trial 0.8');
    expect(next.textContent).not.toContain(first.statement);
  } finally {
    await mounted.close();
  }
});

test('a missing assertion is unavailable and a missing summary remains withheld, while partial dates and TBA keep distinct meanings', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    const row = fixture.first.links[0]!;
    Reflect.deleteProperty(row, 'summary');
    delete row.assertion;
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport: fixture.read });
    expect(mounted.host.querySelector('[data-date-kind="partial"]')?.textContent).toContain('+2024-05');
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    await mounted.click(m.game_reader_inspect());
    const panel = mounted.host.querySelector('[data-slot="game-edition-inspection"]')!;
    expect(panel.textContent).toContain(m.game_reader_assertion_unavailable());
    expect(panel.textContent).not.toContain(m.game_reader_no_qualifiers());
    expect(panel.textContent).not.toContain(m.game_reader_no_references());
    const tba = gameExample('tba');
    await mounted.render({ ...tba.address, locale: 'en', source: tba, reader: null, transport: tba.read });
    expect(mounted.host.querySelector('[data-date-kind="tba"]')?.textContent).toBe(m.release_fidelity_date_tba());
    expect(mounted.host.textContent).not.toContain(m.release_fidelity_date_absent());
    const missing = gameExample('unconfigured');
    await mounted.render({ ...missing.address, locale: 'en', source: missing, reader: null, transport: missing.read });
    expect(mounted.host.textContent).toContain(m.game_reader_unsupported());
    expect(mounted.host.textContent).not.toContain(m.game_reader_editions_empty());
  } finally {
    await mounted.close();
  }
});
