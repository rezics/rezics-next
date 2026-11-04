import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { literaryGrainExample, literaryIds } from '../src/features/catalogue/literary-reader/examples';

test('mounted work, series and edition use supplied grain, authors, directed order, sources and retiring page bounds', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/series/title/contents' });
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
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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
  let input = literaryGrainExample();
  const render = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <LiteraryReaderEntry {...input} />
        </QueryClientProvider>,
      ),
    );
  const fresh = async (type: Parameters<typeof literaryGrainExample>[0]) => {
    input = literaryGrainExample(type);
    await render();
  };
  try {
    await render();
    expect(host.querySelector('[data-type="schema:BookSeries"]')?.textContent).toBe('book series');
    expect(host.querySelectorAll('[data-slot="literary-window"] li[data-statement-id]')).toHaveLength(1);
    expect(host.textContent).toContain('上巻・02a');
    expect(host.textContent).toContain('999');
    const member = host.querySelector<HTMLAnchorElement>('[data-slot="literary-window"] a[target="_blank"]')!;
    expect(member.href).toContain(literaryIds.member);
    expect(new URL(member.href).searchParams.get('via')).toContain('#literary-reader');
    const next = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((node) =>
      new URL(node.href).searchParams.has('cursor'),
    )!;
    expect(new URL(next.href).searchParams.get('cursor')).toBe(input.windows[0]!.next!);
    expect(host.querySelector('details summary')?.textContent).toBe(m.subject_sources());
    expect(host.querySelector('details a')?.getAttribute('href')).toBe('https://bgm.tv/subject/1');
    await act(async () => member.focus());
    input = { ...input, locale: 'ja' };
    await render();
    expect(host.textContent).toContain(m.literary_reader_stale({}, { locale: 'ja' }));
    expect(host.querySelector('[data-slot="literary-window"]')).toBeNull();
    expect(window.document.activeElement?.id).toBe('literary-reader-title');
    input = { ...input, locale: 'en' };
    await render();
    expect(host.querySelector('[data-slot="literary-window"]')).toBeNull();
    await fresh('schema:Book');
    expect(host.textContent).toContain('Supplied author');
    expect(host.textContent).toContain('Harbour series');
    expect(host.textContent).toContain('上巻・02a');
    expect(host.querySelector('[data-type="schema:Book"]')?.textContent).toBe('book');
    expect(host.querySelector('[data-slot="literary-window"] a')?.textContent).toBe('Harbour, 2nd edition');
    await fresh('bf:Instance');
    expect(host.querySelector('[data-type="bf:Instance"]')?.textContent).toBe('edition');
    expect(host.textContent).toContain('Harbour work');
    expect(host.textContent).not.toContain('Supplied author');
    input = { ...input, source: {}, related: {} };
    await render();
    expect(host.textContent).toContain(m.literary_grain_withheld());
    expect(host.querySelectorAll(`a[href*="${literaryIds.member}"]`)).toHaveLength(0);
    input = { ...input, source: {}, work: { ...input.work, statements: {} } };
    await render();
    expect(host.textContent).toContain(m.literary_grain_mapping_missing());
    for (const status of [202, 403, 410, 503]) {
      input = literaryGrainExample();
      input.windows = [{ ...input.windows[0]!, status }];
      await render();
      expect(host.querySelectorAll('[data-slot="literary-window"] li[data-statement-id]')).toHaveLength(0);
      expect(host.querySelector('[data-slot="literary-window"] [data-state]')?.getAttribute('data-state')).toBe(
        status === 202 ? 'preparing' : status === 403 ? 'withheld' : 'unavailable',
      );
    }
    const original = literaryGrainExample();
    input = original;
    await render();
    input = literaryGrainExample('schema:Book');
    await render();
    input = original;
    await render();
    expect(host.querySelector('[data-slot="literary-window"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
