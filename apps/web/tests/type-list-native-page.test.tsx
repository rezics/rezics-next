import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { CompositionDocument } from '@rezics/composition';
import recorded from '../src/kernel/recorded/home-page.json';
import { m } from '../src/paraglide/messages.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { planReads, platformRegistry } = await import('@rezics/composition');
const { OverviewContext } = await import('../src/features/pages/overview');
const { TypeList, TypeListContext } = await import('../src/features/pages/type-list');

const node = 'books';
const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
const anotherId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07';

function hit(overrides: Record<string, unknown> = {}) {
  return { id, type: 'schema:Book', labels: { en: 'Native book' }, summary: null, ...overrides };
}

function summary(subjectId: string, type = 'schema:Book') {
  return { id: subjectId, type, types: [type], label: null, creativeWork: true, cover: null };
}

function renderPage(
  body: unknown,
  options: { types?: string[]; read?: unknown; props?: Record<string, unknown> } = {},
) {
  const types = options.types ?? ['schema:Book'];
  const value = {
    locale: 'en',
    subject: null,
    unlabelled: 'Unlabelled subject',
    reader: { suitability: 'blur' },
    labels: { cover: 'Cover' },
    sections: new Map([
      [
        node,
        {
          ok: true,
          read: options.read ?? {
            kind: 'search',
            body: { filter: { type: { in: types } }, sort: 'name', limit: 24 },
          },
          body,
        },
      ],
    ]),
  };
  return renderToString(
    createElement(
      OverviewContext.Provider,
      { value: value as never },
      createElement(
        TypeListContext.Provider,
        { value: { target: { route: '/' } } },
        createElement(TypeList, { id: node, title: 'Books', types, sort: 'name', limit: 24, ...options.props }),
      ),
    ),
  );
}

test('a malformed or mismatched native row makes the whole TypeList unavailable', () => {
  const good = hit();
  const malformed = [
    hit({ id: 'not-a-uuid' }),
    hit({ type: '' }),
    hit({ labels: [] }),
    hit({ summary: undefined }),
    hit({ id: anotherId, summary: summary(id) }),
    hit({ id: anotherId, summary: summary(anotherId, 'schema:Movie') }),
  ];
  const pages = [
    { subjects: [hit({ id: undefined })], next: null },
    ...malformed.map((bad) => ({ subjects: [good, bad], next: null })),
  ];

  for (const page of pages) {
    const html = renderPage(page);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('Native book');
  }
});

test('duplicate subject identities keep their first native occurrence after checking the raw page bound', () => {
  const normalized = renderPage({
    subjects: [hit({ labels: { en: 'First occurrence' } }), hit({ labels: { en: 'Duplicate occurrence' } })],
    next: null,
  });
  expect(normalized).toContain('First occurrence');
  expect(normalized).not.toContain('Duplicate occurrence');
  expect(normalized).not.toContain('role="alert"');

  const oversized = renderPage(
    { subjects: [hit(), hit(), hit()], next: null },
    {
      props: { limit: 2 },
      read: { kind: 'search', body: { filter: { type: { in: ['schema:Book'] } }, sort: 'name', limit: 2 } },
    },
  );
  expect(oversized).toContain('role="alert"');
  expect(oversized).not.toContain('Native book');
  expect(oversized).not.toContain('role="status"');
});

test('a page from another configured type or a mismatched Search descriptor cannot leak rows', () => {
  const movie = hit({
    id: anotherId,
    type: 'schema:Movie',
    labels: { en: 'Unrelated movie' },
    summary: summary(anotherId, 'schema:Movie'),
  });
  const mixed = renderPage({ subjects: [hit(), movie], next: null });
  expect(mixed).toContain('role="alert"');
  expect(mixed).not.toContain('Native book');
  expect(mixed).not.toContain('Unrelated movie');
  expect(mixed).not.toContain('role="status"');

  const wrongProducer = renderPage(
    { subjects: [hit()], next: null },
    {
      read: {
        kind: 'search',
        body: { filter: { type: { in: ['schema:Movie'] } }, sort: 'name', limit: 24 },
      },
    },
  );
  expect(wrongProducer).toContain('role="alert"');
  expect(wrongProducer).not.toContain('Native book');
  expect(wrongProducer).not.toContain('role="status"');

  const wrongSort = renderPage(
    { subjects: [hit()], next: null },
    {
      read: {
        kind: 'search',
        body: { filter: { type: { in: ['schema:Book'] } }, sort: 'collections', limit: 24 },
      },
    },
  );
  expect(wrongSort).toContain('role="alert"');
  expect(wrongSort).not.toContain('Native book');
  expect(wrongSort).not.toContain('role="status"');
});

test('sparse summaries, native continuation and terminal empty pages render', () => {
  const continued = renderPage({ subjects: [hit()], next: 'opaque-native-cursor' });
  expect(continued).toContain('Native book');
  expect(continued).toContain('data-slot="next-page"');
  expect(continued).toContain('opaque-native-cursor');
  expect(continued).not.toContain('role="alert"');

  const empty = renderPage({ subjects: [], next: null });
  expect(empty).toContain('role="status"');
  expect(empty).not.toContain('role="alert"');
});

test('a successful sparse native window keeps its exact continuation and never claims known empty', () => {
  const cursor = ' opaque/+==?f.=a&cursor=other#二% ';
  const sparse = renderPage({ subjects: [], next: cursor });
  expect(sparse).toContain(m.public_read_sparse());
  expect(sparse).not.toContain(m.search_no_results());
  const encoded =
    /href="([^"]*)"[^>]*data-slot="next-page"/.exec(sparse)?.[1] ??
    /data-slot="next-page"[^>]*href="([^"]*)"/.exec(sparse)?.[1];
  expect(encoded).toBeDefined();
  const url = new URL(encoded!.replaceAll('&amp;', '&'), 'https://site.test');
  expect(url.searchParams.get('cursor')).toBe(cursor);
  expect(renderPage({ subjects: [], next: null })).toContain(m.search_no_results());
});

test('a raw configured limit above the registry maximum stays unavailable when paging would clamp the plan', () => {
  // The registry refuses limit 30 before its paged clamp plans 12, so a native page for that plan must not admit.
  const html = renderPage(
    { subjects: [hit()], next: null },
    {
      props: { limit: 30, paged: true },
      read: { kind: 'search', body: { filter: { type: { in: ['schema:Book'] } }, sort: 'name', limit: 12 } },
    },
  );
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('Native book');
  expect(html).not.toContain('role="status"');
});

test('recorded native home pages admit each configured TypeList only through its own planned descriptor', () => {
  const document = recorded.document as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: null });
  const reads: Record<string, { status: number; body: unknown }> = recorded.reads;
  const lists = document.content.filter((item) => item.type === 'TypeList').map((item) => item.props);
  expect(lists.map((props) => props.id)).toEqual(['books', 'anime', 'visual-novels', 'recipes']);
  const render = (props: Record<string, unknown>, section: unknown) =>
    renderToString(
      createElement(
        OverviewContext.Provider,
        {
          value: {
            locale: 'en',
            subject: null,
            unlabelled: 'Unlabelled subject',
            reader: { suitability: 'blur' },
            labels: { cover: 'Cover' },
            sections: new Map([[String(props.id), section]]),
          } as never,
        },
        createElement(TypeListContext.Provider, { value: { target: { route: '/' } } }, createElement(TypeList, props)),
      ),
    );
  const keyOf = (listId: unknown) => plan.nodes[String(listId)]!;
  const rowsOf = (key: string) => (reads[key]!.body as { subjects: { id: string }[] }).subjects;
  const repeatsSubject = (key: string) => {
    const ids = rowsOf(key).map((hit) => hit.id.toLowerCase());
    return new Set(ids).size !== ids.length;
  };

  // The native Search producer normally returns unique subjects; if a page repeats one, keep its first occurrence.
  expect(lists.filter((props) => repeatsSubject(keyOf(props.id))).map((props) => props.id)).toEqual(['books']);
  for (const props of lists) {
    const key = keyOf(props.id);
    const html = render(props, { ok: true, read: plan.reads[key]!, body: reads[key]!.body });
    expect(html).not.toContain('role="alert"');
    for (const hit of rowsOf(key)) expect(html).toContain(`/en/subjects/${hit.id}/`);
  }
  const books = render(lists[0]!, { ok: true, read: plan.reads[keyOf('books')]!, body: reads[keyOf('books')]!.body });
  expect(books).not.toContain('role="alert"');

  // A complete anime page cannot fill the recipes list: its rows name other types, so the whole page is refused.
  const foreign = render(lists[3]!, {
    ok: true,
    read: plan.reads[keyOf('recipes')]!,
    body: reads[keyOf('anime')]!.body,
  });
  expect(foreign).toContain('role="alert"');
  for (const hit of rowsOf(keyOf('anime'))) expect(foreign).not.toContain(hit.id);
});
