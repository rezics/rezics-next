import { expect, test } from 'bun:test';
import { securityActionResponseByteBudgets } from '@rezics/auth-contract';

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

test('Security removal response bounds cover the exact native success and refusal envelopes', () => {
  const session = [
    '{}',
    '{"error":"authentication_denied"}',
    '{"error":"authentication_denied","code":"stale_review"}',
  ];
  const passkey = [
    '{"success":true}',
    '{"error":"step_up_required","effect_status":"not_applied"}',
    '{"error":"credential_effect_denied","effect_status":"not_applied"}',
    '{"error":"authentication_denied"}',
  ];
  expect(securityActionResponseByteBudgets).toEqual({
    session: Math.max(...session.map(bytes)),
    passkey: Math.max(...passkey.map(bytes)),
  });
});
