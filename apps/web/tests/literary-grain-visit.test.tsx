import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { literaryGrainExample } from '../src/features/catalogue/literary-reader/examples';

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
  const query = new URLSearchParams({
    realm,
    context: context.id,
    node: 'members',
    cursor: 'native/opaque?cursor=current',
    history: JSON.stringify(previous),
  });
  const window = new Window({ url: `https://site.test/en/subjects/series/title/contents?${query}` });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
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
  } = {
    ...literaryGrainExample(),
    context,
    realm,
    view: 'contents',
    continuation: { node: 'members', cursor: 'native/opaque?cursor=current' },
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
    const volume = literaryGrainExample('schema:Book');
    window.history.replaceState({}, '', `${volumeAddress.pathname}${volumeAddress.search}`);
    input = { ...volume, context, realm, view: 'overview' };
    await render();
    const edition = [
      ...host.querySelectorAll<HTMLAnchorElement>('[data-slot="literary-window"] a[target="_blank"]'),
    ].find((link) => link.textContent === 'Harbour, 2nd edition')!;
    const editionAddress = new URL(edition.href);
    const volumeReturn = new URL(editionAddress.searchParams.get('via')!, 'https://site.test');
    expect(volumeReturn.searchParams.get('context')).toBe(context.id);
    expect(volumeReturn.searchParams.get('node')).toBe('editions');
    expect(volumeReturn.searchParams.get('focus')).toContain('editions:statement-schema:exampleOfWork-');

    const editionInput = literaryGrainExample('bf:Instance');
    window.history.replaceState({}, '', `${editionAddress.pathname}${editionAddress.search}`);
    input = { ...editionInput, context, realm, view: 'overview' };
    await render();
    expect(host.querySelector('[data-slot="literary-reader"] [data-type="bf:Instance"]')).not.toBeNull();
    expect(host.textContent).toContain('Harbour work');

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
