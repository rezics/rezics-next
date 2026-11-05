import { expect, test } from 'bun:test';
import {
  isRecoveryResponseProjection,
  recoveryAcknowledgement,
  recoveryNativeError,
  recoveryResponseByteBounds,
} from '@rezics/auth-contract';

test('recovery projections are closed, status-bound and sized from their exact UTF-8 JSON', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  expect(recoveryResponseByteBounds).toEqual({
    acknowledgement: bytes(recoveryAcknowledgement),
    nativeError: bytes(recoveryNativeError),
  });
  expect(recoveryResponseByteBounds).toEqual({ acknowledgement: 16, nativeError: 33 });
  expect(isRecoveryResponseProjection(recoveryAcknowledgement, 200)).toBe(true);
  for (const status of [400, 401, 429, 503])
    expect(isRecoveryResponseProjection(recoveryNativeError, status)).toBe(true);
  expect(isRecoveryResponseProjection({ ...recoveryAcknowledgement, detail: 'extra' }, 200)).toBe(false);
  expect(isRecoveryResponseProjection({ ...recoveryNativeError, code: 'stale_review' }, 409)).toBe(false);
});
