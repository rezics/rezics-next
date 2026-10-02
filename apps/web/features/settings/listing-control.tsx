'use client';

import { Button } from '@rezics/ui/button';
import { Switch } from '@rezics/ui/switch';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserListingApi, newKey, type ListingApi, type ListingState } from '../manage/settings-api.ts';
import { accessMessages } from '../manage/settings-messages.ts';

export function PersonListingControl({ agent, locale, initial, api: provided }: {
  agent: string; locale: UiLocale; initial?: ListingState; api?: ListingApi;
}) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserListingApi(agent), [provided, agent]);
  const [current, setCurrent] = useState<ListingState | null>(initial ?? null);
  const [unlisted, setUnlisted] = useState(initial?.listing === 'unlisted');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    if (initial) return;
    let alive = true;
    void api.read().then(result => {
      if (!alive) return;
      if (result.ok) { setCurrent(result.data); setUnlisted(result.data.listing === 'unlisted'); }
      else setError(t.failed);
    });
    return () => { alive = false; };
  }, [api, initial, t.failed]);
  async function retry() {
    setBusy(true);
    const result = await api.read();
    if (result.ok) { setCurrent(result.data); setUnlisted(result.data.listing === 'unlisted'); setError(null); }
    else setError(t.failed);
    setBusy(false);
  }
  async function save() {
    if (!current || busy) return;
    setBusy(true); setError(null); setStatus(null);
    const listing = unlisted ? 'unlisted' : 'listed';
    const body = JSON.stringify([listing, current.version]);
    if (intent.current?.body !== body) intent.current = { body, key: newKey() };
    const result = await api.save(listing, current.version, intent.current.key);
    if (result.ok) { setCurrent(result.data); setStatus(t.saved); intent.current = null; }
    else if (result.failure === 'stale') {
      const fresh = await api.read();
      if (fresh.ok) { setCurrent(fresh.data); setUnlisted(fresh.data.listing === 'unlisted'); setError(t.personConflict); intent.current = null; }
      else setError(t.failed);
    } else setError(result.failure === 'denied' ? t.denied : t.failed);
    setBusy(false);
  }
  return <section className="grid gap-3 border-border border-t pt-4">
    <div className="flex items-center gap-3"><Switch aria-label={t.personUnlisted} checked={unlisted} disabled={!current || busy}
      onCheckedChange={({ checked }) => { setUnlisted(checked); setStatus(null); }} /><span className="font-medium text-sm">{t.personUnlisted}</span></div>
    {current ? <p className="text-muted-foreground text-sm">{unlisted ? t.personHelp : t.personListedHelp}</p> : null}
    {error ? <p role="alert">{error}</p> : null}{status ? <p role="status">{status}</p> : null}
    {!current && error ? <Button type="button" variant="outline" className="w-fit" disabled={busy} onClick={() => void retry()}>{t.retry}</Button>
      : <Button type="button" className="w-fit" disabled={!current || busy || (unlisted ? 'unlisted' : 'listed') === current.listing}
        isLoading={busy} onClick={() => void save()}>{t.personSave}</Button>}
  </section>;
}
