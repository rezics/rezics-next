import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { OverviewContext } = await import('../src/features/pages/overview');
const { ZoneDestinationsContext, ZoneTypeList } = await import('../src/features/pages/type-list');

const node = 'books';
const zone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';

function renderList(body: unknown, destinations: { cursor?: string; list?: string } = {}) {
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
        ZoneDestinationsContext.Provider,
        { value: { zoneId: zone, locale: 'en', route: '', ...destinations } },
        createElement(ZoneTypeList, { id: node, title: 'Books', types: ['schema:Book'] }),
      ),
    ),
  );
}

test('a Zone TypeList stays on the Zone route and opens exact Zone subject destinations', () => {
  const html = renderList({
    subjects: [{ id, type: 'schema:Book', labels: { en: 'Native book' }, summary: null }],
    next: 'opaque-native-cursor',
  });
  expect(html).toContain('data-zone-type-list');
  expect(html).toContain(`/en/zones/${zone}/subjects/${id}`);
  expect(html).toContain(`/en/zones/${zone}?list=books`);
  expect(html).toContain(`/en/zones/${zone}?list=books&amp;cursor=opaque-native-cursor`);
  expect(html).not.toContain('/en/search/list');
  expect(html).not.toContain(`/en/subjects/${id}`);
});

test('a TypeList full page is selected by list identity and a sibling cursor does not expand it', () => {
  const body = {
    subjects: [{ id, type: 'schema:Book', labels: { en: 'Native book' }, summary: null }],
    next: 'opaque-native-cursor',
  };
  const preview = renderList(body, { cursor: 'opaque-native-cursor' });
  expect(preview).toContain(m.home_see_all({}, { locale: 'en' }));
  expect(preview).not.toContain('<h1');
  const full = renderList(body, { list: node, cursor: 'opaque-native-cursor' });
  expect(full).toContain('<h1');
  expect(full).not.toContain(m.home_see_all({}, { locale: 'en' }));
  const other = renderList(body, { list: 'recipes', cursor: 'opaque-native-cursor' });
  expect(other).toContain(m.home_see_all({}, { locale: 'en' }));
  expect(other).not.toContain('<h1');
});
