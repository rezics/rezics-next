import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { RatingPopulationControl } from '../src/search/rating-population-control';
import { searchSortHref, SearchSort } from '../src/search/sort';

const realmId = 'c7a2a3f2-537c-4e72-b12d-8253fb240832';
const membershipRealmId = '31476787-efeb-4264-a0e4-4184443d15ee';
const filter = JSON.stringify({ realm: { id: membershipRealmId } });
const state: SearchLoaderDeps = {
  query: 'maps',
  type: undefined,
  facets: {},
  cursor: 'generation-bound+/opaque',
  sort: undefined,
  filter,
  resourceScope: undefined,
};

describe('Realm rating controls', () => {
  test('retains the population separately from membership and drops a cursor when order changes', () => {
    const href = searchSortHref('en', state, 'rating', realmId);
    const url = new URL(href, 'https://rezics.invalid');

    expect(url.searchParams.get('q')).toBe('maps');
    expect(url.searchParams.get('ratingPopulation')).toBe(realmId);
    expect(url.searchParams.get('filter')).toBe(filter);
    expect(url.searchParams.get('cursor')).toBeNull();

    const relevance = searchSortHref(
      'en',
      { ...state, sort: 'rating', ratingPopulation: realmId },
      'relevance',
    );
    const restored = new URL(relevance, 'https://rezics.invalid');
    expect(restored.searchParams.get('ratingPopulation')).toBe(realmId);
    expect(restored.searchParams.get('sort')).toBeNull();
    expect(restored.searchParams.get('filter')).toBe(filter);
  });

  test('renders a native population form and a truthful standard-question explanation', () => {
    const html = renderToStaticMarkup(
      createElement(SearchSort, {
        locale: 'en',
        sort: 'rating',
        query: state.query,
        facets: state.facets,
        state,
        ratingPopulation: realmId,
        ratingPopulations: [{ id: realmId, label: 'Atlas Realm' }],
        ratingReadiness: { status: 'ready', question: 'standard', partition: 17 },
      }),
    );

    expect(html).toContain('name="ratingPopulation"');
    expect(html).toContain('Atlas Realm');
    expect(html).toContain('Global');
    expect(html).toContain('standard question');
    expect(html).toContain('one subject partition');
    expect(html).toContain('name="filter"');
    expect(html).not.toContain('generation-bound+/opaque');
    expect(html).not.toMatch(/candidate count|Realm mean|Realm score:|total votes/i);
  });

  test('keeps preparing, unavailable, refused and generation changes distinct', () => {
    const render = (status: 'preparing' | 'unavailable' | 'refused' | 'generation-change') =>
      renderToStaticMarkup(
        createElement(RatingPopulationControl, {
          populations: [{ id: realmId, label: 'Atlas Realm' }],
          selectedPopulationId: realmId,
          readiness: { status },
          restartHref: '/en/search?q=maps&sort=rating&ratingPopulation=' + realmId,
        }),
      );

    expect(render('preparing')).toContain('being prepared');
    expect(render('preparing')).toContain('Check again');
    expect(render('unavailable')).toContain('did not rank a loaded preview');
    expect(render('unavailable')).toContain('replace this order with Global rating');
    expect(render('refused')).toContain('Native Search refused');
    expect(render('generation-change')).toContain('not a correction to your conditions');
    expect(render('generation-change')).toContain('Restart the same search');
  });
});
