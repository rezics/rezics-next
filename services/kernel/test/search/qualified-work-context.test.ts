import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admitDiscoveryPage, discoveryHttpPage } from '../../src/search/discovery-http.ts';
import {
  boundWorkContexts,
  workContextBytes,
  WORK_CONTEXT_LIMITS,
  type CurrentWorkContext,
} from '../../src/search/work-context.ts';
import { finishListWorkContext, prepareListWorkContext } from '../../src/semantic/list-presentation-work-context.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const id = newId(1000),
  target = newId(2000);
const context: CurrentWorkContext = {
  state: 'current',
  subjectId: id,
  type: { id: 'schema:Book', labels: { en: 'Book' } },
  kind: 'work',
  creators: {
    state: 'current',
    overflow: false,
    items: [
      {
        statementId: newId(1000),
        sourceId: id,
        direction: 'outgoing',
        property: { id: 'schema:contributor', labels: { en: 'Contributor' } },
        revision: 1,
        release: bundledDigest,
        rank: 'normal',
        value: {
          state: 'value',
          kind: 'item',
          id: target,
          originalId: target,
          type: { id: 'schema:Person', labels: {} },
          labels: { en: 'Same name' },
        },
        qualifiers: {
          state: 'current',
          items: [
            {
              property: { id: 'wdt:P1932', labels: {} },
              value: { state: 'value', kind: 'text', text: 'Exact credit' },
            },
          ],
        },
      },
    ],
  },
  relations: { state: 'empty' },
  dates: { state: 'empty' },
};
function page(workContext: unknown = structuredClone(context)) {
  return {
    hits: [
      {
        key: { owner: 'semantic', kind: 'schema:Book', route: routeOf(id)!, id },
        summary: {
          kind: 'subject',
          value: {
            id,
            type: 'schema:Book',
            types: ['schema:Book', 'schema:CreativeWork'],
            label: null,
            creativeWork: true,
            cover: null,
          },
        },
        workContext,
      },
    ],
    kinds: { values: [], next: null },
    next: null,
    as_of: '2026-11-04T00:00:00Z',
  };
}
test('discovery-v1 serializes the actual optional work contract and snapshots nested qualifiers', () => {
  const value = page();
  admitDiscoveryPage(value);
  const wire = discoveryHttpPage(value);
  expect(wire.hits[0]).toMatchObject({ workContext: context });
  const original = value.hits[0]!.workContext as CurrentWorkContext;
  original.type.labels.en = 'Changed';
  expect(wire.hits[0]).toMatchObject({ workContext: { type: { labels: { en: 'Book' } } } });
  for (const state of ['empty', 'withheld', 'unsupported'] as const) {
    const current = structuredClone(context);
    current.creators = { state };
    expect(() => admitDiscoveryPage(page(current))).not.toThrow();
  }
  expect(() => admitDiscoveryPage(page({ state: 'unavailable', reason: 'native' }))).not.toThrow();
});
test('malformed qualified wire cannot invent direction, dates, cross-statement identity or overflow delivery', () => {
  const creator = (structuredClone(context).creators as Extract<CurrentWorkContext['creators'], { state: 'current' }>)
    .items[0]!;
  const malformed = [
    { ...context, subjectId: target },
    { ...context, type: { id: 'schema:Person', labels: {} } },
    { ...context, kind: 'recording' },
    { ...context, kind: 'release' },
    { ...context, creators: { state: 'withheld', items: [creator] } },
    { ...context, creators: { state: 'current', overflow: true, items: [creator] } },
    { ...context, creators: { state: 'current', overflow: false, more: '/guessed', items: [creator] } },
    { ...context, creators: { state: 'current', overflow: false, items: [{ ...creator, direction: 'incoming' }] } },
    { ...context, creators: { state: 'current', overflow: false, items: [creator, creator] } },
    {
      ...context,
      dates: {
        state: 'current',
        overflow: false,
        items: [
          {
            ...creator,
            statementId: newId(1000),
            value: { state: 'value', kind: 'time', calendar: 'gregorian', year: 2023, month: 2, day: 29 },
          },
        ],
      },
    },
  ];
  for (const value of malformed) expect(() => admitDiscoveryPage(page(value))).toThrow();
});
test('unrepresentable dates and oversized qualification retain explicit bounded states', () => {
  const raw = {
    kind: 'statement' as const,
    language: null,
    property: 'schema:datePublished',
    statement_id: newId(1000),
    operation: 'assert' as const,
    fact_revision: 1,
    fact_release: bundledDigest,
    body: {
      rank: 'normal',
      value: { type: 'value', content: { time: '+2020-00-00T00:00:00Z', precision: 9, calendarmodel: 'unsupported' } },
    },
  };
  const draft = prepareListWorkContext(id, 'schema:Book', bundledRelease, [raw], new Set(), ['en']);
  expect(finishListWorkContext(id, draft, new Map(), bundledRelease)).toMatchObject({
    dates: { state: 'current', items: [{ value: { state: 'unsupported' } }] },
  });
  const credit = prepareListWorkContext(
    id,
    'schema:Book',
    bundledRelease,
    [
      {
        ...raw,
        property: 'schema:author',
        body: { rank: 'normal', value: { type: 'value', content: target } },
      },
    ],
    new Set(),
  );
  expect(
    finishListWorkContext(id, credit, new Map([[target, { state: 'unavailable' as const }]]), bundledRelease),
  ).toMatchObject({ creators: { state: 'unavailable', reason: 'native' } });
  expect(finishListWorkContext(id, credit, new Map([[target, null]]), bundledRelease)).toMatchObject({
    creators: { state: 'withheld' },
  });
  const qualified = prepareListWorkContext(
    id,
    'schema:Book',
    bundledRelease,
    [
      {
        ...raw,
        property: 'schema:author',
        body: {
          rank: 'normal',
          value: { type: 'value', content: target },
          qualifiers: Array.from({ length: 5 }, () => ({
            property: 'wdt:P1932',
            value: { type: 'value', content: 'Credit' },
          })),
        },
      },
    ],
    new Set(),
  );
  expect(finishListWorkContext(id, qualified, new Map(), bundledRelease)).toMatchObject({
    creators: { state: 'unavailable', reason: 'native' },
  });
  const contexts = boundWorkContexts(
    Array.from({ length: 100 }, () => ({ ...context, type: { ...context.type, labels: { en: 'x'.repeat(16000) } } })),
  );
  expect(contexts.every((value) => value?.state === 'unavailable')).toBe(true);
  expect(contexts.reduce((sum, value) => sum + workContextBytes(value), 0)).toBeLessThanOrEqual(
    WORK_CONTEXT_LIMITS.pageBytes,
  );
});
