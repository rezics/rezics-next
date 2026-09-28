import { expect, test } from 'bun:test';
import { groupNotifications, type StreamItem } from '../src/modules/notification/store.ts';

test('G-286: repeat groups are page-local, disclosure-aware and capped at ten items', () => {
  const item = (index: number, visible = true): StreamItem => ({
    id: String(index), sequence: String(index), purpose: 'social', topic: 'reply',
    state: 'active', read: false, subject: null, createdAt: '2026-09-28T00:00:00.000Z',
    display: visible ? { kind: 'reply', actor: null, realm: null, realmName: null,
      realmRouteSegment: null, roleName: null, roleChange: null, groupKey: 'chapter-1',
      target: { title: 'Chapter', excerpt: null, language: 'en', linkTarget: null, reviewId: null } } : null,
  });
  const groups = groupNotifications([...Array.from({ length: 12 }, (_, i) => item(i + 1)), item(13, false)]);
  expect(groups).toEqual([
    { kind: 'reply', key: 'chapter-1', itemIds: Array.from({ length: 10 }, (_, i) => String(i + 1)) },
    { kind: 'reply', key: 'chapter-1', itemIds: ['11', '12'] },
  ]);
});
