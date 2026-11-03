import { expect, test } from 'bun:test';
import {
  realmMemberEpisodeToken,
  sameMemberAnchor,
  samePublicIdentityObservation,
  sameSelectedMember,
  type MemberAnchor,
} from '../../src/community/member-page.ts';
import frontier from '../../src/community/member-page-frontier.sql';

const accountId = '00000000-0000-0000-0000-000000000020';
const original: MemberAnchor = {
  accountId,
  reservationId: '00000000-0000-0000-0000-000000000021',
  transactionId: '00000000-0000-0000-0000-000000000022',
};
const rejoined: MemberAnchor = {
  accountId,
  reservationId: '00000000-0000-0000-0000-000000000023',
  transactionId: '00000000-0000-0000-0000-000000000024',
};

test('the bounded raw frontier advances by open keys before rejecting future starts', () => {
  expect(frontier.params).toEqual(['route', 'realm_id', 'at', 'after']);
  const page = frontier.sql.slice(frontier.sql.indexOf('page AS MATERIALIZED'), frontier.sql.indexOf('SELECT page.*'));
  const where = page.slice(page.indexOf('WHERE'), page.indexOf('ORDER BY'));
  expect(page).toContain('LIMIT 20');
  expect(page).toContain('m.valid @> args.arg_at AS "current"');
  expect(where).toContain('upper_inf(m.valid)');
  expect(where).not.toContain('arg_at');
});

test('selected membership and absence compare to the original source observation', () => {
  expect(sameMemberAnchor(original, { ...original })).toBe(true);
  expect(sameMemberAnchor(original, rejoined)).toBe(false);
  expect(sameSelectedMember({ accountId, membership: 'member', anchor: original }, rejoined)).toBe(false);
  expect(sameSelectedMember({ accountId, membership: 'none', anchor: null }, undefined)).toBe(true);
  expect(sameSelectedMember({ accountId, membership: 'none', anchor: null }, rejoined)).toBe(false);
});

test('episode tokens bind the selected observation without disclosing native anchors', () => {
  const tokens = { current: 7, keys: new Map([[7, new Uint8Array(32).fill(41)]]) };
  const token = (
    anchor: MemberAnchor | null,
    overrides: { realmId?: string; viewerAccountId?: string; accountId?: string; epoch?: number } = {},
  ) =>
    realmMemberEpisodeToken({
      tokens,
      realmId: overrides.realmId ?? '00000000-0000-0000-0000-000000000011',
      viewerAccountId: overrides.viewerAccountId ?? '00000000-0000-0000-0000-000000000010',
      accountId: overrides.accountId ?? accountId,
      epoch: overrides.epoch ?? 3,
      anchor,
    });
  const selected = token(original);
  expect(token(original)).toBe(selected);
  expect(token(rejoined)).not.toBe(selected);
  expect(token(null)).not.toBe(selected);
  expect(token(original, { viewerAccountId: '00000000-0000-0000-0000-000000000012' })).not.toBe(selected);
  expect(token(original, { realmId: '00000000-0000-0000-0000-000000000013' })).not.toBe(selected);
  expect(token(original, { epoch: 4 })).not.toBe(selected);
  expect(selected).not.toContain(original.reservationId);
  expect(selected).not.toContain(original.transactionId);
});

test('public identity observations include names, handles, and erasure state', () => {
  const before = {
    id: accountId,
    kind: 'actor' as const,
    state: 'active' as const,
    handle: null,
    displayName: null,
    automated: false,
    operatorId: null,
  };
  expect(samePublicIdentityObservation(before, { ...before })).toBe(true);
  expect(samePublicIdentityObservation(before, { ...before, handle: 'new-name', displayName: 'New Name' })).toBe(false);
  expect(samePublicIdentityObservation(before, { id: accountId, kind: 'actor', state: 'deleted' })).toBe(false);
  expect(samePublicIdentityObservation(undefined, before)).toBe(false);
});
