import { expect, test } from 'bun:test';
import {
  credentialEffectResponseByteBudgets,
  credentialEffectResponseLimits,
  isCredentialEffectApprovalReference,
  isCredentialEffectUuid,
  isPasswordCredentialEffectApprovalReference,
} from '@rezics/auth-contract';

const uuid = '00000000-0000-4000-8000-000000000000';

test('password phase bounds admit producer maxima before UTF-8 parsing', () => {
  const longestEcho = '\u0001'.repeat(credentialEffectResponseLimits.textUnits);
  const stage = {
    effectRef: uuid,
    key: longestEcho,
    subjectId: longestEcho,
    purpose: 'set-password',
    digest: 'a'.repeat(64),
  };
  expect(JSON.stringify(stage).length).toBe(credentialEffectResponseByteBudgets.stage.success);

  const reference = `${'A'.repeat(credentialEffectResponseLimits.passwordApprovalReferenceUnits - 44)}.${'A'.repeat(43)}`;
  expect(isPasswordCredentialEffectApprovalReference(reference)).toBe(true);
  expect(isCredentialEffectApprovalReference(reference)).toBe(true);
  expect(JSON.stringify({ reference, expiresAt: '9999-12-31T23:59:59.999Z' }).length).toBe(
    credentialEffectResponseByteBudgets.approve.success,
  );

  expect(JSON.stringify({ receiptId: uuid, replayed: false }).length).toBe(
    credentialEffectResponseByteBudgets.apply.success,
  );
  expect(credentialEffectResponseByteBudgets.stage.error).toBe(66);
  expect(credentialEffectResponseByteBudgets.approve.error).toBe(66);
  expect(credentialEffectResponseByteBudgets.apply.error).toBe(66);
});

test('phase identifiers follow Auth UUIDs and Access sealed-reference syntax', () => {
  expect(credentialEffectResponseLimits.passwordApprovalReferenceUnits).toBe(2_768);
  expect(credentialEffectResponseLimits.approvalReferenceUnits).toBe(2_772);
  expect(isCredentialEffectUuid(uuid)).toBe(true);
  expect(isCredentialEffectUuid('effect-ref')).toBe(false);
  expect(isCredentialEffectApprovalReference(`${'A'.repeat(20)}.${'A'.repeat(43)}`)).toBe(true);
  expect(isPasswordCredentialEffectApprovalReference(`${'A'.repeat(20)}.${'A'.repeat(43)}`)).toBe(true);
  expect(isCredentialEffectApprovalReference(`${'A'.repeat(20)}.${'B'.repeat(43)}`)).toBe(false);
  expect(isCredentialEffectApprovalReference(`A.${'A'.repeat(43)}`)).toBe(false);
  expect(isCredentialEffectApprovalReference(uuid)).toBe(false);
  expect(
    isCredentialEffectApprovalReference(
      `${'A'.repeat(credentialEffectResponseLimits.passwordApprovalReferenceUnits - 43)}.${'A'.repeat(43)}`,
    ),
  ).toBe(false);
  expect(credentialEffectResponseLimits.approvalReferenceUnits).toBeGreaterThanOrEqual(
    credentialEffectResponseLimits.passwordApprovalReferenceUnits,
  );
});
