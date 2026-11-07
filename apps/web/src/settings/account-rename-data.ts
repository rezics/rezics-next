import type { NativePreferenceFailure } from './preferences';

export type AccountRenameContext = {
  accountId: string;
  handle: string | null;
  available: boolean;
};

export type AccountRenameFailure = NativePreferenceFailure & { kind: 'failed' | 'denied' | 'unavailable' };
/** Plain, bounded metadata crosses the server-function boundary, never custom Error properties. */
export type AccountRenameReadResult<T = AccountRenameContext> = {
  context: T | null;
  failures?: AccountRenameFailure[];
};

export function boundedFailure(failure: NativePreferenceFailure): AccountRenameFailure {
  const status = failure.status;
  const text = (value: string | undefined, limit: number) => (value && value.length <= limit ? value : undefined);
  const code = text(failure.code, 128);
  const requestId = text(failure.requestId, 128);
  const retryAfter = text(failure.retryAfter, 128);
  return {
    status,
    kind:
      code === 'platform_closed' || status === 404 || status === 410 || status === 501
        ? 'unavailable'
        : status === 401 || status === 403
          ? 'denied'
          : 'failed',
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
  };
}

/** Mixed native faults stay conservative: unavailable before denied before failed. */
export function accountRenamePresentedFailure(
  failures: AccountRenameFailure[] | undefined,
): AccountRenameFailure | undefined {
  if (!failures?.length) return undefined;
  return (
    failures.find((entry) => entry.kind === 'unavailable') ??
    failures.find((entry) => entry.kind === 'denied') ??
    failures[0]
  );
}
