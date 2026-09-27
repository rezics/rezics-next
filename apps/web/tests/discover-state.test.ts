import { describe, expect, test } from 'bun:test';
import { readDiscovery } from '../features/discover/read.ts';
import { neighbourScope, parseScope, workHref } from '../features/discover/scope.ts';
import { discoverHref, discoveryQuery, genreTerms, parseDiscoverState, shelvesFor, termShelf } from '../features/discover/state.ts';
import { failureOf, type MainClient } from '../features/discover/types.ts';

const realm = '3f0e1c2d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const context = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const term = '0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e';
const iri = (id: string) => `https://rezics.com/id/${id}`;

describe('discover URL state', () => {
  test('scope follows the Work page convention and never widens a malformed view', () => {
    expect(parseScope({})).toEqual({ kind: 'global' });
    expect(parseScope({ scope: 'realm', realm })).toEqual({ kind: 'realm', realm });
    expect(parseScope({ scope: 'mine' })).toEqual({ kind: 'mine' });
    for (const params of [{ scope: 'realm' }, { scope: 'realm', realm: 'classics' }, { realm },
      { scope: 'mine', realm }, { scope: 'everyone' }, { scope: ['global', 'mine'] }]) {
      expect(parseScope(params)).toBeNull();
    }
    expect(neighbourScope({ kind: 'realm', realm })).toEqual({ kind: 'global' });
    expect(neighbourScope({ kind: 'global' })).toBeNull();
  });

  test('filters parse strictly and round-trip through the address', () => {
    const state = parseDiscoverState({ scope: 'realm', realm, context, type: 'book', term });
    expect(state).toEqual({ scope: { kind: 'realm', realm }, context, type: 'book', term });
    expect(discoverHref(state!)).toBe(`/discover?scope=realm&realm=${realm}&context=${context}&type=book&term=${term}`);
    expect(parseDiscoverState(Object.fromEntries(new URL(discoverHref(state!), 'http://x').searchParams))).toEqual(state);
    expect(discoverHref({ scope: { kind: 'global' }, context: null, type: null, term: null })).toBe('/discover');
    expect(parseDiscoverState({ type: 'podcast' })).toBeNull();
    expect(parseDiscoverState({ context: 'not-a-uuid' })).toBeNull();
    expect(parseDiscoverState({ term: iri(term) })).toBeNull();
    expect(parseDiscoverState({ type: ['book', 'recipe'] })).toBeNull();
    // Main defines no personal classification.
    expect(parseDiscoverState({ scope: 'mine', term })).toBeNull();
  });

  test('a Work card links to the Work page in the scope being browsed', () => {
    expect(workHref(iri(term), { kind: 'realm', realm })).toBe(`/w/${term}?scope=realm&realm=${realm}`);
    expect(workHref(iri(term), { kind: 'global' })).toBe(`/w/${term}`);
  });
});

describe('discover shelves', () => {
  const global = { scope: { kind: 'global' as const }, context: null, type: null, term: null };

  test('shelves are curated by meaning and each holds one kind of Work; favorites need a rating question', () => {
    expect(shelvesFor(global, true).map(shelf => shelf.key)).toEqual(['favorites-book', 'recent-book',
      'recent-document', 'recent-recipe']);
    expect(shelvesFor(global).map(shelf => shelf.key)).toEqual(['recent-book', 'recent-document', 'recent-recipe']);
    expect(shelvesFor({ ...global, type: 'recipe' }, true).map(shelf => shelf.topic)).toEqual([
      { kind: 'favorites', type: 'recipe' }, { kind: 'recent', type: 'recipe' }]);
    expect(shelvesFor({ ...global, term }, true).map(shelf => shelf.key)).toEqual([`popular-${term}`, `new-${term}`]);
    expect(shelvesFor({ ...global, scope: { kind: 'mine' } })).toEqual([]);
    expect(shelvesFor({ ...global, scope: { kind: 'mine' } }, true).map(shelf => shelf.topic))
      .toEqual([{ kind: 'mine', type: null }]);
  });

  test('genre shelves come from the terms most often on the overview’s books', () => {
    const tag = (id: string, name: string) => ({ sense: iri(id), concept: iri(context), decision: iri(realm),
      source: 'global' as const, name: { value: name, language: 'en', direction: 'ltr' as const, basis: 'requested' as const } });
    const other = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const items = [[tag(term, 'Adventure')], [tag(term, 'Adventure'), tag(other, 'Satire')], []]
      .map(classifications => ({ classifications }) as unknown as Parameters<typeof genreTerms>[0][number]);
    expect(genreTerms(items).map(entry => [entry.term, entry.name.value])).toEqual([[term, 'Adventure'],
      [other, 'Satire']]);
    expect(genreTerms(items, 1)).toHaveLength(1);
    expect(termShelf(term, 'book', false)).toEqual({ key: `new-${term}`, topic: { kind: 'new-in', type: 'book', term },
      sort: 'recent', type: 'book', term });
  });

  test('Main queries carry the scope, IRIs and only the Context a population is built for', () => {
    const state = { ...global, scope: { kind: 'realm' as const, realm }, term };
    const [top, recent] = shelvesFor(state, true);
    expect(discoveryQuery(state, recent!, { limit: 6, language: 'zh-Hans', context })).toEqual({ scope: 'realm',
      realm: iri(realm), sort: 'recent', limit: 6, language: 'zh-Hans', term: iri(term) });
    expect(discoveryQuery(state, top!, { limit: 6, language: 'en', context, cursor: 'next' })).toEqual({ scope: 'realm',
      realm: iri(realm), sort: 'top-rated', limit: 6, language: 'en', context: iri(context), term: iri(term),
      cursor: 'next' });
    const mine = { ...global, scope: { kind: 'mine' as const }, type: 'book' as const };
    expect(discoveryQuery(mine, shelvesFor(mine, true)[0]!, { limit: 12, language: 'en', context,
      actingSubject: iri(realm) })).toEqual({ scope: 'mine', sort: 'top-rated', limit: 12, language: 'en',
      context: iri(context), type: 'https://schema.org/Book', actingSubject: iri(realm) });
  });

  test('each failure keeps its meaning instead of collapsing into an error', async () => {
    expect(failureOf(503, 'discovery_unavailable')).toBe('unbuilt');
    expect(failureOf(503, 'work_read_unavailable')).toBe('unavailable');
    expect(failureOf(409)).toBe('moved');
    expect(failureOf(404)).toBe('missing');
    expect(failureOf(401)).toBe('sign-in');
    expect(failureOf(422)).toBe('budget');
    expect(failureOf(400)).toBe('invalid');
    const answering = (status: number, code: string) => ({ v1: { works: { get: async () => ({ data: null,
      error: { status, value: { code } } }) } } }) as unknown as MainClient;
    expect(await readDiscovery(answering(503, 'discovery_unavailable'), {})).toEqual({ ok: false, failure: 'unbuilt' });
    // A first page has no cursor to move under: its 409 means the built list predates a write.
    expect(await readDiscovery(answering(409, 'read_basis_changed'), {})).toEqual({ ok: false, failure: 'stale' });
    expect(await readDiscovery(answering(409, 'read_basis_changed'), { cursor: 'c' }))
      .toEqual({ ok: false, failure: 'moved' });
    const throwing = { v1: { works: { get: async () => { throw new Error('offline'); } } } } as unknown as MainClient;
    expect(await readDiscovery(throwing, {})).toEqual({ ok: false, failure: 'unavailable' });
  });
});
