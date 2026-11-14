import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { readDiscovery } from '../src/search/discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import { ResultList } from '../src/search/results';

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = `sha256:${'0'.repeat(64)}`;

function term(id: string, label: string) {
  return { id, labels: { ja: label } };
}

function statement(
  sourceId: string,
  id: number,
  property: string,
  propertyLabel: string,
  value: unknown,
  qualifiers: unknown = { state: 'empty' },
) {
  return {
    statementId: uuid(id),
    sourceId,
    direction: 'outgoing',
    property: term(property, propertyLabel),
    revision: 1,
    release: digest,
    rank: 'normal',
    value,
    qualifiers,
  };
}

function item(id: number, originalId: number, label: string, typeId = 'schema:Person', typeLabel = '人物') {
  return {
    state: 'value',
    kind: 'item',
    id: uuid(id),
    originalId: uuid(originalId),
    type: term(typeId, typeLabel),
    labels: { en: label, ja: label },
  };
}

function context(
  subjectId: string,
  type: string,
  kind: 'work' | 'release' | 'recording',
  creators: unknown,
  relations: unknown,
  dates: unknown,
) {
  return {
    state: 'current',
    subjectId,
    type: term(type, '作品の種類'),
    kind,
    creators,
    relations,
    dates,
  };
}

function subjectHit(id: string, type: string, options: { workContext?: unknown; factProperty?: string } = {}) {
  const { workContext, factProperty } = options;
  return {
    key: { owner: 'semantic', kind: type, route: 0, id },
    summary: {
      kind: 'subject',
      value: {
        id,
        type,
        types: [type],
        label: { value: 'Echo', language: 'en' },
        creativeWork: true,
        cover: null,
      },
    },
    ...(workContext === undefined ? {} : { workContext }),
    ...(factProperty
      ? {
          facts: {
            [factProperty]: [
              {
                kind: 'item',
                id: uuid(factProperty === 'schema:author' ? 100 : 101),
                labels: { en: factProperty === 'schema:author' ? 'Creator 0' : 'Creator 1' },
              },
            ],
            'schema:datePublished': [
              {
                kind: 'time',
                year: factProperty === 'schema:author' ? 2000 : 2001,
                ...(factProperty === 'schema:contributor' ? { month: 2 } : {}),
              },
            ],
          },
          listPresentation: { imageAspect: 'portrait', keyFacts: [factProperty, 'schema:datePublished'] },
        }
      : {}),
  };
}

function responsePage(hits: unknown[]) {
  const kinds = ['schema:Book', 'bf:Instance', 'schema:MusicRecording'];
  return {
    hits,
    kinds: { values: kinds.map((id) => ({ id, labels: { en: id, ja: id }, icon: 'book' })), next: null },
    next: 'native-next',
    as_of: '2026-11-04T00:00:00Z',
  };
}

function render(state: Awaited<ReturnType<typeof readDiscovery>>['discovery']) {
  return renderToStaticMarkup(
    createElement(DiscoveryResults, {
      state,
      locale: 'ja',
      yearProperties: ['schema:datePublished'],
      factDefinitions: {
        'schema:author': { labels: { ja: '著者' } },
        'schema:contributor': { labels: { ja: '貢献者' } },
        'schema:datePublished': { labels: { ja: '出版日' } },
      },
    }),
  );
}

test('native homonyms retain qualified Work, Release and Recording context through one discovery request', async () => {
  const workId = uuid(1);
  const bookId = uuid(2);
  const releaseId = uuid(3);
  const recordingId = uuid(4);
  const absentId = uuid(5);
  const unavailableId = uuid(6);
  const relationItems = [
    statement(workId, 301, 'schema:partOf', '所属作品', item(410, 411, 'Series One', 'schema:CreativeWork', '創作物')),
    statement(workId, 302, 'schema:partOf', '所属作品', item(412, 413, 'Series Two', 'schema:CreativeWork', '創作物')),
    statement(
      workId,
      303,
      'schema:partOf',
      '所属作品',
      item(414, 415, 'Series Three', 'schema:CreativeWork', '創作物'),
    ),
  ];
  const hits = [
    subjectHit(workId, 'schema:Book', {
      factProperty: 'schema:author',
      workContext: context(
        workId,
        'schema:Book',
        'work',
        {
          state: 'current',
          items: [
            statement(workId, 300, 'schema:author', '作者角色', item(400, 401, 'Mira Chen'), {
              state: 'current',
              items: [
                {
                  property: term('schema:roleName', 'クレジット表記'),
                  value: { state: 'value', kind: 'text', text: 'M. Chen' },
                },
              ],
            }),
          ],
          overflow: false,
        },
        { state: 'current', items: relationItems, overflow: true },
        {
          state: 'current',
          items: [
            statement(workId, 304, 'schema:datePublished', '刊行日', {
              state: 'value',
              kind: 'time',
              calendar: 'gregorian',
              year: 2009,
            }),
            statement(workId, 305, 'schema:datePublished', '刊行日', { state: 'somevalue' }),
            statement(workId, 306, 'schema:datePublished', '刊行日', { state: 'novalue' }),
          ],
          overflow: false,
        },
      ),
    }),
    subjectHit(bookId, 'schema:Book', {
      factProperty: 'schema:contributor',
      workContext: context(
        bookId,
        'schema:Book',
        'work',
        { state: 'empty' },
        { state: 'empty' },
        {
          state: 'current',
          items: [
            statement(bookId, 320, 'schema:datePublished', '刊行日', {
              state: 'value',
              kind: 'time',
              calendar: 'gregorian',
              year: 2010,
              month: 2,
            }),
          ],
          overflow: false,
        },
      ),
    }),
    subjectHit(releaseId, 'bf:Instance', {
      workContext: context(
        releaseId,
        'bf:Instance',
        'release',
        { state: 'empty' },
        { state: 'withheld' },
        {
          state: 'current',
          items: [
            statement(releaseId, 330, 'schema:datePublished', '發行日', {
              state: 'value',
              kind: 'time',
              calendar: 'gregorian',
              year: 2011,
              month: 3,
            }),
          ],
          overflow: false,
        },
      ),
    }),
    subjectHit(recordingId, 'schema:MusicRecording', {
      workContext: context(
        recordingId,
        'schema:MusicRecording',
        'recording',
        { state: 'unavailable', reason: 'limit' },
        { state: 'unsupported' },
        {
          state: 'current',
          items: [
            statement(recordingId, 340, 'schema:datePublished', '公開日', {
              state: 'value',
              kind: 'time',
              calendar: 'gregorian',
              year: 2012,
              month: 4,
              day: 5,
            }),
            statement(recordingId, 341, 'schema:datePublished', '公開日', { state: 'unsupported' }),
          ],
          overflow: false,
        },
      ),
    }),
    subjectHit(absentId, 'schema:Book'),
    subjectHit(unavailableId, 'schema:Book', { workContext: { state: 'unavailable', reason: 'response_limit' } }),
  ];
  let calls = 0;
  const client = createKernelClient('http://kernel.local', {
    fetch: async () => {
      calls++;
      return Response.json(responsePage(hits));
    },
  });
  const { discovery } = await readDiscovery({ representation: 'discovery-v1', languages: ['ja'], limit: 20 }, (body) =>
    client.subjects.$search.post(body),
  );
  const html = render(discovery);

  expect(html).toContain('著者:');
  expect(html).toContain('貢献者:');
  expect(html.match(/出版日:/g)).toHaveLength(2);
  expect(html).toContain('data-slot="year">2000</span>');
  expect(html).toContain('data-slot="date">2001年2月</span>');
  expect(html).toContain(`/ja/subjects/${uuid(101)}/creator-1`);
  expect(html).toContain(`/ja/subjects/${bookId}/echo`);
  expect(html).toContain('クレジット表記');
  expect(html).toContain('M. Chen');
  expect(html).toContain('Series One');
  expect(html).toContain('作者角色');
  expect(html).toContain('所属作品');
  expect(html).toContain('作品のコンテキスト · 作品');
  expect(html).toContain('作品のコンテキスト · リリース');
  expect(html).toContain('作品のコンテキスト · 録音');
  expect(html).toContain('2009年');
  expect(html).toContain('2010年2月');
  expect(html).toContain('2011年3月');
  expect(html).toContain('2012年4月5日');
  expect(html).toContain('値があることは示されていますが、内容は公開されていません。');
  expect(html).toContain('値は示されていません。');
  expect(html).toContain('この値はサポートされていません。');
  expect(html).toContain('このセクションに項目はありません。');
  expect(html).toContain('このセクションの情報は非公開です。');
  expect(html).toContain('このセクションの情報を利用できません。');
  expect(html).toContain('このセクションはサポートされていません。');
  expect(html).toContain('ほかにも項目がありますが、移動先は提供されていません。');
  const overflowAt = html.indexOf('data-work-context-overflow');
  expect(overflowAt).toBeGreaterThan(-1);
  expect(html.slice(overflowAt, html.indexOf('</p>', overflowAt))).not.toContain('<a');
  expect(html).toContain(`/ja/subjects/${uuid(400)}/`);
  expect(html).toContain(`/ja/subjects/${uuid(410)}/`);
  expect(html).not.toContain(`/ja/subjects/${uuid(401)}/`);
  expect(html.indexOf(uuid(100))).toBeLessThan(html.indexOf(uuid(101)));
  expect(html).not.toContain('2000年1月');
  expect(calls).toBe(1);
  expect(discovery.status === 'ready' && discovery.page.next).toBe('native-next');
});

test('a replacement page retires old work context and absent context remains unavailable without extra reads', async () => {
  const subjectId = uuid(50);
  const prior = context(
    subjectId,
    'schema:Book',
    'work',
    {
      state: 'current',
      items: [statement(subjectId, 500, 'schema:author', '作者', item(501, 502, 'Old Creator'))],
      overflow: false,
    },
    { state: 'empty' },
    { state: 'empty' },
  );
  const responses = [
    responsePage([subjectHit(subjectId, 'schema:Book', { workContext: prior })]),
    responsePage([subjectHit(subjectId, 'schema:Book')]),
  ];
  let calls = 0;
  const client = createKernelClient('http://kernel.local', {
    fetch: async () => Response.json(responses[calls++] ?? responses[responses.length - 1]),
  });
  const request = { representation: 'discovery-v1' as const, languages: ['ja'], limit: 20 };
  const first = await readDiscovery(request, (body) => client.subjects.$search.post(body));
  expect(render(first.discovery)).toContain('Old Creator');
  const replacement = await readDiscovery(request, (body) => client.subjects.$search.post(body));
  const html = render(replacement.discovery);

  expect(html).not.toContain('Old Creator');
  expect(html).toContain('作品のコンテキストを利用できません。');
  expect(calls).toBe(2);
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
