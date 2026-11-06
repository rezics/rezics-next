import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { OverviewValue } from '../src/features/pages/overview';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { PAGE_GLOBAL_CONTEXT } = await import('@rezics/composition');
const { OverviewContext } = await import('../src/features/pages/overview');
const { TypeList, TypeListContext } = await import('../src/features/pages/type-list');
const { typeListHref } = await import('../src/features/pages/type-list-model');
const { catalogueRowContext } = await import('../src/features/pages/catalogue-list-context/model');
const { catalogueExample, catalogueIds } = await import('../src/kernel/fake/catalogue-list-context');
const { defaultReader } = await import('../src/subject/reader');
const { PlainLink } = await import('../src/features/pages/shared');

const target = { subject: catalogueIds.book, realm: catalogueIds.realm };
// The configured TypeList and its planned Search descriptor name the same types, sort and limit.
const configured = { types: ['schema:Book', 'schema:Movie'], sort: 'name', limit: 2 };
function render(rows: unknown[], options: { failed?: boolean; cursor?: string; locale?: string } = {}) {
  const value = {
    locale: options.locale ?? 'en',
    subject: null,
    reader: defaultReader,
    link: PlainLink,
    unlabelled: 'Unnamed',
    spoilerShow: 'Show',
    labels: { cover: 'Cover' },
    context: { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'realm', id: catalogueIds.realm, title: 'Public Realm' } },
    sections: new Map([
      [
        'works',
        options.failed
          ? { ok: false, status: 503 }
          : {
              ok: true,
              read: {
                kind: 'search',
                body: { filter: { type: { in: configured.types } }, sort: configured.sort, limit: configured.limit },
              },
              body: { subjects: rows, next: 'source-bound-next' },
            },
      ],
    ]),
  };
  return renderToStaticMarkup(
    createElement(
      OverviewContext.Provider,
      { value: value as OverviewValue },
      createElement(
        TypeListContext.Provider,
        { value: { target, full: 'works', cursor: options.cursor } },
        createElement(TypeList, { id: 'works', title: 'Catalogue', ...configured }),
      ),
    ),
  );
}

test('homonyms retain media, qualified creators, precise release facts and sourced provider statistics', () => {
  const html = render([catalogueExample(), catalogueExample(true)]);
  for (const text of [
    'Book',
    'Film',
    'Author',
    'Director',
    'Akira Mori',
    'Aki Mori',
    'Credited as',
    'A. Mori',
    '1998',
    'March 2005',
    'Provider rating',
    '8.2',
    '124 source observations',
    'source-revision-7',
  ])
    expect(html).toContain(text);
  expect(html.indexOf('Akira Mori')).toBeLessThan(html.indexOf('Aki Mori'));
  expect(html).not.toContain('January');
  expect(html).not.toContain('March 1');
  expect(html).not.toContain('data-slot="public-rating');
  expect(html).not.toContain('role="button"');
  expect(html).toContain(`?realm=${catalogueIds.realm}`);
  expect(html).toContain(`subjects/${catalogueIds.creator}/akira-mori`);
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
});

test('the admitted native window and exact scoped cursor remain available in the original tab', () => {
  const html = render([catalogueExample(true), catalogueExample()], { cursor: 'current-source-window', locale: 'fr' });
  const next = typeListHref('fr', target, 'works', 'source-bound-next').replaceAll('&', '&amp;');
  expect(html).toContain(next);
  expect(html).toContain('/fr/subjects/');
  expect(html).toContain('S’ouvre dans un nouvel onglet');
  expect(html.indexOf('Aki Mori')).toBeLessThan(html.indexOf('Akira Mori'));
  expect(html).not.toContain('data-slot="see-all"');
  const failed = render([catalogueExample()], { failed: true, cursor: 'current-source-window' });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('current-source-window');
  expect(failed).not.toContain('The Crossing');
  expect(failed).not.toContain('source-bound-next');
});

test('concealed targets and distinct missing states never invent a creator or personal action', () => {
  const row = catalogueExample();
  for (const state of ['unknown', 'withheld', 'absent', 'unavailable'] as const) {
    const html = render([
      {
        ...row,
        catalogueContext: {
          version: 1,
          state,
          subject: row.id,
          target: null,
          observation: 'revision-8',
        },
      },
    ]);
    expect(html).toContain(`data-state="${state}"`);
    expect(html).not.toContain(`/subjects/${row.id}/`);
    expect(html).not.toContain('Akira Mori');
    expect(html).not.toContain('1998');
    expect(html).not.toContain('data-slot="provider-statistic"');
  }
});

test('existing native facts and supplied presentation render without the reserved producer extension', () => {
  const { catalogueContext: _missing, ...row } = catalogueExample();
  const html = render([{ ...row, facts: { 'schema:datePublished': [{ kind: 'time', year: 1998 }] } }]);
  expect(html).toContain('1998');
  expect(html).toContain('Context unavailable');
  expect(html).not.toContain('Akira Mori');
  expect(html).toContain(`/subjects/${row.id}/`);
});

test('invalid, mismatched, excessive and wrong-direction contexts fail closed within the native row', () => {
  const row = catalogueExample();
  const creator = row.catalogueContext.creators[0]!;
  for (const patch of [
    { subject: catalogueIds.film },
    { target: { id: catalogueIds.film } },
    { medium: {} },
    { creators: [{ ...creator, direction: 'creator-to-subject' }] },
    { creators: Array.from({ length: 4 }, () => creator) },
    { facts: [{ ...row.catalogueContext.facts[0]!, value: { kind: 'time', year: 2005, month: 2, day: 30 } }] },
  ]) {
    const html = render([{ ...row, catalogueContext: { ...row.catalogueContext, ...patch } }]);
    expect(html).toContain('The Crossing');
    expect(html).toContain('Context unavailable');
    expect(html).not.toContain('Akira Mori');
    expect(html).not.toContain(`/subjects/${row.id}/`);
  }
  const long = render([
    {
      ...row,
      catalogueContext: { ...row.catalogueContext, creators: [{ ...creator, name: { en: '森'.repeat(320) } }] },
    },
  ]);
  expect(long).toContain('森'.repeat(159) + '…');
  expect(long).not.toContain('森'.repeat(161));
  expect(
    catalogueRowContext({ id: row.id, facts: { invalid: [{ kind: 'time', year: 2005, day: 1 }] } }).facts,
  ).toBeUndefined();
});
