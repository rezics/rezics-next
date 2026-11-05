export const recoveryAcknowledgement = Object.freeze({ success: true } as const);
export const recoveryNativeError = Object.freeze({ error: 'authentication_denied' } as const);

// These closed ASCII JSON objects are 16 and 33 UTF-8 bytes respectively.
export const recoveryResponseByteBounds = Object.freeze({
  acknowledgement: JSON.stringify(recoveryAcknowledgement).length,
  nativeError: JSON.stringify(recoveryNativeError).length,
});

export type RecoveryAcknowledgement = typeof recoveryAcknowledgement;
export type RecoveryNativeError = typeof recoveryNativeError;

const nativeErrorStatuses = [400, 401, 429, 503] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function isRecoveryAcknowledgement(value: unknown): value is RecoveryAcknowledgement {
  return record(value) && Object.keys(value).length === 1 && value.success === true;
}

export function isRecoveryNativeError(value: unknown, status: number): value is RecoveryNativeError {
  return (
    nativeErrorStatuses.includes(status as (typeof nativeErrorStatuses)[number]) &&
    record(value) &&
    Object.keys(value).length === 1 &&
    value.error === recoveryNativeError.error
  );
}

/** Validate the service's closed HTTP projection, including its actual status. */
export function isRecoveryResponseProjection(value: unknown, status: number): boolean {
  return status === 200 ? isRecoveryAcknowledgement(value) : isRecoveryNativeError(value, status);
}
