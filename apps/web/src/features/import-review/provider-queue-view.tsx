import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { ProviderQueueRead } from './provider-queue';
import {
  ProviderReviewActions,
  providerOutcomeText,
  type ProviderReviewTransport,
} from './provider-review-actions-view';

/** Thin queue insertion seam; producer reads and native decision drafts have separate lifetimes. */
export function ProviderQueueView({
  result,
  locale,
  transport,
  onRetry,
  onRead,
}: {
  result: ProviderQueueRead | { ok: false; reason: 'loading' };
  locale: string;
  transport: ProviderReviewTransport;
  onRetry: () => Promise<ProviderQueueRead>;
  onRead: (read: ProviderQueueRead) => void;
}) {
  const o = { locale: locale as never };
  const current = result;
  const [busy, setBusy] = useState(false);
  async function retry() {
    if (busy) return;
    setBusy(true);
    try {
      onRead(await onRetry());
    } catch {
      onRead({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold sm:text-3xl">{m.provider_title({}, o)}</h1>
        <p className="text-muted-foreground">{m.provider_intro({}, o)}</p>
      </header>
      {current.ok ? (
        <>
          <p>
            {current.page.sourceLabel} · {current.page.contextLabel} · {current.page.statusLabel}
          </p>
          {!current.page.rows.length && <p role="status">{m.provider_empty({}, o)}</p>}
        </>
      ) : current.reason === 'loading' ? (
        <p role="status">{m.candidate_loading({}, o)}</p>
      ) : (
        <div role="alert" className="space-y-3 rounded-xl border border-border p-4">
          <p>{providerOutcomeText(current, locale)}</p>
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void retry()}>
            {m.provider_refresh({}, o)}
          </Button>
        </div>
      )}
      <ProviderReviewActions
        page={current.ok ? current.page : undefined}
        locale={locale}
        transport={transport}
        onRefresh={onRead}
        concealRows={!current.ok && (current.reason === 'denied' || current.reason === 'missing')}
      />
    </main>
  );
}
