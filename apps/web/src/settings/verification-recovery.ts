import type { QueryClient } from '@tanstack/react-query';
import { verificationQueryKey } from './application/verification';

export {
  VerificationRecovery,
  canRequestVerification,
  canRetryVerification,
  canWithdrawVerification,
  verificationQueryKey,
  verificationWithdrawalObservation,
} from './application/verification';
export type {
  VerificationAttempt,
  VerificationRecoveryIO,
  VerificationRecoveryState,
  VerificationSnapshot,
} from './contract/verification';

/** Observe only this viewer's installed read; never create a query or replace its producer's options. */
export function observeVerificationRead(
  client: QueryClient,
  accountId: string | null | undefined,
  changed: () => void,
) {
  const key = verificationQueryKey(accountId);
  return client.getQueryCache().subscribe(({ query }) => {
    if (
      accountId &&
      query.queryKey.length === key.length &&
      query.queryKey.every((part: unknown, index: number) => part === key[index])
    )
      changed();
  });
}
