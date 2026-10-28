import { expect, test } from 'bun:test';
import type { NativeLabelRow, NativeOutboxRow } from './library-labels-driver.ts';

// These are pure identity/provenance fixtures. Product authorization and effects belong to the native outcome suite.

test('an opaque label ID is scoped by its owner partition and rename preserves its identity', () => {
  const sameId = 'opaque-label-fixture';
  const firstOwner: NativeLabelRow = {
    ownerAccountId: 'account-a',
    ownerRoute: 32,
    labelId: sameId,
    normalizedName: 'Reading later',
    revision: 2,
    generation: 2,
    deletedAt: null,
  };
  const secondOwner: NativeLabelRow = { ...firstOwner, ownerAccountId: 'account-b', ownerRoute: 64 };
  const recreated: NativeLabelRow = { ...firstOwner, labelId: 'new-opaque-label-fixture', generation: 2 };
  const ownerKey = (row: NativeLabelRow) => `${row.ownerRoute}:${row.ownerAccountId}:${row.labelId}`;

  expect(firstOwner.labelId).toBe(secondOwner.labelId);
  expect(ownerKey(firstOwner)).not.toBe(ownerKey(secondOwner));
  expect(ownerKey(firstOwner)).not.toBe(ownerKey(recreated));
  expect({ ...firstOwner, normalizedName: 'Reading eventually' }.labelId).toBe(firstOwner.labelId);
});

test('private label event provenance uses the owner as subject and excludes the label value', () => {
  const ownerId = 'owner-account-fixture';
  const subjectId = 'catalogue-subject-fixture';
  const privateName = 'NEVER PUT THIS VALUE IN AN EVENT';
  const event: NativeOutboxRow = {
    type: 'private-label-event-fixture',
    subject: ownerId,
    data: { labelId: 'opaque-label-fixture', subjectId },
  };

  expect(event.subject).toBe(ownerId);
  expect(event.subject).not.toBe(subjectId);
  expect(event.data).not.toHaveProperty('name');
  expect(JSON.stringify(event)).not.toContain(privateName);
});
