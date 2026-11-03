import { expect, test } from 'bun:test';
import { archiveRecoveryAdmission } from '../src/library/archive-entry-recovery/native';

test('Archive admission stays unavailable until exact reviewed selections can cross the native boundary', () => {
  // A mounted implementation or Eden runtime property alone must not enable file transfer.
  expect(archiveRecoveryAdmission()).toEqual({ available: false });
});
