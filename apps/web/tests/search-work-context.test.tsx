import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { readDiscovery } from '../src/search/discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import { ResultList } from '../src/search/results';

test('native homonyms retain their role, partial date, exact localized targets and order without hydration', async () => {
  const hits = ['schema:author', 'schema:contributor'].map((property, index) => {
    const id = `00000000-0000-4000-8000-00000000000${index + 1}`;
    return {
      key: { owner: 'semantic', kind: 'schema:Book', route: 0, id },
      summary: {
        kind: 'subject',
        value: {
          id,
          type: 'schema:Book',
          types: ['schema:Book'],
          label: { value: 'Echo', language: 'en' },
          creativeWork: true,
          cover: null,
        },
      },
      facts: {
        [property]: [
          { kind: 'item', id: `00000000-0000-4000-8000-00000000010${index}`, labels: { en: `Creator ${index}` } },
        ],
        'schema:datePublished': [{ kind: 'time', year: 2000 + index, ...(index ? { month: 2 } : {}) }],
      },
      listPresentation: { imageAspect: 'portrait', keyFacts: [property, 'schema:datePublished'] },
    };
  });
  let calls = 0;
  const client = createKernelClient('http://kernel.local', {
    fetch: async () => {
      calls++;
      return Response.json({
        hits,
        kinds: { values: [], next: null },
        next: 'native-next',
        as_of: '2026-11-04T00:00:00Z',
      });
    },
  });
  const { discovery } = await readDiscovery({ representation: 'discovery-v1', languages: ['ja'], limit: 20 }, (body) =>
    client.subjects.$search.post(body),
  );
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, {
      state: discovery,
      locale: 'ja',
      yearProperties: ['schema:datePublished'],
      factDefinitions: {
        'schema:author': { labels: { ja: '著者' } },
        'schema:contributor': { labels: { ja: '貢献者' } },
        'schema:datePublished': { labels: { ja: '出版日' } },
      },
    }),
  );
  expect(html).toContain('著者:');
  expect(html).toContain('貢献者:');
  expect(html.match(/出版日:/g)).toHaveLength(2);
  expect(html).toContain('data-slot="year">2000</span>');
  expect(html).toContain('data-slot="date">2001年2月</span>');
  expect(html).toContain('/ja/subjects/00000000-0000-4000-8000-000000000101/creator-1');
  expect(html).toContain(`/ja/subjects/${hits[1]!.key.id}/echo`);
  expect(html.indexOf('00000000-0000-4000-8000-000000000100')).toBeLessThan(
    html.indexOf('00000000-0000-4000-8000-000000000101'),
  );
  expect(html).not.toContain('2000年1月');
  expect(calls).toBe(1);
  expect(discovery.status === 'ready' && discovery.page.next).toBe('native-next');
});

test('missing metadata never supplies a creator role or a date', () => {
  const html = renderToStaticMarkup(
    createElement(ResultList, {
      locale: 'en',
      hitTypes: {},
      yearProperties: ['schema:datePublished'],
      hits: [
        {
          id: 'bare-work',
          type: 'schema:Book',
          labels: { en: 'Echo' },
          facts: { 'schema:contributor': [{ kind: 'item', id: 'creator', labels: { en: 'Mira' } }] },
        listPresentation: { imageAspect: 'portrait', keyFacts: ['schema:contributor'] },
        },
      ],
    }),
  );
  expect(html).toContain('/en/subjects/bare-work/echo');
  expect(html).not.toContain('data-slot="year"');
  expect(html).toContain('Mira');
  expect(html).not.toContain('Author:');
  expect(html).not.toContain('Publication date:');
});
