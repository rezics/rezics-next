import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { OverviewContext } = await import('../src/features/pages/overview');
const { ZoneDestinationsContext } = await import('../src/features/pages/zone-destinations');
const { ZoneTypeList } = await import('../src/features/pages/zone-type-list');

const node = 'books';
const zone = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';

function renderList(body: unknown, cursor?: string) {
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
        { value: { zoneId: zone, locale: 'en', route: '', ...(cursor ? { cursor } : {}) } },
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
