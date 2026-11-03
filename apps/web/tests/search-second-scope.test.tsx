import { describe, expect, test } from 'bun:test';
import { discoveryRequest } from '../src/search/search-request';
import {
  parseSearchResourceScope,
  removeSearchResourceScope,
  searchFilterWithScope,
  searchResourceScopeAction,
  type SearchResourceScope,
} from '../src/search/advanced-scope';
import { headerSearchFields } from '../src/search/header-search/header-search';
import {
  discoverySearchHref,
  correctSearchInput,
  removeSearchInput,
  searchFormFields,
  searchLoaderDeps,
} from '../src/search/search-params';
import { searchSortHref } from '../src/search/sort';
import { RATING_POPULATION_FIELD } from '../src/search/rating-population';
import { refinementHref } from '../src/search/refinement/model';

const realmId = '5a522c45-d94f-4d36-8b2a-3af80d988cff';
const collectionId = '438cb7b1-e7a2-4a40-831e-a90b1b143264';
const existingPredicate = { statement: { property: 'genre', in: ['maps'] } };

describe('native Search resource scope', () => {
  test('invalid resource operands remain correctable and unsupported resource modes are refused', () => {
    const invalid = JSON.stringify({ realm: { id: 'not-a-complete-id' } });
    const first = searchLoaderDeps({ q: 'maps', filter: invalid, cursor: 'opaque-next' });
    expect(first.invalidInput).toEqual({ key: 'filter', value: invalid });

    const corrected = correctSearchInput(
      { q: 'maps', filter: invalid, cursor: 'opaque-next' },
      'filter',
      JSON.stringify({ realm: { id: realmId } }),
    );
    const admitted = searchLoaderDeps(corrected);
    expect(admitted.invalidInput).toBeUndefined();
    expect(admitted.resourceScope).toEqual({ kind: 'realm', id: realmId });
    expect(admitted.cursor).toBeUndefined();

    expect(parseSearchResourceScope(JSON.stringify({ zone: { id: realmId } })).invalidInput?.key).toBe('filter');
  });

  test('one native leaf survives GET, history, sort and header submission without changing its cursor', () => {
    const scope: SearchResourceScope = { kind: 'realm', id: realmId };
    const baseFilter = JSON.stringify(existingPredicate);
    const filter = searchFilterWithScope(baseFilter, scope)!;
    const state = searchLoaderDeps({
      q: 'maps',
      filter,
      cursor: 'eyJjdXJzb3IiOiJvcGFxdWUifQ',
      sort: 'rating',
      language: ['ja', 'en'],
    });

    expect(state.resourceScope).toEqual(scope);
    expect(parseSearchResourceScope(filter).scope).toEqual(scope);
    expect(searchFormFields({ filter })).toContainEqual(['filter', filter]);
    const href = discoverySearchHref('en', state);
    const url = new URL(href, 'https://rezics.invalid');
    expect(url.pathname).toBe('/en/search');
    expect(url.searchParams.get('filter')).toBe(filter);
    expect(url.searchParams.get('cursor')).toBe('eyJjdXJzb3IiOiJvcGFxdWUifQ');
    expect(new URL(searchSortHref('en', state, 'rating'), 'https://rezics.invalid').searchParams.get('filter')).toBe(
      filter,
    );

    const action = searchResourceScopeAction('en', scope);
    const headerFields = headerSearchFields(
      [
        ['q', 'maps'],
        ['cursor', 'opaque'],
        ['language', 'ja'],
        ['filter', filter],
      ],
      { kind: 'Realm', id: realmId, name: 'Display only', searchAction: action },
      action,
    );
    expect(headerFields).toEqual([
      ['language', 'ja'],
      ['filter', filter],
    ]);
  });

  test('the scoped request applies to collections too, and removal preserves sibling filters and starts fresh', () => {
    const scope: SearchResourceScope = { kind: 'collection', id: collectionId };
    const baseFilter = JSON.stringify(existingPredicate);
    const filter = searchFilterWithScope(baseFilter, scope)!;
    const state = searchLoaderDeps({ q: 'maps', filter, cursor: 'opaque-next' });
    const body = discoveryRequest(state, ['en']);
    expect(JSON.stringify(body.filter)).toContain(collectionId);

    expect(removeSearchResourceScope(filter)).toBe(baseFilter);
    const removed = removeSearchInput({ q: 'maps', filter, cursor: 'opaque-next' }, 'filter');
    const next = searchLoaderDeps(removed);
    expect(next.resourceScope).toBeUndefined();
    expect(next.filter).toBe(baseFilter);
    expect(next.cursor).toBeUndefined();
    expect(new URL(discoverySearchHref('en', next), 'https://rezics.invalid').searchParams.has('cursor')).toBe(false);

    const globalHeader = headerSearchFields(
      [
        ['language', 'ja'],
        ['filter', filter],
      ],
      undefined,
      '/en/search',
    );
    expect(globalHeader).toEqual([
      ['language', 'ja'],
      ['filter', baseFilter],
    ]);
  });

  test('rating population remains separate, correctable and present across GET, order, history and header paths', () => {
    const filter = searchFilterWithScope(JSON.stringify(existingPredicate), { kind: 'realm', id: realmId })!;
    const state = searchLoaderDeps({
      q: 'maps',
      filter,
      sort: 'rating',
      ratingPopulation: realmId,
      cursor: 'opaque-page',
      language: ['ja', 'en'],
    });
    expect(state).toMatchObject({ resourceScope: { kind: 'realm', id: realmId }, ratingPopulation: realmId });
    expect(searchFormFields({ filter, sort: 'rating', ratingPopulation: realmId })).toEqual([
      ['sort', 'rating'],
      [RATING_POPULATION_FIELD, realmId],
      ['filter', filter],
    ]);

    const href = discoverySearchHref('en', state);
    const restored = searchLoaderDeps(Object.fromEntries(new URL(href, 'https://rezics.invalid').searchParams));
    expect(restored).toMatchObject({ ratingPopulation: realmId, resourceScope: { kind: 'realm', id: realmId } });
    expect(restored.cursor).toBe('opaque-page');
    const refinement = new URL(
      refinementHref(
        'en',
        'maps',
        { facetValues: {}, filter, resourceScope: state.resourceScope, ratingPopulation: realmId },
        'rating',
      ),
      'https://rezics.invalid',
    );
    expect(refinement.searchParams.get(RATING_POPULATION_FIELD)).toBe(realmId);
    expect(refinement.searchParams.get('filter')).toBe(filter);
    expect(refinement.searchParams.get('sort')).toBe('rating');
    expect(refinement.searchParams.has('cursor')).toBe(false);

    const changedOrder = new URL(searchSortHref('en', state, 'relevance'), 'https://rezics.invalid');
    expect(changedOrder.searchParams.get(RATING_POPULATION_FIELD)).toBe(realmId);
    expect(changedOrder.searchParams.has('cursor')).toBe(false);

    const carried = searchFormFields({ filter, ratingPopulation: realmId, language: ['ja'] });
    expect(headerSearchFields(carried, undefined, '/en/search')).toContainEqual([RATING_POPULATION_FIELD, realmId]);
    expect(headerSearchFields(carried, { kind: 'Realm', id: realmId, name: 'Display only' }, undefined)).toContainEqual(
      [RATING_POPULATION_FIELD, realmId],
    );

    const malformed = searchLoaderDeps({ q: 'maps', ratingPopulation: 'not-a-realm-id', cursor: 'opaque-page' });
    expect(malformed.invalidInput).toEqual({ key: RATING_POPULATION_FIELD, value: 'not-a-realm-id' });
    const corrected = searchLoaderDeps(
      correctSearchInput(
        { q: 'maps', ratingPopulation: 'not-a-realm-id', cursor: 'opaque-page' },
        RATING_POPULATION_FIELD,
        realmId,
      ),
    );
    expect(corrected.ratingPopulation).toBe(realmId);
    expect(corrected.cursor).toBeUndefined();
    const removed = searchLoaderDeps(
      removeSearchInput({ q: 'maps', ratingPopulation: realmId, cursor: 'opaque-page' }, RATING_POPULATION_FIELD),
    );
    expect(removed.ratingPopulation).toBeUndefined();
    expect(removed.cursor).toBeUndefined();
  });
});
