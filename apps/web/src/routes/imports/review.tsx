import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { ProviderQueueView } from '../../features/import-review/provider-queue-view';
import type { ProviderQueueRead } from '../../features/import-review/provider-queue';
import {
  confirmProviderDecision,
  loadProviderQueue,
  refreshProviderQueue,
} from '../../features/import-review/provider-review-actions-server';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/imports/review')({
  head: ({ match }) =>
    pageHead({ title: m.provider_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ProviderReviewPage,
});

function ProviderReviewPage() {
  const { state, csrfToken, subject } = useSession();
  // Keep action drafts scoped to the signed-in viewer; no private queue is server-rendered.
  return <ViewerQueue key={`${state}:${subject ?? ''}`} state={state} csrfToken={csrfToken} viewer={subject ?? ''} />;
}

function ViewerQueue({ state, csrfToken, viewer }: { state: string; csrfToken: string | null; viewer: string }) {
  const headers = { 'X-CSRF-Token': csrfToken ?? '' };
  const client = useQueryClient();
  const queryKey = ['provider-review', viewer, getLocale()];
  const query = useQuery({
    ...personalRead,
    queryKey,
    queryFn: () => loadProviderQueue({ headers }),
    enabled: personalRead.enabled && state === 'signed-in',
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const result: ProviderQueueRead | { ok: false; reason: 'loading' } = query.data ?? { ok: false, reason: query.isError ? 'unavailable' : 'loading' };
  return () => {
      active = false;
    };
  }, [state, csrfToken]);
  return (
    <ProviderQueueView
      locale={getLocale()}
      result={state === 'signed-in' ? result : { ok: false, reason: state === 'signed-out' ? 'denied' : 'unavailable' }}
      onRetry={() => loadProviderQueue({ headers })}
      onRead={(read) => client.setQueryData(queryKey, read)}
      transport={{
        confirm: (command) => confirmProviderDecision({ data: command, headers }),
        refresh: (batch) =>
          refreshProviderQueue({
            data: batch.attempts.map(({ command, result }) => ({
              ...command,
              session: result?.ok ? (result.session ?? command.session) : command.session,
            })),
            headers,
          }),
      }}
    />
  );
}
