'use client';

import { Button } from '@rezics/ui/button';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainRelationships, RelationshipError } from './api.ts';
import { NotificationMenu } from './control.tsx';
import { messages } from './messages.ts';
import type { RelationshipsApi, Watch, Level } from './types.ts';

/** Watch is a per-thread override. Its levels stay distinct from Follow's levels at the API boundary. */
export function RelationshipWatch(props: Parameters<typeof RelationshipWatchState>[0]) {
  return <RelationshipWatchState key={`${props.target}:${props.kind}:${props.signedIn}:${props.actingSubject ?? 'guest'}`} {...props} />;
}

function RelationshipWatchState({ target, kind, locale, signedIn, actingSubject, api: supplied }: {
  target: string; kind: string; locale: UiLocale; signedIn: boolean; actingSubject?: string; api?: RelationshipsApi;
}) {
  const t = messages[locale];
  const api = useMemo(() => supplied ?? (actingSubject ? mainRelationships(actingSubject) : null), [supplied, actingSubject]);
  const reader = useRef(api);
  reader.current = api;
  const [watch, setWatch] = useState<Watch | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const retry = useRef<{ level: Level; key: string } | null>(null);
  useEffect(() => {
    setLoaded(false); setWatch(null); setNotice(null); retry.current = null;
    if (!api || !signedIn) return;
    let active = true;
    void api.watch(target, kind).then(state => { if (active) { setWatch(state); setLoaded(true); } })
      .catch(() => { if (active) setNotice(t.unavailable); });
    return () => { active = false; };
  }, [api, target, kind, signedIn, t.unavailable]);
  async function change(level: Level) {
    if (!api || busy || !loaded) return;
    const key = retry.current?.level === level ? retry.current.key : crypto.randomUUID();
    retry.current = { level, key }; setBusy(true); setNotice(null);
    try {
      const result = await api.setWatch(target, kind, level === 'highlights' ? 'participating' : level === 'off' ? 'ignore' : 'all', watch?.revision ?? null, key);
      if (reader.current !== api) return;
      setWatch(result);
      retry.current = null;
    } catch (error) {
      if (reader.current !== api) return;
      if (error instanceof RelationshipError && error.status === 409) {
        retry.current = null;
        try { setWatch(await api.watch(target, kind)); } catch { /* Keep the last known override. */ }
        setNotice(t.stale);
      } else setNotice(t.failed);
    } finally { setBusy(false); }
  }
  if (!signedIn) return null;
  return <section className="grid min-w-0 gap-3 rounded-2xl border border-border/60 bg-card p-5" aria-label={t.watch}>
    <h2 className="font-semibold text-lg">{t.watch}</h2>
    {!api ? <p role="status" className="text-sm">{t.unknown}</p> : loaded ? <div className="flex items-center gap-2">
      <Button size="sm" variant={watch && watch.level !== 'ignore' ? 'outline' : 'default'} disabled={busy}
        aria-pressed={Boolean(watch && watch.level !== 'ignore')}
        onClick={() => void change(watch && watch.level !== 'ignore' ? 'off' : 'highlights')}>{t.watch}</Button>
      <NotificationMenu watch locale={locale} level={watch?.level === 'all' ? 'all' : watch?.level === 'participating' ? 'highlights' : 'off'}
        busy={busy} onChange={level => void change(level)} /></div> : !notice ? <p role="status" className="text-sm">{t.loading}</p> : null}
    {notice ? <p role="status" className="text-destructive-foreground text-sm">{notice}</p> : null}
    {api && !loaded && notice ? <Button variant="outline" size="sm" onClick={() => {
      void api.watch(target, kind).then(state => { setWatch(state); setLoaded(true); setNotice(null); }).catch(() => setNotice(t.unavailable));
    }}>{t.retry}</Button> : null}
  </section>;
}
