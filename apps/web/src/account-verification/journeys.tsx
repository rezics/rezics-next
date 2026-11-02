import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { csrfHeaders } from '../threads/composer';
import { readReviewPage, readAccountVerificationPage, readAccountManagement, decideVerification } from './actions';
import { AccountManagementPageView, AccountVerificationPageView, ReviewPageView } from './pages';
import type { SubmitOperation } from './operation';
import { verificationPageTimeout, withVerificationDeadline } from './deadline';

const submit: SubmitOperation = (data, signal) => decideVerification({ data, signal, headers: csrfHeaders() });

export function ReviewJourney() {
  const { state, csrfToken, subject } = useSession();
  const viewerId = state === 'signed-in' ? (subject ?? null) : null;
  return (
    <ReviewerJourney key={viewerId ?? state} viewerId={viewerId} loading={state === 'unknown'} canWrite={!!csrfToken} />
  );
}

function ReviewerJourney({
  viewerId,
  loading,
  canWrite,
}: {
  viewerId: string | null;
  loading: boolean;
  canWrite: boolean;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery({
    ...personalRead,
    retry: false,
    queryKey: ['account-verification', 'review', viewerId, cursor],
    enabled: personalRead.enabled && !!viewerId,
    queryFn: ({ signal: caller }) =>
      withVerificationDeadline(
        (signal) => readReviewPage({ data: cursor ? { cursor } : {}, signal }),
        caller,
        verificationPageTimeout,
      ),
  });
  const refresh = () => {
    void query.refetch();
  };
  return (
    <ReviewPageView
      page={
        loading
          ? { state: 'loading' }
          : !viewerId || (query.data && query.data.viewerId !== viewerId)
            ? { state: 'denied' }
            : query.isError
              ? { state: 'unavailable' }
              : (query.data?.page ?? { state: 'loading' })
      }
      viewerId={viewerId}
      operations={query.data?.viewerId === viewerId ? (query.data?.operations ?? []) : []}
      submit={submit}
      canWrite={canWrite && !query.isFetching}
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
    queryFn: ({ signal: caller }) =>
      withVerificationDeadline(
        (signal) => readAccountVerificationPage({ data: accountId, signal }),
        caller,
        verificationPageTimeout,
      ),
  });
  return (
    <AccountVerificationPageView
      accountId={accountId}
      page={query.isError ? { state: 'unavailable' } : (query.data?.page ?? { state: 'loading' })}
      viewerId={query.data?.viewerId ?? null}
      canWrite={!!csrfToken && !query.isFetching}
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
    queryFn: ({ signal: caller }) =>
      withVerificationDeadline((signal) => readAccountManagement({ signal }), caller, verificationPageTimeout),
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
