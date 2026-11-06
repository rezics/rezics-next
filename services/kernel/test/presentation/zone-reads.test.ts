import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import type { PageRead } from '../../src/presentation/reads.ts';
import { zoneObservedReadKey } from '../../src/presentation/zone-reads.ts';
import { validateSearchLimit } from '../../src/search/hits.ts';

test('Zone TypeList observed keys match readPage search canonical form including default limit and languages', () => {
  const descriptor: PageRead = {
    kind: 'search',
    body: { filter: { type: { in: ['schema:Book'] } }, sort: 'name' },
  };
  const languages = ['en', 'zh-Hant'] as const;
  const expected = canonicalize({
    ...descriptor,
    kind: 'search',
    body: {
      ...(descriptor.body as object),
      limit: validateSearchLimit(undefined),
      languages: [...languages],
    },
  });
  expect(zoneObservedReadKey(descriptor, languages)).toBe(expected as string);
  const subject: PageRead = { kind: 'subject', id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01' };
  expect(zoneObservedReadKey(subject)).toBe(canonicalize(subject) as string);
  const members: PageRead = {
    kind: 'members',
    source: { kind: 'collection', id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11' },
    sort: 'id',
    limit: 24,
  };
  expect(zoneObservedReadKey(members, languages)).toBe(canonicalize(members) as string);
  expect(zoneObservedReadKey(members, languages)).not.toBe(zoneObservedReadKey(descriptor, languages));
});
