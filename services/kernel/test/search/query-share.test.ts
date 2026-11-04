import { expect, test } from 'bun:test';
import { prepareQueryShare } from '../../src/search/query-share.ts';

test('portable projection preserves raw text and branches while excluding cursor and authority', () => {
  const filter = { and: [{ or: [{ type: { in: ['book'] } }, { not: { type: { in: ['film'] } } }] }, { kind: { in: ['book'] } }] };
  const request = { text: '  "a phrase" | -other ', filter, languages: ['ja', 'en'], cursor: 'secret', principal: 'private' };
  const result = prepareQueryShare(request, { book: { en: 'Book', ja: '本' } });
  expect(result.action).toBe('allowed');
  expect(result.document?.text).toBe(request.text);
  expect(JSON.parse(result.document!.filter!)).toEqual(filter);
  expect(result.selections).toContainEqual({ value: '本', language: 'ja' });
  const params = new URLSearchParams(result.parameters!);
  expect(params.getAll('language')).toEqual(['ja', 'en']);
  expect(params.getAll('kinds')).toEqual(['book']);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('principal');
  const replay = prepareQueryShare({ text: params.get('q')!, languages: params.getAll('language'), filter: { and: [JSON.parse(params.get('condition')!), { kind: { in: params.getAll('kinds') } }] } });
  expect(replay.parameters).toBe(result.parameters);
});

test('private, unknown and oversized queries never emit partial portable documents', () => {
  for (const filter of [{ owner: { presence: true } }, { future: {} }, { collection: { id: '00000000-0000-4000-8000-000000000001' } }]) {
    const result = prepareQueryShare({ filter });
    expect(result.action).toBe('disabled');
    expect(result.document).toBeNull();
    expect(result.parameters).toBeNull();
  }
  expect(prepareQueryShare({ filter: { type: { in: ['x'.repeat(17000)] } } }).reason).toBe('oversized');
  expect(prepareQueryShare({ filter: { type: { in: ['book'] } } }).action).toBe('allowed');
});
