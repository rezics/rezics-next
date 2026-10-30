import { AsyncLocalStorage } from 'node:async_hooks';

// Installed only around the native provider's already-validated assertion write.
// Public request fields cannot install this context.
export const nativeProtocolClient = new AsyncLocalStorage<string>();

type TypedVerification = {
  type?: string;
  userId?: string;
  sessionId?: string;
  userData?: { id?: string };
  query?: { client_id?: string };
};

/** Decode only the pinned producer's typed value while creating that native row.
 * Erasure never reads or searches verification payloads. Unknown/old formats keep
 * null attribution and cannot prove complete coverage or a `none` outcome.
 */
export function verificationAttribution(data: Record<string, unknown>) {
  const subject = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024 ? value : null;
  if (typeof data.identifier === 'string' && data.identifier.startsWith('reset-password:'))
    return { erasure_account_id: subject(data.value), erasure_client_id: null, erasure_session_id: null };
  let value: TypedVerification;
  try {
    value = JSON.parse(String(data.value));
  } catch {
    return null;
  }
  if (value?.type === 'registration' || value?.type === 'authentication')
    return { erasure_account_id: subject(value.userData?.id), erasure_client_id: null, erasure_session_id: null };
  if (value?.type === 'authorization_code')
    return {
      erasure_account_id: subject(value.userId),
      erasure_client_id: subject(value.query?.client_id),
      erasure_session_id: subject(value.sessionId),
    };
  return null;
}
