import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { OverviewContext } from '../src/features/pages/overview';
import { TypeList, TypeListContext } from '../src/features/pages/type-list';

const node = 'books';
const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
const anotherId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07';

function hit(overrides: Record<string, unknown> = {}) {
  return { id, type: 'schema:Book', labels: { en: 'Native book' }, summary: null, ...overrides };
}

function summary(subjectId: string, type = 'schema:Book') {
  return { id: subjectId, type, types: [type], label: null, creativeWork: true, cover: null };
}

function renderPage(body: unknown) {
  const value = {
    locale: 'en',
    subject: null,
    unlabelled: 'Unlabelled subject',
    reader: { suitability: 'blur' },
    labels: { cover: 'Cover' },
    sections: new Map([
      [node, { ok: true, read: { kind: 'search', body: { filter: {}, sort: 'name', limit: 24 } }, body }],
    ]),
  };
  return renderToString(
    createElement(
      OverviewContext.Provider,
      { value: value as never },
      createElement(
        TypeListContext.Provider,
        { value: { target: { route: '/' } } },
        createElement(TypeList, { id: node, title: 'Books', types: ['schema:Book'] }),
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
    { subjects: [good, good], next: null },
  ];

  for (const page of pages) {
    const html = renderPage(page);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('Native book');
  }
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
