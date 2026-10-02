'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Textarea } from '@rezics/ui/textarea';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CommandDialog } from './command-dialog.tsx';
import { browserSpaceAccessApi, newKey, type JoinRequest, type RequestPage, type SpaceAccessApi } from './settings-api.ts';
import { accessMessages } from './settings-messages.ts';
import { date } from './format.ts';
import type { AgentSummary } from './types.ts';

export function RequestsView({ initial, space, realm, actingSubject, locale, api: provided }: {
  initial: RequestPage; space: string; realm: string; actingSubject: string; locale: UiLocale; api?: SpaceAccessApi;
}) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserSpaceAccessApi(space, realm, actingSubject), [provided, space, realm, actingSubject]);
  const [page, setPage] = useState(initial);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<JoinRequest | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const intent = useRef<{ body: string; key: string } | null>(null);
  const [names, setNames] = useState<Record<string, AgentSummary>>({});
  const members = JSON.stringify(initial.items.map(item => item.member));
  useEffect(() => {
    let alive = true;
    void api.names(JSON.parse(members) as string[]).then(found => { if (alive) setNames(previous => ({ ...previous, ...found })); });
    return () => { alive = false; };
  }, [api, members]);
  const shown = page.items.filter(item => `${names[item.member]?.label ?? ''} ${names[item.member]?.handle ?? ''} ${item.member} ${item.reason}`
    .toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)));

  async function load(more: boolean) {
    setBusy(true); setError(null);
    const result = await api.requests(more ? page.nextCursor : null);
    if (result.ok) {
      setPage(previous => ({ ...result.data, items: more
        ? [...previous.items, ...result.data.items.filter(item => !previous.items.some(old => old.id === item.id))] : result.data.items }));
      const found = await api.names(result.data.items.map(item => item.member));
      setNames(previous => ({ ...previous, ...found }));
    }
    else setError(result.failure === 'denied' ? t.denied : t.failed);
    setBusy(false);
  }
  async function approve() {
    if (!selected || busy || !reason.trim()) return;
    setBusy(true); setError(null);
    const body = JSON.stringify([selected, reason.trim()]);
    if (intent.current?.body !== body) intent.current = { body, key: newKey() };
    const result = await api.approve(selected, reason.trim(), intent.current.key);
    if (result.ok) {
      setPage(previous => ({ ...previous, items: previous.items.filter(item => item.id !== selected.id) }));
      setSelected(null); setStatus(t.approved); setReason(''); intent.current = null;
    } else setError(result.failure === 'stale' ? t.staleRequest : result.failure === 'denied' ? t.denied : t.failed);
    setBusy(false);
  }
  return <section aria-labelledby="join-requests-title" className="grid max-w-3xl gap-4">
    <h2 id="join-requests-title" className="font-semibold text-xl">{t.requests}</h2>
    <Field><FieldLabel>{t.search}</FieldLabel><Input type="search" value={search} maxLength={80}
      onChange={event => setSearch(event.currentTarget.value)} /><p className="text-muted-foreground text-sm">{t.searchHelp}</p></Field>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void load(false)}>{t.refresh}</Button></div>
    {status ? <p role="status">{status}</p> : null}
    {error && !selected ? <p role="alert">{error}</p> : null}
    <p className="text-muted-foreground text-sm">{t.declineUnavailable}</p>
    {shown.length ? <ul className="grid gap-3">{shown.map(item => <li key={item.id} className="grid gap-3 rounded-xl border border-border p-4">
      <p dir="auto" className="break-words font-medium">{names[item.member]?.label ?? item.member}</p>
      {names[item.member]?.handle ? <p className="text-muted-foreground text-sm">@{names[item.member]?.handle}</p> : null}
      <time className="text-muted-foreground text-sm" dateTime={item.createdAt}>
        {date(item.createdAt, locale)}</time>
      <p dir="auto" className="whitespace-pre-wrap break-words text-sm">{item.reason}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { setSelected(item); setReason(''); setError(null); }}>{t.approve}</Button>
        <Button variant="outline" disabled title={t.declineUnavailable}>{t.decline}</Button></div>
    </li>)}</ul> : <p role="status">{search ? t.noMatch : t.empty}</p>}
    {page.nextCursor ? <Button className="w-fit" variant="outline" isLoading={busy} disabled={busy}
      onClick={() => void load(true)}>{t.more}</Button> : null}
    <CommandDialog open={selected !== null} title={t.approve} confirm={t.approve} pending={busy} error={error}
      disabled={!reason.trim()} cancel={t.cancel} onClose={() => setSelected(null)} onConfirm={() => void approve()}>
      <p dir="auto" className="break-words font-medium">{selected ? names[selected.member]?.label ?? selected.member : null}</p>
      <Field><FieldLabel>{t.reason}</FieldLabel><Textarea value={reason} maxLength={2000}
        onChange={event => setReason(event.currentTarget.value)} /></Field>
      {error === t.staleRequest ? <Button type="button" variant="outline" disabled={busy}
        onClick={() => { setSelected(null); void load(false); }}>{t.refresh}</Button> : null}
    </CommandDialog>
  </section>;
}
