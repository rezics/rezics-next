import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { gameExample, editionId } from '../src/features/catalogue/game-reader/examples';
import { workReleaseComparisonExample } from '../src/features/catalogue/game-reader/comparison-example';
import type {
  GameReaderAddress,
  GameReaderRead,
  GameReaderTransport,
} from '../src/features/catalogue/game-reader/model';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { GameReader } = await import('../src/features/catalogue/game-reader/view');
const { isolatedWorkReading } = await import('../src/features/catalogue/work-reading-port');
const { m } = await import('../src/paraglide/messages.js');

export async function ui() {
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
  const renderContent = async (content: ReactNode) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, content));
    });
  };
  const render = (props: Parameters<typeof GameReader>[0]) =>
    renderContent(createElement(GameReader, { ...props, reading: isolatedWorkReading }));
  const disclose = async (label: string, scope: Element = host, detail = 0) => {
    const summary = Array.from(scope.querySelectorAll('summary')).find((node) => node.textContent === label);
    if (!summary) throw new Error(`Missing disclosure: ${label}`);
    if (detail === 0) summary.focus();
    await act(async () => {
      summary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    });
    return summary.parentElement as HTMLDetailsElement;
  };
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    const ancestors: HTMLDetailsElement[] = [];
    for (let node = button.parentElement; node; node = node.parentElement)
      if (node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open)
        ancestors.unshift(node as HTMLDetailsElement);
    for (const details of ancestors) await disclose(details.querySelector('summary')!.textContent!, details);
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
  return { host, client, render, renderContent, click, disclose, close };
}

function readingText(node: Node): string {
  if (node instanceof Element && node.tagName === 'DETAILS' && !node.hasAttribute('open'))
    return node.querySelector('summary')?.textContent ?? '';
  return node.childNodes.length ? Array.from(node.childNodes).map(readingText).join(' ') : (node.textContent ?? '');
}

test('initial preparation keeps facts and deliberate inspection; later account or equal credential replacement retires both', async () => {
  const mounted = await ui();
  try {
    for (const reader of [null, 'reader-one']) {
      await act(async () => mounted.client.removeQueries({ queryKey: ['session'], exact: true }));
      const fixture = gameExample();
      const initial = await fixture.read();
      const props = { ...fixture.address, locale: 'en', source: fixture, reader, transport: fixture.read, initial };
      await mounted.render(props);
      const fact = mounted.host.querySelector('[data-game-current-assertion]');
      expect(readingText(mounted.host)).toContain('Windows');
      expect(mounted.host.querySelector('details[data-slot="game-release-destination"]')?.hasAttribute('open')).toBe(
        false,
      );
      const editions = await mounted.disclose(m.subject_editions());
      await mounted.click(m.game_reader_inspect());
      const inspection = mounted.host.querySelector('[data-slot="game-edition-inspection"]');
      const calls = fixture.calls.length;
      await act(async () => {
        mounted.client.setQueryData(
          ['session'],
          reader ? { state: 'signed-in', subject: reader, csrfToken: 'initial' } : { state: 'signed-out' },
        );
      });
      await mounted.render({ ...props, spoiler: reader ? 2 : 0 });
      expect(mounted.host.querySelector('[data-game-current-assertion]')).toBe(fact);
      expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBe(inspection);
      expect(editions.isConnected && editions.open).toBe(true);
      expect(fixture.calls.length).toBe(calls);
      await act(async () => {
        mounted.client.setQueryData(['session'], {
          state: 'signed-in',
          subject: reader ?? 'other',
          csrfToken: 'initial',
        });
        if (!reader) mounted.client.setQueryData(['session'], { state: 'signed-out' });
      });
      expect(mounted.host.querySelector('[data-game-current-assertion]')).toBeNull();
      expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBeNull();
      await mounted.render(props);
      expect(mounted.host.textContent).toContain(m.game_reader_retired());
      expect(fixture.calls.length).toBe(calls);
    }
  } finally {
    await mounted.close();
  }
});

test('default Game reading exposes useful labelled facts and historical meaning before optional evidence and comparison', async () => {
  const mounted = await ui();
  try {
    const fixture = workReleaseComparisonExample('withheld');
    const platform = fixture.publicRead.subject.statements['schema:gamePlatform']![0]!;
    platform.rezics.release = `sha256:${'2'.repeat(64)}`;
    const initial = await fixture.read();
    const props = { ...fixture.address, locale: 'en', source: fixture, reader: null, transport: fixture.read, initial };
    await mounted.render(props);
    const calls = fixture.calls.length;
    for (const text of ['Harbour game', 'Windows', 'Source engine', 'May 2024', m.release_fidelity_historical()])
      expect(readingText(mounted.host)).toContain(text);
    for (const text of ['Trial 0.8', '+2024-05', 'Harbour Digital', 'source:status-02?', platform.id])
      expect(readingText(mounted.host)).not.toContain(text);
    expect(Array.from(mounted.host.querySelectorAll('details')).every((node) => !node.open)).toBe(true);
    const fact = mounted.host.querySelector(`[data-game-current-assertion="${platform.id}"]`)!;
    await mounted.disclose(m.game_reader_evidence(), fact);
    expect(readingText(fact)).toContain('ja');
    expect(readingText(fact)).toContain(platform.rezics.release);
    expect(readingText(fact)).toContain(platform.rank);
    await mounted.disclose(m.game_profile_credits());
    expect(readingText(mounted.host)).toContain('Harbour Studio Ltd');
    await mounted.disclose(m.subject_editions(), mounted.host, 1);
    const comparison = mounted.host.querySelector('[data-slot="work-release-comparison"]')!;
    expect(readingText(comparison)).not.toContain('Harbour Digital');
    await mounted.disclose(m.game_reader_compare_title(), comparison);
    expect(readingText(comparison)).toContain('Harbour Digital');
    expect(readingText(comparison)).toContain(m.game_reader_compare_withheld());
    expect(fixture.calls.length).toBe(calls);
    await mounted.render({ ...props, compact: true });
    expect(readingText(mounted.host)).toContain('Windows');
    await mounted.render({ ...props, source: {} });
    expect(Array.from(mounted.host.querySelectorAll('details')).every((node) => !node.open)).toBe(true);
    expect(fixture.calls.length).toBe(calls);
  } finally {
    await mounted.close();
  }
});

test('initial edition failure stays behind Editions while current work facts remain readable and retry stays open', async () => {
  const mounted = await ui();
  try {
    const fixture = workReleaseComparisonExample();
    const seed = await fixture.read();
    if (!seed.ok) throw new Error('Expected admitted work');
    const addresses: GameReaderAddress[] = [];
    await mounted.render({
      ...fixture.address,
      locale: 'en',
      source: fixture,
      reader: null,
      initial: { ...seed, editions: [], editionFailure: { ok: false, reason: 'unavailable' } },
      transport: (address) => {
        addresses.push(address);
        return fixture.read(address);
      },
    });
    expect(readingText(mounted.host)).toContain('Windows');
    expect(readingText(mounted.host)).not.toContain(m.game_reader_unavailable());
    expect(addresses).toEqual([]);
    const editions = await mounted.disclose(m.subject_editions());
    expect(readingText(editions)).toContain(m.game_reader_unavailable());
    await mounted.click(m.album_tracks_retry());
    expect(addresses).toEqual([fixture.address]);
    expect(editions.isConnected && editions.open).toBe(true);
    expect(readingText(editions)).not.toContain(m.game_reader_unavailable());
    expect(editions.querySelector(`a[href*="${editionId}"]`)).not.toBeNull();
  } finally {
    await mounted.close();
  }
});

test('exact classification keyboard return selects its admitted fact without opening Editions or evidence', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample();
    const initial = await fixture.read();
    if (!initial.ok) throw new Error('Expected admitted work');
    const field = initial.groups
      .find((group) => group.id === 'classification')!
      .fields.find((field) => field.statements.length)!;
    const statement = field.statements[0]!;
    await mounted.render({
      ...fixture.address,
      locale: 'en',
      source: fixture,
      reader: null,
      transport: fixture.read,
      initial,
      returnSelection: {
        ...fixture.address,
        holder: fixture.address.id,
        source: '/en/subjects/game',
        locale: 'en',
        release: initial.digest,
        reader: null,
        property: field.property,
        statement: statement.id,
        focus: 'keyboard',
      },
    });
    expect(document.activeElement?.getAttribute('data-game-current-assertion')).toBe(statement.id);
    expect(mounted.host.querySelector<HTMLDetailsElement>('[data-slot="game-release-destination"]')?.open).toBe(false);
    expect(mounted.host.querySelector('details[open]')).toBeNull();
  } finally {
    await mounted.close();
  }
});

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
    await mounted.disclose(m.subject_editions());
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

test('unqualified selected membership supports public release navigation and return to its opener', async () => {
  const mounted = await ui();
  try {
    const fixture = gameExample('visual-novel');
    fixture.first.links[0]!.assertion!.qualifiers = [];
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport: fixture.read });
    await mounted.disclose(m.subject_editions());
    const destination = mounted.host.querySelector<HTMLAnchorElement>(`a[href*="${editionId}"][href$="/release"]`)!;
    expect(destination).not.toBeNull();
    expect(destination.target).toBe('_blank');
    destination.focus();
    await act(async () => {
      destination.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    destination.blur();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.activeElement).toBe(destination);
    expect(mounted.host.textContent).toContain(fixture.publicRead.subject.labels.en);
    expect(fixture.calls).toHaveLength(2);
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
    const props = {
      ...fixture.address,
      locale: 'en',
      source: fixture,
      reader: null,
      spoiler: 0,
      transport: fixture.read,
    };
    await mounted.render(props);
    expect(mounted.host.textContent).toContain(m.game_reader_platform());
    expect(mounted.host.querySelector('a[href$="/details"]')).not.toBeNull();
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.textContent).not.toContain('Trial 0.8');
    await mounted.click(m.thread_reveal_spoiler());
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).not.toBeNull();
    await mounted.click(m.game_reader_inspect());
    await mounted.click(m.subject_spoiler_hide());
    expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBeNull();
    expect(mounted.host.textContent).not.toContain('Trial 0.8');
    await mounted.click(m.thread_reveal_spoiler());
    await mounted.render({ ...props, spoiler: 2 });
    expect(mounted.host.textContent).toContain(m.game_reader_retired());
    expect(mounted.host.querySelector('[data-game-current-assertion]')).toBeNull();
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    await mounted.render(props);
    expect(mounted.host.textContent).toContain(m.game_reader_retired());
    await mounted.render({ ...props, source: {} });
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('[data-slot="game-edition-inspection"]')).toBeNull();
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
    expect(readingText(panel)).not.toContain('Trial 0.8');
    await mounted.disclose(m.game_reader_evidence(), panel);
    expect(readingText(panel)).toContain('Trial 0.8');
    expect(readingText(panel)).toContain('source:version');
    expect(panel.querySelector('[data-reference="edition-reference"] a')?.getAttribute('href')).toBe(
      'https://example.test/edition-source',
    );
    await mounted.click(m.game_reader_close_inspection());
    expect(document.activeElement?.textContent).toBe(m.game_reader_inspect());
    const controls = mounted.host.querySelectorAll<HTMLButtonElement>('button');
    const other = Array.from(controls).filter((node) => node.textContent === m.game_reader_inspect())[1]!;
    await act(async () => {
      other.focus();
      other.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(document.activeElement).toBe(other);
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
    expect(mounted.host.querySelector('[data-date-kind="partial"]')?.textContent).toBe('May 2024');
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

test.each([false, true])(
  'malformed HTTP comparison retains reading and retries its same native page (cursor: %s)',
  async (cursor) => {
    const mounted = await ui();
    try {
      const fixture = workReleaseComparisonExample();
      const good = await fixture.read();
      if (!good.ok || good.workReleaseCards?.state !== 'available')
        throw new Error('Expected native comparison reading');
      const body = { ...fixture.first, next: null, workReleaseCards: good.workReleaseCards };
      const broken = structuredClone(body);
      Reflect.deleteProperty(broken.workReleaseCards!, 'cards');
      const addresses: GameReaderAddress[] = [];
      const transport: GameReaderTransport = (address) => {
        addresses.push(address);
        return fixture.read(address);
      };
      if (!cursor) fixture.respond(broken);
      await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport });
      expect(mounted.host.querySelector<HTMLDetailsElement>('[data-slot="game-release-destination"]')?.open).toBe(
        false,
      );
      if (!cursor) expect(readingText(mounted.host)).not.toContain(m.game_reader_compare_unavailable());
      if (cursor) {
        fixture.respond(broken);
        await mounted.click(m.work_parts_more());
      }
      expect(mounted.host.textContent).toContain('Harbour Studio');
      expect(mounted.host.textContent).toContain(m.game_reader_compare_unavailable());
      expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).not.toBeNull();
      expect(mounted.host.querySelector('[data-slot="work-release-comparison"]')).toBeNull();
      if (!cursor) await mounted.disclose(m.subject_editions());
      expect(readingText(mounted.host)).toContain(m.game_reader_compare_unavailable());
      fixture.respond(body);
      await mounted.click(m.album_tracks_retry());
      expect(mounted.host.querySelector<HTMLDetailsElement>('[data-slot="game-release-destination"]')?.open).toBe(true);
      const target = { ...fixture.address, ...(cursor ? { cursor: 'opaque:game/next' } : {}) };
      expect(addresses.slice(-2)).toEqual([target, target]);
      const requests = fixture.calls.slice(-4).map((url) => new URL(url));
      expect(requests.map((url) => url.pathname.endsWith('/links'))).toEqual([false, true, false, true]);
      expect(
        requests.filter((url) => url.pathname.endsWith('/links')).map((url) => url.searchParams.get('cursor')),
      ).toEqual([target.cursor ?? null, target.cursor ?? null]);
      expect(mounted.host.querySelectorAll('[data-slot="work-release-comparison"]')).toHaveLength(1);
      expect(mounted.host.querySelector<HTMLDetailsElement>('[data-slot="work-release-comparison"]')?.open).toBe(false);
      expect(mounted.host.textContent).toContain('Harbour Digital');
      expect(mounted.host.textContent).not.toContain(m.game_reader_compare_unavailable());
      if (cursor) {
        // Retrying a successful continuation must not push that address into Previous again.
        await mounted.click(m.game_reader_previous());
        expect(addresses.at(-1)).toEqual(fixture.address);
      }
    } finally {
      await mounted.close();
    }
  },
);

test('reader replacement fences a pending comparison retry and its former release destinations', async () => {
  const mounted = await ui();
  try {
    const fixture = workReleaseComparisonExample();
    const good = await fixture.read();
    if (!good.ok || good.workReleaseCards?.state !== 'available') throw new Error('Expected native comparison reading');
    const broken = { ...fixture.first, workReleaseCards: structuredClone(good.workReleaseCards) };
    Reflect.deleteProperty(broken.workReleaseCards!, 'cards');
    fixture.respond(broken);
    let deliver!: (read: GameReaderRead) => void;
    let calls = 0;
    const transport: GameReaderTransport = (address) => {
      if (++calls === 1) return fixture.read(address);
      return new Promise((resolve) => {
        deliver = resolve;
      });
    };
    await mounted.render({ ...fixture.address, locale: 'en', source: fixture, reader: null, transport });
    await mounted.disclose(m.subject_editions());
    const retry = Array.from(mounted.host.querySelectorAll('button')).find(
      (button) => button.textContent === m.album_tracks_retry(),
    )!;
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(calls).toBe(2);
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    const replacement = gameExample('empty');
    replacement.respond({ ...replacement.first, workReleaseCards: { state: 'available', cards: [] } });
    await mounted.render({
      ...replacement.address,
      locale: 'en',
      source: replacement,
      reader: null,
      transport: replacement.read,
    });
    await act(async () => deliver(good));
    expect(mounted.host.querySelector<HTMLDetailsElement>('[data-slot="game-release-destination"]')?.open).toBe(false);
    expect(mounted.host.textContent).toContain(m.game_reader_editions_empty());
    expect(mounted.host.textContent).not.toContain('Harbour Digital');
    expect(mounted.host.querySelector(`a[href*="${editionId}"]`)).toBeNull();
    expect(mounted.host.querySelector('[data-slot="work-release-comparison"]')).toBeNull();
  } finally {
    await mounted.close();
  }
});
