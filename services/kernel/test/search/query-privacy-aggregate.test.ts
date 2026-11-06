import { expect, test } from 'bun:test';
import {
  liveFacetCountsAreWitnesses,
  queryPrivacyFacetSiblings,
  queryPrivacyFacets,
  queryPrivacyTotal,
  queryPrivacyWithholdUnsafeTotals,
} from '../../src/search/query-privacy-aggregate.ts';
import { queryPrivacyCurrentness } from '../../src/search/query-privacy.ts';
import { privacyBarrier, privacyHead, privacyHeads } from './support/query-privacy-heads.ts';

test('sampled hit counts stay withheld or lower bounds without whole-query proof', () => {
  const currentness = queryPrivacyCurrentness(privacyHeads());
  expect(queryPrivacyTotal({ currentness, witnesses: 3, exhausted: false, aggregateProof: false })).toEqual({
    value: 3,
    exact: false,
  });
  expect(queryPrivacyTotal({ currentness, witnesses: 0, exhausted: false, aggregateProof: false })).toEqual({
    withheld: true,
  });
  expect(
    queryPrivacyTotal({
      currentness: queryPrivacyCurrentness(privacyHeads({ blocking: [privacyBarrier()] })),
      witnesses: 3,
      exhausted: true,
      aggregateProof: true,
    }),
  ).toEqual({ withheld: true });
});

test('exact totals require currentness, exhaustion and independent aggregate proof', () => {
  const currentness = queryPrivacyCurrentness(privacyHeads());
  expect(queryPrivacyTotal({ currentness, witnesses: 0, exhausted: true, aggregateProof: true })).toEqual({
    value: 0,
    exact: true,
  });
  expect(queryPrivacyTotal({ currentness, witnesses: 4, exhausted: true, aggregateProof: true })).toEqual({
    value: 4,
    exact: true,
  });
  expect(
    queryPrivacyWithholdUnsafeTotals(
      queryPrivacyTotal({ currentness, witnesses: 4, exhausted: true, aggregateProof: false }),
    ),
  ).toBe(true);
});

test('an unclean observation withholds every sibling facet value', () => {
  const page = queryPrivacyFacetSiblings({
    heads: privacyHeads({ blocking: [privacyBarrier({ scope: 'filter_or_order' })] }),
    facets: [{ property: 'schema:keywords', values: [{ value: 'harem', labels: { en: 'Harem' } }], exhausted: true }],
    aggregateProof: true,
  });
  expect(page).toEqual({ status: 'preparing' });
});

test('trusted stale observations still disclose facet identities as lower bounds', () => {
  const page = queryPrivacyFacets({
    currentness: queryPrivacyCurrentness(privacyHeads({ changed: [privacyHead()] })),
    aggregateProof: false,
    facets: [
      {
        property: 'schema:keywords',
        values: [{ value: 'harem', labels: { en: 'Harem' } }],
        exhausted: true,
      },
    ],
  });
  expect(page).toEqual({
    status: 'ready',
    exact: false,
    facets: [
      {
        property: 'schema:keywords',
        relation: 'lower_bound',
        values: [{ value: 'harem', labels: { en: 'Harem' } }],
      },
    ],
  });
});

test('whole-query current aggregate proof can publish exact sibling values', () => {
  const page = queryPrivacyFacetSiblings({
    heads: privacyHeads(),
    aggregateProof: true,
    facets: [
      { property: 'schema:keywords', values: [{ value: 'harem', labels: { en: 'Harem' } }], exhausted: true },
      { property: 'type', values: [{ value: 'schema:Book', labels: { en: 'Book' } }], exhausted: true },
    ],
  });
  expect(page.status).toBe('ready');
  if (page.status === 'ready') {
    expect(page.exact).toBe(true);
    expect(page.facets.every((facet) => 'relation' in facet && facet.relation === 'exact')).toBe(true);
  }
});

test('live engine samples remain witnesses even when the engine window is complete', () => {
  expect(liveFacetCountsAreWitnesses(true)).toBe(true);
  expect(liveFacetCountsAreWitnesses(false)).toBe(true);
});
