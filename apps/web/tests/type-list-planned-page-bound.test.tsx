import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { OverviewContext } from '../src/features/pages/overview';
import { TypeList, TypeListContext } from '../src/features/pages/type-list';
import { typeListHref, type TypeListTarget } from '../src/features/pages/type-list-model';

const node = 'books';
const ids = ['0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06', '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07'] as const;
const routeTarget: TypeListTarget = { route: '/books' };
const realmTarget: TypeListTarget = { subject: ids[0], realm: '0192f3a0-6c1e-7b2a-9d4e-000000000201' };

function hit(index: 0 | 1, label: string) {
  return { id: ids[index], type: 'schema:Book', labels: { en: label }, summary: null };
}

function plannedRead(limit: number) {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [
      {
        type: 'TypeList',
        props: { id: node, title: { en: 'Books' }, types: ['schema:Book'], sort: 'name', limit },
      },
    ],
  };
  const plan = planReads(platformRegistry, document, { subject: null });
  const read = plan.reads[plan.nodes[node]!];
  expect(read?.kind).toBe('search');
  expect(read && 'body' in read ? read.body.limit : undefined).toBe(limit);
  return read!;
}

function hrefInHtml(href: string) {
  return href.replaceAll('&', '&amp;');
}

function renderList(
  body: unknown,
  options: { limit: number; full?: boolean; target: TypeListTarget; read?: unknown },
) {
  const value = {
    locale: 'en',
    subject: null,
    unlabelled: 'Unlabelled subject',
    reader: { suitability: 'blur' },
    labels: { cover: 'Cover' },
    sections: new Map([[node, { ok: true, read: options.read ?? plannedRead(options.limit), body }]]),
  };
  return renderToString(
    createElement(
      OverviewContext.Provider,
      { value: value as never },
      createElement(
        TypeListContext.Provider,
        { value: { target: options.target, ...(options.full ? { full: node } : {}) } },
        createElement(TypeList, { id: node, title: 'Books', types: ['schema:Book'] }),
      ),
    ),
  );
}

test('a structurally valid TypeList page above its planned search limit is unavailable as a whole', () => {
  const cursor = 'over-limit-cursor';
  const body = { subjects: [hit(0, 'Native first'), hit(1, 'Native last')], next: cursor };
  for (const full of [false, true]) {
    const html = renderList(body, { limit: 1, full, target: routeTarget });
    const retry = typeListHref('en', routeTarget, node);
    expect(html).toContain('role="alert"');
    expect(html).toContain(hrefInHtml(retry));
    expect(html).not.toContain('Native first');
    expect(html).not.toContain('Native last');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('data-slot="next-page"');
    expect(html).not.toContain(cursor);
    expect(html).toContain(full ? '<h1' : '<h2');
  }
});

test('exactly-at-limit and sparse TypeList pages retain order, labels, targets and native continuation', () => {
  const cursor = 'opaque-native-cursor';
  for (const full of [false, true]) {
    const atLimit = renderList(
      { subjects: [hit(0, 'Native first'), hit(1, 'Native last')], next: null },
      { limit: 2, full, target: realmTarget },
    );
    expect(atLimit).toContain('Native first');
    expect(atLimit).toContain('Native last');
    expect(atLimit.indexOf('Native first')).toBeLessThan(atLimit.indexOf('Native last'));
    expect(atLimit).toContain(`/en/subjects/${ids[0]}/`);
    expect(atLimit).toContain(`/en/subjects/${ids[1]}/`);
    expect(atLimit).toContain(hrefInHtml(typeListHref('en', realmTarget, node)));
    expect(atLimit).not.toContain('role="alert"');
    expect(atLimit).not.toContain('data-slot="next-page"');
    if (full) expect(atLimit).not.toContain('data-slot="see-all"');
    else expect(atLimit).toContain('data-slot="see-all"');

    const sparse = renderList(
      { subjects: [hit(0, 'Native first')], next: cursor },
      { limit: 2, full, target: realmTarget },
    );
    expect(sparse).toContain('Native first');
    expect(sparse).not.toContain('Native last');
    expect(sparse).toContain('data-slot="next-page"');
    expect(sparse).toContain(hrefInHtml(typeListHref('en', realmTarget, node, cursor)));
    expect(sparse).not.toContain('role="alert"');

    const empty = renderList({ subjects: [], next: null }, { limit: 2, full, target: realmTarget });
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain('role="alert"');
    expect(empty).not.toContain('data-slot="next-page"');
  }
});

test('a non-search descriptor makes the TypeList unavailable as a whole before slicing or continuation', () => {
  const cursor = 'non-search-cursor';
  const body = { subjects: [hit(0, 'Native first'), hit(1, 'Native last')], next: cursor };
  const html = renderList(body, {
    limit: 2,
    target: routeTarget,
    read: { kind: 'links', id: ids[0], property: 'schema:author', limit: 2 },
  });
  expect(html).toContain('role="alert"');
  expect(html).toContain(hrefInHtml(typeListHref('en', routeTarget, node)));
  expect(html).not.toContain('Native first');
  expect(html).not.toContain('Native last');
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain('data-slot="next-page"');
  expect(html).not.toContain(cursor);
});
