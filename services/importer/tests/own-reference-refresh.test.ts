import { expect, test } from 'bun:test';
import { resolveOwnReferences } from '../src/own-references.ts';
import type { SourceProjection } from '../src/run-store.ts';

const projection: SourceProjection = {
  sourceKind: 'openlibrary',
  normalizedRecord: {
    type: { key: '/type/edition' },
    key: '/books/OL2M',
    authors: [{ key: '/authors/OL1A' }],
    works: [{ key: '/works/OL1W' }],
  },
};

test('own Open Library handoff point-reads only exact configured aliases and native relation keys', () => {
  const calls: { source: string; external_id: string }[] = [];
  const claims = new Map([
    ['alias-a:/works/OL1W', { state: 'bound' as const, subject: 'real-work-id' }],
    ['alias-b:/authors/OL1A', { state: 'bound' as const, subject: 'other-alias-id' }],
  ]);
  const bindingReader = {
    claim(input: { source: string; external_id: string }) {
      calls.push(input);
      return claims.get(`${input.source}:${input.external_id}`) ?? null;
    },
  };

  const resolved = resolveOwnReferences(projection, 'alias-a', bindingReader);
  expect(resolved?.resolvedReferences).toEqual({ '/works/OL1W': 'real-work-id' });
  expect(calls).toEqual([
    { source: 'alias-a', external_id: '/authors/OL1A' },
    { source: 'alias-a', external_id: '/works/OL1W' },
  ]);
  expect(resolveOwnReferences(projection, 'alias-b', bindingReader)?.resolvedReferences).toEqual({
    '/authors/OL1A': 'other-alias-id',
  });
});
