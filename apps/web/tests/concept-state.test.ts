import { describe, expect, test } from 'bun:test';
import { alsoCarried } from '../features/concept/concept-page.tsx';
import { classificationFacet, facetLabel } from '../features/concept/facets.ts';
import { conceptFacet, ok, state, works, worksPage } from '../features/concept/fixtures.ts';
import { conceptHref, conceptPath, conceptQuery, hasRoom, parseConceptState, withoutValue, withValue }
  from '../features/concept/state.ts';
import { failureOf, type FacetList } from '../features/concept/types.ts';
import { isPublicPagePath } from '../i18n/locale.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iri = (uuid: string) => `https://rezics.com/id/${uuid}`;
const [concept, magic, romance, realm] = [id(1), id(2), id(3), id(4)];

describe('Concept page URL state', () => {
  test('G-409 a Condition bar round-trips through its address, defaults adding nothing', () => {
    const parsed = parseConceptState(concept, { scope: 'realm', realm, include: magic, exclude: romance, match: 'any' });
    expect(parsed).toEqual({ concept, scope: { kind: 'realm', realm }, include: [magic], exclude: [romance],
      match: 'any' });
    expect(conceptHref(parsed!)).toBe(`/concepts/${concept}?scope=realm&realm=${realm}&include=${magic}&exclude=${romance}&match=any`);
    expect(parseConceptState(concept, {})).toEqual({ concept, scope: { kind: 'global' }, include: [], exclude: [],
      match: 'all' });
    expect(conceptPath(iri(concept))).toBe(`/concepts/${concept}`);
    expect(conceptPath(iri(concept), { kind: 'realm', realm })).toBe(`/concepts/${concept}?scope=realm&realm=${realm}`);
    // `any` means nothing without a second included value, so the address leaves it out.
    expect(conceptHref({ ...parsed!, include: [], match: 'any' })).not.toContain('match');
    expect(isPublicPagePath(`/zh-Hans/concepts/${concept}`)).toBe(true);
  });

  test('G-409 a malformed, repeated, contradictory or oversized Condition is refused, never widened', () => {
    for (const params of [{ include: 'fantasy' }, { include: `${magic},${magic}` }, { include: magic, exclude: magic },
      { include: concept }, { exclude: concept }, { match: 'some' }, { scope: 'mine' }, { scope: 'realm' },
      { realm }, { include: [magic, romance] }]) {
      expect(parseConceptState(concept, params)).toBeNull();
    }
    expect(parseConceptState('fantasy', {})).toBeNull();
    // The page's Concept counts as included: seven more reach a Facet of eight values.
    const seven = Array.from({ length: 7 }, (_, index) => id(10 + index));
    expect(parseConceptState(concept, { include: seven.join(',') })).not.toBeNull();
    expect(parseConceptState(concept, { include: [...seven, id(20)].join(',') })).toBeNull();
    expect(parseConceptState(concept, { include: magic }, 2)).not.toBeNull();
    expect(parseConceptState(concept, { include: `${magic},${romance}` }, 2)).toBeNull();
  });

  test('G-409 including a value takes it out of the excluded, and room follows the Facet', () => {
    const base = parseConceptState(concept, { exclude: romance })!;
    expect(withValue(base, romance, 'include')).toMatchObject({ include: [romance], exclude: [] });
    expect(withValue(base, magic, 'exclude')).toMatchObject({ exclude: [romance, magic] });
    expect(withoutValue(withValue(base, magic, 'include'), romance)).toMatchObject({ include: [magic], exclude: [] });
    expect(hasRoom({ ...base, include: [magic] }, 'include', 2)).toBe(false);
    expect(hasRoom(base, 'exclude', 1)).toBe(false);
  });

  test('Concept Works passes all, any and none as Query Conditions with exact cursor state', () => {
    const parsed = parseConceptState(concept, { scope: 'realm', realm, include: magic, exclude: romance })!;
    expect(conceptQuery(parsed, 'next')).toEqual({ context: { realm: iri(realm) }, scope: { kind: 'all' },
      sort: 'newest', page: { size: 20, continuation: 'next' }, filter: { all: [
        { facet: 'concept', all: [iri(concept), iri(magic)] },
        { facet: 'concept', none: [iri(romance)] },
      ] } });
    expect(conceptQuery({ ...parsed, match: 'any' }).filter).toEqual({ all: [
      { facet: 'concept', all: [iri(concept)] },
      { facet: 'concept', any: [iri(magic)] },
      { facet: 'concept', none: [iri(romance)] },
    ] });
    expect(conceptQuery(parseConceptState(concept, {})!)).toMatchObject({ context: 'global',
      filter: { all: [{ facet: 'concept', all: [iri(concept)] }] } });
  });

  test('G-519 state round-trips through its address into a Filter that keeps the page Concept', () => {
    const pool = [id(2), id(3), id(4)];
    const subsets = (values: string[]): string[][] => values.reduce<string[][]>(
      (sets, value) => [...sets, ...sets.map(set => [...set, value])], [[]]);
    const scopes = [{ kind: 'global' as const }, { kind: 'realm' as const, realm }];
    let cases = 0;
    for (const include of subsets(pool)) {
      const excludedFrom = pool.filter(value => !include.includes(value));
      for (const exclude of subsets(excludedFrom)) {
        for (const match of ['all', 'any'] as const) {
          for (const scope of scopes) {
            const state = { concept, scope, include, exclude, match };
            const href = conceptHref(state);
            const url = new URL(href, 'https://rezics.test');
            const params = Object.fromEntries(url.searchParams);
            const parsed = parseConceptState(url.pathname.split('/').at(-1)!, params);
            const canonical = include.length || match === 'all' ? state : { ...state, match: 'all' as const };
            expect(parsed).toEqual(canonical);
            expect(conceptQuery(parsed!).filter).toEqual(conceptQuery(state).filter);
            const filter = conceptQuery(state).filter;
            if (!filter || !('all' in filter)) throw new Error('Concept Query has no Filter');
            if (match === 'any' && include.length) {
              expect(filter.all.slice(0, 2)).toEqual([
                { facet: 'concept', all: [iri(concept)] },
                { facet: 'concept', any: include.map(iri) },
              ]);
            } else {
              expect(filter.all[0]).toEqual({ facet: 'concept', all: [concept, ...include].map(iri) });
            }
            cases += 1;
          }
        }
      }
    }
    // 2^3 include subsets, and for each the exclude subsets of what remains, times match and scope.
    expect(cases).toBe(108);
  });
});

describe('Concept page reads', () => {
  test('G-409 Tags is the free Concept Facet\'s own label, never a web string', () => {
    const facets: FacetList = { profile: 'facets-v1', digest: '0'.repeat(64), facets: [
      { ...conceptFacet, id: 'https://rezics.com/definition/facet-genre-v1', name: 'genre',
        values: [{ kind: 'concept', scheme: 'https://rezics.com/id/genre-scheme' }], labels: { ...conceptFacet.labels,
          en: 'Genre' } }, conceptFacet] };
    const facet = classificationFacet(facets);
    expect(facet?.id).toBe(conceptFacet.id);
    expect(facetLabel(facet!, 'zh-Hans')).toBe('标签');
    expect(classificationFacet(null)).toBeNull();
  });

  test('G-409 values the listed Works also carry are offered most shared first', () => {
    const page = worksPage(state(), works);
    expect(alsoCarried(ok(page)).slice(0, 2).map(value => value.name?.value)).toEqual(['Fantasy', 'Dragons']);
    expect(alsoCarried(ok({ ...page, stale: true }))).toEqual([]);
    expect(alsoCarried({ ok: false, failure: 'missing' })).toEqual([]);
  });

  test('G-409 a refused Condition, a hidden value and an unprepared scope read as different failures', () => {
    expect(failureOf(400)).toBe('invalid');
    expect(failureOf(404)).toBe('missing');
    expect(failureOf(503, 'discovery_unavailable')).toBe('unbuilt');
    expect(failureOf(503)).toBe('unavailable');
    expect(failureOf(409)).toBe('moved');
  });
});
