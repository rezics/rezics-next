/** Received Work SDK_RETIREMENT_DISPATCH. The SDK reserves each native dispatch.
 * Auth retains its envelope identities for retention cost composition; attempt
 * includes the connection admission represented by the SDK connect dispatch. */
export const AUTH_SDK_RETIREMENT_DISPATCH = Object.freeze({
  attempt: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 1 },
  connect: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 1 },
  wait: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
  backoff: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
  reconcile: { rows: 3, points: 2, statements: 1, bytes: 8192, engineRequests: 0 },
  rollback: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  begin: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  settings: { rows: 1, points: 0, statements: 1, bytes: 128, engineRequests: 0 },
  lock: { rows: 4, points: 2, statements: 4, bytes: 8192, engineRequests: 0 },
  retire: { rows: 8, points: 5, statements: 9, bytes: 32768, engineRequests: 0 },
  commit: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
});

export type AuthSdkRetirementDispatch = keyof typeof AUTH_SDK_RETIREMENT_DISPATCH;
