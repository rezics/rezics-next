import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
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
  return <ViewerQueue key={`${state}:${subject ?? ''}`} state={state} csrfToken={csrfToken} />;
}

function ViewerQueue({ state, csrfToken }: { state: string; csrfToken: string | null }) {
  const [result, setResult] = useState<ProviderQueueRead | { ok: false; reason: 'loading' }>({
    ok: false,
    reason: 'loading',
  });
  const headers = { 'X-CSRF-Token': csrfToken ?? '' };
  useEffect(() => {
    if (state !== 'signed-in') return;
    let active = true;
    loadProviderQueue({ headers }).then(
      (next) => {
        if (active) setResult(next);
      },
      () => {
        if (active) setResult({ ok: false, reason: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [state, csrfToken]);
  return (
    <ProviderQueueView
      locale={getLocale()}
      result={state === 'signed-in' ? result : { ok: false, reason: state === 'signed-out' ? 'denied' : 'unavailable' }}
      onRetry={() => loadProviderQueue({ headers })}
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
