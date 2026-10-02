'use client';

import { Alert, AlertAction, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Kbd } from '@rezics/ui/kbd';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { ChoiceSelect } from '@rezics/ui/select';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/table';
import { toast } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, DownloadIcon, FilterIcon, LinkIcon, SearchIcon, XIcon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AccountErrorCode, AuditEntry, AuditExportFormat, AuditPage, ReasonCode } from '../api/types.ts';
import { errorMessage } from '../actions/confirm.tsx';
import { exactTime, Time } from '../format.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { usePageKeys } from '../shell/keys.ts';
import { useNarrow } from '../shell/media.ts';
import { Actor, actionLabel, OutcomeBadge, reasonLabel, Target } from './entry.tsx';
import { type AuditState, auditHref, auditParams, changes, filtered, knownActions, type Outcome, parseAuditSearch, type Range,
  ranges, reasonCodes } from './state.ts';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

export type AuditRead = { status: 'ok'; data: AuditPage } | { status: 'error'; code: AccountErrorCode | 'network' };
const cell = 'px-3 py-2.5 align-top group-data-[density=compact]/admin:py-1';
const show = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
const utcDay = (iso: string) => iso.slice(0, 10);

/** The search box's current filters written back as text, for editing. */
const searchText = (state: AuditState) => [state.actor ? `actor:${/\s/.test(state.actor) ? `"${state.actor}"` : state.actor}` : '',
  state.target ? `target:${/\s/.test(state.target) ? `"${state.target}"` : state.target}` : '', state.request ?? '', state.text ?? '']
  .filter(Boolean).join(' ');

/** A record's detail: exact time, request, message, what changed and where to go from it. */
function EntryDetail({ entry, onFilter }: { entry: AuditEntry; onFilter(change: Partial<AuditState>, label: string): void }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const diff = changes(entry.before, entry.after);
  const permalink = () => {
    const url = new URL(auditHref({ range: 'all', from: null, to: null, action: null, outcome: null, reason: null, actor: null,
      target: null, request: entry.requestId, text: null }), window.location.origin);
    void navigator.clipboard.writeText(url.toString()).then(() => toast.success({ title: t.auditSearch.linkCopied }), () => {});
  };
  return <div className="flex flex-col gap-3 text-sm">
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
      <span>{exactTime(entry.occurredAt, locale)}</span>
      <span className="font-mono text-xs">{t.requestId({ id: entry.requestId })}</span>
      <Button size="xs" variant="ghost" onClick={permalink}><LinkIcon aria-hidden="true" />{t.auditSearch.copyLink}</Button></p>
    {entry.reason ? <p className="whitespace-pre-wrap">{entry.reason}</p> : null}
    {entry.userMessage ? <p><span className="font-medium">{t.user.messageToUser}: </span>{entry.userMessage}</p> : null}
    <div><p className="mb-1 font-medium">{t.changes}</p>
      {diff.length ? <table className="text-xs"><thead><tr className="text-muted-foreground">
        <th scope="col" className="pe-6 text-start font-normal"><span className="sr-only">{t.changes}</span></th>
        <th scope="col" className="pe-6 text-start font-normal">{t.before}</th>
        <th scope="col" className="text-start font-normal">{t.after}</th></tr></thead>
        <tbody>{diff.map(change => <tr key={change.key}>
          <th scope="row" className="pe-6 text-start font-mono font-normal">{change.key}</th>
          <td className="pe-6 font-mono break-all text-destructive-foreground line-through decoration-1">{show(change.before)}</td>
          <td className="font-mono break-all text-success-foreground">{show(change.after)}</td></tr>)}</tbody></table>
        : <p className="text-muted-foreground">{t.noChanges}</p>}</div>
    <p className="flex flex-wrap gap-2">
      <Button size="xs" variant="outline" onClick={() => onFilter({ actor: entry.actorId }, entry.actorName || entry.actorEmail || entry.actorId)}>
        <FilterIcon aria-hidden="true" />{t.filterByActor({ name: entry.actorName || entry.actorEmail || entry.actorId })}</Button>
      <Button size="xs" variant="outline" onClick={() => onFilter({ target: entry.targetId }, entry.targetName || entry.targetEmail || entry.targetId)}>
        <FilterIcon aria-hidden="true" />{t.filterByTarget({ name: entry.targetName || entry.targetEmail || entry.targetId })}</Button>
    </p>
  </div>;
}

/** Every staff action, newest first and grouped by day: filtered by period
 * (relative or custom UTC dates), action, outcome, reason, who, what, a
 * request ID or words in the reason, all in the URL; each with its
 * before/after and a link; exported as CSV or JSON Lines. */
export function AuditExplorer({ initialState, initial, names }: { initialState: AuditState; initial: AuditRead;
  /** Display names for the actor and target filters, when the page knows them. */
  names: { actor: string | null; target: string | null } }) {
  const { t } = useTranslation('admin');
  const { api, replaceUrl, download } = useAdminClient();
  const [state, setState] = useState(initialState);
  const [draft, setDraft] = useState(searchText(initialState));
  const [read, setRead] = useState<AuditRead>(initial);
  const [items, setItems] = useState<AuditEntry[]>(initial.status === 'ok' ? initial.data.items : []);
  const [cursor, setCursor] = useState(initial.status === 'ok' ? initial.data.nextCursor : null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initialState.request && initial.status === 'ok'
    ? initial.data.items.map(item => item.id) : []));
  const [labels, setLabels] = useState(names);
  const [active, setActive] = useState(-1);
  const [composing, setComposing] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    let current = true;
    setLoading(true);
    void api.audit(auditParams(state)).then(result => {
      if (!current) return;
      setLoading(false); setActive(-1);
      setRead(result.ok ? { status: 'ok', data: result.data } : { status: 'error', code: result.code });
      if (result.ok) {
        setItems(result.data.items); setCursor(result.data.nextCursor);
        setOpen(new Set(state.request ? result.data.items.map(item => item.id) : []));
      }
    });
    return () => { current = false; };
  }, [api, state, reload]);
  const update = (change: Partial<AuditState>) => {
    const next = { ...state, ...change };
    setState(next);
    setDraft(searchText(next));
    replaceUrl(auditHref(next));
  };
  const applySearch = (text: string) => update(parseAuditSearch(text));
  // Typing waits for a pause (never mid-composition); Enter searches at once.
  useEffect(() => {
    const parsed = parseAuditSearch(draft);
    if (composing || (['actor', 'target', 'request', 'text'] as const).every(key => parsed[key] === state[key])) return;
    const timer = setTimeout(() => {
      const next = { ...state, ...parsed };
      setState(next);
      replaceUrl(auditHref(next));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, state, composing, replaceUrl]);
  async function more() {
    if (!cursor) return;
    setLoading(true);
    const result = await api.audit({ ...auditParams(state), cursor });
    setLoading(false);
    if (result.ok) { setItems(current => [...current, ...result.data.items]); setCursor(result.data.nextCursor); }
    else toast.error({ title: errorMessage(result, t) });
  }
  async function exportLog(format: AuditExportFormat) {
    setExporting(true);
    const { limit: _limit, ...params } = auditParams(state);
    const result = await api.exportAudit(params, format);
    setExporting(false);
    if (!result.ok) { toast.error({ title: errorMessage(result, t) }); return; }
    download(result.data.blob, `rezics-account-audit-${new Date().toISOString().slice(0, 10)}.${format}`);
    toast.success({ title: result.data.truncated ? t.exportTruncated({ value: result.data.rows }) : t.exported(result.data.rows) });
  }
  const toggle = (id: string) => setOpen(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const filterBy = (change: Partial<AuditState>, label: string) => {
    setLabels(current => ({ ...current, ...(change.actor ? { actor: label } : {}), ...(change.target ? { target: label } : {}) }));
    update(change);
  };
  const focusRow = (index: number) => {
    setActive(index);
    document.querySelector<HTMLElement>(`[data-audit-row="${index}"]`)?.focus();
  };
  usePageKeys(event => {
    if (!items.length) return false;
    if (event.key === 'j') { focusRow(Math.min(items.length - 1, active + 1)); return true; }
    if (event.key === 'k') { focusRow(Math.max(0, active - 1)); return true; }
    return false;
  });
  const actions = [...new Set([...knownActions, ...(state.action ? [state.action] : [])])];
  const chips = [
    state.actor ? { label: `${t.actor}: ${labels.actor ?? state.actor}`, remove: t.removeActor, change: { actor: null } } : null,
    state.target ? { label: `${t.target}: ${labels.target ?? state.target}`, remove: t.removeTarget, change: { target: null } } : null,
    state.request ? { label: t.auditSearch.requestChip({ id: state.request.slice(0, 8) }), remove: t.auditSearch.removeRequest,
      change: { request: null } } : null,
  ].filter(chip => chip !== null);
  // Newest first, one heading per UTC day (as the service's records are kept).
  const days = items.reduce<{ day: string; entries: { entry: AuditEntry; index: number }[] }[]>((groups, entry, index) => {
    const key = utcDay(entry.occurredAt);
    if (groups.at(-1)?.day === key) groups.at(-1)!.entries.push({ entry, index }); else groups.push({ day: key, entries: [{ entry, index }] });
    return groups;
  }, []);
  const locale = useLocale().current;
  const phone = useNarrow(767);
  const dayLabel = (key: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${key}T00:00:00Z`));
  return <>
    <PageHeading title={t.audit} intro={t.auditIntro} actions={<Menu positioning={{ placement: 'bottom-end' }}
      onSelect={({ value }) => void exportLog(value as AuditExportFormat)}>
      <MenuTrigger asChild><Button variant="outline" isLoading={exporting}><DownloadIcon aria-hidden="true" />
        {exporting ? t.exporting : t.auditSearch.export}</Button></MenuTrigger>
      <MenuContent className="min-w-60">
        <MenuItem value="csv">{t.exportCsv}</MenuItem>
        <MenuItem value="jsonl">{t.auditSearch.exportJsonl}</MenuItem>
      </MenuContent>
    </Menu>} />
    <div className="mb-4 flex flex-col gap-3">
      <div className="relative">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input ref={search} id="admin-search" type="search" role="searchbox" aria-label={t.auditSearch.label} value={draft}
          placeholder={t.auditSearch.placeholder} autoComplete="off" spellCheck={false} autoCapitalize="none" enterKeyHint="search" maxLength={400}
          aria-describedby="audit-search-help"
          className="h-10 w-full rounded-xl border border-border/80 bg-primary/5 ps-10 pe-12 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/64 hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 md:text-sm [&::-webkit-search-cancel-button]:hidden"
          onChange={event => setDraft(event.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={event => { setComposing(false); setDraft(event.currentTarget.value); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || composing) return;
            if (event.key === 'Enter') { event.preventDefault(); applySearch(draft); }
            if (event.key === 'Escape' && draft) { event.preventDefault(); applySearch(''); }
          }} />
        <span className="absolute end-1.5 top-1/2 -translate-y-1/2">{draft ? <Button variant="ghost" size="icon-sm" aria-label={t.search.clear}
          onClick={() => { applySearch(''); search.current?.focus(); }}><XIcon aria-hidden="true" /></Button>
          : <Kbd aria-hidden="true" className="me-1.5 max-md:hidden">/</Kbd>}</span>
      </div>
      <p id="audit-search-help" className="sr-only">{t.auditSearch.help}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto"><FieldLabel>{t.range}</FieldLabel>
          <ChoiceSelect label={t.range} value={state.range} onValueChange={value => {
            const range = value as Range;
            update(range === 'custom' ? { range, from: state.from ?? utcDay(new Date(Date.now() - 7 * 86_400_000).toISOString()),
              to: state.to ?? utcDay(new Date().toISOString()) } : { range, from: null, to: null });
          }} options={ranges.map(range => ({ value: range, label: range === 'custom' ? t.auditSearch.custom : t.ranges[range] }))} /></Field>
        {state.range === 'custom' ? <>
          <Field className="w-auto"><FieldLabel>{t.auditSearch.from}</FieldLabel>
            <Input type="date" value={state.from ?? ''} max={state.to ?? undefined} onChange={event => update({ from: event.currentTarget.value || null })} /></Field>
          <Field className="w-auto"><FieldLabel>{t.auditSearch.to}</FieldLabel>
            <Input type="date" value={state.to ?? ''} min={state.from ?? undefined} onChange={event => update({ to: event.currentTarget.value || null })} /></Field>
        </> : null}
        <Field className="w-auto"><FieldLabel>{t.action}</FieldLabel>
          <ChoiceSelect label={t.action} value={state.action ?? ''} onValueChange={value => update({ action: value || null })}
            options={[{ value: '', label: t.anyAction }, ...actions.map(action => ({ value: action, label: actionLabel(action, t) }))]} /></Field>
        <Field className="w-auto"><FieldLabel>{t.outcome}</FieldLabel>
          <ChoiceSelect label={t.outcome} value={state.outcome ?? ''} onValueChange={value => update({ outcome: (value || null) as Outcome | null })}
            options={[{ value: '', label: t.anyOutcome }, ...(['succeeded', 'failed', 'attempted'] as const).map(outcome => ({ value: outcome, label: t.outcomes[outcome] }))]} /></Field>
        <Field className="w-auto"><FieldLabel>{t.reasonCode}</FieldLabel>
          <ChoiceSelect label={t.reasonCode} value={state.reason ?? ''} onValueChange={value => update({ reason: (value || null) as ReasonCode | null })}
            options={[{ value: '', label: t.auditSearch.anyReason }, ...reasonCodes.map(code => ({ value: code, label: t.reasonCodes[code] }))]} /></Field>
      </div>
      {chips.length ? <ul aria-label={t.auditSearch.filters} className="flex flex-wrap gap-1.5">{chips.map(chip => <li key={chip.remove}>
        <span className="inline-flex h-8 items-center gap-1 rounded-full border border-primary/25 bg-primary/8 ps-3 pe-1 text-sm text-primary">
          {chip.label}<Button variant="ghost" size="icon-xs" className="rounded-full" aria-label={chip.remove} onClick={() => update(chip.change)}>
            <XIcon aria-hidden="true" /></Button></span></li>)}</ul> : null}
    </div>
    {read.status === 'error' ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{t.errorLine({ code: read.code })}</AlertDescription>
      <AlertAction><Button size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>{t.retry}</Button></AlertAction></Alert>
      : !items.length ? <p className="rounded-3xl border border-dashed border-border px-6 py-14 text-center text-muted-foreground">
        {filtered(state) ? t.auditNoMatch : t.auditEmpty}</p>
        : <>
          {!phone ? <div>
            <Table aria-busy={loading} className={cn('min-w-[56rem]', loading && 'opacity-60')}>
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
              {days.map(group => <TableBody key={group.day}>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="rowgroup" colSpan={7} className="h-auto bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {dayLabel(group.day)}</TableHead>
                </TableRow>
                {group.entries.map(({ entry, index }) => {
                  const expanded = open.has(entry.id);
                  return <Fragment key={entry.id}>
                    <TableRow data-active={index === active || undefined} className="data-active:shadow-[inset_3px_0_0_var(--color-primary)]">
                      <TableCell className={cell}><Button variant="ghost" size="icon-sm" aria-expanded={expanded} aria-controls={`audit-${entry.id}`}
                        data-audit-row={index} onFocus={() => setActive(index)}
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
                      <TableCell colSpan={7} className="px-6 py-4 whitespace-normal"><EntryDetail entry={entry} onFilter={filterBy} /></TableCell>
                    </TableRow> : null}
                  </Fragment>;
                })}
              </TableBody>)}
            </Table>
          </div> : <ol aria-label={t.auditTable} aria-busy={loading} className={cn('flex flex-col gap-4', loading && 'opacity-60')}>
            {days.map(group => <li key={group.day}>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">{dayLabel(group.day)}</h2>
              <ol className="flex flex-col gap-2">{group.entries.map(({ entry, index }) => {
                const expanded = open.has(entry.id);
                return <li key={entry.id} className="rounded-2xl border border-border/60 bg-card">
                  <button type="button" data-audit-row={index} aria-expanded={expanded} aria-controls={`audit-card-${entry.id}`}
                    onClick={() => toggle(entry.id)} onFocus={() => setActive(index)}
                    className="flex w-full flex-col gap-1 rounded-2xl px-4 py-3 text-start text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32">
                    <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{actionLabel(entry.action, t)}</span>
                      <OutcomeBadge outcome={entry.outcome} /><Time iso={entry.occurredAt} className="ms-auto text-xs text-muted-foreground" /></span>
                    <span className="text-muted-foreground">{entry.actorName || entry.actorEmail || entry.actorId}
                      {' → '}{entry.targetName || entry.targetEmail || entry.targetId}</span>
                    {entry.reason ? <span className="line-clamp-2 text-xs text-muted-foreground">
                      {entry.reasonCode ? `${reasonLabel(entry.reasonCode, t)} · ` : ''}{entry.reason}</span> : null}
                  </button>
                  {expanded ? <div id={`audit-card-${entry.id}`} className="border-t border-border/60 px-4 py-3">
                    <EntryDetail entry={entry} onFilter={filterBy} /></div> : null}
                </li>;
              })}</ol>
            </li>)}
          </ol>}
        </>}
    {cursor && read.status === 'ok' ? <div className="mt-4 flex justify-center">
      <Button variant="outline" isLoading={loading} onClick={() => void more()}>{t.loadMore}</Button></div> : null}
  </>;
}
