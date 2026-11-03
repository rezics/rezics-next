import { expect, test } from 'bun:test';
import { feedDiscoveryItem } from '../../src/content/feed-discovery.ts';
import type { DiscoveryHit } from '../../src/search/discovery.ts';

const id = '00000000-0000-4000-8000-000000000001';
const subject: DiscoveryHit = {
  key: { owner: 'semantic', kind: 'schema:Book', route: 0, id },
  summary: {
    kind: 'subject',
    value: {
      id,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: null,
      creativeWork: true,
      cover: null,
    },
  },
};
const account: DiscoveryHit = {
  key: { owner: 'accounts', kind: 'account', route: 0, id },
  summary: {
    kind: 'account',
    value: {
      id,
      accountKind: 'actor',
      handle: 'reader',
      displayName: null,
      automated: false,
      operatorId: null,
      avatar: null,
      verifiedAgent: null,
    },
  },
};

test('Mixed native summaries retain exact kinds, distinct identities and canonical destinations without hydration', () => {
  const items = [subject, account].map(feedDiscoveryItem);
  expect(items.map((item) => item.key)).toEqual([subject.key, account.key]);
  expect(items.map((item) => item.destination)).toEqual([
    { kind: 'subject', id, title: null },
    { kind: 'account', id, title: 'reader' },
  ]);
  expect(new Set(items.map((item) => item.id)).size).toBe(2);
  expect(items.map((item) => item.summary)).toEqual([subject.summary.value, account.summary.value]);
});

test('Foreign variants and inconsistent primary identities cannot become fallback Account cards', () => {
  const invalid = [
    ...['collection', 'review', 'space'].map((kind) => ({
      key: { owner: 'content', kind, route: 0, id },
      summary: { kind, value: { id, title: 'Hidden metadata' } },
    })),
    { ...subject, key: account.key },
    { ...account, key: subject.key },
    { ...subject, key: { ...subject.key, kind: 'schema:Movie' } },
    {
      ...account,
      key: { ...account.key, id: '00000000-0000-4000-8000-000000000002' },
    },
  ];
  for (const hit of invalid)
    expect(() => feedDiscoveryItem(hit as DiscoveryHit)).toThrow(
      expect.objectContaining({ code: 'dependency_unavailable' }),
    );
});
