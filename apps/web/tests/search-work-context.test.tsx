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

// Native schema/presentation witnesses; these do not stand in for installed callable acceptance.
import * as v from 'valibot';
import { qualifiedSearchExample } from '../src/search/work-context/examples';
import { WorkContextView } from '../src/search/work-context/view';
import {
  workContextSchema,
  validWorkContextBinding,
  workContextPageWithinLimit,
} from '../src/search/work-context/schema';
import { parseDiscoveryPage } from '../src/search/discovery';
import { qualifiedWorkContextInstalled } from '../src/search/work-context/availability';
import { realmCatalogueSubjectHref } from '../src/search/realm-catalogue-handoff';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

function contextExample() {
  const hit = qualifiedSearchExample().page.hits[0]!;
  if (!('workContext' in hit) || hit.workContext?.state !== 'current' || hit.summary.kind !== 'subject')
    throw new Error('Expected native Work context');
  const context = hit.workContext;
  if (context.creators.state !== 'current') throw new Error('Expected native creator');
  return { hit, context, statement: context.creators.items[0]! };
}

test('qualified homonyms keep same-statement qualifiers, directed release facts and the exact localized Search return', () => {
  const state = qualifiedSearchExample();
  for (const locale of ['en', 'zh-Hant', 'ja']) {
    const search = `/${locale}/search?q=Echo&kinds=schema%3ABook&language=ja&language=en&f.genre=mystery&layout=compact&cursor=exact%2Fopaque%2Bcursor`;
    const html = renderToStaticMarkup(
      createElement(DiscoveryResults, {
        state,
        locale,
        yearProperties: [],
        subjectHrefFor: (subject) => realmCatalogueSubjectHref(subject, locale, search),
      }),
    );
    expect(html).toContain('data-context-kind="release"');
    expect(html.match(/data-context-kind="work"/g)).toHaveLength(5);
    expect(html).toContain('title="schema:contributor">Contributor</span>:');
    expect(html).toContain('data-qualifier-property="wdt:P1932"');
    expect(html).toContain('Mira Chen (original credit)');
    expect(html).toContain('data-qualifier-property="wdt:P3831"');
    expect(html).toContain('Original edition translator');
    expect(html).toContain('data-property="schema:exampleOfWork"');
    expect(html).toContain('data-precision="year"');
    expect(html).toContain('data-precision="month"');
    const href = realmCatalogueSubjectHref({ id: state.page.hits[5]!.key.id, label: 'Echo' }, locale, search);
    expect(html).toContain(href.replaceAll('&', '&amp;'));
    expect(subjectVisitReturn(new URL(href, 'https://rezics.invalid').searchParams.get('via'), locale)).toBe(
      `${search}#search-results`,
    );
    expect(html).not.toContain('schema:MusicRecording');
    expect(html).not.toContain('schema:MusicRelease');
  }
});

test('the closed native admission keeps absent separate and requires installed callable activation', () => {
  const original = qualifiedSearchExample().page;
  const page = parseDiscoveryPage(original);
  expect(page).toBeDefined();
  if (!page) return;
  const first = page.hits[0]!;
  if (!('workContext' in first)) throw new Error('Context was discarded');
  expect(first.workContext?.state).toBe(qualifiedWorkContextInstalled ? 'current' : 'unavailable');
  const absent = structuredClone(original);
  const hit = absent.hits[0]!;
  if ('workContext' in hit) delete hit.workContext;
  const admitted = parseDiscoveryPage(absent)?.hits[0];
  expect(admitted && 'workContext' in admitted && admitted.workContext).toBeFalsy();
  // Admission never changes the supplied native projection or hydrates another Subject.
  expect('workContext' in original.hits[0]! && original.hits[0].workContext?.state).toBe('current');
});

test('native source/type identity, unique statements, byte bounds, decimal strings and date precision are enforced', () => {
  const { context, statement, hit } = contextExample();
  expect(v.safeParse(workContextSchema, context).success).toBe(true);
  if (hit.summary.kind !== 'subject') throw new Error('Expected Subject');
  expect(validWorkContextBinding(context, hit.summary.value)).toBe(true);
  expect(
    validWorkContextBinding({ ...context, type: { ...context.type, id: 'schema:Movie' } }, hit.summary.value),
  ).toBe(false);
  expect(
    validWorkContextBinding(
      {
        ...context,
        creators: {
          state: 'current',
          items: [{ ...statement, sourceId: '00000000-0000-4000-8000-999999999999' }],
          overflow: false,
        },
      },
      hit.summary.value,
    ),
  ).toBe(false);
  expect(
    validWorkContextBinding(
      { ...context, relations: { state: 'current', items: [statement], overflow: false } },
      hit.summary.value,
    ),
  ).toBe(false);
  const invalid = [
    { ...context, creators: { state: 'withheld', items: [statement] } },
    { ...context, creators: { state: 'current', items: [statement], overflow: true } },
    { ...context, type: { id: context.type.id, labels: { en: 'a', ja: 'a' } } },
    { ...context, type: { id: context.type.id, labels: { en: '界'.repeat(86) } } },
    {
      ...context,
      dates: {
        state: 'current',
        items: [
          {
            ...statement,
            value: { state: 'value', kind: 'time', calendar: 'gregorian', year: 2023, month: 2, day: 29 },
          },
        ],
        overflow: false,
      },
    },
    {
      ...context,
      dates: {
        state: 'current',
        items: [{ ...statement, value: { state: 'value', kind: 'time', calendar: 'gregorian', year: 2024, day: 2 } }],
        overflow: false,
      },
    },
    {
      ...context,
      creators: {
        state: 'current',
        items: [
          {
            ...statement,
            qualifiers: {
              state: 'current',
              items: [
                { property: statement.property, value: { state: 'value', kind: 'quantity', amount: 0.1, unit: 's' } },
              ],
            },
          },
        ],
        overflow: false,
      },
    },
  ];
  for (const value of invalid) expect(v.safeParse(workContextSchema, value).success).toBe(false);
  const large = {
    ...context,
    creators: {
      state: 'current' as const,
      items: [
        statement,
        { ...statement, statementId: '00000000-0000-4000-8000-000000000999' },
        { ...statement, statementId: '00000000-0000-4000-8000-000000000998' },
      ],
      overflow: true,
    },
  };
  expect(workContextPageWithinLimit(Array.from({ length: 100 }, () => large))).toBe(false);
  expect(
    parseDiscoveryPage({
      ...qualifiedSearchExample().page,
      hits: [{ ...hit, workContext: { ...context, subjectId: '00000000-0000-4000-8000-000000000999' } }],
    }),
  ).toBeUndefined();
});

test('empty, withheld, unsupported, unavailable reasons, unknown values, exact quantities and original targets remain distinct', () => {
  const { context, statement } = contextExample();
  const render = (context: Parameters<typeof WorkContextView>[0]['context']) =>
    renderToStaticMarkup(createElement(WorkContextView, { context, locale: 'en' }));
  const states = [
    { state: 'empty' },
    { state: 'withheld' },
    { state: 'unsupported' },
    ...['native', 'limit', 'response_limit'].map((reason) => ({ state: 'unavailable', reason })),
  ];
  for (const state of states) {
    const parsed = v.parse(workContextSchema, { ...context, creators: state, relations: state, dates: state });
    const html = render(parsed);
    expect(html).toContain(`data-context-state="${state.state}"`);
    expect(html).not.toContain(statement.statementId);
    if ('reason' in state) expect(html).toContain(`data-context-reason="${state.reason}"`);
  }
  expect(render(undefined)).toContain('data-context-state="absent"');
  const qualified = v.parse(workContextSchema, {
    ...context,
    creators: {
      state: 'current',
      overflow: false,
      items: [
        {
          ...statement,
          value: {
            state: 'value',
            kind: 'item',
            id: '00000000-0000-4000-8000-000000000800',
            originalId: '00000000-0000-4000-8000-000000000801',
            type: { id: 'schema:Person', labels: { en: 'Person' } },
            labels: { en: 'Terminal Person' },
          },
          qualifiers: {
            state: 'current',
            items: [
              {
                property: statement.property,
                value: { state: 'value', kind: 'quantity', amount: '+9007199254740993.00100', unit: 's' },
              },
              { property: statement.property, value: { state: 'somevalue' } },
              { property: statement.property, value: { state: 'novalue' } },
            ],
          },
        },
      ],
    },
  });
  const html = render(qualified);
  expect(html).toContain('+9007199254740993.00100 s');
  expect(html).toContain('/en/subjects/00000000-0000-4000-8000-000000000800/terminal-person');
  expect(html).toContain('Originally asserted target:');
  expect(html).toContain('data-value-state="somevalue"');
  expect(html).toContain('data-value-state="novalue"');
});
