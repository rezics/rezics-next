import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { RealmHome } from '../src/community/space';

mock.module('../src/community/space-actions', () => ({
  changeRealmMembership: async () => ({ outcome: 'accepted' }),
}));
const { RealmMembership } = await import('../src/community/realm-membership');

const returnTo = '/en/spaces/atlas';
const realm = (viewer: RealmHome['viewer']): RealmHome => ({
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  visibility: 'public',
  boards: [],
  published: [],
  viewer,
});

function membership(viewer: RealmHome['viewer']): string {
  return renderToString(createElement(RealmMembership, { realm: realm(viewer), returnTo }));
}

function membershipSection(html: string): string {
  const section = /<section\b[^>]*aria-label="Membership"[^>]*>[\s\S]*?<\/section>/.exec(html);
  expect(section, 'membership section is rendered').not.toBeNull();
  return section![0];
}

function joinControlGroup(section: string): string {
  const group = /<div class="flex flex-wrap items-center gap-3">[\s\S]*?<\/div>/.exec(section);
  expect(group, 'Join control has the same flex group as membership actions').not.toBeNull();
  return group![0];
}

test('signed-out visitors get the same Join action in the same place, linked to sign-in and back to this page', () => {
  const signedOut = membershipSection(membership(null));
  const nonMember = membershipSection(membership({ state: 'none', idempotencyKey: 'join-key' }));

  expect(signedOut).toMatch(/<a\b[^>]*href="\/auth\/sign-in\?return_to=%2Fen%2Fspaces%2Fatlas"[^>]*>Join<\/a>/);
  expect(joinControlGroup(signedOut)).toContain('>Join</a>');
  expect(joinControlGroup(nonMember)).toContain('>Join</button>');
  expect(signedOut).not.toContain('Sign in to join this Realm.');
  expect(signedOut).not.toContain('rounded-lg border');
  expect(signedOut).not.toContain('Sign in</a>');
});
