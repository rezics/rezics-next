'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader } from '@rezics/ui/alert-dialog';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { CircleCheckIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMaintainers, type MaintainerChangeResult, type MaintainerRoster, type MaintainerSource } from './api.ts';
import { type MaintainerCopy, copyOf } from './messages.ts';
import { maintainerChangeKey, maintainerDetail, maintainerProblem, maintainerRows, maintainerTarget, showAdd, type MaintainerRow } from './rules.ts';

export interface MaintainerNotice {
  kind: 'saved' | 'stale' | 'continuity' | 'denied' | 'sign-in' | 'invalid' | 'unavailable';
  replayed?: boolean;
  detail?: string | null;
}

/** The list, the add field and the confirm step. `rows` already carry who may see Remove. */
export function MaintainerPanel({ rows, canAdd, draft, fieldError, notice, pending, confirming, reloading, t,
  onDraft, onAdd, onAskRemove, onConfirmRemove, onCancelRemove, onReload }: {
  rows: readonly MaintainerRow[];
  canAdd: boolean;
  draft: string;
  fieldError: string | null;
  notice: MaintainerNotice | null;
  pending: 'add' | 'remove' | null;
  confirming: MaintainerRow | null;
  reloading: boolean;
  t: MaintainerCopy;
  onDraft: (value: string) => void;
  onAdd: () => void;
  onAskRemove: (id: string) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onReload: () => void;
}) {
  const headingId = useId();
  const submit = (event: FormEvent) => { event.preventDefault(); onAdd(); };
  return <section aria-labelledby={headingId} className="grid min-w-0 content-start gap-3">
    <div className="grid gap-1">
      <h3 id={headingId} className="font-semibold">{t.heading}</h3>
      <p className="text-pretty text-muted-foreground text-sm">{t.help}</p>
    </div>
    <MaintainerNoticeView notice={notice} t={t} onReload={onReload} reloading={reloading} />
    <ul className="grid gap-2">{rows.map(row => <li key={row.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-border/60 bg-card px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium">{row.name}</span>
        {row.handle ? <span className="block break-all text-muted-foreground text-sm">@{row.handle}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {row.owner ? <Badge variant="secondary">{t.owner}</Badge> : null}
        {row.remove ? <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11"
          aria-label={t.removeNamed({ name: row.name })} disabled={pending !== null}
          onClick={() => onAskRemove(row.id)}>{t.remove}</Button> : null}
      </span>
    </li>)}</ul>
    {canAdd ? <form onSubmit={submit} className="grid gap-2">
      <Field invalid={fieldError !== null}>
        <FieldLabel>{t.addLabel}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={draft} onChange={event => onDraft(event.target.value)} name="maintainer" autoComplete="off"
            className="min-w-0 flex-1 basis-48" disabled={pending !== null} />
          <Button type="submit" size="sm" className="pointer-coarse:h-11" disabled={pending !== null}
            isLoading={pending === 'add'}>{t.add}</Button>
        </div>
        <FieldHelper>{t.addHelp}</FieldHelper>
        {fieldError ? <FieldError>{fieldError}</FieldError> : null}
      </Field>
    </form> : null}
    {confirming ? <AlertDialog open onOpenChange={details => { if (!details.open) onCancelRemove(); }} pending={pending === 'remove'}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader title={t.confirmTitle({ name: confirming.name })} description={t.confirmBody({ name: confirming.name })} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending === 'remove'}>{t.cancel}</AlertDialogCancel>
          <Button variant="destructive" disabled={pending === 'remove'} isLoading={pending === 'remove'}
            onClick={onConfirmRemove}>{t.confirm}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog> : null}
  </section>;
}

function MaintainerNoticeView({ notice, t, onReload, reloading }: {
  notice: MaintainerNotice | null; t: MaintainerCopy; onReload: () => void; reloading: boolean;
}) {
  if (!notice) return null;
  if (notice.kind === 'saved') {
    return <Alert variant="success" role="status"><CircleCheckIcon aria-hidden="true" />
      <AlertDescription>{notice.replayed ? t.savedReplayed : t.saved}</AlertDescription></Alert>;
  }
  const title = { stale: t.conflictTitle, continuity: t.continuityTitle, denied: t.deniedTitle, 'sign-in': t.signInTitle,
    invalid: t.invalidTitle, unavailable: t.unavailableTitle }[notice.kind];
  const body = notice.kind === 'stale' ? t.conflictBody
    : notice.kind === 'continuity' ? t.continuityBody
      : notice.kind === 'denied' ? t.deniedBody
        : notice.kind === 'unavailable' ? t.unavailableBody : null;
  return <Alert variant="destructive" role="alert"><TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="grid gap-2">
      {body ? <span>{body}</span> : null}
      {notice.detail ? <span><span className="font-medium">{t.mainSays}:</span> {notice.detail}</span> : null}
      {notice.kind === 'stale' ? <Button type="button" variant="outline" size="sm" className="w-fit"
        onClick={onReload} isLoading={reloading} disabled={reloading}>
        <RefreshCwIcon aria-hidden="true" />{t.reload}</Button> : null}
    </AlertDescription></Alert>;
}

function noticeOf(result: MaintainerChangeResult): MaintainerNotice {
  if ((result.status === 200 || result.status === 201) && result.roster) return { kind: 'saved', replayed: result.replayed };
  const kind = maintainerProblem(result.status, result.code);
  return { kind, detail: maintainerDetail(result.title) };
}

/** Maintainers of one Work, for the Studio details tab of the identity that is editing. */
export function WorkMaintainers({ work, actingSubject, locale, source }: {
  work: string; actingSubject: string; locale: UiLocale; source?: MaintainerSource;
}) {
  const t = useMemo(() => copyOf(locale), [locale]);
  const [fallback] = useState(() => source ?? browserMaintainers(actingSubject));
  const client = source ?? fallback;
  const [roster, setRoster] = useState<MaintainerRoster | null>(null);
  const [names, setNames] = useState<Readonly<Record<string, { displayName: string; handle: string | null }>>>({});
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MaintainerNotice | null>(null);
  const [pending, setPending] = useState<'add' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const headingId = useId();

  useEffect(() => {
    let stop = false;
    void (async () => {
      const read = await client.read(work);
      if (stop) return;
      if (!read) { setLoad('failed'); return; }
      setRoster(read);
      setLoad('ready');
      const named = await client.names(read.maintainers);
      if (!stop) setNames(named);
    })();
    return () => { stop = true; };
  }, [attempt, client, work]);

  const rows = roster ? maintainerRows({ viewer: actingSubject, owner: roster.owner, maintainers: roster.maintainers, names }) : [];
  const confirmingRow = rows.find(row => row.id === confirming) ?? null;

  async function reload() {
    setReloading(true);
    const read = await client.read(work);
    setReloading(false);
    if (!read) { setLoad('failed'); return; }
    setRoster(read);
    setLoad('ready');
    setNotice(null);
    setNames(await client.names(read.maintainers));
  }

  function applied(result: MaintainerChangeResult, extra?: { id: string; name: { displayName: string; handle: string | null } }) {
    const next = noticeOf(result);
    if (next.kind === 'saved' && result.roster) {
      setRoster(result.roster);
      setDraft('');
      setFieldError(null);
      if (extra) setNames(current => ({ ...current, [extra.id]: extra.name }));
      void client.names(result.roster.maintainers).then(setNames);
    }
    setConfirming(null);
    setNotice(next);
    setPending(null);
  }

  async function add() {
    const current = rosterRef.current;
    if (!current || pending) return;
    const parsed = maintainerTarget(draft);
    if (parsed.kind === 'invalid') { setFieldError(draft.trim() ? t.badTarget : t.emptyQuery); return; }
    setPending('add');
    setFieldError(null);
    setNotice(null);
    const resolved = await client.resolve(draft);
    if (!resolved) { setFieldError(t.notFound); setPending(null); return; }
    if (resolved.id === actingSubject) { setFieldError(t.self); setPending(null); return; }
    if (current.maintainers.includes(resolved.id)) {
      setFieldError(t.already({ name: resolved.name.displayName.trim() || resolved.name.handle || resolved.id }));
      setPending(null);
      return;
    }
    const key = await maintainerChangeKey([current.work, actingSubject, resolved.id, 'add', current.generation]);
    applied(await client.change({ work: current.work, actingSubject, target: resolved.id, action: 'add',
      expectedGeneration: current.generation, key }), resolved);
  }

  async function confirmRemove() {
    const current = rosterRef.current;
    if (!current || !confirming || pending) return;
    setPending('remove');
    setNotice(null);
    const key = await maintainerChangeKey([current.work, actingSubject, confirming, 'remove', current.generation]);
    applied(await client.change({ work: current.work, actingSubject, target: confirming, action: 'remove',
      expectedGeneration: current.generation, key }));
  }

  if (load === 'loading') {
    return <section aria-labelledby={headingId} aria-busy="true" className="grid gap-1">
      <h3 id={headingId} className="font-semibold">{t.heading}</h3>
      <p role="status" className="text-muted-foreground text-sm">{t.loading}</p>
    </section>;
  }
  if (load === 'failed' || !roster) {
    return <section aria-labelledby={headingId} className="grid gap-3">
      <h3 id={headingId} className="font-semibold">{t.heading}</h3>
      <Alert variant="warning" role="alert"><TriangleAlertIcon aria-hidden="true" />
        <AlertDescription>{t.loadFailed}</AlertDescription></Alert>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => { setLoad('loading'); setAttempt(value => value + 1); }}>{t.retry}</Button>
    </section>;
  }
  return <MaintainerPanel rows={rows} canAdd={showAdd(actingSubject, roster.maintainers)} draft={draft} fieldError={fieldError}
    notice={notice} pending={pending} confirming={confirmingRow} reloading={reloading} t={t}
    onDraft={value => { setDraft(value); setFieldError(null); }} onAdd={() => void add()}
    onAskRemove={setConfirming} onConfirmRemove={() => void confirmRemove()}
    onCancelRemove={() => { if (pending !== 'remove') setConfirming(null); }} onReload={() => void reload()} />;
}
