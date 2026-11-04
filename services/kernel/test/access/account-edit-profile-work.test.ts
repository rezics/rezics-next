import { expect, test } from 'bun:test';
import {
  accountEditProfileReadWork,
  accountProfileEditing,
  PROFILE_LINK_LABEL_MAX_LENGTH,
  PROFILE_LINK_MAX_ITEMS,
  PROFILE_LINK_URL_MAX_LENGTH,
  PROFILE_PUBLIC_VIEW_FLAGS,
  PROFILE_TEXT_MAX_LENGTH,
} from '../../src/access/account-edit-profile.ts';
import { accessNativeDeclaration, addAccessWork, EMPTY_ACCESS_WORK } from '../../src/access/work.ts';

const actorId = '019a0000-0000-7000-8000-000000000001';
const organizationId = '019a0000-0000-7000-8000-000000000002';
const operatorId = '019a0000-0000-7000-8000-000000000003';

test('private profile advice is closed per viewer and kind at three unrelated populations', () => {
  const actor = accountProfileEditing(actorId, { id: actorId, kind: 'actor' });
  const organization = accountProfileEditing(actorId, { id: organizationId, kind: 'organization' });
  const managed = accountProfileEditing(operatorId, { id: actorId, kind: 'actor' });
  const identity = {
    displayName: { applicable: true, maxLength: PROFILE_TEXT_MAX_LENGTH },
    biography: { applicable: true, maxLength: PROFILE_TEXT_MAX_LENGTH },
    avatar: { applicable: true },
    links: {
      applicable: true,
      maxItems: PROFILE_LINK_MAX_ITEMS,
      labelMaxLength: PROFILE_LINK_LABEL_MAX_LENGTH,
      urlMaxLength: PROFILE_LINK_URL_MAX_LENGTH,
    },
    publicViews: { applicable: true, flags: PROFILE_PUBLIC_VIEW_FLAGS },
  };
  expect(actor).toEqual({
    viewer: { accountId: actorId },
    target: { accountId: actorId, kind: 'actor' },
    fields: identity,
  });
  expect(actor.fields).not.toHaveProperty('speakersListed');
  expect(organization).toEqual({
    viewer: { accountId: actorId },
    target: { accountId: organizationId, kind: 'organization' },
    fields: { ...identity, speakersListed: { applicable: true } },
  });
  expect(managed).toEqual({
    viewer: { accountId: operatorId },
    target: { accountId: actorId, kind: 'actor' },
    fields: identity,
  });
});

test('derived private-profile read work includes checkout, controls, statement, avatar and serialization', () => {
  const bound = accountEditProfileReadWork();
  const profile = accessNativeDeclaration('account-profile', {}, {}).bound;
  expect(bound.keys).toBeGreaterThanOrEqual(profile.keys);
  expect(bound.points).toBeGreaterThan(0);
  expect(bound.rows).toBeGreaterThan(0);
  expect(bound.bytes).toBeGreaterThan(profile.bytes);
  expect(bound.emptySeeks).toBeGreaterThan(0);
  expect(addAccessWork(bound, EMPTY_ACCESS_WORK)).toEqual(bound);
});
