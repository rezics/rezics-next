import { describe, expect, test } from 'bun:test';
import { readDiscovery } from '../features/discover/read.ts';
import { neighbourScope, parseScope, workHref } from '../features/discover/scope.ts';
import { discoverHref, discoveryQuery, parseDiscoverState, shelvesFor } from '../features/discover/state.ts';
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

  test('the overview adds a recent shelf per Work type; top rated needs an explicit Context', () => {
    expect(shelvesFor(global).map(shelf => shelf.key)).toEqual(['recent', 'recent-book', 'recent-document',
      'recent-recipe']);
    expect(shelvesFor({ ...global, context }).map(shelf => shelf.key)).toEqual(['recent', 'top-rated', 'recent-book',
      'recent-document', 'recent-recipe']);
    expect(shelvesFor({ ...global, type: 'recipe' })).toEqual([{ key: 'recent', sort: 'recent', type: 'recipe', term: null }]);
    expect(shelvesFor({ ...global, scope: { kind: 'mine' } })).toEqual([]);
  });

  test('Main queries carry the scope, IRIs and only the Context a population is built for', () => {
    const [recent, top] = shelvesFor({ ...global, scope: { kind: 'realm', realm }, context, term });
    const state = { ...global, scope: { kind: 'realm' as const, realm }, context, term };
    expect(discoveryQuery(state, recent!, { limit: 6, language: 'zh-CN' })).toEqual({ scope: 'realm', realm: iri(realm),
      sort: 'recent', limit: 6, language: 'zh-CN', term: iri(term) });
    expect(discoveryQuery(state, top!, { limit: 6, language: 'en', cursor: 'next' })).toEqual({ scope: 'realm',
      realm: iri(realm), sort: 'top-rated', limit: 6, language: 'en', context: iri(context), term: iri(term),
      cursor: 'next' });
    const mine = { ...global, scope: { kind: 'mine' as const }, context, type: 'book' as const };
    expect(discoveryQuery(mine, shelvesFor(mine)[0]!, { limit: 12, language: 'en', actingSubject: iri(realm) }))
      .toEqual({ scope: 'mine', sort: 'recent', limit: 12, language: 'en', context: iri(context),
        type: 'https://schema.org/Book', actingSubject: iri(realm) });
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
