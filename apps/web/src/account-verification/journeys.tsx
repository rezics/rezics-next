import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { csrfHeaders } from '../threads/composer';
import { readReviewPage, readAccountVerificationPage, readAccountManagement, decideVerification } from './actions';
import { AccountManagementPageView, AccountVerificationPageView, ReviewPageView } from './pages';
import type { SubmitOperation } from './operation';

const submit: SubmitOperation = (data) => decideVerification({ data, headers: csrfHeaders() });

export function ReviewJourney() {
  const { state, csrfToken } = useSession();
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery({
    ...personalRead,
    retry: false,
    queryKey: ['account-verification', 'review', cursor],
    enabled: personalRead.enabled && state === 'signed-in',
    queryFn: () => readReviewPage({ data: cursor ? { cursor } : {} }),
  });
  const refresh = () => {
    void query.refetch();
  };
  return (
    <ReviewPageView
      page={query.isError ? { state: 'unavailable' } : (query.data?.page ?? { state: 'loading' })}
      viewerId={query.data?.viewerId ?? null}
      operations={query.data?.operations ?? []}
      submit={submit}
      canWrite={!!csrfToken}
      refresh={refresh}
      next={(value) => {
        setCursor(value);
        window.scrollTo(0, 0);
      }}
      first={() => {
        if (cursor) setCursor(undefined);
        else refresh();
      }}
    />
  );
}

export function AccountVerificationJourney({ accountId }: { accountId: string }) {
  const { state, csrfToken } = useSession();
  const query = useQuery({
    ...personalRead,
    retry: false,
    queryKey: ['account-verification', 'account', accountId],
    enabled: personalRead.enabled && state === 'signed-in',
    queryFn: () => readAccountVerificationPage({ data: accountId }),
  });
  return (
    <AccountVerificationPageView
      accountId={accountId}
      page={query.isError ? { state: 'unavailable' } : (query.data?.page ?? { state: 'loading' })}
      viewerId={query.data?.viewerId ?? null}
      canWrite={!!csrfToken}
      submit={submit}
      refresh={() => {
        void query.refetch();
      }}
    />
  );
}

export function AccountManagementJourney() {
  const { state } = useSession();
  const query = useQuery({
    ...personalRead,
    retry: false,
    queryKey: ['account-verification', 'management'],
    enabled: personalRead.enabled && state === 'signed-in',
    queryFn: () => readAccountManagement(),
  });
  return (
    <AccountManagementPageView
      page={query.isError ? { state: 'unavailable' } : (query.data ?? { state: 'loading' })}
      refresh={() => {
        void query.refetch();
      }}
    />
  );
}
