import { expect, test } from 'bun:test';
import { createPresentationMuteFilter } from '../../../services/main/src/modules/presentation/realm-mutes.ts';

test('IAM18 partial: presentation mute selectors hide only their declared author or Realm relation', () => {
  const filter = createPresentationMuteFilter([
    { targetKind: 'agent', target: 'agent:muted', match: 'author' },
    { targetKind: 'realm', target: 'realm:publishing', match: 'publishing-realm' },
    { targetKind: 'realm', target: 'realm:membership', match: 'author-membership' },
    { targetKind: 'realm', target: 'realm:context', match: 'publication-context' },
  ]);
  const items = [
    { id: 'author', author: 'agent:muted', publishingRealm: null,
      authorMembershipRealms: [], publicationContext: null },
    { id: 'publishing-realm', author: null, publishingRealm: 'realm:publishing',
      authorMembershipRealms: [], publicationContext: null },
    { id: 'author-membership', author: null, publishingRealm: null,
      authorMembershipRealms: ['realm:membership'], publicationContext: null },
    { id: 'publication-context', author: null, publishingRealm: null,
      authorMembershipRealms: [], publicationContext: 'realm:context' },
    { id: 'same-realm-other-relation', author: null, publishingRealm: null,
      authorMembershipRealms: [], publicationContext: 'realm:publishing' },
    { id: 'unrelated', author: 'agent:other', publishingRealm: null,
      authorMembershipRealms: [], publicationContext: null },
  ];

  expect(filter.visible(items).map(item => item.id)).toEqual([
    'same-realm-other-relation', 'unrelated',
  ]);
});
