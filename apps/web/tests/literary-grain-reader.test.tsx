import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProfileRelationWindow } from '../src/features/pages/views';
import {
  literaryDirection,
  literaryGrainExample,
  literaryIds,
  literaryStatement,
} from '../src/features/catalogue/literary-reader/examples';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

test('all admitted membership and Edition streams stay discoverable while one exact page per family is retained', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/series/title/contents' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of ['navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'ResizeObserver'])
    globals[key] = Reflect.get(window, key);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { LiteraryReaderEntry } = await import('../src/features/catalogue/literary-reader/entry');
  const memberInput = literaryGrainExample();
  const firstMember = memberInput.windows[0]!;
  const firstRow = firstMember.rows[0] as Record<string, any>;
  const secondAssertion = {
    ...firstRow.assertion,
    id: 'membership-occurrence-two',
    qualifiers: [
      {
        property: { id: 'schema:position', data_type: 'string' },
        value: { type: 'value', content: '上巻・02b' },
      },
    ],
  };
  const membersSecond: ProfileRelationWindow = {
    ...firstMember,
    node: 'members-second',
    next: 'member-page-two',
    rows: [firstRow, { ...firstRow, statement: secondAssertion.id, assertion: secondAssertion }],
  };
  const membersFirst: ProfileRelationWindow = {
    ...firstMember,
    node: 'members-first',
    next: 'member-page-one',
    rows: [firstRow],
  };
  const editionAssertion = literaryStatement('schema:exampleOfWork', literaryIds.series);
  const editionInverse: ProfileRelationWindow = {
    ...firstMember,
    node: 'edition-inverse',
    property: 'schema:exampleOfWork',
    direction: 'inverse',
    rows: [
      {
        subject: literaryIds.edition,
        property: 'schema:exampleOfWork',
        statement: editionAssertion.id,
        assertion: editionAssertion,
        label: 'Harbour edition',
        type: 'bf:Instance',
        related: {},
        summary: { id: literaryIds.edition, type: 'bf:Instance', label: { value: 'Harbour edition', language: 'en' } },
      },
    ],
  };
  const editionForwardAssertion = literaryStatement('schema:workExample', literaryIds.edition);
  const editionForward: ProfileRelationWindow = {
    ...firstMember,
    node: 'edition-forward',
    property: 'schema:workExample',
    direction: 'forward',
    rows: [
      {
        target: literaryIds.edition,
        statement: editionForwardAssertion,
        label: 'Harbour edition',
        type: 'bf:Instance',
        related: {},
        summary: { id: literaryIds.edition, type: 'bf:Instance', label: { value: 'Harbour edition', language: 'en' } },
      },
    ],
  };
  const memberWindows = [membersFirst, membersSecond];
  const editionWindows = [editionInverse, editionForward];
  const base = {
    ...memberInput,
    windows: [...memberWindows, ...editionWindows],
    directions: [
      ...memberInput.directions!,
      literaryDirection('schema:workExample', 'forward'),
    ],
  };
  let input: ReturnType<typeof literaryGrainExample> & {
    continuation?: { node: string; cursor: string };
    selectedNode?: string;
    selectedStreamProperty?: string;
    selectedStreamDirection?: 'forward' | 'inverse';
    realm?: string;
  } = base;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
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
    expect([...host.querySelectorAll<HTMLElement>('[data-stream-node]')].map((node) => node.dataset.streamNode)).toEqual([
      'members-first',
      'members-second',
      'edition-inverse',
      'edition-forward',
    ]);
    expect(
      [...host.querySelectorAll<HTMLElement>('[data-stream-node]')].map((node) => {
        const url = new URL(node.querySelector('a')!.href);
        return [
          url.searchParams.get('node'),
          url.searchParams.get('streamProperty'),
          url.searchParams.get('streamDirection'),
        ];
      }),
    ).toEqual([
      ['members-first', 'wdt:P179', 'inverse'],
      ['members-second', 'wdt:P179', 'inverse'],
      ['edition-inverse', 'schema:exampleOfWork', 'inverse'],
      ['edition-forward', 'schema:workExample', 'forward'],
    ]);
    expect(host.querySelectorAll('[data-slot="literary-window"]')).toHaveLength(2);
    const memberRows = host.querySelectorAll<HTMLElement>(
      '[data-slot="literary-window"][data-node="members-first"] > ul > li[data-statement-id]',
    );
    expect([...memberRows].map((row) => row.textContent)).toEqual([expect.stringContaining('上巻・02a')]);
    expect(host.querySelector('[data-stream-node="edition-forward"] [data-state="ready"]')).not.toBeNull();

    input = {
      ...base,
      source: {},
      view: 'contents',
      realm: literaryIds.author,
      selectedNode: 'members-second',
      selectedStreamProperty: 'wdt:P179',
      selectedStreamDirection: 'inverse',
      continuation: { node: 'members-second', cursor: 'current-member-cursor' },
    };
    await render();
    expect([...host.querySelectorAll<HTMLElement>('[data-slot="literary-window"]')].map((node) => node.dataset.node)).toEqual([
      'members-second',
      'edition-inverse',
    ]);
    const selectedRows = host.querySelectorAll<HTMLElement>(
      '[data-slot="literary-window"][data-node="members-second"] > ul > li[data-statement-id]',
    );
    expect([...selectedRows].map((row) => row.textContent)).toEqual([
      expect.stringContaining('上巻・02a'),
      expect.stringContaining('上巻・02b'),
    ]);
    const chosen = host.querySelector<HTMLAnchorElement>('[data-stream-node="members-second"] > a')!;
    const chosenUrl = new URL(chosen.href);
    expect(chosenUrl.searchParams.get('node')).toBe('members-second');
    expect(chosenUrl.searchParams.get('streamProperty')).toBe('wdt:P179');
    expect(chosenUrl.searchParams.get('streamDirection')).toBe('inverse');
    expect(chosenUrl.searchParams.get('cursor')).toBe('current-member-cursor');
    const otherStream = new URL(host.querySelector<HTMLAnchorElement>('[data-stream-node="edition-inverse"] > a')!.href);
    expect(otherStream.searchParams.has('cursor')).toBe(false);

    const next = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => {
      const url = new URL(link.href);
      return url.searchParams.get('cursor') === 'member-page-two';
    })!;
    const nextUrl = new URL(next.href);
    expect(nextUrl.searchParams.get('node')).toBe('members-second');
    expect(nextUrl.searchParams.get('streamProperty')).toBe('wdt:P179');
    expect(nextUrl.searchParams.get('streamDirection')).toBe('inverse');
    const destination = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => {
      const via = new URL(link.href).searchParams.get('via');
      return via !== null;
    })!;
    const returnAddress = new URL(destination.href).searchParams.get('via')!;
    expect(subjectVisitReturn(returnAddress, 'en')).toBe(returnAddress);
    const returned = new URL(returnAddress, 'https://site.test');
    expect(returned.pathname).toContain('/contents');
    expect(returned.searchParams.get('realm')).toBe(literaryIds.author);
    expect(returned.searchParams.get('node')).toBe('members-second');
    expect(returned.searchParams.get('streamProperty')).toBe('wdt:P179');
    expect(returned.searchParams.get('streamDirection')).toBe('inverse');
    expect(returned.searchParams.get('cursor')).toBe('current-member-cursor');

    host.querySelector<HTMLAnchorElement>('[data-stream-node="members-second"] > a')!.focus();
    input = { ...input, source: {}, windows: [membersFirst, editionInverse] };
    await render();
    expect(host.querySelector('[data-slot="literary-window"]')).toBeNull();
    expect(window.document.activeElement?.id).toBe('literary-reader-title');
    expect(host.textContent).toContain('The selected native stream is unavailable');
    const recovery = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Read the current Subject again'),
    )!;
    const recoveryUrl = new URL(recovery.href);
    expect(recoveryUrl.searchParams.has('node')).toBe(false);
    expect(recoveryUrl.searchParams.has('cursor')).toBe(false);
    const unrelated = window.document.createElement('button');
    window.document.body.append(unrelated);
    unrelated.focus();
    await render();
    expect(window.document.activeElement).toBe(unrelated);
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
