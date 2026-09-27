'use client';

import { Alert, AlertAction, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { NativeSelect } from '@rezics/ui/native-select';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/table';
import { toast } from '@rezics/ui/toast';
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, DownloadIcon, FilterIcon, XIcon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AccountErrorCode, AuditEntry, AuditPage } from '../api/types.ts';
import { errorMessage } from '../actions/confirm.tsx';
import { exactTime, Time } from '../format.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { Actor, actionLabel, OutcomeBadge, reasonLabel, Target } from './entry.tsx';
import { type AuditState, auditHref, auditParams, changes, filtered, knownActions, type Outcome, type Range, ranges } from './state.ts';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

export type AuditRead = { status: 'ok'; data: AuditPage } | { status: 'error'; code: AccountErrorCode | 'network' };
const cell = 'px-3 py-2.5 align-top group-data-[density=compact]/admin:py-1';
const show = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);

/** Every staff action, newest first, filtered by period, action, outcome,
 * actor and target (all in the URL), with its before/after and a CSV export. */
export function AuditExplorer({ initialState, initial, names }: { initialState: AuditState; initial: AuditRead;
  /** Display names for the actor and target filters, when the page knows them. */
  names: { actor: string | null; target: string | null } }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const { api, replaceUrl, download } = useAdminClient();
  const [state, setState] = useState(initialState);
  const [read, setRead] = useState<AuditRead>(initial);
  const [items, setItems] = useState<AuditEntry[]>(initial.status === 'ok' ? initial.data.items : []);
  const [cursor, setCursor] = useState(initial.status === 'ok' ? initial.data.nextCursor : null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [labels, setLabels] = useState(names);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    let current = true;
    setLoading(true);
    void api.audit(auditParams(state)).then(result => {
      if (!current) return;
      setLoading(false);
      setRead(result.ok ? { status: 'ok', data: result.data } : { status: 'error', code: result.code });
      if (result.ok) { setItems(result.data.items); setCursor(result.data.nextCursor); setOpen(new Set()); }
    });
    return () => { current = false; };
  }, [api, state]);
  const update = (change: Partial<AuditState>) => {
    const next = { ...state, ...change };
    setState(next);
    replaceUrl(auditHref(next));
  };
  async function more() {
    if (!cursor) return;
    setLoading(true);
    const result = await api.audit({ ...auditParams(state), cursor });
    setLoading(false);
    if (result.ok) { setItems(current => [...current, ...result.data.items]); setCursor(result.data.nextCursor); }
    else toast.error({ title: errorMessage(result, t) });
  }
  async function exportCsv() {
    setExporting(true);
    const { limit: _limit, ...params } = auditParams(state);
    const result = await api.exportAudit(params);
    setExporting(false);
    if (!result.ok) { toast.error({ title: errorMessage(result, t) }); return; }
    download(result.data.blob, `rezics-account-audit-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success({ title: result.data.truncated ? t.exportTruncated({ value: result.data.rows }) : t.exported(result.data.rows) });
  }
  const toggle = (id: string) => setOpen(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const actions = [...new Set([...knownActions, ...(state.action ? [state.action] : [])])];
  return <>
    <PageHeading title={t.audit} intro={t.auditIntro} actions={<Button variant="outline" isLoading={exporting} onClick={() => void exportCsv()}>
      <DownloadIcon aria-hidden="true" />{exporting ? t.exporting : t.exportCsv}</Button>} />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field className="w-auto"><FieldLabel>{t.range}</FieldLabel>
        <NativeSelect value={state.range} onChange={event => update({ range: event.currentTarget.value as Range })}>
          {ranges.map(range => <option key={range} value={range}>{t.ranges[range]}</option>)}</NativeSelect></Field>
      <Field className="w-auto"><FieldLabel>{t.action}</FieldLabel>
        <NativeSelect value={state.action ?? ''} onChange={event => update({ action: event.currentTarget.value || null })}>
          <option value="">{t.anyAction}</option>
          {actions.map(action => <option key={action} value={action}>{actionLabel(action, t)}</option>)}</NativeSelect></Field>
      <Field className="w-auto"><FieldLabel>{t.outcome}</FieldLabel>
        <NativeSelect value={state.outcome ?? ''} onChange={event => update({ outcome: (event.currentTarget.value || null) as Outcome | null })}>
          <option value="">{t.anyOutcome}</option>
          {(['succeeded', 'failed', 'attempted'] as const).map(outcome => <option key={outcome} value={outcome}>{t.outcomes[outcome]}</option>)}
        </NativeSelect></Field>
      {state.actor ? <FilterChip label={`${t.actor}: ${labels.actor ?? state.actor}`} remove={t.removeActor}
        onRemove={() => update({ actor: null })} /> : null}
      {state.target ? <FilterChip label={`${t.target}: ${labels.target ?? state.target}`} remove={t.removeTarget}
        onRemove={() => update({ target: null })} /> : null}
    </div>
    {read.status === 'error' ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{t.errorLine({ code: read.code })}</AlertDescription>
      <AlertAction><Button size="sm" variant="outline" onClick={() => update({})}>{t.retry}</Button></AlertAction></Alert>
      : !items.length ? <p className="rounded-3xl border border-dashed border-border px-6 py-14 text-center text-muted-foreground">
        {filtered(state) ? t.auditNoMatch : t.auditEmpty}</p>
        : <Table aria-busy={loading} className={loading ? 'min-w-[56rem] opacity-60' : 'min-w-[56rem]'}>
          <TableCaption className="sr-only">{t.auditTable}</TableCaption>
          <TableHeader><TableRow>
            <TableHead scope="col" className="w-10 px-3"><span className="sr-only">{t.details}</span></TableHead>
            <TableHead scope="col" className="px-3">{t.when}</TableHead>
            <TableHead scope="col" className="px-3">{t.actor}</TableHead>
            <TableHead scope="col" className="px-3">{t.action}</TableHead>
            <TableHead scope="col" className="px-3">{t.target}</TableHead>
            <TableHead scope="col" className="px-3">{t.user.reason}</TableHead>
            <TableHead scope="col" className="px-3">{t.outcome}</TableHead>
          </TableRow></TableHeader>
          <TableBody>{items.map(entry => {
            const expanded = open.has(entry.id);
            const diff = changes(entry.before, entry.after);
            return <Fragment key={entry.id}>
              <TableRow>
                <TableCell className={cell}><Button variant="ghost" size="icon-sm" aria-expanded={expanded} aria-controls={`audit-${entry.id}`}
                  aria-label={expanded ? t.hideDetails : t.details} onClick={() => toggle(entry.id)}>
                  {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}</Button></TableCell>
                <TableCell className={`${cell} text-muted-foreground`}><Time iso={entry.occurredAt} /></TableCell>
                <TableCell className={cell}><Actor entry={entry} /></TableCell>
                <TableCell className={cell}>{actionLabel(entry.action, t)}</TableCell>
                <TableCell className={`${cell} max-w-56 truncate`}><Target entry={entry} /></TableCell>
                <TableCell className={`${cell} max-w-72 whitespace-normal`}>
                  {entry.reasonCode ? <Badge variant="outline" size="sm" className="me-1.5">{reasonLabel(entry.reasonCode, t)}</Badge> : null}
                  <span className="line-clamp-2 text-muted-foreground">{entry.reason}</span></TableCell>
                <TableCell className={cell}><OutcomeBadge outcome={entry.outcome} /></TableCell>
              </TableRow>
              {expanded ? <TableRow id={`audit-${entry.id}`} className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={7} className="px-6 py-4 whitespace-normal">
                  <div className="flex flex-col gap-3 text-sm">
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                      <span>{exactTime(entry.occurredAt, locale)}</span>
                      <span className="font-mono text-xs">{t.requestId({ id: entry.requestId })}</span></p>
                    {entry.userMessage ? <p><span className="font-medium">{t.user.messageToUser}: </span>{entry.userMessage}</p> : null}
                    <div><p className="mb-1 font-medium">{t.changes}</p>
                      {diff.length ? <table className="text-xs"><thead><tr className="text-muted-foreground">
                        <th scope="col" className="pe-6 text-start font-normal"> </th><th scope="col" className="pe-6 text-start font-normal">{t.before}</th>
                        <th scope="col" className="text-start font-normal">{t.after}</th></tr></thead>
                        <tbody>{diff.map(change => <tr key={change.key}>
                          <th scope="row" className="pe-6 text-start font-mono font-normal">{change.key}</th>
                          <td className="pe-6 font-mono text-destructive-foreground line-through decoration-1">{show(change.before)}</td>
                          <td className="font-mono text-success-foreground">{show(change.after)}</td></tr>)}</tbody></table>
                        : <p className="text-muted-foreground">{t.noChanges}</p>}</div>
                    <p className="flex flex-wrap gap-2">
                      <Button size="xs" variant="outline" onClick={() => { setLabels(current => ({ ...current,
                        actor: entry.actorName || entry.actorEmail })); update({ actor: entry.actorId }); }}>
                        <FilterIcon aria-hidden="true" />{t.filterByActor({ name: entry.actorName || entry.actorEmail || entry.actorId })}</Button>
                      <Button size="xs" variant="outline" onClick={() => { setLabels(current => ({ ...current,
                        target: entry.targetName || entry.targetEmail })); update({ target: entry.targetId }); }}>
                        <FilterIcon aria-hidden="true" />{t.filterByTarget({ name: entry.targetName || entry.targetEmail || entry.targetId })}</Button>
                    </p>
                  </div>
                </TableCell>
              </TableRow> : null}
            </Fragment>;
          })}</TableBody>
        </Table>}
    {cursor && read.status === 'ok' ? <div className="mt-4 flex justify-center">
      <Button variant="outline" isLoading={loading} onClick={() => void more()}>{t.loadMore}</Button></div> : null}
  </>;
}

function FilterChip({ label, remove, onRemove }: { label: string; remove: string; onRemove(): void }) {
  return <span className="inline-flex h-9 items-center gap-1 rounded-full border border-primary/25 bg-primary/8 ps-3 pe-1 text-sm text-primary">
    {label}<Button variant="ghost" size="icon-xs" className="rounded-full" aria-label={remove} onClick={onRemove}><XIcon aria-hidden="true" /></Button></span>;
}
