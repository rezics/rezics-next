import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { literaryGrainExample, literaryGrainRow } from '../src/features/catalogue/literary-reader/examples';
import type { Reader } from '../src/subject/reader';
import { literaryFocusId } from '../src/features/catalogue/literary-visit/navigation';

test('mounted literary visit re-reads bounded addresses and returns focus only to a current assertion', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000941';
  const context = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000942',
    population: { kind: 'realm' as const, id: realm, title: 'Harbour shelf' },
  };
  const previous = [{ view: 'overview' }, { view: 'contents', node: 'members', cursor: 'native/opaque?cursor=older' }];
  const series = literaryGrainExample();
  const assertion = literaryGrainRow(series.windows[0]!.rows[0]).assertion;
  assertion.qualifiers.push({
    property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
    value: { type: 'value', content: { amount: '+1', unit: '1' } },
  });
  const focus = `members:${assertion.id}`;
  const query = new URLSearchParams({
    realm,
    context: context.id,
    node: 'members',
    cursor: 'native/opaque?cursor=current',
    history: JSON.stringify(previous),
    focus,
  });
  const window = new Window({ url: `https://site.test/en/subjects/series/title/contents?${query}` });
  const nativeRead = mock(() => Promise.reject(new Error('unexpected native read')));
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  globals.fetch = nativeRead;
  for (const key of [
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
  ])
    globals[key] = Reflect.get(window, key);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { LiteraryReaderEntry } = await import('../src/features/catalogue/literary-reader/entry');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let input: ReturnType<typeof literaryGrainExample> & {
    context: typeof context;
    realm: string;
    continuation?: { node: string; cursor: string };
    reader?: Reader;
    selectedNode?: string;
    selectedStreamProperty?: string;
    selectedStreamDirection?: 'forward' | 'inverse';
  } = {
    ...series,
    context,
    realm,
    view: 'contents',
    continuation: { node: 'members', cursor: 'native/opaque?cursor=current' },
    selectedNode: 'members',
    selectedStreamProperty: 'wdt:P179',
    selectedStreamDirection: 'inverse',
  };
  const render = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <LiteraryReaderEntry {...input} />
        </QueryClientProvider>,
      ),
    );
  try {
    await render();
    const currentWindow = host.querySelector('[data-slot="literary-window"]');
    expect(host.querySelector('[data-slot="literary-window"] a[target="_blank"]')).toBeNull();
    expect(host.textContent).not.toContain(m.literary_reader_stale());
    const concealedNext = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => new URL(link.href).searchParams.get('cursor') === input.windows[0]!.next,
    )!;
    expect(JSON.parse(new URL(concealedNext.href).searchParams.get('history')!).at(-1).focus).toBeUndefined();
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'prepared-reader', csrfToken: 'prepared-token' });
    });
    input = { ...input, reader: { spoilerLevel: 2, suitability: 'show' } };
    await render();
    expect(host.querySelector('[data-slot="literary-window"]')).toBe(currentWindow);
    expect(window.document.activeElement?.id).toBe(literaryFocusId(focus));
    const prepared = input;
    const back = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => new URL(link.href).searchParams.get('cursor') === 'native/opaque?cursor=older',
    )!;
    expect(new URL(back.href).searchParams.get('node')).toBe('members');
    expect(JSON.parse(new URL(back.href).searchParams.get('history')!)).toEqual([{ view: 'overview' }]);
    const next = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => new URL(link.href).searchParams.get('cursor') === input.windows[0]!.next,
    )!;
    expect(JSON.parse(new URL(next.href).searchParams.get('history')!)).toHaveLength(3);
    const volume = host.querySelector<HTMLAnchorElement>('[data-slot="literary-window"] a[target="_blank"]')!;
    const returnTo = new URL(new URL(volume.href).searchParams.get('via')!, 'https://site.test');
    expect(returnTo.searchParams.get('context')).toBe(context.id);
    expect(returnTo.searchParams.get('node')).toBe('members');
    expect(returnTo.searchParams.get('cursor')).toBe('native/opaque?cursor=current');
    expect(returnTo.searchParams.get('focus')).toContain('members:statement-wdt:P179-');
    expect(host.querySelector('[data-slot="literary-assertion-inspection"]')?.textContent).toContain('Harbour work');
    expect(
      [...host.querySelectorAll<HTMLAnchorElement>('a')].some(
        (link) => link.textContent === m.subject_sources() && new URL(link.href).pathname.endsWith('/sources'),
      ),
    ).toBe(true);

    const volumeAddress = new URL(volume.href);
    const volumeInput = literaryGrainExample('schema:Book');
    window.history.replaceState({}, '', `${volumeAddress.pathname}${volumeAddress.search}`);
    input = { ...volumeInput, context, realm, view: 'overview' };
    await render();
    expect(host.querySelector('[data-slot="literary-window"]')).toBeNull();
    const editions = host.querySelector<HTMLAnchorElement>('[data-slot="literary-overview-destinations"] a')!;
    const editionsAddress = new URL(editions.href);
    expect(editionsAddress.searchParams.get('context')).toBe(context.id);
    expect(editionsAddress.searchParams.has('node')).toBe(false);
    expect(editionsAddress.searchParams.has('cursor')).toBe(false);
    editionsAddress.searchParams.set('node', 'editions');
    editionsAddress.searchParams.set('cursor', 'edition/opaque?cursor=current');
    window.history.replaceState({}, '', `${editionsAddress.pathname}${editionsAddress.search}`);
    input = {
      ...input,
      source: {},
      view: 'editions',
      continuation: { node: 'editions', cursor: 'edition/opaque?cursor=current' },
      selectedNode: 'editions',
      selectedStreamProperty: 'schema:exampleOfWork',
      selectedStreamDirection: 'inverse',
    };
    await render();
    const edition = [
      ...host.querySelectorAll<HTMLAnchorElement>('[data-slot="literary-window"] a[target="_blank"]'),
    ].find((link) => link.textContent === 'Harbour, 2nd edition')!;
    const editionAddress = new URL(edition.href);
    const volumeReturn = new URL(editionAddress.searchParams.get('via')!, 'https://site.test');
    expect(volumeReturn.searchParams.get('context')).toBe(context.id);
    expect(volumeReturn.searchParams.get('node')).toBe('editions');
    expect(volumeReturn.searchParams.get('cursor')).toBe('edition/opaque?cursor=current');
    expect(volumeReturn.searchParams.get('streamProperty')).toBe('schema:exampleOfWork');
    expect(volumeReturn.searchParams.get('streamDirection')).toBe('inverse');
    expect(volumeReturn.searchParams.get('focus')).toContain('editions:statement-schema:exampleOfWork-');
    const editionWindow = host.querySelector('[data-slot="literary-window"]');
    input = { ...input, reader: { spoilerLevel: 1, suitability: 'show' } };
    await render();
    expect(host.querySelector('[data-slot="literary-window"]')).toBe(editionWindow);
    expect(host.querySelector('[data-slot="literary-window"] a[target="_blank"]')).toBe(edition);
    expect(edition.href).toBe(editionAddress.href);

    const editionInput = literaryGrainExample('bf:Instance');
    window.history.replaceState({}, '', `${editionAddress.pathname}${editionAddress.search}`);
    input = { ...editionInput, context, realm, view: 'overview' };
    await render();
    expect(host.querySelector('[data-slot="literary-reader"] [data-type="bf:Instance"]')).not.toBeNull();
    expect(host.textContent).toContain('Harbour work');

    window.history.replaceState({}, '', `${returnTo.pathname}${returnTo.search}`);
    input = { ...prepared, source: {} };
    await render();
    expect(window.document.activeElement?.id).toBe(literaryFocusId(focus));
    const returned = host.querySelector<HTMLAnchorElement>('[data-slot="literary-window"] a[target="_blank"]')!;
    expect(new URL(new URL(returned.href).searchParams.get('via')!, 'https://site.test').search).toBe(returnTo.search);
    input = { ...input, windows: [{ ...input.windows[0]!, rows: [] }] };
    await render();
    expect(window.document.activeElement?.id).toBe('literary-reader-title');
    expect(host.querySelectorAll(`[id="${literaryFocusId(focus)}"]`)).toHaveLength(0);

    const moved = new URLSearchParams({ realm, context: context.id, focus: 'members:removed-volume' });
    window.history.replaceState({}, '', `/en/subjects/series/title/contents?${moved}`);
    input = {
      ...literaryGrainExample(),
      context,
      realm,
      view: 'contents',
      windows: [{ ...literaryGrainExample().windows[0]!, rows: [] }],
    };
    await render();
    expect(host.textContent).toContain(m.literary_visit_currentness());
    expect(
      [...host.querySelectorAll<HTMLAnchorElement>('a')].some((link) => new URL(link.href).searchParams.has('cursor')),
    ).toBe(true);
    expect(nativeRead).toHaveBeenCalledTimes(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
