'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import { labelOfType } from '../catalogue/types.ts';
import { mainRelationships, RelationshipError } from './api.ts';
import { RelationshipControl } from './control.tsx';
import { observeRelationships } from './events.ts';
import { relationshipSource } from './list.ts';
import { messages } from './messages.ts';
import type { Follow, FollowEdit, Level, Membership, Order, RelationshipsApi } from './types.ts';

/** A selection names exact targets across pages; it never means the unseen remainder of a query. */
export function FollowingManager({ locale, signedIn, actingSubject, signInHref, api: supplied }: {
  locale: UiLocale; signedIn: boolean; actingSubject?: string | null; signInHref: string; api?: RelationshipsApi;
}) {
  const t = messages[locale];
  const [view, setView] = useState<'follows' | 'memberships'>('follows');
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState<Order>('recent');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<ReadonlyMap<string, Follow>>(new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const api = useMemo(() => supplied ?? (actingSubject ? mainRelationships(actingSubject) : null), [supplied, actingSubject]);
  const source = useMemo(() => relationshipSource(async query => {
    if (!api) throw new Error('No reader');
    return api.follows({ ...query, kind: kind || undefined, order });
  }, item => item.id, item => item.name?.value ?? t.unavailableTarget), [api, kind, order, t.unavailableTarget]);
  const membershipSource = useMemo(() => relationshipSource(async query => {
    if (!api) throw new Error('No reader');
    return api.memberships({ ...query, order });
  }, item => item.membershipId, item => item.name?.value ?? t.unavailableTarget), [api, order, t.unavailableTarget]);
  const follows = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const memberships = useSyncExternalStore(membershipSource.subscribe, membershipSource.getSnapshot, membershipSource.getSnapshot);
  const current = view === 'follows' ? follows : memberships;
  const activeSource = view === 'follows' ? source : membershipSource;
  const busyRef = useRef(false);
  const retry = useRef<{ signature: string; edits: FollowEdit[]; key: string } | null>(null);
  useEffect(() => { setSelected(new Map()); retry.current = null; setNotice(null); }, [api]);
  useEffect(() => {
    if (!signedIn || !api) return;
    const timer = setTimeout(() => void activeSource.search(q), q ? 200 : 0);
    return () => { clearTimeout(timer); activeSource.cancel(); };
  }, [activeSource, api, signedIn, q]);
  useEffect(() => observeRelationships(() => {
    if (!busyRef.current) void activeSource.search(q);
  }), [activeSource, q]);

  async function bulk(edit: { following?: false; level?: Level; pinPosition?: number | null }) {
    if (!api || busy || !selected.size) return;
    const snapshot = [...selected.values()];
    setBusy(true); busyRef.current = true; setNotice(null);
    let done = 0;
    try {
      for (let offset = 0; offset < snapshot.length; offset += 20) {
        const batch = snapshot.slice(offset, offset + 20);
        const signature = JSON.stringify({ ids: batch.map(item => item.id), edit });
        const edits = batch.map((item, index) => ({ target: item.id, expectedRevision: item.revision,
          ...edit, ...(edit.pinPosition != null ? { pinPosition: offset + index } : {}) }));
        const pending = retry.current?.signature === signature ? retry.current : { signature, edits, key: crypto.randomUUID() };
        retry.current = pending;
        const receipt = await api.batch(pending.edits, pending.key);
        // A malformed or partial response is not success; preserve the intent and idempotency key for recovery.
        if (receipt.items.length !== batch.length || batch.some(item => !receipt.items.some(result => result.target === item.id)))
          throw new Error('Incomplete follow batch receipt');
        done += batch.length; retry.current = null;
        setSelected(previous => {
          const next = new Map(previous);
          for (const item of batch) next.delete(item.id);
          return next;
        });
      }
      setNotice(t.saved);
    } catch (error) {
      if (error instanceof RelationshipError && error.status === 409) {
        retry.current = null;
        // Keep every selected identity, but get its fresh revision before asking the reader to retry.
        const fresh = await Promise.all(snapshot.slice(done, done + 20).map(async item => {
          try { const state = await api.state(item.id, item.kind);
            return state.following && state.revision && state.level && state.source
              ? { ...item, revision: state.revision, level: state.level, source: state.source, pinPosition: state.pinPosition } : null;
          } catch { return item; }
        }));
        setSelected(previous => {
          const next = new Map(previous);
          snapshot.slice(done, done + 20).forEach(item => next.delete(item.id));
          fresh.forEach(item => { if (item) next.set(item.id, item); });
          return next;
        });
        setNotice(t.stale);
      } else setNotice(done ? t.partial : t.failed);
    } finally {
      busyRef.current = false; setBusy(false);
      void activeSource.search(q);
    }
  }
  if (!signedIn) return <section className="grid gap-4 p-6"><h1 className="font-semibold text-2xl">{t.followingTitle}</h1>
    <a href={signInHref} className="text-primary underline">{t.signIn}</a></section>;
  if (!api) return <p role="status" className="p-6">{t.unknown}</p>;
  const kinds = [...new Set(['space', 'agent', 'work', 'concept', 'collection', 'saved-view', 'external-author',
    ...follows.items.map(item => item.kind)])];
  return <section className="mx-auto grid w-full max-w-4xl gap-5 p-4 md:p-6" aria-labelledby="following-title">
    <h1 id="following-title" className="font-semibold text-2xl">{t.followingTitle}</h1>
    <div className="flex flex-wrap gap-2">
      <Button variant={view === 'follows' ? 'default' : 'outline'} aria-pressed={view === 'follows'} onClick={() => setView('follows')}>{t.followingTitle}</Button>
      <Button variant={view === 'memberships' ? 'default' : 'outline'} aria-pressed={view === 'memberships'} onClick={() => setView('memberships')}>{t.memberships}</Button>
    </div>
    <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <label className="grid min-w-0 gap-1 text-sm">{t.search}<Input type="search" value={q} maxLength={80}
        onChange={event => setQ(event.target.value)} /></label>
      {view === 'follows' ? <div className="grid min-w-0 gap-1 text-sm"><span>{t.type}</span>
        <ChoiceSelect label={t.type} className="min-w-0 max-w-full sm:max-w-64" value={kind} onValueChange={setKind}
          options={[{ value: '', label: t.allTypes }, ...kinds.map(value => ({ value, label: kindLabel(value, locale) }))]} />
        </div> : null}
      <div className="grid min-w-0 gap-1 text-sm"><span>{t.sort}</span><ChoiceSelect label={t.sort} className="min-w-0 max-w-full" value={order}
        onValueChange={value => setOrder(value as Order)} options={[{ value: 'recent', label: t.recent }, { value: 'pinned', label: t.pinned }]} /></div>
    </div>
    {selected.size ? <div className="grid gap-3 rounded-2xl border border-border bg-card p-4" aria-label={t.selected}>
      <div className="flex flex-wrap items-center gap-2"><p className="flex-1 text-sm">{t.selected}: {new Intl.NumberFormat(locale).format(selected.size)}</p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSelected(new Map()); retry.current = null; }}>{t.clear}</Button></div>
      <p className="text-muted-foreground text-sm">{t.bulkHelp}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk({ following: false })}>{t.bulkUnfollow}</Button>
        <div className="grid min-w-0 gap-1 text-sm"><span>{t.bulkLevel}</span><ChoiceSelect label={t.bulkLevel} disabled={busy} value="" placeholder="—"
          onValueChange={value => { if (value) void bulk({ level: value as Level }); }}
          options={[{ value: 'all', label: t.all }, { value: 'highlights', label: t.highlights }, { value: 'off', label: t.off }]} /></div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk({ pinPosition: 0 })}>{t.bulkPin}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk({ pinPosition: null })}>{t.bulkUnpin}</Button>
      </div>
    </div> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {current.error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>{t.unavailable}</span>
      <Button size="sm" variant="outline" onClick={() => void activeSource.retry()}>{t.retry}</Button></div> : null}
    <ul className="grid min-w-0 divide-y divide-border rounded-2xl border border-border bg-card">
      {view === 'follows' ? follows.items.map(item => <li key={item.id}
        className="grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-3 p-4 sm:flex sm:flex-wrap" data-follow={item.id}>
        <Checkbox aria-label={`${t.select} · ${item.label}`} checked={selected.has(item.id)} disabled={busy}
          onCheckedChange={details => setSelected(previous => { const next = new Map(previous);
            if (details.checked === true) next.set(item.id, item); else next.delete(item.id); return next; })} />
        <CommunityIcon icon={item.icon} name={item.label} person={item.kind === 'agent'} />
        <div className="min-w-0 flex-1"><ResourceName item={item} locale={locale} fallback={t.unavailableTarget} />
          <p className="break-words text-muted-foreground text-xs">{kindLabel(item.kind, locale)}</p></div>
        <RelationshipControl target={item.id} kind={item.kind} name={item.label} locale={locale} signedIn actingSubject={actingSubject}
          signInHref={signInHref} api={api} realm={item.realm}
          className="col-span-3 ms-auto sm:col-auto sm:ms-0"
          initial={{ following: true, revision: item.revision, level: item.level, source: item.source, pinPosition: item.pinPosition }} />
        {item.pinPosition !== null ? <label className="col-span-3 flex items-center gap-2 text-xs sm:col-auto">{t.pinOrder}<Input type="number" min={1} max={10000}
          className="w-20" defaultValue={item.pinPosition + 1} aria-label={`${t.pinOrder} · ${item.label}`} disabled={busy}
          onBlur={event => {
            const value = Number(event.target.value) - 1;
            if (event.target.value === '' || !Number.isInteger(value) || value < 0 || value > 9999) {
              event.target.value = String(item.pinPosition! + 1); return;
            }
            if (value === item.pinPosition) return;
            void api.batch([{ target: item.id, expectedRevision: item.revision, pinPosition: value }])
              .catch(error => {
                setNotice(error instanceof RelationshipError && error.status === 409 ? t.stale : t.failed);
                if (error instanceof RelationshipError && error.status === 409) void source.search(q);
              });
          }} /></label> : null}
      </li>) : memberships.items.map(item => <MembershipRow key={item.membershipId} item={item} locale={locale} api={api}
        actingSubject={actingSubject} signInHref={signInHref} refresh={() => void membershipSource.search(q)} />)}
    </ul>
    {!current.items.length && !current.loading && !current.error && current.complete
      ? <p className="text-muted-foreground text-sm">{q || kind || view === 'memberships' ? t.noResults : t.empty}</p> : null}
    {current.loading ? <p role="status" className="text-muted-foreground text-sm">{t.loading}</p> : null}
    {!current.complete && current.nextCursor && !current.error ? <Button variant="outline" disabled={current.loading}
      onClick={() => void activeSource.more()}>{t.more}</Button> : null}
  </section>;
}

function ResourceName({ item, locale, fallback }: { item: Follow; locale: UiLocale; fallback: string }) {
  const text = <span lang={item.name?.language} dir={item.name?.direction} className="break-words">{item.name?.value ?? fallback}</span>;
  return item.available && item.href ? <a href={localizedPath(item.href, locale)} className="font-medium hover:underline">{text}</a> : text;
}

function MembershipRow({ item, locale, api, actingSubject, signInHref, refresh }: {
  item: Membership; locale: UiLocale; api: RelationshipsApi; actingSubject?: string | null; signInHref: string; refresh: () => void;
}) {
  const t = messages[locale];
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return <li className="grid gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
    <div className="min-w-0"><a href={localizedPath(spaceHref(item.space ?? item.realm, 'community'), locale)} className="break-words font-medium hover:underline"
      lang={item.name?.language} dir={item.name?.direction}>{item.name?.value ?? t.unavailableTarget}</a>
      <p className="text-muted-foreground text-xs">{t.joined}{item.level ? ` · ${t[item.level]}` : ''}</p></div>
    <RelationshipControl target={item.space ?? item.realm} kind="space" realm={item.realm}
      name={item.name?.value ?? t.unavailableTarget} locale={locale} signedIn actingSubject={actingSubject}
      signInHref={signInHref} api={api} initial={null} membership={{ joined: true, leave: api.canLeave ? () => {
      if (busy) return;
      if (!window.confirm(`${t.confirmLeave}\n${t.leaveHelp}`)) return;
      setBusy(true); setNotice(null);
      void api.leave(item.realm, item.generation).catch(error => {
        setNotice(error instanceof RelationshipError && error.status === 409 ? t.stale : t.failed);
        if (error instanceof RelationshipError && error.status === 409) refresh();
      })
        .finally(() => setBusy(false));
    } : undefined }} />
    {!api.canLeave ? <p role="status" className="text-muted-foreground text-xs">{t.leaveUnavailable}</p> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
  </li>;
}

export function kindLabel(kind: string, locale: UiLocale): string {
  // Unknown admitted types remain selectable; the API owns kind classification.
  const t = messages[locale];
  const labels: Record<string, string> = { space: t.communities, agent: t.people, work: t.works,
    concept: t.concepts, collection: t.collections, 'saved-view': t.savedViews, 'external-author': t.catalogueAuthors };
  return labels[kind] ?? labelOfType(kind, locale, 'other') ?? kind;
}
