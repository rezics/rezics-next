import { expect, test } from 'bun:test';
import {
  admitCanonicalKeyset,
  bindExecutedSearchRequest,
  bindSearchIdentityCursorRequest,
  executedRatingPair,
  type SearchIdentityMapping,
} from '../../src/search/canonical-keyset-admit.ts';

const subject = (id: string) => ({ id });
const mapped = (original: string, terminal: string): SearchIdentityMapping => ({
  state: 'mapped',
  original,
  terminal,
});

test('canonical pages emit one terminal for merged originals and keep a hidden original with a readable terminal', () => {
  const terminal = subject('11111111-1111-4111-8111-111111111111');
  const hidden = subject('22222222-2222-4222-8222-222222222222');
  const other = subject('33333333-3333-4333-8333-333333333333');
  const admission = admitCanonicalKeyset(
    [hidden, terminal, other],
    [mapped(hidden.id, terminal.id), mapped(terminal.id, terminal.id), mapped(other.id, other.id)],
  );
  expect(admission.status).toBe('ready');
  if (admission.status !== 'ready') throw new Error('canonical keyset prepared');
  expect([...admission.accepted.values()].map((row) => row.id).sort()).toEqual([other.id, terminal.id].sort());
  expect(admission.canonicalId(terminal)).toBe(terminal.id);
  expect(admission.canonicalId(hidden)).toBe(terminal.id);
});

test('a stale indexed original whose terminal is absent prepares instead of omitting the group', () => {
  const original = subject('44444444-4444-4444-8444-444444444444');
  expect(admitCanonicalKeyset([original], [mapped(original.id, '55555555-5555-4555-8555-555555555555')])).toEqual({
    status: 'preparing',
  });
});

test('only published mappings admit canonical pages; empty pages stay ready', () => {
  const original = subject('66666666-6666-4666-8666-666666666666');
  expect(admitCanonicalKeyset([original], [{ state: 'pending', original: original.id }])).toEqual({
    status: 'preparing',
  });
  expect(admitCanonicalKeyset([original], [{ state: 'unavailable', reason: 'bootstrap' }])).toEqual({
    status: 'preparing',
  });
  expect(admitCanonicalKeyset([original], [{ state: 'absent' }])).toEqual({ status: 'preparing' });
  const mappedSelf = admitCanonicalKeyset([original], [mapped(original.id, original.id)]);
  expect(mappedSelf.status).toBe('ready');
  if (mappedSelf.status !== 'ready') throw new Error('published self mapping prepared');
  expect([...mappedSelf.accepted.values()].map((row) => row.id)).toEqual([original.id]);
  expect(mappedSelf.canonicalId(original)).toBe(original.id);
  const empty = admitCanonicalKeyset([], []);
  expect(empty.status).toBe('ready');
});

test('cursor bindings retain the published identity epoch beside the executed operands', () => {
  expect(bindSearchIdentityCursorRequest({ text: 'lantern', sort: 'name' }, 'epoch-digest')).toEqual({
    text: 'lantern',
    sort: 'name',
    identityEpoch: 'epoch-digest',
  });
});

test('search, facets and typeahead share one executed request including the rating pair', () => {
  const executed = bindExecutedSearchRequest('anonymous', 'epoch-digest', {
    text: 'lantern',
    sort: 'rating',
    population: { realm: '11111111-1111-4111-8111-111111111111' },
    limit: 20,
    languages: ['en'],
  });
  expect(executed.principal).toBe('anonymous');
  expect(executed.identityEpoch).toBe('epoch-digest');
  expect(executed.operands.sort).toBe('rating');
  expect(executedRatingPair(executed.operands)).toEqual({
    sort: 'rating',
    population: { realm: '11111111-1111-4111-8111-111111111111' },
  });
  expect(bindSearchIdentityCursorRequest(executed.operands, executed.identityEpoch).identityEpoch).toBe('epoch-digest');
});
