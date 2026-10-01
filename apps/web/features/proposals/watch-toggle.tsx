'use client';

import { Switch } from '@rezics/ui/switch';
import { useEffect, useState } from 'react';
import { browserMainApi } from '../api/browser.ts';
import { type MainClient, settle } from '../feed/types.ts';
import { useShell } from '../shell/shell-provider.tsx';

type Subscription = { level: string; reason: string; revision: string } | null;

/**
 * Watch or mute one correction. Main decides who may, and whether new activity
 * arrives; this control only sends `participating` or `ignore` with the
 * revision it last read.
 */
export function WatchToggle({ proposal, main }: { proposal: string; main?: MainClient }) {
  const { t } = useShell();
  const [subscription, setSubscription] = useState<Subscription>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'denied' | 'stale' | 'unavailable'>('loading');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = main ?? browserMainApi();
    let active = true;
    void settle(() => api.v1.me['proposal-subscriptions']({ proposal }).get()).then(result => {
      if (!active) return;
      if (!result.ok) {
        setStatus(result.failure === 'missing' || result.failure === 'sign-in' ? 'denied' : 'unavailable');
        return;
      }
      setSubscription(result.data.subscription);
      setStatus('ready');
    });
    return () => { active = false; };
  }, [proposal, main]);
  const watching = subscription?.level === 'participating';
  async function change(checked: boolean) {
    if (busy || status === 'loading' || status === 'stale') return;
    if (!checked && subscription === null) return;
    setBusy(true);
    const result = await settle(() => (main ?? browserMainApi()).v1.me['proposal-subscriptions']({ proposal }).put({
      profile: 'proposal-subscription-v1', level: checked ? 'participating' : 'ignore',
      expectedRevision: subscription?.revision ?? null }));
    setBusy(false);
    if (!result.ok) {
      setStatus(result.failure === 'moved' ? 'stale' : result.failure === 'missing' ? 'denied' : 'failed');
      return;
    }
    setSubscription({ level: result.data.level, reason: result.data.reason, revision: result.data.revision });
    setStatus('ready');
  }
  if (status === 'loading') return <p role="status" className="text-muted-foreground text-sm">{t.loading}</p>;
  if (status === 'unavailable' || status === 'denied') return <p role="status" className="min-w-0 text-pretty text-muted-foreground text-sm">
    {status === 'denied' ? t.watchDenied : t.watchUnavailable}</p>;
  return <section className="grid min-w-0 gap-2 rounded-2xl border border-border/60 bg-card p-5" aria-labelledby="watch-heading">
    <h2 id="watch-heading" className="font-semibold text-lg">{t.watchLabel}</h2>
    <p className="text-pretty text-muted-foreground text-sm">{t.watchHelp}</p>
    <div className="flex items-center gap-3 text-sm">
      <Switch size="sm" checked={watching} disabled={busy || status === 'stale'} aria-label={t.watchLabel}
        onCheckedChange={details => void change(details.checked)} />
      <span>{watching ? t.watchWatching : subscription?.level === 'ignore' ? t.watchMuted : t.watchOff}</span>
    </div>
    {status === 'failed' ? <p role="alert" className="text-destructive-foreground text-sm">{t.watchFailed}</p> : null}
    {status === 'stale' ? <p role="alert" className="text-destructive-foreground text-sm">{t.watchStale}</p> : null}
  </section>;
}
